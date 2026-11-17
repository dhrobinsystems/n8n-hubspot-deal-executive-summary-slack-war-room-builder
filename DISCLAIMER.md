# ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts in this repository (**n8n-hubspot-deal-executive-summary-slack-war-room-builder**) are provided for educational and architectural demonstration purposes.

**No Liability:** The author and dhRobin Systems accept no responsibility or liability for any direct, indirect, incidental, or consequential damages that result from using, misusing, or deploying these scripts. That includes Slack channels created in error, duplicated, misnamed or shared with the wrong people; confidential deal, account or contact information exposed in Slack; inaccurate, incomplete or outdated executive briefs; incorrect or overwritten HubSpot deal properties; missed or delayed war rooms; and any commercial decision made on the basis of an automated or AI-assisted brief.

**No Warranty:** All software, n8n JSON blueprints, JavaScript modules, prompts, and sample payloads are provided "AS IS", without warranty of any kind, express or implied. This includes, but is not limited to, warranties of merchantability, fitness for a particular purpose, and non-infringement. Nothing here guarantees that buying roles are inferred correctly, that risks and next steps are extracted completely, that channel names never collide, or that HubSpot, Slack or AI provider APIs, scopes and limits will stay unchanged.

**Production Testing Required:** Always test thoroughly in an isolated staging environment, such as a HubSpot developer test account or sandbox and a dedicated test Slack workspace, with `SANDBOX_MODE=true` and `DRY_RUN=true` enabled, before you connect live HubSpot, Slack or AI credentials. Review the Dry-Run Preview before you set `SLACK_MUTATIONS_ENABLED=true` or `HUBSPOT_MUTATIONS_ENABLED=true`. Treat every executive brief, stakeholder map and AI-assisted summary as a draft that a person must review before it's relied on or shared further.

**Third-Party APIs & Compliance:** You alone are responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, Slack, your AI provider, n8n, and any connected services. That includes confirming a lawful basis and internal approval for copying CRM contact and engagement data into Slack, limiting war-room membership to people with a business need, preferring private channels, applying your Slack retention and export policies to the channels created, confirming that your AI provider's data-processing terms allow CRM content to be sent before you enable `AI_ENABLED`, keeping customer personal data to the minimum the brief needs, protecting the webhook secret, and reviewing every automatically created channel and updated deal record.

The full disclaimer is also available in [DISCLAIMER.md](DISCLAIMER.md).

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).

---

Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 DH Robin (dhRobin Systems) · Provided as-is, see the disclaimer.
