'use strict';

/**
 * src/velocityEngine.js
 * ---------------------------------------------------------------------------
 * Deal-stage velocity benchmarks for HubSpot pipelines.
 *
 *   GET /crm/v3/pipelines/deals ──► normalizePipelines()
 *                                     │
 *                                     ▼
 *                              buildDealSearchRequest()   (requests every stage's
 *                                     │                    entered / exited timestamp)
 *   POST /crm/v3/objects/deals/search ──► extractDeals()
 *                                     │
 *                                     ▼
 *                              computeBenchmarks()
 *                                ├─ buildDealTimeline()  per deal: stage visits in time order
 *                                ├─ stage dwell stats    mean / median / p75 / p90 per stage
 *                                ├─ transition stats     stage A -> next stage B durations
 *                                ├─ stall detection      open deals over a benchmark threshold
 *                                └─ bottleneck flags     slow, stall-prone or low-converting stages
 *                                     │
 *                                     ▼
 *                 buildSlackMessages() / buildSheetRows() / buildDryRunReport()
 *
 * Zero dependencies, no require(): inlined into n8n Code nodes at build time.
 * Read-only analytics: nothing here writes to HubSpot.
 * Cross-realm safe (n8n runs Code nodes in a separate VM context): no instanceof.
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. The user is
 * responsible for CRM data integrity, API rate limits and compliance with
 * third-party terms of service. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const ENGINE_VERSION = '1.0.0';
const DAY_MS = 24 * 60 * 60 * 1000;
const SLACK_MAX_BLOCKS = 48;
const SLACK_TEXT_MAX = 2900;

const SKIP_REASONS = Object.freeze({
  INVALID_DEAL: 'INVALID_DEAL',
  DUPLICATE: 'DUPLICATE',
  PIPELINE_NOT_ANALYZED: 'PIPELINE_NOT_ANALYZED',
  NO_STAGE_HISTORY: 'NO_STAGE_HISTORY',
});

const BOTTLENECK_REASONS = Object.freeze({
  SLOW_STAGE: 'SLOW_STAGE',
  HIGH_STALL_RATE: 'HIGH_STALL_RATE',
  LOW_CONVERSION: 'LOW_CONVERSION',
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDate(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** Parse ISO strings, epoch-millisecond strings/numbers and Date objects. */
function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (isDate(value)) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? new Date(value) : null;
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^\d{12,13}$/.test(t)) return new Date(Number(t));
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

function round(value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = Math.pow(10, decimals === undefined ? 1 : decimals);
  return Math.round(value * f) / f;
}

function days(fromDate, toDate) {
  return (toDate.getTime() - fromDate.getTime()) / DAY_MS;
}

/** Linear-interpolated percentile (p in 0..100) of an unsorted numeric array. */
function percentile(values, p) {
  const list = (values || []).filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const rank = (p / 100) * (list.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return list[low] + (list[high] - list[low]) * (rank - low);
}

/** Summary statistics in days, rounded to 1 decimal. */
function describe(values) {
  const list = (values || []).filter((v) => Number.isFinite(v));
  if (list.length === 0) return { n: 0, mean: null, median: null, p75: null, p90: null, min: null, max: null };
  const sum = list.reduce((a, b) => a + b, 0);
  return {
    n: list.length,
    mean: round(sum / list.length),
    median: round(percentile(list, 50)),
    p75: round(percentile(list, 75)),
    p90: round(percentile(list, 90)),
    min: round(Math.min.apply(null, list)),
    max: round(Math.max.apply(null, list)),
  };
}

/** Strip emails, bearer tokens and HubSpot private-app tokens from free text. */
function redact(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted-token]')
    .replace(/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]+/g, '[redacted-token]');
}

