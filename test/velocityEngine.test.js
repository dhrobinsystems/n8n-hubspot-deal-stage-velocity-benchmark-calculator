'use strict';

/**
 * test/velocityEngine.test.js
 * Unit tests for src/config.js and src/velocityEngine.js (node:test).
 * All pipelines, stages and deals are synthetic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError, ENV_KEYS, DEFAULTS, isPlaceholder } = require('../src/config');
const E = require('../src/velocityEngine');

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (daysAgo) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const cfg = (overrides) => loadConfig(Object.assign({ AS_OF_DATE: '2026-06-01', HUBSPOT_PORTAL_ID: '12345678' }, overrides || {}));

/** A small three-stage pipeline: A -> B -> C -> Won / Lost. */
const PIPELINE_JSON = {
  results: [
    {
      id: 'p1',
      label: 'Test Pipeline',
      displayOrder: 0,
      stages: [
        { id: 'c', label: 'Stage C', displayOrder: 2, metadata: { isClosed: 'false', probability: '0.6' } },
        { id: 'a', label: 'Stage A', displayOrder: 0, metadata: { isClosed: 'false', probability: '0.2' } },
        { id: 'b', label: 'Stage B', displayOrder: 1, metadata: { isClosed: 'false', probability: '0.4' } },
        { id: 'won', label: 'Won', displayOrder: 3, metadata: { isClosed: 'true', probability: '1.0' } },
        { id: 'lost', label: 'Lost', displayOrder: 4, metadata: { isClosed: 'true', probability: '0.0' } },
        { id: 'old', label: 'Old', displayOrder: 5, archived: true, metadata: { isClosed: 'false' } },
      ],
    },
    { id: 'p2', label: 'Other', displayOrder: 1, stages: [{ id: 'x', label: 'X', displayOrder: 0, metadata: { isClosed: 'false' } }] },
    { id: 'p3', label: 'Archived', archived: true, stages: [{ id: 'y', label: 'Y' }] },
  ],
};

