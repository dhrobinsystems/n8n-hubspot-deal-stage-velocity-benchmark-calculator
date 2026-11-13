#!/usr/bin/env node
'use strict';

/**
 * scripts/generate-fixtures.js
 * ---------------------------------------------------------------------------
 * Generates deterministic, fully synthetic HubSpot API responses for tests and
 * the offline simulator. No real deals, companies or people are involved.
 *
 *   node scripts/generate-fixtures.js
 *
 * Writes:
 *   test/fixtures/pipelines.json        GET  /crm/v3/pipelines/deals
 *   test/fixtures/deals-page-1.json     POST /crm/v3/objects/deals/search (page 1)
 *   test/fixtures/deals-page-2.json     POST /crm/v3/objects/deals/search (page 2)
 *
 * The data is shaped so the analysis has something real to find: the
 * "Decision maker bought-in" stage is slow and converts poorly (a bottleneck),
 * some open deals are stalled, and a few records are deliberately dirty
 * (no stage history, a duplicate, an unknown pipeline, an exit-before-entry).
 *
 * DISCLAIMER: provided "AS IS", without warranty of any kind. See DISCLAIMER.md.
 * ---------------------------------------------------------------------------
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'test', 'fixtures');
const AS_OF = Date.parse('2026-06-01T00:00:00.000Z'); // matches AS_OF_DATE used in tests
const DAY = 24 * 60 * 60 * 1000;

/** Small deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIPELINES = {
  results: [
    {
      id: 'default',
      label: 'Sales Pipeline',
      displayOrder: 0,
      archived: false,
      stages: [
        { id: 'appointmentscheduled', label: 'Appointment scheduled', displayOrder: 0, archived: false, metadata: { isClosed: 'false', probability: '0.2' } },
        { id: 'qualifiedtobuy', label: 'Qualified to buy', displayOrder: 1, archived: false, metadata: { isClosed: 'false', probability: '0.4' } },
        { id: 'presentationscheduled', label: 'Presentation scheduled', displayOrder: 2, archived: false, metadata: { isClosed: 'false', probability: '0.6' } },
        { id: 'decisionmakerboughtin', label: 'Decision maker bought-in', displayOrder: 3, archived: false, metadata: { isClosed: 'false', probability: '0.8' } },
        { id: 'contractsent', label: 'Contract sent', displayOrder: 4, archived: false, metadata: { isClosed: 'false', probability: '0.9' } },
        { id: 'closedwon', label: 'Closed won', displayOrder: 5, archived: false, metadata: { isClosed: 'true', probability: '1.0' } },
        { id: 'closedlost', label: 'Closed lost', displayOrder: 6, archived: false, metadata: { isClosed: 'true', probability: '0.0' } },
      ],
    },
    {
      id: '7000001',
      label: 'Partner Pipeline',
      displayOrder: 1,
      archived: false,
      stages: [
        { id: '7100001', label: 'Partner intro', displayOrder: 0, archived: false, metadata: { isClosed: 'false', probability: '0.1' } },
        { id: '7100002', label: 'Joint discovery', displayOrder: 1, archived: false, metadata: { isClosed: 'false', probability: '0.3' } },
        { id: '7100003', label: 'Proposal', displayOrder: 2, archived: false, metadata: { isClosed: 'false', probability: '0.6' } },
        { id: '7100004', label: 'Won', displayOrder: 3, archived: false, metadata: { isClosed: 'true', probability: '1.0' } },
        { id: '7100005', label: 'Lost', displayOrder: 4, archived: false, metadata: { isClosed: 'true', probability: '0.0' } },
      ],
    },
    { id: '7000002', label: 'Archived Pipeline', displayOrder: 2, archived: true, stages: [] },
  ],
};

/** Per-stage behaviour: median dwell (days) and probability of advancing. */
const PROFILES = {
  default: {
    open: ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'decisionmakerboughtin', 'contractsent'],
    won: 'closedwon',
    lost: 'closedlost',
    dwell: { appointmentscheduled: 3, qualifiedtobuy: 6, presentationscheduled: 5, decisionmakerboughtin: 21, contractsent: 4 },
    advance: { appointmentscheduled: 0.85, qualifiedtobuy: 0.75, presentationscheduled: 0.75, decisionmakerboughtin: 0.2, contractsent: 0.85 },
  },
  '7000001': {
    open: ['7100001', '7100002', '7100003'],
    won: '7100004',
    lost: '7100005',
    dwell: { '7100001': 5, '7100002': 9, '7100003': 7 },
    advance: { '7100001': 0.8, '7100002': 0.7, '7100003': 0.6 },
  },
};