function escapeSlack(value) {
  return String(value === undefined || value === null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// ---------------------------------------------------------------------------
// Pipelines and search request
// ---------------------------------------------------------------------------

/**
 * Normalize GET /crm/v3/pipelines/deals into ordered pipelines and stages.
 * A stage is closed when metadata.isClosed is "true"; won when it is closed with
 * probability 1 (HubSpot's default Closed Won), otherwise closed lost.
 */
function normalizePipelines(json, config) {
  const results = isPlainObject(json) && Array.isArray(json.results) ? json.results : Array.isArray(json) ? json : [];
  const wanted = (config && config.hubspot && config.hubspot.pipelineIds) || [];
  return results
    .filter((p) => isPlainObject(p) && p.id !== undefined && !p.archived)
    .filter((p) => wanted.length === 0 || wanted.indexOf(String(p.id)) !== -1)
    .map((p) => {
      const stages = (Array.isArray(p.stages) ? p.stages : [])
        .filter((s) => isPlainObject(s) && s.id !== undefined && !s.archived)
        .map((s, index) => {
          const meta = isPlainObject(s.metadata) ? s.metadata : {};
          const isClosed = String(meta.isClosed).toLowerCase() === 'true';
          const probability = Number(meta.probability);
          return {
            id: String(s.id),
            label: String(s.label || s.id),
            order: Number.isFinite(Number(s.displayOrder)) ? Number(s.displayOrder) : index,
            isClosed,
            isWon: isClosed && probability === 1,
            isLost: isClosed && probability !== 1,
          };
        })
        .sort((a, b) => a.order - b.order);
      return { id: String(p.id), label: String(p.label || p.id), order: Number(p.displayOrder) || 0, stages };
    })
    .filter((p) => p.stages.length > 0)
    .sort((a, b) => a.order - b.order);
}

/** Every stage timestamp property to request for the given pipelines. */
function stageTimestampProperties(pipelines, config) {
  const props = [];
  pipelines.forEach((p) =>
    p.stages.forEach((s) => {
      config.hubspot.enteredPrefixes.forEach((prefix) => props.push(prefix + s.id));
      config.hubspot.exitedPrefixes.forEach((prefix) => props.push(prefix + s.id));
    })
  );
  return props;
}

/** Body for POST /crm/v3/objects/deals/search (deals in the look-back window). */
function buildDealSearchRequest(pipelines, config, now) {
  const at = parseDate(now) || new Date();
  const windowStart = new Date(at.getTime() - config.hubspot.lookbackDays * DAY_MS);
  const filters = [{ propertyName: config.hubspot.dateFilterProperty, operator: 'GTE', value: String(windowStart.getTime()) }];
  if (config.hubspot.pipelineIds.length > 0) {
    filters.push({ propertyName: 'pipeline', operator: 'IN', values: config.hubspot.pipelineIds.slice() });
  }
  const base = ['dealstage', 'pipeline', 'createdate', 'closedate', 'hs_lastmodifieddate', 'amount', 'hubspot_owner_id', 'hs_is_closed', 'hs_is_closed_won'];
  if (config.report.includeDealNames) base.push('dealname');
  const properties = base.concat(stageTimestampProperties(pipelines, config)).filter((v, i, all) => all.indexOf(v) === i);
  return {
    windowStart: windowStart.toISOString(),
    body: {
      filterGroups: [{ filters }],
      sorts: [{ propertyName: config.hubspot.dateFilterProperty, direction: 'ASCENDING' }],
      properties,
      limit: config.hubspot.searchPageSize,
    },
  };
}

function describeFetchError(errorValue) {
  const err = isPlainObject(errorValue) ? errorValue : { message: String(errorValue) };
  const status = Number(err.httpCode || err.statusCode || err.status) || null;
  const message = redact(truncate(err.message || err.description || 'Unknown HubSpot error', 300));
  return { status, message, rateLimited: status === 429 || /\b429\b|rate.?limit|too many requests/i.test(message) };
}

/** Flatten paginated search responses (and n8n error items) into deals. */
function extractDeals(items) {
  const deals = [];
  const errors = [];
  (Array.isArray(items) ? items : []).forEach((raw) => {
    const item = isPlainObject(raw) && isPlainObject(raw.json) ? raw.json : raw;
    if (!isPlainObject(item)) return;
    if (item.error) {
      errors.push(describeFetchError(item.error));
      return;
    }
    if (Array.isArray(item.results)) item.results.forEach((d) => isPlainObject(d) && deals.push(d));
    else if (item.id !== undefined && isPlainObject(item.properties)) deals.push(item);
  });
  return { deals, errors, rateLimited: errors.some((e) => e.rateLimited) };
}

// ---------------------------------------------------------------------------
// Per-deal timeline
// ---------------------------------------------------------------------------

function firstTimestamp(props, prefixes, stageId) {
  for (const prefix of prefixes) {
    const d = parseDate(props[prefix + stageId]);
    if (d) return d;
  }
  return null;
}

/**
 * Build a deal's stage visits in chronological order.
 * Each visit: { stageId, enteredAt, exitedAt, dwellDays, outcome, nextStageId }
 * outcome: ADVANCED | LOST | WON_TERMINAL | LOST_TERMINAL | OPEN | UNKNOWN
 */
function buildDealTimeline(deal, pipeline, config, now) {
  const props = isPlainObject(deal.properties) ? deal.properties : {};
  const currentStageId = props.dealstage ? String(props.dealstage) : null;
  const byId = {};
  pipeline.stages.forEach((s) => (byId[s.id] = s));
  const dataIssues = [];

  const visits = pipeline.stages
    .map((stage) => ({
      stage,
      enteredAt: firstTimestamp(props, config.hubspot.enteredPrefixes, stage.id),
      exitedAt: firstTimestamp(props, config.hubspot.exitedPrefixes, stage.id),
    }))
    .filter((v) => v.enteredAt)
    .sort((a, b) => a.enteredAt - b.enteredAt || a.stage.order - b.stage.order);

  const out = visits.map((visit, i) => {
    const next = visits[i + 1] || null;
    const stage = visit.stage;
    const result = { stageId: stage.id, enteredAt: visit.enteredAt, exitedAt: null, dwellDays: null, outcome: 'UNKNOWN', nextStageId: next ? next.stage.id : null };

    if (stage.isClosed) {
      result.outcome = stage.isWon ? 'WON_TERMINAL' : 'LOST_TERMINAL';
      return result;
    }
    let exit = visit.exitedAt && visit.exitedAt >= visit.enteredAt ? visit.exitedAt : null;
    if (visit.exitedAt && visit.exitedAt < visit.enteredAt) dataIssues.push(`EXIT_BEFORE_ENTRY:${stage.id}`);
    if (!exit && next) exit = next.enteredAt;

    if (next) {
      result.exitedAt = exit;
      result.dwellDays = days(visit.enteredAt, exit);
      result.outcome = next.stage.isLost ? 'LOST' : 'ADVANCED';
    } else if (currentStageId === stage.id && !byId[stage.id].isClosed) {
      result.outcome = 'OPEN';
      result.dwellDays = Math.max(0, days(visit.enteredAt, now));
    } else if (exit) {
      // Left the stage, but the destination is outside this pipeline's history.
      result.exitedAt = exit;
      result.dwellDays = days(visit.enteredAt, exit);
    }
    return result;
  });

  const currentStage = currentStageId ? byId[currentStageId] : null;
  return {
    visits: out,
    currentStageId,
    currentStage: currentStage || null,
    isOpen: currentStage ? !currentStage.isClosed : String(props.hs_is_closed).toLowerCase() !== 'true',
    isWon: currentStage ? currentStage.isWon : String(props.hs_is_closed_won).toLowerCase() === 'true',
    isLost: currentStage ? currentStage.isLost : false,
    dataIssues,
  };
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

function stallThreshold(stageStats, stageId, config) {
  const s = config.stall;
  if (s.overrides && s.overrides[stageId]) return { days: s.overrides[stageId], source: 'OVERRIDE' };
  if (s.mode === 'fixed') return { days: s.fixedDays, source: 'FIXED' };
  const benchmark = stageStats.dwell[s.stat];
  if (stageStats.dwell.n >= config.analysis.minSampleSize && Number.isFinite(benchmark)) {
    return { days: round(Math.max(s.minDays, benchmark * s.multiplier)), source: `BENCHMARK_${s.stat.toUpperCase()}_X${s.multiplier}` };
  }
  return { days: Math.max(s.minDays, s.fixedDays), source: 'FALLBACK_FIXED' };
}

function dealUrl(dealId, config) {
  if (!config.hubspot.portalId) return null;
  return `${config.hubspot.appBaseUrl}/contacts/${config.hubspot.portalId}/record/0-3/${encodeURIComponent(dealId)}`;
}

/**
 * Compute stage velocity benchmarks, stalled deals and bottlenecks.
 * @param {object[]} rawDeals HubSpot deal objects from the search API.
 * @param {object[]} pipelines Output of normalizePipelines().
 * @param {object} config From loadConfig().
 * @param {Date|string} [nowInput]
 * @param {{ windowStart?: string, fetchErrors?: object[], runId?: string }} [meta]
 */
function computeBenchmarks(rawDeals, pipelines, config, nowInput, meta) {
  const info = meta || {};
  const now = parseDate(nowInput) || new Date();
  const pipelineById = {};
  (pipelines || []).forEach((p) => (pipelineById[p.id] = p));
  const skipped = {};
  const skip = (reason) => (skipped[reason] = (skipped[reason] || 0) + 1);
  const seen = {};
  let dataQualityIssues = 0;

  // Accumulators per pipeline / stage.
  const acc = {};
  (pipelines || []).forEach((p) => {
    acc[p.id] = {
      deals: 0, open: 0, won: 0, lost: 0, cycleDays: [],
      stages: {}, transitions: {}, openDeals: [],
    };
    p.stages.forEach((s) => (acc[p.id].stages[s.id] = { entered: 0, advanced: 0, lost: 0, open: 0, dwell: [], openDwell: [] }));
  });

  let analyzed = 0;
  (Array.isArray(rawDeals) ? rawDeals : []).forEach((deal) => {
    if (!isPlainObject(deal) || deal.id === undefined || !isPlainObject(deal.properties)) return skip(SKIP_REASONS.INVALID_DEAL);
    const id = String(deal.id);
    if (seen[id]) return skip(SKIP_REASONS.DUPLICATE);
    seen[id] = true;
    const pipeline = pipelineById[String(deal.properties.pipeline || '')];
    if (!pipeline) return skip(SKIP_REASONS.PIPELINE_NOT_ANALYZED);

    const timeline = buildDealTimeline(deal, pipeline, config, now);
    if (timeline.visits.length === 0) return skip(SKIP_REASONS.NO_STAGE_HISTORY);
    analyzed += 1;
    dataQualityIssues += timeline.dataIssues.length;

    const a = acc[pipeline.id];
    a.deals += 1;
    if (timeline.isWon) a.won += 1;
    else if (timeline.isLost) a.lost += 1;
    else if (timeline.isOpen) a.open += 1;

    if (timeline.isWon) {
      const created = parseDate(deal.properties.createdate);
      const wonVisit = timeline.visits.find((v) => v.outcome === 'WON_TERMINAL');
      const closed = (wonVisit && wonVisit.enteredAt) || parseDate(deal.properties.closedate);
      if (created && closed && closed >= created) a.cycleDays.push(days(created, closed));
      else dataQualityIssues += 1;
    }

    timeline.visits.forEach((visit, i) => {
      const st = a.stages[visit.stageId];
      st.entered += 1;
      if (visit.outcome === 'ADVANCED') st.advanced += 1;
      if (visit.outcome === 'LOST') st.lost += 1;
      if (visit.outcome === 'OPEN') {
        st.open += 1;
        st.openDwell.push(visit.dwellDays);
        a.openDeals.push({ deal, stageId: visit.stageId, dwellDays: visit.dwellDays, enteredAt: visit.enteredAt });
      } else if (Number.isFinite(visit.dwellDays)) {
        st.dwell.push(visit.dwellDays);
      }
      const next = timeline.visits[i + 1];
      if (next && !pipeline.stages.find((s) => s.id === visit.stageId).isClosed) {
        const key = `${visit.stageId}>${next.stageId}`;
        if (!a.transitions[key]) a.transitions[key] = { from: visit.stageId, to: next.stageId, durations: [] };
        const d = days(visit.enteredAt, next.enteredAt);
        if (d >= 0) a.transitions[key].durations.push(d);
        else dataQualityIssues += 1;
      }
    });
  });

  let totalStalled = 0;
  const pipelineReports = (pipelines || []).map((p) => {
    const a = acc[p.id];
    const stageReports = p.stages.map((s) => {
      const st = a.stages[s.id];
      const resolved = st.advanced + st.lost;
      const report = {
        id: s.id,
        label: s.label,
        order: s.order,
        isClosed: s.isClosed,
        isWon: s.isWon,
        entered: st.entered,
        advanced: st.advanced,
        lost: st.lost,
        open: st.open,
        conversionRate: !s.isClosed && resolved > 0 ? round(st.advanced / resolved, 3) : null,
        dwell: describe(st.dwell),
        openDwell: describe(st.openDwell),
        stalled: 0,
        stallThresholdDays: null,
        thresholdSource: null,
        bottleneck: { flagged: false, reasons: [], score: 0 },
      };
      if (!s.isClosed) {
        const t = stallThreshold(report, s.id, config);
        report.stallThresholdDays = t.days;
        report.thresholdSource = t.source;
      }
      return report;
    });
    const stageById = {};
    stageReports.forEach((s) => (stageById[s.id] = s));

    // Stalled deals.
    const stalledDeals = a.openDeals
      .filter((o) => {
        const s = stageById[o.stageId];
        return s && !s.isClosed && Number.isFinite(s.stallThresholdDays) && o.dwellDays > s.stallThresholdDays;
      })
      .map((o) => {
        const s = stageById[o.stageId];
        s.stalled += 1;
        const props = o.deal.properties;
        const amount = Number(props.amount);
        const entry = {
          dealId: String(o.deal.id),
          pipelineId: p.id,
          stageId: s.id,
          stageLabel: s.label,
          daysInStage: round(o.dwellDays),
          thresholdDays: s.stallThresholdDays,
          overByRatio: round(o.dwellDays / s.stallThresholdDays, 2),
          ownerId: props.hubspot_owner_id ? String(props.hubspot_owner_id) : null,
          amount: Number.isFinite(amount) ? amount : null,
          enteredStageAt: o.enteredAt.toISOString(),
          url: dealUrl(o.deal.id, config),
        };
        if (config.report.includeDealNames) entry.dealName = truncate(props.dealname || '', 120) || null;
        return entry;
      })
      .sort((x, y) => y.overByRatio - x.overByRatio || y.daysInStage - x.daysInStage);
    totalStalled += stalledDeals.length;

    // Bottlenecks: compare each open stage against the pipeline baseline.
    const openStages = stageReports.filter((s) => !s.isClosed);
    openStages.forEach((s) => {
      const reasons = [];
      const peers = openStages.filter((o) => o.id !== s.id && o.dwell.n >= config.analysis.minSampleSize && Number.isFinite(o.dwell.median));
      const baseline = percentile(peers.map((o) => o.dwell.median), 50);
      if (s.dwell.n >= config.analysis.minSampleSize && Number.isFinite(baseline) && baseline > 0 && s.dwell.median >= baseline * config.analysis.bottleneckDwellMultiplier) {
        reasons.push({ code: BOTTLENECK_REASONS.SLOW_STAGE, detail: `median ${s.dwell.median}d vs pipeline baseline ${round(baseline)}d` });
      }
      if (s.open >= 3 && s.stalled / s.open >= config.analysis.bottleneckStallRate) {
        reasons.push({ code: BOTTLENECK_REASONS.HIGH_STALL_RATE, detail: `${s.stalled} of ${s.open} open deals stalled, ${Math.round((s.stalled / s.open) * 100)}%` });
      }
      const resolved = s.advanced + s.lost;
      if (resolved >= config.analysis.minSampleSize && s.conversionRate !== null && s.conversionRate < config.analysis.bottleneckMinConversion) {
        reasons.push({ code: BOTTLENECK_REASONS.LOW_CONVERSION, detail: `${Math.round(s.conversionRate * 100)}% advance, ${s.advanced} of ${resolved}` });
      }
      s.bottleneck = { flagged: reasons.length > 0, reasons, score: reasons.length };
    });

    const transitions = Object.keys(a.transitions)
      .map((k) => {
        const t = a.transitions[k];
        const stats = describe(t.durations);
        return { from: t.from, to: t.to, fromLabel: (stageById[t.from] || {}).label || t.from, toLabel: (stageById[t.to] || {}).label || t.to, n: stats.n, mean: stats.mean, median: stats.median, p90: stats.p90 };
      })
      .filter((t) => t.n > 0)
      .sort((x, y) => ((stageById[x.from] || {}).order - (stageById[y.from] || {}).order) || y.n - x.n);

    const closedDeals = a.won + a.lost;
    return {
      id: p.id,
      label: p.label,
      deals: a.deals,
      open: a.open,
      won: a.won,
      lost: a.lost,
      winRate: closedDeals > 0 ? round(a.won / closedDeals, 3) : null,
      cycle: describe(a.cycleDays),
      stages: stageReports,
      transitions,
      bottlenecks: openStages
        .filter((s) => s.bottleneck.flagged)
        .sort((x, y) => y.bottleneck.score - x.bottleneck.score || (y.dwell.median || 0) - (x.dwell.median || 0))
        .map((s) => ({ stageId: s.id, stageLabel: s.label, reasons: s.bottleneck.reasons })),
      stalledDeals,
    };
  });

  return {
    kind: 'benchmark_report',
    engineVersion: ENGINE_VERSION,
    runId: info.runId || null,
    generatedAt: now.toISOString(),
    mode: config.sandboxMode ? 'SANDBOX' : 'LIVE',
    window: { lookbackDays: config.hubspot.lookbackDays, start: info.windowStart || null, dateProperty: config.hubspot.dateFilterProperty },
    settings: {
      stallMode: config.stall.mode,
      stallStat: config.stall.stat,
      stallMultiplier: config.stall.multiplier,
      minSampleSize: config.analysis.minSampleSize,
    },
    totals: {
      dealsFetched: Array.isArray(rawDeals) ? rawDeals.length : 0,
      dealsAnalyzed: analyzed,
      skipped,
      dataQualityIssues,
      stalledDeals: totalStalled,
      bottlenecks: pipelineReports.reduce((n, p) => n + p.bottlenecks.length, 0),
    },
    fetchErrors: (info.fetchErrors || []).map((e) => ({ status: e.status || null, rateLimited: Boolean(e.rateLimited), message: redact(e.message) })),
    warnings: (config.warnings || []).map(redact),
    pipelines: pipelineReports,
  };
}

// ---------------------------------------------------------------------------
// Delivery formats
// ---------------------------------------------------------------------------

function fmtDays(v) {
  return Number.isFinite(v) ? `${v}d` : '–';
}

function fmtPct(v) {
  return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–';
}

function pad(text, width, right) {
  const t = String(text);
  if (t.length >= width) return t.slice(0, width);
  return right ? ' '.repeat(width - t.length) + t : t + ' '.repeat(width - t.length);
}

/** Monospaced stage table for Slack code blocks and logs. */
function stageTable(pipeline) {
  const header = `${pad('Stage', 28)} ${pad('In', 5, true)} ${pad('Adv%', 5, true)} ${pad('Median', 7, true)} ${pad('P90', 7, true)} ${pad('Open', 5, true)} ${pad('Stall', 5, true)}`;
  const rows = pipeline.stages
    .filter((s) => !s.isClosed)
    .map((s) => `${pad((s.bottleneck.flagged ? '! ' : '  ') + s.label, 28)} ${pad(s.entered, 5, true)} ${pad(fmtPct(s.conversionRate), 5, true)} ${pad(fmtDays(s.dwell.median), 7, true)} ${pad(fmtDays(s.dwell.p90), 7, true)} ${pad(s.open, 5, true)} ${pad(s.stalled, 5, true)}`);
  return [header, '-'.repeat(header.length)].concat(rows).join('\n');
}

/**
 * Slack Block Kit messages (split so each stays under Slack's 50-block limit).
 * @returns {{ channel: string, text: string, blocks: object[], blocksJson: string }[]}
 */
function buildSlackMessages(report, config) {
  const date = String(report.generatedAt || '').slice(0, 10);
  const t = report.totals;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 Deal Stage Velocity Benchmarks · ${date}`, emoji: true } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${t.dealsAnalyzed} deals analysed · last ${report.window.lookbackDays} days by \`${report.window.dateProperty}\` · ${t.stalledDeals} stalled · ${t.bottlenecks} bottleneck stage(s)${report.mode === 'SANDBOX' ? ' · SANDBOX' : ''}`,
        },
      ],
    },
  ];
  if (report.fetchErrors.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:warning: ${report.fetchErrors.length} HubSpot request(s) failed; results may be incomplete.` } });
  }

  report.pipelines.forEach((p) => {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: truncate(`*${escapeSlack(p.label)}* · ${p.deals} deals · ${p.open} open · win rate ${fmtPct(p.winRate)} · median cycle ${fmtDays(p.cycle.median)} (n=${p.cycle.n})`, SLACK_TEXT_MAX),
      },
    });
    if (p.deals > 0) {
      // Keep whole table lines (and their alignment) within Slack's section limit.
      let table = '';
      stageTable(p)
        .split('\n')
        .forEach((line) => {
          if (table.length + line.length + 1 <= SLACK_TEXT_MAX - 6) table += (table ? '\n' : '') + line;
        });
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + escapeSlack(table) + '```' } });
    }
    if (p.bottlenecks.length > 0) {
      const lines = p.bottlenecks.map(
        (b) => `• *${escapeSlack(b.stageLabel)}*: ${b.reasons.map((r) => `${r.code.replace(/_/g, ' ').toLowerCase()} (${escapeSlack(r.detail)})`).join('; ')}`
      );
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: (':rotating_light: *Bottlenecks*\n' + lines.join('\n')).slice(0, SLACK_TEXT_MAX) } });
    }
    const top = p.stalledDeals.slice(0, config.report.maxStalled);
    if (top.length > 0) {
      const lines = top.map((d) => {
        const name = d.dealName ? escapeSlack(d.dealName) : `Deal ${d.dealId}`;
        const label = d.url ? `<${d.url}|${name}>` : name;
        return `• ${label}: ${d.daysInStage}d in ${escapeSlack(d.stageLabel)} (threshold ${d.thresholdDays}d)${d.ownerId ? ` · owner ${d.ownerId}` : ''}`;
      });
      const more = p.stalledDeals.length > top.length ? `\n_…and ${p.stalledDeals.length - top.length} more_` : '';
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: (`:hourglass: *Stalled deals* (${p.stalledDeals.length})\n` + lines.join('\n')).slice(0, SLACK_TEXT_MAX - more.length) + more } });
    }
  });

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Stall threshold: ${report.settings.stallMode === 'fixed' ? 'fixed days' : `${report.settings.stallMultiplier}× stage ${report.settings.stallStat}`} · "!" marks a bottleneck stage · hubspot-deal-stage-velocity-benchmark-calculator v${ENGINE_VERSION}` }] });

  // Split into Slack-sized messages.
  const messages = [];
  for (let i = 0; i < blocks.length; i += SLACK_MAX_BLOCKS) {
    const chunk = blocks.slice(i, i + SLACK_MAX_BLOCKS);
    const text = `Deal stage velocity benchmarks ${date}: ${t.dealsAnalyzed} deals, ${t.stalledDeals} stalled, ${t.bottlenecks} bottleneck stage(s)${messages.length ? ' (continued)' : ''}`;
    messages.push({ channel: config.delivery.slackChannel, text, blocks: chunk, blocksJson: JSON.stringify({ blocks: chunk }) });
  }
  return messages;
}

/** One row per pipeline stage, for Google Sheets / Airtable / BI tools. */
function buildSheetRows(report) {
  const rows = [];
  report.pipelines.forEach((p) =>
    p.stages
      .filter((s) => !s.isClosed)
      .forEach((s) =>
        rows.push({
          run_date: String(report.generatedAt).slice(0, 10),
          window_start: report.window.start ? String(report.window.start).slice(0, 10) : '',
          pipeline_id: p.id,
          pipeline_label: p.label,
          stage_id: s.id,
          stage_label: s.label,
          stage_order: s.order,
          entered: s.entered,
          advanced: s.advanced,
          lost: s.lost,
          open: s.open,
          stalled: s.stalled,
          conversion_rate: s.conversionRate === null ? '' : s.conversionRate,
          dwell_n: s.dwell.n,
          dwell_mean_days: s.dwell.mean === null ? '' : s.dwell.mean,
          dwell_median_days: s.dwell.median === null ? '' : s.dwell.median,
          dwell_p75_days: s.dwell.p75 === null ? '' : s.dwell.p75,
          dwell_p90_days: s.dwell.p90 === null ? '' : s.dwell.p90,
          stall_threshold_days: s.stallThresholdDays === null ? '' : s.stallThresholdDays,
          threshold_source: s.thresholdSource || '',
          bottleneck: s.bottleneck.flagged ? 'YES' : 'NO',
          bottleneck_reasons: s.bottleneck.reasons.map((r) => r.code).join(','),
          pipeline_win_rate: p.winRate === null ? '' : p.winRate,
          pipeline_median_cycle_days: p.cycle.median === null ? '' : p.cycle.median,
        })
      )
  );
  return rows;
}

/** Sanitized log lines for the sandbox branch. */
function buildDryRunReport(report, config) {
  const lines = [
    `[velocity] DRY RUN${report.runId ? ` run=${report.runId}` : ''} deals=${report.totals.dealsAnalyzed}/${report.totals.dealsFetched} stalled=${report.totals.stalledDeals} bottlenecks=${report.totals.bottlenecks} dataIssues=${report.totals.dataQualityIssues}`,
  ];
  report.pipelines.forEach((p) => {
    lines.push(`[velocity] pipeline=${p.id} "${p.label}" deals=${p.deals} winRate=${fmtPct(p.winRate)} medianCycle=${fmtDays(p.cycle.median)}`);
    stageTable(p)
      .split('\n')
      .forEach((l) => lines.push(`[velocity]   ${l}`));
    p.bottlenecks.forEach((b) => lines.push(`[velocity]   BOTTLENECK ${b.stageId}: ${b.reasons.map((r) => r.code).join(', ')}`));
  });
  report.fetchErrors.forEach((e) => lines.push(`[velocity] fetch-error status=${e.status} rateLimited=${e.rateLimited} ${e.message}`));
  return {
    kind: 'dry_run_report',
    mode: 'SANDBOX',
    runId: report.runId,
    totals: report.totals,
    wouldPostSlackMessages: config && config.delivery.slackEnabled ? buildSlackMessages(report, config).length : 0,
    wouldAppendSheetRows: config && !config.delivery.sheetsEnabled ? 0 : buildSheetRows(report).length,
    lines: lines.map(redact),
  };
}

module.exports = {
  ENGINE_VERSION,
  SKIP_REASONS,
  BOTTLENECK_REASONS,
  parseDate,
  percentile,
  describe,
  redact,
  normalizePipelines,
  stageTimestampProperties,
  buildDealSearchRequest,
  extractDeals,
  buildDealTimeline,
  computeBenchmarks,
  stageTable,
  buildSlackMessages,
  buildSheetRows,
  buildDryRunReport,
};
