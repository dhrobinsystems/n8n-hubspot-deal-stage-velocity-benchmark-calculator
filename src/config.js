'use strict';

/**
 * src/config.js
 * ---------------------------------------------------------------------------
 * Environment parser and fail-fast validator for the
 * hubspot-deal-stage-velocity-benchmark-calculator n8n workflow.
 *
 *  - Zero dependencies, no require(): inlined into n8n Code nodes at build time.
 *  - Every problem is collected and thrown together as one ConfigError, before
 *    any HubSpot request is made.
 *  - Placeholders such as {{GOOGLE_SHEETS_DOCUMENT_ID}}, YOUR_..., your-...
 *    and REPLACE_... count as "not set".
 *  - No secrets are read here. HubSpot, Slack and Google credentials live in
 *    the n8n credential store.
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. The user is
 * responsible for CRM data integrity, API rate limits and compliance with
 * third-party terms of service. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const ENV_KEYS = Object.freeze([
  'SANDBOX_MODE',
  'AS_OF_DATE',
  'HUBSPOT_PORTAL_ID',
  'HUBSPOT_APP_BASE_URL',
  'PIPELINE_IDS',
  'LOOKBACK_DAYS',
  'DATE_FILTER_PROPERTY',
  'SEARCH_PAGE_SIZE',
  'STAGE_ENTERED_PREFIXES',
  'STAGE_EXITED_PREFIXES',
  'STALL_THRESHOLD_MODE',
  'STALL_BENCHMARK_STAT',
  'STALL_BENCHMARK_MULTIPLIER',
  'STALL_THRESHOLD_DAYS',
  'STALL_MIN_DAYS',
  'STAGE_THRESHOLD_OVERRIDES_JSON',
  'MIN_SAMPLE_SIZE',
  'BOTTLENECK_DWELL_MULTIPLIER',
  'BOTTLENECK_STALL_RATE',
  'BOTTLENECK_MIN_CONVERSION',
  'INCLUDE_DEAL_NAMES',
  'MAX_STALLED_IN_REPORT',
  'ENABLE_SLACK',
  'SLACK_CHANNEL',
  'ENABLE_GOOGLE_SHEETS',
  'GOOGLE_SHEETS_DOCUMENT_ID',
  'GOOGLE_SHEETS_SHEET_NAME',
]);

const DEFAULTS = Object.freeze({
  SANDBOX_MODE: 'true',
  AS_OF_DATE: '',
  HUBSPOT_PORTAL_ID: '',
  HUBSPOT_APP_BASE_URL: 'https://app.hubspot.com',
  PIPELINE_IDS: '',
  LOOKBACK_DAYS: '180',
  DATE_FILTER_PROPERTY: 'createdate',
  SEARCH_PAGE_SIZE: '100',
  STAGE_ENTERED_PREFIXES: 'hs_v2_date_entered_,hs_date_entered_',
  STAGE_EXITED_PREFIXES: 'hs_v2_date_exited_,hs_date_exited_',
  STALL_THRESHOLD_MODE: 'benchmark',
  STALL_BENCHMARK_STAT: 'median',
  STALL_BENCHMARK_MULTIPLIER: '2',
  STALL_THRESHOLD_DAYS: '21',
  STALL_MIN_DAYS: '7',
  STAGE_THRESHOLD_OVERRIDES_JSON: '',
  MIN_SAMPLE_SIZE: '5',
  BOTTLENECK_DWELL_MULTIPLIER: '1.5',
  BOTTLENECK_STALL_RATE: '0.3',
  BOTTLENECK_MIN_CONVERSION: '0.25',
  INCLUDE_DEAL_NAMES: 'false',
  MAX_STALLED_IN_REPORT: '15',
  ENABLE_SLACK: 'true',
  SLACK_CHANNEL: '#revops-reports',
  ENABLE_GOOGLE_SHEETS: 'false',
  GOOGLE_SHEETS_DOCUMENT_ID: '',
  GOOGLE_SHEETS_SHEET_NAME: 'stage_benchmarks',
});

const PLACEHOLDER = /^\{\{.*\}\}$|^<?(your[-_]|YOUR_|REPLACE_)/;
const PROPERTY_PREFIX = /^[a-z][a-z0-9_]*_$/;
const STATS = Object.freeze(['median', 'p75', 'p90', 'mean']);

class ConfigError extends Error {
  constructor(problems) {
    super('Invalid velocity benchmark configuration:\n  - ' + problems.join('\n  - '));
    this.name = 'ConfigError';
    this.problems = problems.slice();
  }
}

function isPlaceholder(value) {
  return typeof value === 'string' && PLACEHOLDER.test(value.trim());
}

function deepFreeze(obj) {
  Object.keys(obj).forEach((k) => {
    if (obj[k] && typeof obj[k] === 'object' && !Object.isFrozen(obj[k])) deepFreeze(obj[k]);
  });
  return Object.freeze(obj);
}

/**
 * Parse and validate configuration.
 * @param {Record<string,string|undefined>} [env] process.env in Node, $env in n8n.
 * @returns {object} deeply frozen configuration
 * @throws {ConfigError}
 */
