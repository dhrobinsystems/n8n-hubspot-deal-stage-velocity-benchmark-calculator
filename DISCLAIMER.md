# ⚠️ Disclaimer & Liability Limitation

Use at your own risk. The code, workflows, and scripts provided in this repository (`hubspot-deal-stage-velocity-benchmark-calculator`) are for educational and architectural demonstration purposes.

- **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts.
- **No Warranty:** All software, n8n JSON blueprints, and JavaScript modules are provided "AS IS" without warranty of any kind, express or implied, including but not limited to merchantability, fitness for a particular purpose, or non-infringement.
- **Production Testing Required:** Always test thoroughly in an isolated staging environment (for example a HubSpot developer test account or sandbox) with `SANDBOX_MODE=true` enabled before connecting live HubSpot credentials or posting reports to shared Slack channels and spreadsheets.
- **Third-Party APIs & Compliance:** Users are solely responsible for complying with the terms of service, rate limits, data privacy regulations (GDPR/CCPA), and security policies of HubSpot, Slack, Google and any connected services, including reviewing every report before it is shared and controlling who can access the deal data it contains.

## Operational risk breakdown

This workflow is designed to be **read-only** towards HubSpot: it reads pipeline definitions and deal records and never creates, updates or deletes CRM data. It still carries operational risks that the user must manage.

### 1. CRM automation risk

- **Configuration drift:** pipeline and stage IDs, property names (`hs_v2_date_entered_<stageId>`, `hs_date_entered_<stageId>`) and stage metadata can change when HubSpot or your administrators change the portal. Benchmarks can silently change meaning if stages are renamed, merged, re-ordered or repurposed.
- **Modified workflows:** if you add nodes that write to HubSpot (for example, tagging stalled deals or reassigning owners), you take on full responsibility for those writes, their correctness and their reversibility.
- **Credential scope:** grant the HubSpot private app the minimum scopes needed (deal read access). Broader scopes increase the impact of a leaked or misused credential.

### 2. Bulk deal processing risk

- **Volume and completeness:** the HubSpot CRM search API returns at most 10,000 results per query, and the workflow caps pagination. Large portals or long look-back windows can produce **incomplete samples** without obvious errors. Narrow `LOOKBACK_DAYS` or `PIPELINE_IDS` for large datasets.
- **Statistical validity:** averages, medians and percentiles from small samples are unreliable. Thresholds such as `MIN_SAMPLE_SIZE` reduce, but do not remove, the risk of misleading benchmarks. Bottleneck and stall flags are heuristics, **not** performance judgements about any individual.
- **Data quality:** stage-history timestamps can be missing, back-filled by imports, edited manually, or out of order. The workflow skips or flags some of these cases, but cannot detect every inaccuracy in source data.
- **Decision risk:** do not base compensation, disciplinary, forecasting or contractual decisions solely on this report. Validate findings against the underlying records.

### 3. API data synchronisation risk

- **Rate limits and outages:** HubSpot, Slack and Google enforce rate limits and may be unavailable. Requests are retried and paced, and partial results are labelled (`PARTIAL_FETCH_ERROR`, `PARTIAL_RATE_LIMITED`), but a run can still complete with partial data.
- **Point-in-time snapshots:** each run reflects data at execution time. Reports appended to Google Sheets are historical snapshots and are **not** updated when CRM data later changes.
- **API changes:** third-party APIs, node versions and response formats change. Re-test after upgrading n8n or when HubSpot announces API or property deprecations.

### 4. Data privacy and disclosure risk

- Reports can contain deal IDs, owner IDs, amounts and (if `INCLUDE_DEAL_NAMES=true`) deal names, which may reveal customer relationships or personal data. Post them only to channels and spreadsheets with appropriate access controls.
- Exports in Slack and Google Sheets fall under those platforms' retention and access policies, which you are responsible for configuring.

## User responsibility

By deploying this workflow, the user (and the organisation they represent) accepts **sole responsibility** for:

- **Compliance:** lawful processing of CRM data under applicable data-protection law (including GDPR, UK GDPR and CCPA/CPRA), internal data-governance policies, customer contracts, and the terms of service of HubSpot, Slack, Google and n8n.
- **Data integrity:** validating that pipelines, stage mappings, property prefixes and thresholds match their portal; reviewing reports before acting on them; and maintaining backups of any data they export or modify.
- **Security:** storing credentials only in the n8n credential store or a secret manager, restricting access to the n8n instance and its execution logs, and rotating credentials when people leave.
- **Monitoring:** configuring an n8n Error Workflow and reviewing failed or partial runs.

## Liability limitation

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. THE USER ASSUMES FULL RESPONSIBILITY FOR CRM DATA INTEGRITY, BACKUPS, API RATE LIMITS, REPORT ACCURACY, AND COMPLIANCE WITH THIRD-PARTY TERMS OF SERVICE AND DATA-PROTECTION LAW WHEN EXECUTING AUTOMATED WORKFLOWS IN PRODUCTION ENVIRONMENTS.

## License

Released under the MIT License. Copyright (c) 2026 DH Robin (dhRobin Systems). See [LICENSE](LICENSE).