function simulateDeal(id, pipelineId, random, useV2) {
  const profile = PROFILES[pipelineId];
  const created = AS_OF - Math.floor(random() * 170 + 2) * DAY - Math.floor(random() * DAY);
  const props = {
    hs_object_id: String(id),
    pipeline: pipelineId,
    createdate: new Date(created).toISOString(),
    hs_lastmodifieddate: new Date(AS_OF - DAY).toISOString(),
    amount: String(Math.round((random() * 45 + 5)) * 1000),
    hubspot_owner_id: String(900 + Math.floor(random() * 6)),
    dealname: `Synthetic deal ${id}`,
  };
  const prefix = useV2 ? 'hs_v2_date_entered_' : 'hs_date_entered_';
  const exitPrefix = useV2 ? 'hs_v2_date_exited_' : 'hs_date_exited_';
  let t = created;
  let stage = profile.open[0];
  let i = 0;
  for (;;) {
    props[prefix + stage] = new Date(t).toISOString();
    if (stage === profile.won || stage === profile.lost) {
      props.dealstage = stage;
      props.closedate = new Date(t).toISOString();
      props.hs_is_closed = 'true';
      props.hs_is_closed_won = String(stage === profile.won);
      break;
    }
    // Skewed dwell: median * (0.4 .. 2.2)
    const dwell = profile.dwell[stage] * (0.4 + random() * random() * 3) * DAY;
    if (t + dwell > AS_OF) {
      props.dealstage = stage; // still open in this stage
      props.hs_is_closed = 'false';
      props.hs_is_closed_won = 'false';
      break;
    }
    const advance = random() < profile.advance[stage];
    t += dwell;
    if (random() < 0.5) props[exitPrefix + stage] = new Date(t).toISOString();
    if (!advance) {
      stage = profile.lost;
    } else if (i + 1 < profile.open.length) {
      i += 1;
      // Occasionally skip a stage, as real reps do.
      if (random() < 0.08 && i + 1 < profile.open.length) i += 1;
      stage = profile.open[i];
    } else {
      stage = profile.won;
    }
  }
  return { id: String(id), properties: props, createdAt: props.createdate, updatedAt: props.hs_lastmodifieddate, archived: false };
}

function main() {
  const random = rng(20260601);
  const deals = [];
  let id = 50000001;
  for (let n = 0; n < 140; n += 1) deals.push(simulateDeal(id++, 'default', random, n % 3 !== 0));
  for (let n = 0; n < 40; n += 1) deals.push(simulateDeal(id++, '7000001', random, true));

  // Deliberately long-stalled open deals in the bottleneck stage.
  for (let n = 0; n < 6; n += 1) {
    const created = AS_OF - (90 + n * 5) * DAY;
    deals.push({
      id: String(id++),
      archived: false,
      properties: {
        hs_object_id: String(id - 1),
        pipeline: 'default',
        dealstage: 'decisionmakerboughtin',
        createdate: new Date(created).toISOString(),
        hs_v2_date_entered_appointmentscheduled: new Date(created).toISOString(),
        hs_v2_date_entered_qualifiedtobuy: new Date(created + 4 * DAY).toISOString(),
        hs_v2_date_entered_presentationscheduled: new Date(created + 10 * DAY).toISOString(),
        hs_v2_date_entered_decisionmakerboughtin: new Date(created + 16 * DAY).toISOString(),
        hs_is_closed: 'false',
        hs_is_closed_won: 'false',
        amount: String(20000 + n * 5000),
        hubspot_owner_id: '901',
        dealname: `Synthetic stalled deal ${n + 1}`,
      },
    });
  }

  // Dirty records.
  deals.push({ id: String(id++), archived: false, properties: { pipeline: 'default', dealstage: 'appointmentscheduled', createdate: new Date(AS_OF - 5 * DAY).toISOString() } }); // no history
  deals.push(JSON.parse(JSON.stringify(deals[0]))); // duplicate
  deals.push({ id: String(id++), archived: false, properties: { pipeline: '7000002', dealstage: 'x', createdate: new Date(AS_OF - 5 * DAY).toISOString() } }); // unknown pipeline
  deals.push({
    id: String(id++),
    archived: false,
    properties: {
      pipeline: 'default',
      dealstage: 'qualifiedtobuy',
      createdate: new Date(AS_OF - 20 * DAY).toISOString(),
      hs_date_entered_appointmentscheduled: new Date(AS_OF - 20 * DAY).toISOString(),
      hs_date_exited_appointmentscheduled: new Date(AS_OF - 30 * DAY).toISOString(), // exit before entry
      hs_date_entered_qualifiedtobuy: new Date(AS_OF - 15 * DAY).toISOString(),
      hs_is_closed: 'false',
    },
  });

  const half = Math.ceil(deals.length / 2);
  const page1 = { total: deals.length, results: deals.slice(0, half), paging: { next: { after: String(half), link: '' } } };
  const page2 = { total: deals.length, results: deals.slice(half) };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'pipelines.json'), JSON.stringify(PIPELINES, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'deals-page-1.json'), JSON.stringify(page1, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'deals-page-2.json'), JSON.stringify(page2, null, 2) + '\n');
  console.log(`Wrote ${deals.length} synthetic deals across 2 pages and ${PIPELINES.results.length} pipelines to test/fixtures/.`);
}

if (require.main === module) main();

module.exports = { AS_OF, PIPELINES };