function loadConfig(env) {
  const source = env !== undefined ? env : typeof process !== 'undefined' && process.env ? process.env : {};
  const problems = [];
  const warnings = [];

  const raw = (key) => {
    let value;
    try {
      value = source[key];
    } catch (err) {
      value = undefined; // n8n may block $env access
    }
    if (value === undefined || value === null || String(value).trim() === '') return DEFAULTS[key] || '';
    return String(value).trim();
  };
  const str = (key) => (isPlaceholder(raw(key)) ? '' : raw(key));
  const bool = (key) => {
    const v = raw(key).toLowerCase();
    if (['true', '1', 'yes', 'on'].indexOf(v) !== -1) return true;
    if (['false', '0', 'no', 'off'].indexOf(v) !== -1) return false;
    problems.push(`${key} must be true or false, received "${v}"`);
    return DEFAULTS[key] === 'true';
  };
  const num = (key, min, max, integer) => {
    const v = raw(key);
    const n = Number(v);
    if (v === '' || !Number.isFinite(n)) {
      problems.push(`${key} must be a number, received "${v}"`);
      return Number(DEFAULTS[key]);
    }
    if (integer && !Number.isInteger(n)) problems.push(`${key} must be an integer, received ${n}`);
    if (n < min || n > max) problems.push(`${key} must be between ${min} and ${max}, received ${n}`);
    return n;
  };
  const list = (key) =>
    str(key)
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p && !isPlaceholder(p));

  const sandboxMode = bool('SANDBOX_MODE');

  // Optional fixed "now" for reproducible reports and backtesting (ISO date or datetime).
  let asOf = null;
  const asOfRaw = str('AS_OF_DATE');
  if (asOfRaw) {
    const ms = Date.parse(asOfRaw);
    if (!/^\d{4}-\d{2}-\d{2}/.test(asOfRaw) || Number.isNaN(ms)) problems.push('AS_OF_DATE must be an ISO date such as 2026-06-01 (or blank for "now")');
    else asOf = new Date(ms).toISOString();
  }

  const hubspot = {
    portalId: str('HUBSPOT_PORTAL_ID'),
    appBaseUrl: raw('HUBSPOT_APP_BASE_URL').replace(/\/+$/, ''),
    pipelineIds: list('PIPELINE_IDS'),
    lookbackDays: num('LOOKBACK_DAYS', 7, 1825, true),
    dateFilterProperty: raw('DATE_FILTER_PROPERTY'),
    searchPageSize: num('SEARCH_PAGE_SIZE', 1, 200, true),
    enteredPrefixes: list('STAGE_ENTERED_PREFIXES'),
    exitedPrefixes: list('STAGE_EXITED_PREFIXES'),
  };
  if (hubspot.portalId && !/^\d+$/.test(hubspot.portalId)) problems.push('HUBSPOT_PORTAL_ID must be numeric');
  if (!/^https:\/\/\S+$/.test(hubspot.appBaseUrl)) problems.push('HUBSPOT_APP_BASE_URL must be an https:// URL');
  if (['createdate', 'hs_lastmodifieddate', 'closedate'].indexOf(hubspot.dateFilterProperty) === -1) {
    problems.push('DATE_FILTER_PROPERTY must be createdate, hs_lastmodifieddate or closedate');
  }
  if (hubspot.enteredPrefixes.length === 0) problems.push('STAGE_ENTERED_PREFIXES must list at least one property prefix');
  hubspot.enteredPrefixes.concat(hubspot.exitedPrefixes).forEach((p) => {
    if (!PROPERTY_PREFIX.test(p)) problems.push(`"${p}" is not a valid property prefix (lowercase, ending with "_")`);
  });
  hubspot.pipelineIds.forEach((id) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) problems.push(`PIPELINE_IDS contains an invalid pipeline ID "${id}"`);
  });

  let overrides = {};
  const overridesRaw = str('STAGE_THRESHOLD_OVERRIDES_JSON');
  if (overridesRaw) {
    try {
      const parsed = JSON.parse(overridesRaw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      Object.keys(parsed).forEach((stageId) => {
        const days = Number(parsed[stageId]);
        if (!Number.isFinite(days) || days <= 0) problems.push(`STAGE_THRESHOLD_OVERRIDES_JSON value for "${stageId}" must be a positive number of days`);
        else overrides[stageId] = days;
      });
    } catch (err) {
      problems.push('STAGE_THRESHOLD_OVERRIDES_JSON must be a JSON object like {"appointmentscheduled": 10}');
      overrides = {};
    }
  }

  const stall = {
    mode: raw('STALL_THRESHOLD_MODE').toLowerCase(),
    stat: raw('STALL_BENCHMARK_STAT').toLowerCase(),
    multiplier: num('STALL_BENCHMARK_MULTIPLIER', 1, 20, false),
    fixedDays: num('STALL_THRESHOLD_DAYS', 1, 730, false),
    minDays: num('STALL_MIN_DAYS', 0, 365, false),
    overrides,
  };
  if (['benchmark', 'fixed'].indexOf(stall.mode) === -1) problems.push('STALL_THRESHOLD_MODE must be "benchmark" or "fixed"');
  if (STATS.indexOf(stall.stat) === -1) problems.push(`STALL_BENCHMARK_STAT must be one of ${STATS.join(', ')}`);

  const analysis = {
    minSampleSize: num('MIN_SAMPLE_SIZE', 1, 1000, true),
    bottleneckDwellMultiplier: num('BOTTLENECK_DWELL_MULTIPLIER', 1, 20, false),
    bottleneckStallRate: num('BOTTLENECK_STALL_RATE', 0.01, 1, false),
    bottleneckMinConversion: num('BOTTLENECK_MIN_CONVERSION', 0, 1, false),
  };

  const report = {
    includeDealNames: bool('INCLUDE_DEAL_NAMES'),
    maxStalled: num('MAX_STALLED_IN_REPORT', 0, 200, true),
  };

  const delivery = {
    slackEnabled: bool('ENABLE_SLACK'),
    slackChannel: str('SLACK_CHANNEL'),
    sheetsEnabled: bool('ENABLE_GOOGLE_SHEETS'),
    sheetsDocumentId: str('GOOGLE_SHEETS_DOCUMENT_ID'),
    sheetsSheetName: str('GOOGLE_SHEETS_SHEET_NAME'),
  };
  if (delivery.sheetsDocumentId && !/^[A-Za-z0-9_-]{10,200}$/.test(delivery.sheetsDocumentId)) {
    problems.push('GOOGLE_SHEETS_DOCUMENT_ID must be the ID from the sheet URL (letters, digits, - and _)');
  }

  const liveIssues = [];
  if (delivery.slackEnabled && !delivery.slackChannel) liveIssues.push('SLACK_CHANNEL is required when ENABLE_SLACK=true');
  if (delivery.sheetsEnabled && !delivery.sheetsDocumentId) liveIssues.push('GOOGLE_SHEETS_DOCUMENT_ID is required when ENABLE_GOOGLE_SHEETS=true');
  if (delivery.sheetsEnabled && !delivery.sheetsSheetName) liveIssues.push('GOOGLE_SHEETS_SHEET_NAME is required when ENABLE_GOOGLE_SHEETS=true');
  if (!delivery.slackEnabled && !delivery.sheetsEnabled) liveIssues.push('Both ENABLE_SLACK and ENABLE_GOOGLE_SHEETS are false; the report will not be delivered anywhere');
  if (!hubspot.portalId) warnings.push('HUBSPOT_PORTAL_ID is not set; stalled-deal links will be omitted');
  if (report.includeDealNames) warnings.push('INCLUDE_DEAL_NAMES=true: deal names will appear in Slack and Sheets');

  if (sandboxMode) liveIssues.forEach((i) => warnings.push(`[sandbox] ${i}`));
  else liveIssues.forEach((i) => problems.push(i));

  if (problems.length > 0) throw new ConfigError(problems);

  return deepFreeze({ sandboxMode, asOf, hubspot, stall, analysis, report, delivery, warnings });
}

module.exports = { ENV_KEYS, DEFAULTS, ConfigError, isPlaceholder, loadConfig };
