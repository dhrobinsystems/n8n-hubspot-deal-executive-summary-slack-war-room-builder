#!/usr/bin/env node
/*
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-deal-executive-summary-slack-war-room-builder.
 *
 * Zero network modules: this file only requires fs, path and vm. Code-node
 * JavaScript is taken verbatim from workflow.json and executed in isolated VM
 * contexts. A small execution engine follows workflow.json's connections,
 * evaluates IF / HTTP {{ expressions }}, emulates the "Loop Over Items"
 * (splitInBatches v3) node and n8n's "$('Node').first() = latest run"
 * semantics. HTTP Request nodes are routed to in-memory HubSpot / Slack / AI
 * mocks, so even the fully-armed live path is exercised without a socket.
 *
 * Verifies: workflow structure and static safety, safe defaults, live-mode
 * refusals, webhook authentication, fixture parity, threshold / stage /
 * currency / idempotency gating, channel slug sanitisation and collision
 * handling, stakeholder mapping, PII redaction, Block Kit limits and escaping,
 * AI data minimisation and output validation, call ordering (stamp before
 * invite/post), registry + lock behaviour, and partial-failure reporting.
 *
 * Usage:  node scripts/simulate-sandbox-run.js [--quiet]
 * Exit:   0 when every check passes, 1 otherwise.
 * Output: sim-output/ (git-ignored): Block Kit payloads, dry-run preview,
 *         run reports. Paste a blocks file into Slack's Block Kit Builder.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Paranoia: make any accidental global network use fail loudly.
globalThis.fetch = () => { throw new Error('Network access is not allowed in the simulator'); };

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const FIXTURE_PATH = path.join(ROOT, 'sample-payloads', 'enterprise-deal-context-fixture.json');
const OUT_DIR = path.join(ROOT, 'sim-output');
const QUIET = process.argv.includes('--quiet');

const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ------------------------------------------------------------------ harness
let passed = 0;
let failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; if (!QUIET) console.log(`  ✔ ${label}`); }
  else { failed++; failures.push(label + (detail ? ` -- ${detail}` : '')); console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n▶ ${t}`); };

// ===================================================================== mocks
const SIM_TOKENS = {
  HUBSPOT_ACCESS_TOKEN: 'sim-placeholder-hubspot-token',
  SLACK_BOT_TOKEN: 'sim-placeholder-slack-token',
  AI_API_KEY: 'sim-placeholder-ai-key',
  WEBHOOK_SHARED_SECRET: 'sim-placeholder-webhook-secret-0123456789',
};
class HttpError extends Error { constructor(status, message) { super(`${status} - ${message}`); this.status = status; } }

function makeMocks(opts = {}) {
  const state = {
    calls: [],
    stamped: {},
    channels: new Set(opts.existingChannels || []),
    nextChannel: 99001001,
    nextTs: 1763366400,
  };
  const deals = Object.fromEntries(fixture.deals.map((d) => [d.deal.id, d]));
  const records = { companies: {}, contacts: {}, calls: {}, meetings: {}, notes: {} };
  for (const d of fixture.deals) {
    const c = d.context;
    if (c.company) records.companies[c.company.id] = c.company;
    for (const t of ['contacts', 'calls', 'meetings', 'notes']) for (const r of c[t] || []) records[t][r.id] = r;
  }
  const auth = (headers, key) => {
    if (headers.Authorization !== `Bearer ${SIM_TOKENS[key]}`) throw new HttpError(401, `bad or missing ${key} bearer token`);
  };
  function handle({ method, url, headers, body, node }) {
    const u = new URL(url);
    state.calls.push({ node, method, host: u.host, path: u.pathname, query: u.search, body: clone(body) });
    // ---------------------------------------------------------- HubSpot
    if (u.host === 'api.hubapi.com') {
      auth(headers, 'HUBSPOT_ACCESS_TOKEN');
      let m;
      if (method === 'GET' && (m = u.pathname.match(/^\/crm\/v3\/objects\/deals\/(\d+)$/))) {
        const d = deals[m[1]];
        if (!d) throw new HttpError(404, 'deal not found');
        const out = clone(d.deal);
        Object.assign(out.properties, state.stamped[m[1]] || {});
        return out;
      }
      if (method === 'GET' && (m = u.pathname.match(/^\/crm\/v3\/owners\/(\d+)$/))) {
        const o = fixture.owners[m[1]];
        if (!o) throw new HttpError(404, 'owner not found');
        return o;
      }
      if (method === 'POST' && (m = u.pathname.match(/^\/crm\/v3\/objects\/(\w+)\/batch\/read$/))) {
        const type = m[1];
        if (opts.failBatch === type) throw new HttpError(403, 'MISSING_SCOPES');
        const ids = (body.inputs || []).map((i) => String(i.id));
        if (type === 'deals') return { status: 'COMPLETE', results: ids.map((id) => ({ id, properties: { description: deals[id] && deals[id].deal.properties.description } })) };
        return { status: 'COMPLETE', results: ids.map((id) => records[type][id]).filter(Boolean) };
      }
      if (method === 'PATCH' && (m = u.pathname.match(/^\/crm\/v3\/objects\/deals\/(\d+)$/))) {
        state.stamped[m[1]] = { ...(state.stamped[m[1]] || {}), ...body.properties };
        return { id: m[1], properties: body.properties };
      }
      throw new HttpError(404, `unmocked HubSpot route ${method} ${u.pathname}`);
    }
    // ------------------------------------------------------------ Slack
    if (u.host === 'slack.com') {
      auth(headers, 'SLACK_BOT_TOKEN');
      const api = u.pathname.replace('/api/', '');
      if (api === 'users.lookupByEmail') {
        const email = u.searchParams.get('email');
        const id = fixture.sandboxSlackDirectory[email];
        return id ? { ok: true, user: { id, deleted: false, is_bot: false } } : { ok: false, error: 'users_not_found' };
      }
      if (api === 'conversations.create') {
        if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(body.name)) return { ok: false, error: 'invalid_name_specials' };
        if (state.channels.has(body.name)) return { ok: false, error: 'name_taken' };
        state.channels.add(body.name);
        return { ok: true, channel: { id: `C${state.nextChannel++}`, name: body.name, is_private: body.is_private, context_team_id: 'T99000001' } };
      }
      if (api === 'conversations.invite') return { ok: true, channel: { id: body.channel } };
      if (api === 'chat.postMessage') {
        if (opts.failPost) return { ok: false, error: 'msg_too_long' };
        return { ok: true, channel: body.channel, ts: `${state.nextTs++}.000100` };
      }
      if (api === 'pins.add') return body.timestamp ? { ok: true } : { ok: false, error: 'no_item_specified' };
      return { ok: false, error: 'unknown_method' };
    }
    // --------------------------------------------------------------- AI
    if (u.host === 'ai.example.com') {
      auth(headers, 'AI_API_KEY');
      if (opts.aiMode === 'error') throw new HttpError(500, 'upstream error');
      const content = opts.aiMode === 'malicious'
        ? JSON.stringify({ executiveSummary: 'Ping <!channel> and email dana.whitfield@example.com now.', risks: [], nextSteps: [] })
        : opts.aiMode === 'garbage' ? 'Sure! Here is your summary: ...'
        : JSON.stringify({
          executiveSummary: 'Six-figure expansion with a fully mapped committee. Security review and MSA liability terms are the critical path to a Q1 close.',
          risks: ['Security review may push signature into Q2', 'MSA liability cap unresolved'],
          nextSteps: ['Kick off security review this week', 'Deliver TCO model by 2026-11-24'],
          stakeholderInsights: ['Champion also holds decision rights, so keep them close'],
        });
      return { model: body.model, choices: [{ message: { role: 'assistant', content } }] };
    }
    throw new HttpError(502, `unmocked host ${u.host}`);
  }
  return { state, handle };
}

// ==================================================================== engine
function evalExpr(template, ctx) {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const t = template.slice(1);
  const single = t.match(/^\{\{([\s\S]*)\}\}$/);
  const run = (expr) => vm.runInNewContext(`(${expr})`, { ...ctx, encodeURIComponent, JSON, String, Object, Number }, { timeout: 2000 });
  if (single && !single[1].includes('}}')) return run(single[1]);
  return t.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const v = run(e);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function runWorkflow({ trigger = 'manual', webhookItem, env = {}, mocks, staticData = {} }) {
  const runData = {};
  const loopState = {};
  const order = [];
  const envProxy = new Proxy({}, {
    get(_t, k) {
      if (env === 'BLOCKED') throw new Error('access to env vars denied');
      return typeof k === 'string' ? env[k] : undefined;
    },
  });
  const accessor = (name) => {
    const runs = runData[name];
    if (!runs || !runs.length) throw new Error(`Referenced node "${name}" has not executed (no_execution_data)`);
    const outIdx = byName[name].type === 'n8n-nodes-base.splitInBatches' ? 1 : 0;
    const items = (runs[runs.length - 1][outIdx] || []).map((j) => ({ json: clone(j) }));
    return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
  };
  const ctxFor = (json) => ({ $json: clone(json), $: accessor, $env: envProxy });

  function record(name, outputs) {
    (runData[name] = runData[name] || []).push(outputs.map((o) => (o || []).map(clone)));
    order.push(name);
  }
  function exec(name, items) {
    const node = byName[name];
    let outputs;
    switch (node.type) {
      case 'n8n-nodes-base.manualTrigger':
      case 'n8n-nodes-base.webhook':
        outputs = [items];
        break;
      case 'n8n-nodes-base.code': {
        const sandbox = {
          $input: { first: () => ({ json: clone(items[0]) }), all: () => items.map((j) => ({ json: clone(j) })), item: { json: clone(items[0]) } },
          $env: envProxy,
          $: accessor,
          $getWorkflowStaticData: () => staticData,
          require: (m) => { throw new Error(`Cannot find module '${m}'`); },
          Buffer: undefined,
          console: { log() {}, warn() {}, error() {} },
        };
        const res = vm.runInNewContext(`(() => {\n${node.parameters.jsCode}\n})()`, sandbox, { timeout: 10000, filename: `${name}.js` });
        if (!Array.isArray(res)) throw new Error(`Code node "${name}" did not return an array`);
        outputs = [res.map((i) => clone(i.json))];
        break;
      }
      case 'n8n-nodes-base.if': {
        const t = [], f = [];
        for (const j of items) (evalExpr(node.parameters.conditions.conditions[0].leftValue, ctxFor(j)) === true ? t : f).push(j);
        outputs = [t, f];
        break;
      }
      case 'n8n-nodes-base.httpRequest': {
        const out = [];
        for (const j of items) {
          const c = ctxFor(j);
          const url = evalExpr(node.parameters.url, c);
          const headers = Object.fromEntries((node.parameters.headerParameters?.parameters || []).map((h) => [h.name, evalExpr(h.value, c)]));
          const body = node.parameters.sendBody ? JSON.parse(evalExpr(node.parameters.jsonBody, c)) : undefined;
          try {
            out.push(mocks.handle({ method: node.parameters.method || 'GET', url, headers, body, node: name }));
          } catch (e) {
            if (node.onError === 'continueRegularOutput') out.push({ error: { message: e.message, status: e.status } });
            else throw Object.assign(new Error(`${name}: ${e.message}`), { node: name });
          }
        }
        outputs = [out];
        break;
      }
      case 'n8n-nodes-base.splitInBatches': {
        const st = loopState[name];
        if (!st) {
          loopState[name] = { queue: items.slice(1), processed: [] };
          outputs = [[], items.slice(0, 1)];
        } else {
          st.processed.push(...items);
          outputs = st.queue.length ? [[], [st.queue.shift()]] : [st.processed, []];
          if (!st.queue.length && outputs[0].length) delete loopState[name];
        }
        break;
      }
      default:
        throw new Error(`Engine does not support node type ${node.type}`);
    }
    record(name, outputs);
    const conns = (workflow.connections[name] || {}).main || [];
    outputs.forEach((outItems, idx) => {
      if (!outItems || !outItems.length) return;
      for (const c of conns[idx] || []) exec(c.node, outItems);
    });
  }
  let error = null;
  try {
    if (trigger === 'webhook') exec('HubSpot Deal Webhook', [webhookItem]);
    else exec('Manual Test Trigger', [{}]);
  } catch (e) { error = e; }
  const last = (n, out = 0) => (runData[n] ? runData[n][runData[n].length - 1][out] : undefined);
  const all = (n, out = 0) => (runData[n] || []).flatMap((r) => r[out] || []);
  return { runData, order, error, last, all, staticData, calls: mocks.state.calls, mocks };
}

// -------------------------------------------------------- reusable configs
const NOW = '2026-11-17T08:00:00.000Z';
const LIVE_READ = { SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: SIM_TOKENS.HUBSPOT_ACCESS_TOKEN, HUBSPOT_PORTAL_ID: '99000001', WEBHOOK_SHARED_SECRET: SIM_TOKENS.WEBHOOK_SHARED_SECRET, NOW_OVERRIDE: NOW, TEST_DEAL_ID: '990001001' };
const ARMED = {
  ...LIVE_READ, DRY_RUN: 'false', SLACK_MUTATIONS_ENABLED: 'true', HUBSPOT_MUTATIONS_ENABLED: 'true', SLACK_BOT_TOKEN: SIM_TOKENS.SLACK_BOT_TOKEN,
  LEADERSHIP_SLACK_USER_IDS: 'U99000001', LEADERSHIP_EMAILS: 'cro@example.com,vp.sales@example.com,nobody@example.com',
  SLACK_WORKSPACE_URL: 'https://example-workspace.slack.com',
};
const AI_ON = { AI_ENABLED: 'true', AI_API_KEY: SIM_TOKENS.AI_API_KEY, AI_MODEL: 'example-model', AI_API_BASE_URL: 'https://ai.example.com/v1' };
const SECRET_VALUES = Object.values(SIM_TOKENS);
const hook = (body, secret = SIM_TOKENS.WEBHOOK_SHARED_SECRET) => ({
  headers: { 'content-type': 'application/json', ...(secret !== null ? { 'X-War-Room-Secret': secret } : {}) },
  params: {}, query: {}, body,
});
const dealEvent = (id, prop = 'amount', portalId = 99000001) => ({ eventId: 1, subscriptionId: 7, portalId, appId: 1, occurredAt: 1763366400000, subscriptionType: 'deal.propertyChange', attemptNumber: 0, objectId: Number(id), propertyName: prop, propertyValue: '185000', changeSource: 'CRM_UI' });

// ---------------------------------------------------- Block Kit validator
function validateBlocks(msg) {
  const errs = [];
  const b = msg.blocks || [];
  if (b.length > 50) errs.push(`blocks ${b.length} > 50`);
  if (!msg.text || msg.text.length > 4000) errs.push('fallback text missing or > 4000');
  const allowed = new Set(['header', 'section', 'divider', 'context', 'actions']);
  for (const [i, blk] of b.entries()) {
    if (!allowed.has(blk.type)) errs.push(`#${i} unknown type ${blk.type}`);
    if (blk.type === 'header' && (blk.text.type !== 'plain_text' || blk.text.text.length > 150)) errs.push(`#${i} header invalid`);
    if (blk.type === 'section') {
      if (!blk.text && !blk.fields) errs.push(`#${i} section without text/fields`);
      if (blk.text && blk.text.text.length > 3000) errs.push(`#${i} section text > 3000`);
      if (blk.fields && (blk.fields.length > 10 || blk.fields.some((f) => f.text.length > 2000))) errs.push(`#${i} fields invalid`);
    }
    if (blk.type === 'context' && (blk.elements.length > 10 || blk.elements.some((e) => e.text.length > 3000))) errs.push(`#${i} context invalid`);
    if (blk.type === 'actions') for (const e of blk.elements) {
      if (e.text.text.length > 75) errs.push(`#${i} button text > 75`);
      if (!/^https:\/\//.test(e.url) || e.url.length > 3000) errs.push(`#${i} button url invalid`);
    }
  }
  return errs;
}
const allText = (msg) => JSON.stringify(msg);

// ====================================================================== main
(function main() {
  console.log('n8n-hubspot-deal-executive-summary-slack-war-room-builder :: offline simulator');
  console.log(`workflow: workflow.json (${workflow.nodes.length} nodes)`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ------------------------------------------------------------ 1. structure
  section('1. Workflow structure and static safety checks');
  const names = workflow.nodes.map((n) => n.name);
  check('Node names are unique', new Set(names).size === names.length);
  check('Workflow is inactive on import', workflow.active === false);
  const bad = [];
  for (const [src, c] of Object.entries(workflow.connections)) {
    if (!byName[src]) bad.push(src);
    for (const br of c.main || []) for (const x of br) if (!byName[x.node]) bad.push(`${src}->${x.node}`);
  }
  check('All connections reference existing nodes', bad.length === 0, bad.join(', '));
  const ifs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
  check(`All ${ifs.length} IF nodes wire both outputs`, ifs.every((n) => (workflow.connections[n.name]?.main || []).length === 2 && workflow.connections[n.name].main.every((b) => b.length)));
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); for (const b of workflow.connections[n]?.main || []) for (const c of b) walk(c.node); };
  walk('Manual Test Trigger'); walk('HubSpot Deal Webhook');
  const unreachable = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reach.has(n.name)).map((n) => n.name);
  check('Every functional node is reachable from a trigger', unreachable.length === 0, unreachable.join(', '));
  const wh = byName['HubSpot Deal Webhook'];
  check('Webhook trigger is POST and responds immediately', wh && wh.parameters.httpMethod === 'POST' && wh.parameters.responseMode === 'onReceived');
  const httpNodes = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  const auths = httpNodes.flatMap((n) => (n.parameters.headerParameters?.parameters || []).filter((h) => h.name === 'Authorization'));
  check(`All ${httpNodes.length} HTTP nodes authenticate via {{ $env.* }} only`, auths.length === httpNodes.length && auths.every((h) => /^=Bearer \{\{ \$env\.(HUBSPOT_ACCESS_TOKEN|SLACK_BOT_TOKEN|AI_API_KEY) \}\}$/.test(h.value)));
  check('No stored n8n credentials', workflow.nodes.every((n) => !n.credentials));
  const hsWrites = httpNodes.filter((n) => /HUBSPOT_ACCESS_TOKEN/.test(JSON.stringify(n.parameters)) && !['GET'].includes(n.parameters.method || 'GET'));
  check('Only "HubSpot: Stamp Deal War-Room" can PATCH HubSpot; other non-GETs are batch reads', hsWrites.every((n) => (n.name === 'HubSpot: Stamp Deal War-Room' && n.parameters.method === 'PATCH') || (n.parameters.method === 'POST' && n.name === 'HubSpot Context Collector')));
  check('Context Collector posts only to /batch/read endpoints', /batch\/read/.test(fs.readFileSync(WORKFLOW_PATH, 'utf8')) && !/batch\/(create|update|upsert|archive)/.test(fs.readFileSync(WORKFLOW_PATH, 'utf8')));
  check('Slack create-channel and post-message nodes never auto-retry (no duplicates)', ['Slack: Create Channel', 'Slack: Create Channel (Fallback Name)', 'Slack: Post Executive Brief'].every((n) => !byName[n].retryOnFail));
  const rawWf = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const PATTERNS = [
    [/xox[abposr]-[A-Za-z0-9-]{10,}/, 'Slack token'], [/hooks\.slack\.com\/services\//, 'Slack webhook'], [/pat-(na|eu|ap)\d?-[0-9a-f-]{20,}/i, 'HubSpot token'],
    [/sk-[A-Za-z0-9]{20,}/, 'AI key'], [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'], [/Bearer [A-Za-z0-9\-_.]{16,}/, 'literal bearer'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  ];
  const texts = { 'workflow.json': rawWf };
  for (const f of ['README.md', 'DISCLAIMER.md', '.env.example', 'sample-payloads/enterprise-deal-context-fixture.json']) if (fs.existsSync(path.join(ROOT, f))) texts[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hits = [];
  for (const [f, t] of Object.entries(texts)) for (const [re, l] of PATTERNS) if (re.test(t)) hits.push(`${l} in ${f}`);
  check('No hardcoded tokens, keys or webhook URLs in shipped files', hits.length === 0, hits.join(', '));
  const emails = [...new Set((texts['sample-payloads/enterprise-deal-context-fixture.json'] + rawWf).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
  check('Every email address in fixture and workflow uses example.com', emails.length > 0 && emails.every((e) => /@([a-z0-9-]+\.)*example\.(com|invalid)$/i.test(e)), emails.filter((e) => !/example\./.test(e)).join(', '));
  const slackIds = [...new Set(rawWf.match(/\b[UC]\d{8}\b/g) || [])];
  check('Slack IDs in the fixture are U99/C99 placeholders', slackIds.every((id) => /^[UC]99\d{6}$/.test(id)), slackIds.join(','));
  const exprErr = [];
  const visit = (v, w) => {
    if (typeof v === 'string' && v.startsWith('=')) for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { try { new Function('$json', '$', '$env', `return (${m[1]});`); } catch (e) { exprErr.push(`${w}: ${e.message}`); } }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${w}.${k}`);
  };
  workflow.nodes.forEach((n) => visit(n.parameters, n.name));
  check('Every {{ expression }} parses as JavaScript', exprErr.length === 0, exprErr.join('; '));
  const codeErr = [];
  for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) { try { new vm.Script(`(() => {\n${n.parameters.jsCode}\n})`); } catch (e) { codeErr.push(`${n.name}: ${e.message}`); } }
  check('Every Code node compiles', codeErr.length === 0, codeErr.join('; '));
  check('Code nodes use no require() at all (no network or fs modules)', workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code').every((n) => !/\brequire\s*\(/.test(n.parameters.jsCode)));

  // ------------------------------------------------------- 2. safe defaults
  section('2. Safe-by-default configuration');
  const cfgOf = (env) => {
    const r = runWorkflow({ env, mocks: makeMocks() });
    return { cfg: r.last('Config & Safety Gate') && r.last('Config & Safety Gate')[0].config, r };
  };
  const { cfg: d0 } = cfgOf({});
  check('Empty env -> SANDBOX_MODE and DRY_RUN on', d0.sandboxMode && d0.dryRun);
  check('Empty env -> Slack, HubSpot stamp and AI all blocked', !d0.slack.allowed && !d0.hubspot.stampAllowed && !d0.ai.allowed);
  check('Empty env -> ARR threshold 50000 USD on "amount"', d0.threshold.amount === 50000 && d0.threshold.currency === 'USD' && d0.threshold.property === 'amount');
  check('Empty env -> private channels, prefix "deal-"', d0.slack.channelPrivate === true && d0.slack.channelPrefix === 'deal-');
  const { cfg: typo } = cfgOf({ SANDBOX_MODE: 'flase', DRY_RUN: 'nah', SLACK_MUTATIONS_ENABLED: 'enabled', AI_ENABLED: 'True ' });
  check('Typos keep SANDBOX/DRY_RUN on and do not arm Slack', typo.sandboxMode && typo.dryRun && !typo.slack.mutationsEnabled);
  check('AI stays blocked in sandbox even when AI_ENABLED=true', typo.ai.enabled === true && typo.ai.allowed === false && typo.ai.blockers.some((b) => b.startsWith('SANDBOX_MODE')));
  const { cfg: blocked } = cfgOf('BLOCKED');
  check('Blocked $env -> all safe defaults', blocked.envBlocked && blocked.sandboxMode && blocked.dryRun && !blocked.slack.allowed);
  const { cfg: sp } = cfgOf({ HUBSPOT_PORTAL_ID: '12345678' });
  check('Sandbox ignores a real-looking portal ID (forces 99000001)', sp.portalId === '99000001');
  const { cfg: noStamp } = cfgOf({ ...ARMED, HUBSPOT_MUTATIONS_ENABLED: 'false' });
  check('Slack provisioning refuses to run without HubSpot stamping (idempotency)', !noStamp.slack.allowed && noStamp.slack.blockers.some((b) => b.includes('idempotency')));
  const { cfg: override } = cfgOf({ ...ARMED, HUBSPOT_MUTATIONS_ENABLED: 'false', ALLOW_SLACK_WITHOUT_HUBSPOT_STAMP: 'true' });
  check('ALLOW_SLACK_WITHOUT_HUBSPOT_STAMP=true is the explicit override', override.slack.allowed && !override.hubspot.stampAllowed);
  const { cfg: aiHttp } = cfgOf({ ...LIVE_READ, ...AI_ON, AI_API_BASE_URL: 'http://ai.example.com/v1' });
  check('AI over plain http is refused', !aiHttp.ai.allowed && aiHttp.ai.blockers.some((b) => b.includes('https')));
  const { cfg: noModel } = cfgOf({ ...LIVE_READ, ...AI_ON, AI_MODEL: '' });
  check('AI requires an explicit AI_MODEL (no stale default)', !noModel.ai.allowed && noModel.ai.blockers.some((b) => b.includes('AI_MODEL')));
  const { cfg: badIds } = cfgOf({ LEADERSHIP_SLACK_USER_IDS: 'U99000001,not-an-id', LEADERSHIP_EMAILS: 'cro@example.com,broken' });
  check('Invalid leadership IDs / emails are dropped with a warning', badIds.slack.leadershipSlackUserIds.length === 1 && badIds.slack.leadershipEmails.length === 1 && badIds.warnings.length === 2);
  const { r: armedRun } = cfgOf(ARMED);
  check('Config output never contains secret values', SECRET_VALUES.every((s) => !JSON.stringify(armedRun.last('Config & Safety Gate')).includes(s)));

  // ------------------------------------------------------ 3. live refusals
  section('3. Live-mode refusals and webhook authentication');
  const r1 = runWorkflow({ env: { SANDBOX_MODE: 'false', HUBSPOT_PORTAL_ID: '99000001' }, mocks: makeMocks() });
  check('Live without HUBSPOT_ACCESS_TOKEN is refused', r1.error && /HUBSPOT_ACCESS_TOKEN/.test(r1.error.message));
  const r2 = runWorkflow({ env: { SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: 'x' }, mocks: makeMocks() });
  check('Live without numeric HUBSPOT_PORTAL_ID is refused', r2.error && /HUBSPOT_PORTAL_ID/.test(r2.error.message));
  const r3 = runWorkflow({ env: { ...LIVE_READ, TEST_DEAL_ID: '' }, mocks: makeMocks() });
  check('Live manual run without TEST_DEAL_ID is refused', r3.error && /TEST_DEAL_ID/.test(r3.error.message));
  const m4 = makeMocks();
  const r4 = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')], null), env: LIVE_READ, mocks: m4 });
  check('Webhook without x-war-room-secret is rejected before any API call', r4.error && /x-war-room-secret/.test(r4.error.message) && m4.state.calls.length === 0);
  const r5 = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')], 'wrong-secret-wrong-secret'), env: LIVE_READ, mocks: makeMocks() });
  check('Webhook with a wrong secret is rejected', r5.error && /invalid/.test(r5.error.message));
  const r6 = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: { ...LIVE_READ, WEBHOOK_SHARED_SECRET: 'short' }, mocks: makeMocks() });
  check('Live webhooks fail closed when WEBHOOK_SHARED_SECRET is unset or < 16 chars', r6.error && /WEBHOOK_SHARED_SECRET/.test(r6.error.message));
  const m7 = makeMocks();
  const r7 = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001'), dealEvent('990001001'), dealEvent('990001002', 'hs_lastmodifieddate'), dealEvent('990001003', 'amount', 12345)]), env: LIVE_READ, mocks: m7 });
  const parsed = r7.last('Parse & Authenticate Trigger Event') || [];
  check('Valid webhook: dedupes, ignores non-trigger properties and foreign portals', !r7.error && parsed.length === 1 && parsed[0].dealId === '990001001', JSON.stringify(parsed.map((p) => p.dealId)));
  check('Secret header is stripped before leaving the Config node', !JSON.stringify(r7.runData['Config & Safety Gate']).includes(SIM_TOKENS.WEBHOOK_SHARED_SECRET) && !/x-war-room-secret/i.test(JSON.stringify(r7.last('Config & Safety Gate')[0].trigger[0].headers)));
  const rq = runWorkflow({ trigger: 'webhook', webhookItem: { headers: {}, params: {}, query: { war_room_secret: SIM_TOKENS.WEBHOOK_SHARED_SECRET }, body: [dealEvent('990001002')] }, env: LIVE_READ, mocks: makeMocks() });
  check('Secret accepted as ?war_room_secret= (HubSpot app subscriptions) and stripped', !rq.error && (rq.last('Parse & Authenticate Trigger Event') || [])[0]?.dealId === '990001002' && !JSON.stringify(rq.runData['Config & Safety Gate']).includes(SIM_TOKENS.WEBHOOK_SHARED_SECRET));
  const r8 = runWorkflow({ trigger: 'webhook', webhookItem: hook({ objectId: 990001002, properties: { amount: '96500' } }), env: LIVE_READ, mocks: makeMocks() });
  check('HubSpot workflow "Send a webhook" payload (single object) is accepted', (r8.last('Parse & Authenticate Trigger Event') || [])[0]?.dealId === '990001002');

  // --------------------------------------------------- 4. fixture parity
  section('4. Fixture parity and synthetic-data hygiene');
  const emb = byName['Load Synthetic Deal Context'].parameters.jsCode.match(/const FIXTURE = ([\s\S]*?);\n\nconst items/);
  let parity = false;
  try { parity = JSON.stringify(JSON.parse(emb[1])) === JSON.stringify(fixture); } catch (e) { parity = false; }
  check('Fixture embedded in workflow.json equals sample-payloads/enterprise-deal-context-fixture.json', parity);
  check('Fixture is flagged synthetic, portal 99000001, six scenarios', fixture._meta.synthetic && fixture.portalId === '99000001' && fixture.deals.length === 6);
  const acme = fixture.deals.find((d) => d.deal.id === '990001001');
  check('Primary fixture deal is > $50k with a 6-person buying committee and call notes', Number(acme.deal.properties.amount) > 50000 && acme.context.contacts.length === 6 && acme.context.calls.length >= 2);

  // -------------------------------------------------------------- 5. slugs
  section('5. Channel slug sanitisation');
  const synthSrc = byName['Executive Brief & Stakeholder Map Synthesizer'].parameters.jsCode;
  const grab = (name) => {
    const s = synthSrc.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = synthSrc.indexOf('{', s); i < synthSrc.length; i++) { if (synthSrc[i] === '{') depth++; if (synthSrc[i] === '}' && --depth === 0) return synthSrc.slice(s, i + 1); }
    return '';
  };
  const legal = synthSrc.match(/const LEGAL_SUFFIXES = [^;]+;/)[0];
  const sctx = {};
  vm.runInNewContext(`${legal}\n${grab('slugify')}\n${grab('fitName')}\nthis.slugify = slugify; this.fitName = fitName;`, sctx);
  const cases = [
    ['Acme Enterprise Corp', 'acme-enterprise'],
    ['Northstar Logistics, Inc.', 'northstar-logistics'],
    ['Zürich Café Systems AG', 'zurich-cafe-systems'],
    ['AT&T Field Services', 'at-and-t-field-services'],
    ["O'Neil & Sons Ltd.", 'oneil-and-sons'],
    ['Søren Ærø Ståhl GmbH', 'soren-aero-stahl'],
    ['  --Weird   Spacing__Co!!  ', 'weird-spacing'],
    ['Inc', 'inc'],
    ['株式会社サンプル', ''],
    ['<script>alert(1)</script> Corp', 'script-alert-1-script'],
  ];
  for (const [input, want] of cases) check(`slugify(${JSON.stringify(input)}) -> "${want}"`, sctx.slugify(input, true) === want, sctx.slugify(input, true));
  check('Legal-suffix stripping can be disabled', sctx.slugify('Acme Enterprise Corp', false) === 'acme-enterprise-corp');
  const long = sctx.slugify('The Extraordinarily Long International Consolidated Freight Forwarding And Warehousing Company Holdings', true);
  const ln = sctx.fitName('deal-', long);
  const lf = sctx.fitName('deal-', long, '-990001001');
  check('Long names fit Slack\'s 80-char limit on a word boundary', ln.length <= 80 && lf.length <= 80 && !ln.endsWith('-') && lf.endsWith('-990001001'), `${ln.length}/${lf.length}`);
  check('Generated names match Slack rules ^[a-z0-9][a-z0-9_-]{0,79}$', [ln, lf, sctx.fitName('deal-', 'acme-enterprise')].every((n) => /^[a-z0-9][a-z0-9_-]{0,79}$/.test(n)));

  // ------------------------------------------------ 6. sandbox end-to-end
  section('6. Sandbox end-to-end (engine, synthetic fixture)');
  const sbMocks = makeMocks();
  const sbStatic = {};
  const sb = runWorkflow({ env: { NOW_OVERRIDE: NOW }, mocks: sbMocks, staticData: sbStatic });
  check('Sandbox run completes without error', !sb.error, sb.error && sb.error.message);
  check('Sandbox run makes ZERO HTTP calls', sbMocks.state.calls.length === 0, String(sbMocks.state.calls.length));
  check('Sandbox run touches no workflow static data (no locks, no registry)', Object.keys(sbStatic).length === 0);
  const report = sb.last('Run Report')[0];
  const dec = Object.fromEntries(sb.last('Threshold & Idempotency Guard').map((d) => [d.dealId, d.decision]));
  check('Gating: 2 eligible, 4 skipped with the expected reasons', JSON.stringify(dec) === JSON.stringify({ 990001001: 'ELIGIBLE', 990001002: 'ELIGIBLE', 990001003: 'SKIP_BELOW_THRESHOLD', 990001004: 'SKIP_ALREADY_PROVISIONED', 990001005: 'SKIP_STAGE_EXCLUDED', 990001006: 'SKIP_CURRENCY_MISMATCH' }), JSON.stringify(dec));
  check('Loop processed each eligible deal once (DRY_RUN_PREVIEW x2)', report.processed === 2 && report.tally.DRY_RUN_PREVIEW === 2);
  check('Run Report includes the 4 skipped deals', report.skipped.length === 4);
  const briefs = sb.all('Block Kit Brief Builder');
  const acmeOut = briefs.find((b) => b.brief.dealId === '990001001');
  const nsOut = briefs.find((b) => b.brief.dealId === '990001002');
  check('Per-iteration data is not mixed across loop runs', acmeOut && nsOut && acmeOut.brief.company.name === 'Acme Enterprise Corp' && nsOut.brief.company.name === 'Northstar Logistics, Inc.');
  const roleOf = (b, name) => (b.brief.stakeholders.find((s) => s.name === name) || {}).roles || [];
  check('Stakeholders: HubSpot buying roles respected (Dana = Executive Sponsor)', roleOf(acmeOut, 'Dana Whitfield').join() === 'Executive Sponsor');
  check('Stakeholders: multi-role contact mapped (Marcus = Decision Maker + Champion)', roleOf(acmeOut, 'Marcus Lee').join() === 'Decision Maker,Champion');
  check('Stakeholders: title inference (counsel -> Legal & Compliance, architect -> Technical Evaluator)', roleOf(acmeOut, 'Elena Sorensen').join() === 'Legal & Compliance' && roleOf(acmeOut, 'Tom Okafor').join() === 'Technical Evaluator');
  check('Stakeholders: inferred roles are flagged as inferred', acmeOut.brief.stakeholders.filter((s) => s.roleSource === 'inferred').length === 2);
  check('Coverage: Acme 100%, Northstar 0% with 3 missing core roles', acmeOut.brief.coverage.score === 100 && nsOut.brief.coverage.score === 0 && nsOut.brief.coverage.missingRequired.length === 3);
  check('Risks extracted from notes (security review, MSA liability, competitive bids)', ['Security review', 'liability', 'competitive bids'].every((k) => acmeOut.brief.risks.some((r) => r.text.includes(k))));
  check('Next steps extracted (TCO model, SOC 2, architecture overview)', ['TCO model', 'SOC 2', 'architecture overview'].every((k) => acmeOut.brief.nextSteps.some((n) => n.text.includes(k))));
  check('Competitor mention extracted (RouteGrid)', acmeOut.brief.competitors.includes('RouteGrid'));
  check('Derived risks: near close date at early stage + stale activity (Northstar)', nsOut.brief.risks.some((r) => /early stage/.test(r.text)) && nsOut.brief.risks.some((r) => /No logged activity for \d+ days/.test(r.text)));
  check('Channel names: deal-acme-enterprise / deal-northstar-logistics', acmeOut.slack.channelName === 'deal-acme-enterprise' && nsOut.slack.channelName === 'deal-northstar-logistics');
  check('Fallback channel name appends the deal ID', acmeOut.slack.fallbackChannelName === 'deal-acme-enterprise-990001001');
  check('Channels are private by default', acmeOut.slack.createBody.is_private === true);

  for (const b of briefs) {
    const errs = validateBlocks(b.slack.message);
    check(`Block Kit within Slack limits (${b.brief.company.name}, ${b.slack.message.blocks.length} blocks)`, errs.length === 0, errs.join('; '));
  }
  const acmeText = allText(acmeOut.slack.message);
  check('Raw <!channel> from notes is escaped (&lt;!channel&gt;), never a live mention', !acmeText.includes('<!channel>') && acmeText.includes('&lt;!channel&gt;'));
  check('No email addresses in the Slack brief', !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(acmeText));
  check('No phone numbers in the Slack brief', !/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(acmeText));
  const rctx = {};
  vm.runInNewContext(`${grab('redact')}\nthis.redact = redact;`, rctx);
  const rawNote = acme.context.calls[0].properties.hs_call_body;
  const red = rctx.redact(rawNote);
  check('redact() strips the email and phone from the raw call note', !red.includes('marcus.lee@example.com') && !red.includes('010-0103') && red.includes('[email redacted]') && red.includes('[phone redacted]'), red.slice(-80));
  check('redact() leaves dates and durations intact', rctx.redact('Deliver by 2026-11-24, review takes 3-4 weeks, SOC 2') === 'Deliver by 2026-11-24, review takes 3-4 weeks, SOC 2');
  check('Private links in notes are removed from the brief', !acmeText.includes('docs.example.com') && acmeText.includes('[link removed]'));
  check('Sandbox brief is visibly labelled [SANDBOX] / synthetic', acmeOut.slack.message.blocks[0].text.text.includes('[SANDBOX]') && acmeText.includes('Synthetic test data'));
  check('Brief links to the deal record in HubSpot (portal 99000001)', acmeText.includes('/contacts/99000001/record/0-3/990001001'));
  const preview = sb.all('Dry-Run Preview').find((p) => p.dealId === '990001001');
  check('Dry-run preview lists create -> stamp -> invite -> post -> pin', /conversations\.create.*PATCH.*conversations\.invite.*chat\.postMessage.*pins\.add/.test(preview.plannedCalls.map((c) => c.method).join('|')));
  check('Dry-run preview resolves sandbox invitees (owner + leadership) to U99 IDs', JSON.stringify(preview.plannedInvitees) === JSON.stringify(['U99000001', 'U99000011', 'U99000003', 'U99000002']), JSON.stringify(preview.plannedInvitees));
  check('Dry-run preview explains why Slack is blocked', preview.blockedBy.some((b) => b.startsWith('SANDBOX_MODE')) && preview.blockedBy.some((b) => b.startsWith('DRY_RUN')));
  for (const b of briefs) fs.writeFileSync(path.join(OUT_DIR, `block-kit-${b.slack.channelName}.json`), JSON.stringify({ blocks: b.slack.message.blocks }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'dry-run-preview.json'), JSON.stringify(sb.all('Dry-Run Preview'), null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-run-report.json'), JSON.stringify(report, null, 2) + '\n');

  // --------------------------------------------- 7. live dry-run (mocked)
  section('7. Live dry-run with mocked HubSpot (reads only)');
  const ldM = makeMocks();
  const ld = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001'), dealEvent('990001002'), dealEvent('990001003')]), env: LIVE_READ, mocks: ldM, staticData: {} });
  check('Live dry-run completes', !ld.error, ld.error && ld.error.message);
  check('Only HubSpot GET / batch-read calls, zero Slack calls, zero PATCH', ldM.state.calls.length > 0 && ldM.state.calls.every((c) => c.host === 'api.hubapi.com' && (c.method === 'GET' || /\/batch\/read$/.test(c.path))));
  check('Live dry-run: 2 previews, 1 below-threshold skip', ld.last('Run Report')[0].tally.DRY_RUN_PREVIEW === 2 && ld.last('Run Report')[0].skipped.length === 1);
  const liveAcme = ld.all('Block Kit Brief Builder').find((b) => b.brief.dealId === '990001001');
  check('Live context collector yields the same stakeholder map and risks as the fixture', liveAcme && JSON.stringify(liveAcme.brief.stakeholders.map((s) => s.roles)) === JSON.stringify(acmeOut.brief.stakeholders.map((s) => s.roles)) && JSON.stringify(liveAcme.brief.risks) === JSON.stringify(acmeOut.brief.risks));
  check('Live brief is not labelled SANDBOX', !liveAcme.slack.message.blocks[0].text.text.includes('[SANDBOX]'));
  const ldFail = makeMocks({ failBatch: 'calls' });
  const ld2 = runWorkflow({ env: LIVE_READ, mocks: ldFail });
  const b2 = ld2.last('Block Kit Brief Builder')[0];
  check('A failed context source (calls 403) degrades gracefully and is footnoted', !ld2.error && b2.brief.contextErrors.some((e) => e.key === 'calls') && allText(b2.slack.message).includes('context source(s) unavailable'));

  // -------------------------------------- 8. fully armed live provisioning
  section('8. Armed live provisioning with mocked Slack + HubSpot');
  const pm = makeMocks();
  const pStatic = {};
  const pr = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: pm, staticData: pStatic });
  check('Provisioning run completes', !pr.error, pr.error && pr.error.message);
  const res = pr.last('Run Report')[0].results[0];
  check('Result status PROVISIONED', res.status === 'PROVISIONED', JSON.stringify(res.steps));
  const seq = pm.state.calls.filter((c) => c.host !== 'api.hubapi.com' || c.method === 'PATCH').map((c) => (c.host === 'slack.com' ? c.path.replace('/api/', '') : 'hubspot.PATCH'));
  check('Call order: lookups -> create -> HubSpot stamp -> invite -> post -> pin', JSON.stringify(seq) === JSON.stringify(['users.lookupByEmail', 'users.lookupByEmail', 'users.lookupByEmail', 'users.lookupByEmail', 'conversations.create', 'hubspot.PATCH', 'conversations.invite', 'chat.postMessage', 'pins.add']), seq.join(' > '));
  const create = pm.state.calls.find((c) => c.path === '/api/conversations.create');
  check('conversations.create: private #deal-acme-enterprise', create.body.name === 'deal-acme-enterprise' && create.body.is_private === true);
  const invite = pm.state.calls.find((c) => c.path === '/api/conversations.invite');
  check('conversations.invite: owner + leadership, unknown email skipped, force=true', invite.body.users === 'U99000001,U99000011,U99000003,U99000002' && invite.body.force === true, invite.body.users);
  const post = pm.state.calls.find((c) => c.path === '/api/chat.postMessage');
  check('chat.postMessage posts the Block Kit brief to the new channel', post.body.channel === res.channelId && post.body.blocks.length > 5 && post.body.unfurl_links === false);
  const pin = pm.state.calls.find((c) => c.path === '/api/pins.add');
  check('pins.add pins the posted message ts', pin.body.channel === res.channelId && /^\d+\.\d+$/.test(pin.body.timestamp));
  const stamp = pm.state.calls.find((c) => c.method === 'PATCH');
  check('HubSpot stamp writes channel ID, URL and timestamp to the deal', stamp.path === '/crm/v3/objects/deals/990001001' && stamp.body.properties.war_room_slack_channel_id === res.channelId && stamp.body.properties.war_room_slack_channel_url === `https://example-workspace.slack.com/archives/${res.channelId}` && stamp.body.properties.war_room_created_at === NOW);
  check('Registry records the channel in workflow static data', pStatic.warRoom.provisioned['990001001'].channelId === res.channelId);
  check('In-flight lock set while provisioning', typeof pStatic.warRoom.locks['990001001'] === 'number');
  check('Unresolved invitee email is reported, not fatal', pr.last('Provisioning Result')[0].unresolvedInvitees.some((u) => u.email === 'nobody@example.com'));
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-call-log.json'), JSON.stringify(pm.state.calls.map((c) => ({ node: c.node, method: c.method, host: c.host, path: c.path })), null, 2) + '\n');

  // ------------------------------------------------------- 9. idempotency
  section('9. Idempotency and duplicate prevention');
  const again = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: pm, staticData: pStatic });
  check('Re-trigger after success: SKIP_ALREADY_PROVISIONED via HubSpot stamp', again.last('Threshold & Idempotency Guard')[0].decision === 'SKIP_ALREADY_PROVISIONED');
  check('Re-trigger creates no channel and posts nothing', pm.state.calls.filter((c) => c.path === '/api/conversations.create').length === 1 && pm.state.calls.filter((c) => c.path === '/api/chat.postMessage').length === 1);
  const regM = makeMocks();
  const regStatic = clone(pStatic);
  const viaReg = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: regM, staticData: regStatic });
  check('Stamp missing but registry has the channel: still skipped', viaReg.last('Threshold & Idempotency Guard')[0].decision === 'SKIP_ALREADY_PROVISIONED' && regM.state.calls.every((c) => c.host === 'api.hubapi.com'));
  const lockStatic = { warRoom: { provisioned: {}, locks: { 990001001: Date.parse(NOW) + 600000 } } };
  const locked = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: makeMocks(), staticData: lockStatic });
  check('Concurrent execution (unexpired lock): SKIP_LOCKED', locked.last('Threshold & Idempotency Guard')[0].decision === 'SKIP_LOCKED');
  const expired = { warRoom: { provisioned: {}, locks: { 990001001: Date.parse(NOW) - 1 } } };
  const exp = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: makeMocks(), staticData: expired });
  check('Expired lock is ignored and replaced', exp.last('Threshold & Idempotency Guard')[0].decision === 'ELIGIBLE');

  // ---------------------------------------------------- 10. collisions
  section('10. Channel name collision handling');
  const cm = makeMocks({ existingChannels: ['deal-acme-enterprise'] });
  const col = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: cm, staticData: {} });
  const colRes = col.last('Run Report')[0].results[0];
  check('name_taken -> fallback #deal-acme-enterprise-990001001 created', colRes.status === 'PROVISIONED' && colRes.channelName === 'deal-acme-enterprise-990001001');
  check('Fallback is reported in the provisioning steps', colRes.steps.createChannel.usedFallback === true);
  const bm = makeMocks({ existingChannels: ['deal-acme-enterprise', 'deal-acme-enterprise-990001001'] });
  const bStatic = {};
  const both = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: bm, staticData: bStatic });
  const bothRes = both.last('Run Report')[0].results[0];
  check('Both names taken -> RECONCILE_REQUIRED, nothing posted, deal not stamped', bothRes.status === 'RECONCILE_REQUIRED' && !bm.state.calls.some((c) => c.path === '/api/chat.postMessage' || c.method === 'PATCH'));
  check('Failed provisioning releases the in-flight lock', !(bStatic.warRoom.locks || {})['990001001']);

  // ------------------------------------------------------------- 11. AI
  section('11. Optional AI synthesis (mocked provider)');
  const am = makeMocks({ aiMode: 'ok' });
  const ai = runWorkflow({ env: { ...LIVE_READ, ...AI_ON }, mocks: am });
  const aiOut = ai.last('Block Kit Brief Builder')[0];
  check('AI path runs only when explicitly enabled and uses the brief', !ai.error && aiOut.brief.synthesis.method === 'ai-assisted');
  check('AI-assisted content is labelled in the brief', allText(aiOut.slack.message).includes('AI-assisted'));
  const aiReq = am.state.calls.find((c) => c.host === 'ai.example.com');
  const aiReqText = JSON.stringify(aiReq.body);
  check('AI request contains no emails, phone numbers or links', !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(aiReqText) && !/\(\d{3}\)\s?\d{3}-\d{4}/.test(aiReqText) && !/https?:\/\//.test(aiReqText));
  check('AI request omits contact names by default', !aiReqText.includes('Dana Whitfield') && aiReqText.includes('Stakeholder 1'));
  check('AI request frames CRM text as untrusted data', aiReqText.includes('untrusted'));
  const mal = runWorkflow({ env: { ...LIVE_READ, ...AI_ON }, mocks: makeMocks({ aiMode: 'malicious' }) });
  const malOut = mal.last('Block Kit Brief Builder')[0];
  check('AI output with mentions / emails is rejected -> deterministic brief', malOut.brief.synthesis.method === 'deterministic' && !allText(malOut.slack.message).includes('dana.whitfield@example.com'));
  const garb = runWorkflow({ env: { ...LIVE_READ, ...AI_ON }, mocks: makeMocks({ aiMode: 'garbage' }) });
  check('Non-JSON AI output falls back to the deterministic brief', garb.last('Block Kit Brief Builder')[0].brief.synthesis.method === 'deterministic');
  const aerr = runWorkflow({ env: { ...LIVE_READ, ...AI_ON }, mocks: makeMocks({ aiMode: 'error' }) });
  check('AI provider error falls back and the run still completes', !aerr.error && aerr.last('Block Kit Brief Builder')[0].brief.synthesis.method === 'deterministic');
  for (const b of [aiOut, malOut]) check(`Block Kit still valid with ${b.brief.synthesis.method} synthesis`, validateBlocks(b.slack.message).length === 0);

  // ------------------------------------------------- 12. partial failures
  section('12. Partial failures and overrides');
  const fm = makeMocks({ failPost: true });
  const fr = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001001')]), env: ARMED, mocks: fm, staticData: {} });
  const frRes = fr.last('Run Report')[0].results[0];
  check('Brief post failure -> PARTIAL with the Slack error recorded (channel already stamped)', frRes.status === 'PARTIAL' && frRes.steps.postBrief.error === 'msg_too_long' && fm.state.calls.some((c) => c.method === 'PATCH'));
  const om = makeMocks();
  const ov = runWorkflow({ trigger: 'webhook', webhookItem: hook([dealEvent('990001002')]), env: { ...ARMED, HUBSPOT_MUTATIONS_ENABLED: 'false', ALLOW_SLACK_WITHOUT_HUBSPOT_STAMP: 'true' }, mocks: om, staticData: {} });
  check('Override path provisions Slack without any HubSpot PATCH', ov.last('Run Report')[0].results[0].status === 'PROVISIONED' && !om.state.calls.some((c) => c.method === 'PATCH'));
  const sumText = JSON.stringify([pr.runData['Run Report'], fr.runData['Run Report'], ai.runData['Block Kit Brief Builder']]);
  check('No secret value appears in any report or brief', SECRET_VALUES.every((s) => !sumText.includes(s)));

  // ------------------------------------------------------------ report
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  console.log(`Output written to: sim-output/ (git-ignored)`);
  if (failed) { console.log('\nFailures:\n' + failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();
