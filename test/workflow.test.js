'use strict';

/**
 * test/workflow.test.js
 * Validates workflow.json and executes its Code nodes (via scripts/simulate.js)
 * against the synthetic fixtures in test/fixtures.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../scripts/simulate');
const { buildWorkflow, serialize } = require('../scripts/build-workflow');

const ROOT = path.resolve(__dirname, '..');
const workflow = S.loadWorkflow();
const node = (name) => {
  const n = workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `missing node ${name}`);
  return n;
};

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test('workflow.json matches a fresh build of src/', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'), serialize(buildWorkflow()), 'run npm run build');
});

test('required nodes are present with the expected types', () => {
  const expected = {
    'Weekly Schedule': 'n8n-nodes-base.scheduleTrigger',
    'Manual Run': 'n8n-nodes-base.manualTrigger',
    'Load Configuration': 'n8n-nodes-base.code',
    'HubSpot Get Deal Pipelines': 'n8n-nodes-base.httpRequest',
    'Build Deal Search': 'n8n-nodes-base.code',
    'HubSpot Search Deals': 'n8n-nodes-base.httpRequest',
    'Compute Velocity Benchmarks': 'n8n-nodes-base.code',
    'Sandbox Mode?': 'n8n-nodes-base.if',
    'Dry-Run Telemetry': 'n8n-nodes-base.code',
    'Format Slack Report': 'n8n-nodes-base.code',
    'Slack Post Benchmark Report': 'n8n-nodes-base.slack',
    'Build Sheet Rows': 'n8n-nodes-base.code',
    'Google Sheets Append Benchmarks': 'n8n-nodes-base.googleSheets',
  };
  Object.entries(expected).forEach(([name, type]) => assert.equal(node(name).type, type, name));
  assert.equal(node('Weekly Schedule').parameters.rule.interval[0].field, 'weeks');
  assert.equal(workflow.active, false);
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length);
});

test('connections are valid and every non-trigger node is reachable', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  const targets = new Set();
  Object.entries(workflow.connections).forEach(([src, v]) => {
    assert.ok(names.has(src), src);
    v.main.forEach((branch) => branch.forEach((c) => (assert.ok(names.has(c.node), c.node), targets.add(c.node))));
  });
  workflow.nodes.filter((n) => !/Trigger$|stickyNote$/.test(n.type)).forEach((n) => assert.ok(targets.has(n.name), `${n.name} unreachable`));
  assert.equal(workflow.connections['Sandbox Mode?'].main[0][0].node, 'Dry-Run Telemetry');
  assert.deepEqual(workflow.connections['Sandbox Mode?'].main[1].map((c) => c.node).sort(), ['Build Sheet Rows', 'Format Slack Report']);
});

test('HubSpot calls are read-only, authenticated by credential, paginated and retried', () => {
  workflow.nodes
    .filter((n) => n.type === 'n8n-nodes-base.httpRequest')
    .forEach((n) => {
      assert.match(n.parameters.url, /^https:\/\/api\.hubapi\.com\/crm\/v3\/(pipelines\/deals|objects\/deals\/search)$/, n.name);
      assert.ok(['GET', 'POST'].includes(n.parameters.method), `${n.name} must not modify CRM data`);
      assert.equal(n.parameters.nodeCredentialType, 'hubspotAppToken');
      assert.equal(n.retryOnFail, true);
    });
  const pagination = node('HubSpot Search Deals').parameters.options.pagination.pagination;
  assert.equal(pagination.limitPagesFetched, true);
  assert.ok(pagination.requestInterval >= 200);
  workflow.nodes
    .filter((n) => n.credentials)
    .forEach((n) =>
      Object.values(n.credentials).forEach((c) => {
        assert.match(c.id, /^REPLACE_WITH_/, n.name);
        assert.match(c.name, /placeholder/i, n.name);
      })
    );
});

// ---------------------------------------------------------------------------
// Code node execution against fixtures
// ---------------------------------------------------------------------------

test('Load Configuration fails fast and tolerates blocked $env', async () => {
  await assert.rejects(() => S.runCodeNode(workflow, 'Load Configuration', [{}], { env: { LOOKBACK_DAYS: 'forever' } }), /LOOKBACK_DAYS/);
  const blocked = await S.runCodeNode(workflow, 'Load Configuration', [{}], { blockEnv: true });
  assert.equal(blocked.output[0].json.sandbox, true);
});

test('Build Deal Search builds the request, ends cleanly without pipelines and stops on API errors', async () => {
  const { output } = await S.runCodeNode(workflow, 'Build Deal Search', [S.fixture('pipelines.json')], { env: S.SIM_ENV });
  const json = output[0].json;
  assert.equal(json.pipelineCount, 2, 'archived pipeline excluded');
  assert.equal(json.stageCount, 12);
  assert.ok(json.searchBody.properties.includes('hs_v2_date_entered_decisionmakerboughtin'));
  assert.equal(json.windowStart, '2025-12-03T00:00:00.000Z');

  const none = await S.runCodeNode(workflow, 'Build Deal Search', [{ results: [] }], { env: S.SIM_ENV });
  assert.deepEqual(none.output, []);
  assert.ok(none.logs.some((l) => l.includes('Nothing to analyse')));

  await assert.rejects(
    () => S.runCodeNode(workflow, 'Build Deal Search', [{ error: { message: 'Unauthorized for ops@example.com' } }], { env: S.SIM_ENV }),
    (err) => /Could not load HubSpot deal pipelines/.test(err.message) && !err.message.includes('ops@example.com')
  );
});

test('sandbox simulation: benchmarks, bottleneck and stalled deals from fixtures, nothing posted', async () => {
  const result = await S.simulate();
  const r = result.report;
  assert.equal(r.status, 'OK');
  assert.equal(r.mode, 'SANDBOX');
  assert.deepEqual(r.totals.skipped, { NO_STAGE_HISTORY: 1, DUPLICATE: 1, PIPELINE_NOT_ANALYZED: 1 });
  assert.equal(r.totals.dataQualityIssues, 1);
  const sales = r.pipelines.find((p) => p.id === 'default');
  const dmbi = sales.stages.find((s) => s.id === 'decisionmakerboughtin');
  assert.equal(dmbi.bottleneck.flagged, true);
  assert.ok(dmbi.bottleneck.reasons.some((x) => x.code === 'SLOW_STAGE'));
  assert.equal(sales.bottlenecks[0].stageId, 'decisionmakerboughtin', 'worst bottleneck first');
  assert.ok(sales.stalledDeals.length >= 6, 'the six planted stalled deals are found');
  assert.ok(sales.stalledDeals.slice(0, 6).every((d) => d.stageId === 'decisionmakerboughtin'));
  assert.ok(result.dryRun.lines.some((l) => l.includes('BOTTLENECK decisionmakerboughtin')));
  assert.deepEqual(result.slackMessages, []);
  assert.deepEqual(result.sheetRows, []);
});

test('live simulation: Slack message and sheet rows are produced', async () => {
  const result = await S.simulate({ env: { SANDBOX_MODE: 'false', ENABLE_GOOGLE_SHEETS: 'true', GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-sheet-id-000000000000' } });
  assert.equal(result.dryRun, null);
  assert.equal(result.slackMessages.length, 1);
  const text = S.slackToText(result.slackMessages[0]);
  assert.match(text, /Deal Stage Velocity Benchmarks · 2026-06-01/);
  assert.match(text, /! Decision maker bought-in/);
  assert.equal(result.sheetRows.length, 8, '5 open stages + 3 open stages');
  assert.ok(result.sheetRows.every((row) => row.run_date === '2026-06-01'));
});

test('delivery toggles: disabled channels produce no items', async () => {
  const result = await S.simulate({ env: { SANDBOX_MODE: 'false', ENABLE_SLACK: 'false', ENABLE_GOOGLE_SHEETS: 'true', GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-sheet-id-000000000000' } });
  assert.deepEqual(result.slackMessages, []);
  assert.equal(result.sheetRows.length, 8);
});

test('HubSpot search errors degrade gracefully', async () => {
  const pages = [S.fixture('deals-page-1.json'), { error: { message: 'Too Many Requests', httpCode: '429' } }];
  const partial = await S.simulate({ dealPages: pages });
  assert.equal(partial.report.status, 'PARTIAL_RATE_LIMITED');
  assert.ok(partial.report.totals.dealsAnalyzed > 0);
  const failed = await S.simulate({ dealPages: [{ error: { message: 'Bad gateway', httpCode: '502' } }] });
  assert.equal(failed.report.status, 'FETCH_ERROR');
  assert.equal(failed.report.totals.dealsAnalyzed, 0);
});

test('Slack formatter reports engine errors instead of failing silently', async () => {
  const { output } = await S.runCodeNode(workflow, 'Format Slack Report', [{ status: 'ENGINE_ERROR', error: 'boom' }], { env: Object.assign({}, S.SIM_ENV, { SANDBOX_MODE: 'false' }) });
  assert.equal(output.length, 1);
  assert.match(output[0].json.text, /run failed: boom/);
});

// ---------------------------------------------------------------------------
// Repository hygiene
// ---------------------------------------------------------------------------

test('repository contains no secrets or non-placeholder email addresses', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      if (['node_modules', '.git', 'coverage'].includes(e.name)) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|json|md|yml)$|^\.env\.example$|^\.gitignore$|^LICENSE$/.test(e.name)) files.push(full);
    });
  })(ROOT);
  assert.ok(files.length >= 12);
  const forbidden = [/pat-(na|eu|ap)\d-[0-9a-f]{8}-/, /xox[abposr]-\d{6,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /ya29\.[A-Za-z0-9_-]{20,}/];
  const allowedEmail = /@([a-z0-9-]+\.)*(example\.(com|org|net)|[a-z0-9-]+\.example)$/i;
  files.forEach((file) => {
    if (file === __filename) return;
    const text = fs.readFileSync(file, 'utf8');
    forbidden.forEach((re) => assert.ok(!re.test(text), `${re} found in ${path.relative(ROOT, file)}`));
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).forEach((a) => assert.match(a, allowedEmail, `email ${a} in ${path.relative(ROOT, file)}`));
  });
});
