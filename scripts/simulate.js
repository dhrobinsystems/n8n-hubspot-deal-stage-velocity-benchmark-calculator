#!/usr/bin/env node
'use strict';

/**
 * scripts/simulate.js
 * ---------------------------------------------------------------------------
 * Offline simulator for workflow.json. Executes the generated n8n Code nodes in
 * an isolated VM context that mimics the n8n Code node runtime ($input, $env,
 * $execution, $()), and replaces the HubSpot HTTP nodes with the synthetic
 * fixtures in test/fixtures. No network calls, no credentials.
 *
 *   node scripts/simulate.js             sandbox run: prints the dry-run report
 *   node scripts/simulate.js --live      live run: prints the Slack text and sheet rows that would be sent
 *   node scripts/simulate.js --json      full JSON benchmark report
 *
 * Also used by test/workflow.test.js.
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/** Test-only settings. AS_OF_DATE pins "now" to the fixture generation date. */
const SIM_ENV = Object.freeze({
  SANDBOX_MODE: 'true',
  AS_OF_DATE: '2026-06-01',
  HUBSPOT_PORTAL_ID: '12345678',
  ENABLE_SLACK: 'true',
  SLACK_CHANNEL: '#revops-reports',
});

function loadWorkflow() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Run one Code node ("Run Once for All Items").
 * @param {object} workflow parsed workflow.json
 * @param {string} name node name
 * @param {object[]} inputJsons input item JSON
 * @param {{ env?: object, blockEnv?: boolean, nodeOutputs?: Record<string, object[]> }} [options]
 */
async function runCodeNode(workflow, name, inputJsons, options) {
  const opts = options || {};
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node || node.type !== 'n8n-nodes-base.code') throw new Error(`Code node "${name}" not found`);
  const items = (inputJsons || []).map((json) => ({ json }));
  const logs = [];
  const outputs = opts.nodeOutputs || {};
  const context = {
    $input: { all: () => items, first: () => items[0], last: () => items[items.length - 1] },
    $execution: { id: 'sim-exec-1' },
    $: (nodeName) => {
      const list = (outputs[nodeName] || []).map((json) => ({ json }));
      return {
        first: () => {
          if (!list.length) throw new Error(`No output from "${nodeName}"`);
          return list[0];
        },
        all: () => list,
        item: list[0],
      };
    },
    console: { log: (...a) => logs.push(a.join(' ')), warn: () => {}, error: () => {} },
  };
  if (opts.blockEnv) {
    Object.defineProperty(context, '$env', {
      get() {
        throw new Error('access to env vars denied');
      },
    });
  } else {
    context.$env = opts.env || {};
  }
  const result = await vm.runInNewContext(`(async () => {\n${node.parameters.jsCode}\n})()`, context, { timeout: 10000 });
  return { output: plain(result) || [], logs };
}

/**
 * Replay the whole workflow against fixtures, following its routing.
 * @param {{ env?: object, pipelines?: object, dealPages?: object[] }} [input]
 */
async function simulate(input) {
  const opts = input || {};
  const workflow = opts.workflow || loadWorkflow();
  const env = Object.assign({}, SIM_ENV, opts.env || {});
  const pipelines = opts.pipelines !== undefined ? opts.pipelines : fixture('pipelines.json');
  const dealPages = opts.dealPages !== undefined ? opts.dealPages : [fixture('deals-page-1.json'), fixture('deals-page-2.json')];
  const logs = [];
  const result = { config: null, search: null, report: null, dryRun: null, slackMessages: [], sheetRows: [], logs, requests: [] };

  const cfg = await runCodeNode(workflow, 'Load Configuration', [{}], { env });
  logs.push(...cfg.logs);
  result.config = cfg.output[0] && cfg.output[0].json;

  result.requests.push({ method: 'GET', url: 'https://api.hubapi.com/crm/v3/pipelines/deals' });
  const search = await runCodeNode(workflow, 'Build Deal Search', [pipelines], { env });
  logs.push(...search.logs);
  if (search.output.length === 0) return result;
  result.search = search.output[0].json;

  dealPages.forEach((_, i) => result.requests.push({ method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/deals/search', page: i + 1 }));
  const computed = await runCodeNode(workflow, 'Compute Velocity Benchmarks', dealPages, {
    env,
    nodeOutputs: { 'HubSpot Get Deal Pipelines': [pipelines], 'Build Deal Search': [result.search] },
  });
  logs.push(...computed.logs);
  result.report = computed.output[0].json;

  if (result.report.sandbox) {
    const dry = await runCodeNode(workflow, 'Dry-Run Telemetry', [result.report], { env });
    logs.push(...dry.logs);
    result.dryRun = dry.output[0] && dry.output[0].json;
  } else {
    const slack = await runCodeNode(workflow, 'Format Slack Report', [result.report], { env });
    const rows = await runCodeNode(workflow, 'Build Sheet Rows', [result.report], { env });
    result.slackMessages = slack.output.map((i) => i.json);
    result.sheetRows = rows.output.map((i) => i.json);
  }
  return result;
}

/** Plain-text rendering of Slack blocks for the console. */
function slackToText(message) {
  return message.blocks
    .map((b) => {
      if (b.type === 'header') return `## ${b.text.text}`;
      if (b.type === 'divider') return '---';
      if (b.type === 'context') return b.elements.map((e) => e.text).join(' ');
      return b.text ? b.text.text.replace(/```/g, '\n') : '';
    })
    .join('\n');
}

async function main(argv) {
  const args = new Set(argv);
  const live = args.has('--live');
  const result = await simulate({ env: live ? { SANDBOX_MODE: 'false', ENABLE_GOOGLE_SHEETS: 'true', GOOGLE_SHEETS_DOCUMENT_ID: 'synthetic-sheet-id-000000000000' } : {} });
  if (args.has('--json')) {
    console.log(JSON.stringify(result.report, null, 2));
    return 0;
  }
  if (!live) {
    result.logs.forEach((l) => console.log(l));
    return 0;
  }
  result.slackMessages.forEach((m, i) => console.log(`\n===== Slack message ${i + 1} → ${m.channel} =====\n${slackToText(m)}`));
  console.log(`\n===== ${result.sheetRows.length} Google Sheets rows (first 2) =====`);
  console.log(JSON.stringify(result.sheetRows.slice(0, 2), null, 2));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => (process.exitCode = code))
    .catch((err) => {
      console.error(`Simulation failed: ${err.stack || err.message}`);
      process.exitCode = 1;
    });
}

module.exports = { SIM_ENV, loadWorkflow, fixture, runCodeNode, simulate, slackToText };