/** Deal factory: stages = [[stageId, enteredDaysAgo, exitedDaysAgo?], ...] */
function deal(id, current, stages, extra) {
  const properties = Object.assign({ pipeline: 'p1', dealstage: current, createdate: iso(stages[0][1]), amount: '10000', hubspot_owner_id: '901' }, extra || {});
  stages.forEach(([stageId, entered, exited]) => {
    properties[`hs_v2_date_entered_${stageId}`] = iso(entered);
    if (exited !== undefined) properties[`hs_v2_date_exited_${stageId}`] = iso(exited);
  });
  return { id: String(id), properties };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('config: safe defaults and every key declared', () => {
  const c = loadConfig({});
  assert.equal(c.sandboxMode, true);
  assert.equal(c.asOf, null);
  assert.equal(c.hubspot.lookbackDays, 180);
  assert.deepEqual(c.hubspot.enteredPrefixes, ['hs_v2_date_entered_', 'hs_date_entered_']);
  assert.equal(c.stall.mode, 'benchmark');
  assert.ok(Object.isFrozen(c.stall));
  Object.keys(DEFAULTS).forEach((k) => assert.ok(ENV_KEYS.includes(k), k));
});

test('config: placeholders count as unset', () => {
  assert.equal(isPlaceholder('{{GOOGLE_SHEETS_DOCUMENT_ID}}'), true);
  assert.equal(isPlaceholder('your-portal-id'), true);
  assert.equal(loadConfig({ HUBSPOT_PORTAL_ID: 'your-portal-id' }).hubspot.portalId, '');
});

test('config: fail fast with every problem reported together', () => {
  assert.throws(
    () =>
      loadConfig({
        SANDBOX_MODE: 'maybe',
        AS_OF_DATE: 'last week',
        LOOKBACK_DAYS: '2',
        DATE_FILTER_PROPERTY: 'dealname',
        STAGE_ENTERED_PREFIXES: 'BadPrefix',
        STALL_THRESHOLD_MODE: 'vibes',
        STALL_BENCHMARK_STAT: 'p99',
        STAGE_THRESHOLD_OVERRIDES_JSON: '{"a": -1}',
        BOTTLENECK_STALL_RATE: '2',
        PIPELINE_IDS: 'ok,bad id',
        GOOGLE_SHEETS_DOCUMENT_ID: 'x',
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      const text = err.problems.join('\n');
      ['SANDBOX_MODE', 'AS_OF_DATE', 'LOOKBACK_DAYS', 'DATE_FILTER_PROPERTY', 'BadPrefix', 'STALL_THRESHOLD_MODE', 'STALL_BENCHMARK_STAT', 'STAGE_THRESHOLD_OVERRIDES_JSON', 'BOTTLENECK_STALL_RATE', 'bad id', 'GOOGLE_SHEETS_DOCUMENT_ID'].forEach(
        (needle) => assert.ok(text.includes(needle), `missing ${needle}`)
      );
      return true;
    }
  );
});

test('config: live mode requires a delivery target; sandbox only warns', () => {
  assert.throws(() => cfg({ SANDBOX_MODE: 'false', SLACK_CHANNEL: '{{SLACK_CHANNEL}}' }), /SLACK_CHANNEL is required/);
  assert.throws(() => cfg({ SANDBOX_MODE: 'false', ENABLE_GOOGLE_SHEETS: 'true' }), /GOOGLE_SHEETS_DOCUMENT_ID is required/);
  assert.throws(() => cfg({ SANDBOX_MODE: 'false', ENABLE_SLACK: 'false' }), /will not be delivered/);
  const sandbox = cfg({ ENABLE_SLACK: 'false' });
  assert.ok(sandbox.warnings.some((w) => w.includes('will not be delivered')));
  const live = cfg({ SANDBOX_MODE: 'false', STAGE_THRESHOLD_OVERRIDES_JSON: '{"a": 10}' });
  assert.equal(live.stall.overrides.a, 10);
  assert.equal(live.asOf, '2026-06-01T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('parseDate, percentile and describe', () => {
  assert.equal(E.parseDate('2026-06-01T00:00:00Z').getTime(), NOW.getTime());
  assert.equal(E.parseDate(String(NOW.getTime())).getTime(), NOW.getTime());
  assert.equal(E.parseDate(NOW).getTime(), NOW.getTime());
  [null, '', 'nope', {}, -1].forEach((v) => assert.equal(E.parseDate(v), null));
  assert.equal(E.percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(E.percentile([10], 90), 10);
  assert.equal(E.percentile([], 50), null);
  assert.equal(E.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9.1);
  assert.deepEqual(E.describe([2, 4, 6, NaN]), { n: 3, mean: 4, median: 4, p75: 5, p90: 5.6, min: 2, max: 6 });
  assert.deepEqual(E.describe([]).n, 0);
});

test('redact removes emails and tokens', () => {
  const out = E.redact('ops@example.com Bearer abc.def pat-na1-0000-1111');
  assert.ok(!out.includes('ops@example.com') && !out.includes('abc.def') && !out.includes('pat-na1-0000'));
});

// ---------------------------------------------------------------------------
// Pipelines and search request
// ---------------------------------------------------------------------------

test('normalizePipelines orders stages, drops archived items and classifies closed stages', () => {
  const pipes = E.normalizePipelines(PIPELINE_JSON, cfg());
  assert.deepEqual(pipes.map((p) => p.id), ['p1', 'p2']);
  assert.deepEqual(pipes[0].stages.map((s) => s.id), ['a', 'b', 'c', 'won', 'lost']);
  const won = pipes[0].stages.find((s) => s.id === 'won');
  const lost = pipes[0].stages.find((s) => s.id === 'lost');
  assert.deepEqual([won.isClosed, won.isWon, won.isLost], [true, true, false]);
  assert.deepEqual([lost.isClosed, lost.isWon, lost.isLost], [true, false, true]);
  assert.deepEqual(E.normalizePipelines(PIPELINE_JSON, cfg({ PIPELINE_IDS: 'p2' })).map((p) => p.id), ['p2']);
  assert.deepEqual(E.normalizePipelines(null, cfg()), []);
  assert.deepEqual(E.normalizePipelines({ results: 'bad' }, cfg()), []);
});

test('buildDealSearchRequest requests every stage timestamp within the look-back window', () => {
  const c = cfg({ PIPELINE_IDS: 'p1', LOOKBACK_DAYS: '90' });
  const pipes = E.normalizePipelines(PIPELINE_JSON, c);
  const req = E.buildDealSearchRequest(pipes, c, NOW);
  assert.equal(req.windowStart, iso(90));
  const filters = req.body.filterGroups[0].filters;
  assert.deepEqual(filters[0], { propertyName: 'createdate', operator: 'GTE', value: String(NOW.getTime() - 90 * DAY) });
  assert.deepEqual(filters[1], { propertyName: 'pipeline', operator: 'IN', values: ['p1'] });
  ['hs_v2_date_entered_a', 'hs_date_entered_c', 'hs_v2_date_exited_b', 'hs_date_exited_won', 'dealstage'].forEach((p) => assert.ok(req.body.properties.includes(p), p));
  assert.ok(!req.body.properties.includes('dealname'), 'deal names are not fetched by default');
  assert.ok(E.buildDealSearchRequest(pipes, cfg({ INCLUDE_DEAL_NAMES: 'true' }), NOW).body.properties.includes('dealname'));
  assert.equal(new Set(req.body.properties).size, req.body.properties.length);
});

test('extractDeals flattens pages and reports errors and rate limits', () => {
  const out = E.extractDeals([
    { json: { results: [{ id: '1', properties: {} }, 'junk'] } },
    { results: [{ id: '2', properties: {} }] },
    { json: { error: { message: 'Too Many Requests', httpCode: '429' } } },
    { id: '3', properties: {} },
    null,
  ]);
  assert.deepEqual(out.deals.map((d) => d.id), ['1', '2', '3']);
  assert.equal(out.errors[0].status, 429);
  assert.equal(out.rateLimited, true);
  assert.deepEqual(E.extractDeals(undefined), { deals: [], errors: [], rateLimited: false });
});

// ---------------------------------------------------------------------------
// Timelines
// ---------------------------------------------------------------------------

test('buildDealTimeline: dwell times, outcomes, open stages and exit timestamps', () => {
  const c = cfg();
  const [p1] = E.normalizePipelines(PIPELINE_JSON, c);

  const won = E.buildDealTimeline(deal(1, 'won', [['a', 30], ['b', 25], ['c', 15], ['won', 10]]), p1, c, NOW);
  assert.deepEqual(won.visits.map((v) => [v.stageId, v.outcome, Math.round(v.dwellDays || 0)]), [
    ['a', 'ADVANCED', 5],
    ['b', 'ADVANCED', 10],
    ['c', 'ADVANCED', 5],
    ['won', 'WON_TERMINAL', 0],
  ]);
  assert.equal(won.isWon, true);

  const lost = E.buildDealTimeline(deal(2, 'lost', [['a', 20], ['lost', 12]]), p1, c, NOW);
  assert.equal(lost.visits[0].outcome, 'LOST');
  assert.equal(lost.isLost, true);

  const open = E.buildDealTimeline(deal(3, 'b', [['a', 20], ['b', 14]]), p1, c, NOW);
  assert.deepEqual([open.visits[1].outcome, Math.round(open.visits[1].dwellDays)], ['OPEN', 14]);
  assert.equal(open.isOpen, true);

  // Explicit exit timestamp wins over the next stage's entry (e.g. a gap between stages).
  const exited = E.buildDealTimeline(deal(4, 'b', [['a', 20, 18], ['b', 10]]), p1, c, NOW);
  assert.equal(Math.round(exited.visits[0].dwellDays), 2);

  // Exit before entry is ignored and counted as a data issue.
  const dirty = E.buildDealTimeline(deal(5, 'b', [['a', 20, 25], ['b', 10]]), p1, c, NOW);
  assert.equal(Math.round(dirty.visits[0].dwellDays), 10);
  assert.deepEqual(dirty.dataIssues, ['EXIT_BEFORE_ENTRY:a']);
});

test('buildDealTimeline: legacy property prefixes and skipped stages', () => {
  const c = cfg();
  const [p1] = E.normalizePipelines(PIPELINE_JSON, c);
  const legacy = { id: '9', properties: { pipeline: 'p1', dealstage: 'c', hs_date_entered_a: iso(10), hs_date_entered_c: iso(4) } };
  const t = E.buildDealTimeline(legacy, p1, c, NOW);
  assert.deepEqual(t.visits.map((v) => [v.stageId, v.nextStageId, v.outcome]), [['a', 'c', 'ADVANCED'], ['c', null, 'OPEN']]);
  assert.equal(Math.round(t.visits[0].dwellDays), 6);
});

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/** 10 completed deals with known dwell times plus stalled and fresh open deals. */
function scenario() {
  const deals = [];
  // Stage A always 2 days, stage B 3..12 days, stage C 4 days.
  for (let i = 0; i < 10; i += 1) {
    const start = 100 + i;
    const bDays = 3 + i;
    deals.push(deal(100 + i, 'won', [['a', start], ['b', start - 2], ['c', start - 2 - bDays], ['won', start - 2 - bDays - 4]]));
  }
  // 4 deals lost from B.
  for (let i = 0; i < 4; i += 1) deals.push(deal(200 + i, 'lost', [['a', 60], ['b', 58], ['lost', 50]]));
  // Open deals in B: 2 stalled (far beyond 2x median), 1 fresh.
  deals.push(deal(300, 'b', [['a', 80], ['b', 78]]));
  deals.push(deal(301, 'b', [['a', 70], ['b', 60]]));
  deals.push(deal(302, 'b', [['a', 5], ['b', 3]]));
  return deals;
}

test('computeBenchmarks: stage stats, conversion, cycle and win rate', () => {
  const c = cfg({ PIPELINE_IDS: 'p1' });
  const pipes = E.normalizePipelines(PIPELINE_JSON, c);
  const report = E.computeBenchmarks(scenario(), pipes, c, NOW, { windowStart: iso(180), runId: 'r1' });
  const p = report.pipelines[0];
  const stage = (id) => p.stages.find((s) => s.id === id);

  assert.equal(report.totals.dealsAnalyzed, 17);
  assert.deepEqual([p.deals, p.won, p.lost, p.open], [17, 10, 4, 3]);
  assert.equal(p.winRate, 0.714);
  assert.equal(stage('a').dwell.median, 2);
  assert.deepEqual([stage('a').entered, stage('a').advanced, stage('a').conversionRate], [17, 17, 1]);
  assert.deepEqual([stage('b').entered, stage('b').advanced, stage('b').lost, stage('b').open], [17, 10, 4, 3]);
  assert.equal(stage('b').conversionRate, 0.714);
  assert.equal(stage('b').dwell.n, 14, '10 advanced + 4 lost; open deals are excluded from completed dwell');
  assert.equal(stage('c').dwell.median, 4);
  assert.equal(stage('won').conversionRate, null, 'closed stages have no conversion rate');
  assert.equal(p.cycle.n, 10);
  assert.equal(p.cycle.median, 13.5);
  const ab = p.transitions.find((t) => t.from === 'a' && t.to === 'b');
  assert.deepEqual([ab.n, ab.median], [17, 2]);
  assert.ok(p.transitions.find((t) => t.from === 'b' && t.to === 'lost'));
});

test('computeBenchmarks: stalled deals use the stage benchmark threshold', () => {
  const c = cfg({ PIPELINE_IDS: 'p1' });
  const report = E.computeBenchmarks(scenario(), E.normalizePipelines(PIPELINE_JSON, c), c, NOW);
  const p = report.pipelines[0];
  const b = p.stages.find((s) => s.id === 'b');
  assert.match(b.thresholdSource, /^BENCHMARK_MEDIAN_X2$/);
  assert.equal(b.stallThresholdDays, Math.max(7, b.dwell.median * 2));
  assert.deepEqual(p.stalledDeals.map((d) => d.dealId), ['300', '301']);
  assert.equal(p.stalledDeals[0].url, 'https://app.hubspot.com/contacts/12345678/record/0-3/300');
  assert.equal(p.stalledDeals[0].ownerId, '901');
  assert.equal('dealName' in p.stalledDeals[0], false);
  assert.equal(b.stalled, 2);
  assert.equal(report.totals.stalledDeals, 2);
});

test('computeBenchmarks: fixed, override and fallback thresholds', () => {
  const pipesFor = (c) => E.normalizePipelines(PIPELINE_JSON, c);
  const fixed = cfg({ PIPELINE_IDS: 'p1', STALL_THRESHOLD_MODE: 'fixed', STALL_THRESHOLD_DAYS: '2' });
  const fixedReport = E.computeBenchmarks(scenario(), pipesFor(fixed), fixed, NOW).pipelines[0];
  assert.equal(fixedReport.stages.find((s) => s.id === 'b').thresholdSource, 'FIXED');
  assert.equal(fixedReport.stalledDeals.length, 3);

  const override = cfg({ PIPELINE_IDS: 'p1', STAGE_THRESHOLD_OVERRIDES_JSON: '{"b": 100}' });
  const overrideReport = E.computeBenchmarks(scenario(), pipesFor(override), override, NOW).pipelines[0];
  assert.equal(overrideReport.stages.find((s) => s.id === 'b').thresholdSource, 'OVERRIDE');
  assert.equal(overrideReport.stalledDeals.length, 0);

  const sparse = cfg({ PIPELINE_IDS: 'p1', MIN_SAMPLE_SIZE: '50' });
  const sparseReport = E.computeBenchmarks(scenario(), pipesFor(sparse), sparse, NOW).pipelines[0];
  assert.equal(sparseReport.stages.find((s) => s.id === 'b').thresholdSource, 'FALLBACK_FIXED');
});

test('computeBenchmarks: bottleneck detection', () => {
  const c = cfg({ PIPELINE_IDS: 'p1', BOTTLENECK_MIN_CONVERSION: '0.8' });
  const p = E.computeBenchmarks(scenario(), E.normalizePipelines(PIPELINE_JSON, c), c, NOW).pipelines[0];
  const b = p.stages.find((s) => s.id === 'b');
  const codes = b.bottleneck.reasons.map((r) => r.code).sort();
  assert.deepEqual(codes, ['HIGH_STALL_RATE', 'LOW_CONVERSION', 'SLOW_STAGE']);
  assert.equal(p.bottlenecks[0].stageId, 'b');
  assert.equal(p.stages.find((s) => s.id === 'a').bottleneck.flagged, false);

  const strict = cfg({ PIPELINE_IDS: 'p1', BOTTLENECK_DWELL_MULTIPLIER: '10', BOTTLENECK_STALL_RATE: '1', BOTTLENECK_MIN_CONVERSION: '0' });
  const none = E.computeBenchmarks(scenario(), E.normalizePipelines(PIPELINE_JSON, strict), strict, NOW).pipelines[0];
  assert.equal(none.bottlenecks.length, 0);
});

test('computeBenchmarks: skips invalid, duplicate, foreign-pipeline and history-less deals', () => {
  const c = cfg();
  const pipes = E.normalizePipelines(PIPELINE_JSON, c);
  const good = deal(1, 'b', [['a', 10], ['b', 5]]);
  const report = E.computeBenchmarks(
    [good, good, null, { id: '2' }, { id: '3', properties: { pipeline: 'unknown' } }, { id: '4', properties: { pipeline: 'p1', dealstage: 'a' } }],
    pipes,
    c,
    NOW
  );
  assert.equal(report.totals.dealsAnalyzed, 1);
  assert.deepEqual(report.totals.skipped, { DUPLICATE: 1, INVALID_DEAL: 2, PIPELINE_NOT_ANALYZED: 1, NO_STAGE_HISTORY: 1 });
});

test('computeBenchmarks: empty input and pipelines without deals', () => {
  const c = cfg();
  const report = E.computeBenchmarks([], E.normalizePipelines(PIPELINE_JSON, c), c, NOW);
  assert.equal(report.totals.dealsAnalyzed, 0);
  assert.equal(report.pipelines[0].winRate, null);
  assert.equal(report.pipelines[0].stages[0].dwell.median, null);
  assert.deepEqual(E.computeBenchmarks(null, null, c, NOW).pipelines, []);
});

test('computeBenchmarks: deal names only when INCLUDE_DEAL_NAMES=true', () => {
  const c = cfg({ PIPELINE_IDS: 'p1', INCLUDE_DEAL_NAMES: 'true' });
  const deals = scenario();
  deals.find((d) => d.id === '300').properties.dealname = 'Synthetic deal 300';
  const p = E.computeBenchmarks(deals, E.normalizePipelines(PIPELINE_JSON, c), c, NOW).pipelines[0];
  assert.equal(p.stalledDeals[0].dealName, 'Synthetic deal 300');
});

// ---------------------------------------------------------------------------
// Delivery formats
// ---------------------------------------------------------------------------

test('buildSlackMessages: valid Block Kit within Slack limits, escaped, with links', () => {
  const c = cfg({ PIPELINE_IDS: 'p1', MAX_STALLED_IN_REPORT: '1' });
  const json = JSON.parse(JSON.stringify(PIPELINE_JSON));
  json.results[0].label = 'Pipeline <script> & co';
  const report = E.computeBenchmarks(scenario(), E.normalizePipelines(json, c), c, NOW);
  const messages = E.buildSlackMessages(report, c);
  assert.equal(messages.length, 1);
  const m = messages[0];
  assert.equal(m.channel, '#revops-reports');
  assert.deepEqual(JSON.parse(m.blocksJson).blocks, m.blocks);
  assert.ok(m.blocks.length <= 50);
  const text = JSON.stringify(m.blocks);
  assert.ok(text.includes('Pipeline &lt;script&gt; &amp; co'));
  assert.ok(text.includes('<https://app.hubspot.com/contacts/12345678/record/0-3/300|Deal 300>'));
  assert.ok(text.includes('and 1 more'));
  m.blocks.filter((b) => b.type === 'section').forEach((b) => assert.ok(b.text.text.length <= 3000));
});

test('buildSlackMessages: splits very large reports into several messages', () => {
  const c = cfg();
  const many = { results: Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, label: `P${i}`, stages: [{ id: `s${i}`, label: 'S', metadata: { isClosed: 'false' } }] })) };
  const pipes = E.normalizePipelines(many, c);
  const deals = pipes.map((p, i) => ({ id: String(i), properties: { pipeline: p.id, dealstage: p.stages[0].id, [`hs_v2_date_entered_${p.stages[0].id}`]: iso(3) } }));
  const messages = E.buildSlackMessages(E.computeBenchmarks(deals, pipes, c, NOW), c);
  assert.ok(messages.length >= 2);
  messages.forEach((m) => assert.ok(m.blocks.length <= 50));
  assert.match(messages[1].text, /continued/);
});

test('buildSheetRows and buildDryRunReport', () => {
  const c = cfg({ PIPELINE_IDS: 'p1' });
  const report = E.computeBenchmarks(scenario(), E.normalizePipelines(PIPELINE_JSON, c), c, NOW, { windowStart: iso(180) });
  const rows = E.buildSheetRows(report);
  assert.deepEqual(rows.map((r) => r.stage_id), ['a', 'b', 'c'], 'closed stages are not rows');
  const b = rows.find((r) => r.stage_id === 'b');
  assert.equal(b.run_date, '2026-06-01');
  assert.equal(b.window_start, '2025-12-03');
  assert.equal(b.bottleneck, 'YES');
  assert.equal(b.stalled, 2);
  Object.values(b).forEach((v) => assert.ok(v !== null && v !== undefined, 'no null cells'));

  const dry = E.buildDryRunReport(report, c);
  assert.equal(dry.kind, 'dry_run_report');
  assert.equal(dry.wouldPostSlackMessages, 1);
  assert.equal(dry.wouldAppendSheetRows, 0, 'sheets disabled by default');
  assert.ok(dry.lines.some((l) => l.includes('BOTTLENECK b')));
});
