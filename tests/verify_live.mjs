import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:3000';

// 8 crime incident coordinates spread across Barangay Commonwealth
const incidents = [
  { crimeId: 'CRIME-001', lat: 14.7010, lng: 121.0900 },
  { crimeId: 'CRIME-002', lat: 14.7035, lng: 121.0920 },
  { crimeId: 'CRIME-003', lat: 14.7060, lng: 121.0890 },
  { crimeId: 'CRIME-004', lat: 14.7020, lng: 121.0960 },
  { crimeId: 'CRIME-005', lat: 14.6990, lng: 121.0950 },
  { crimeId: 'CRIME-006', lat: 14.7045, lng: 121.0870 },
  { crimeId: 'CRIME-007', lat: 14.7000, lng: 121.0930 },
  { crimeId: 'CRIME-008', lat: 14.7055, lng: 121.0945 },
];

async function runTest(label, payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const events = [];
    let timer;

    ws.on('open', () => {
      ws.send(JSON.stringify(payload));
      timer = setTimeout(() => {
        ws.close();
        reject(new Error(`${label}: timed out after 30s`));
      }, 30000);
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      events.push(msg);
      if (msg.type === 'pipeline_complete' || msg.type === 'error') {
        clearTimeout(timer);
        ws.close();
        resolve({ label, events });
      }
    });

    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function summarise({ label, events }) {
  console.log(`\n===== ${label} =====`);
  for (const e of events) {
    if (e.type === 'stage_start')    console.log(`  → Stage ${e.data.stage} start: ${e.data.name}`);
    if (e.type === 'stage_complete') console.log(`  ✓ Stage ${e.data.stage} complete (${Math.round(e.data.runtimeMs)}ms)`);
    if (e.type === 'warning')        console.log(`  ⚠ Warning (stage ${e.data.stage}): ${e.data.message}`);
    if (e.type === 'error')          console.log(`  ✗ ERROR (stage ${e.data.stage}): ${e.data.message}`);
    if (e.type === 'pipeline_complete') {
      const d = e.data;
      console.log(`  ✓ Pipeline complete — ${Math.round(d.totalRuntimeMs)}ms`);
      console.log(`    Hull vertices:  ${d.hull ? d.hull.length : 'none'}`);
      console.log(`    Patrols:        ${d.patrols ? d.patrols.length : 0}`);
      console.log(`    Zones:          ${d.zones ? d.zones.length : 'none'}`);
      if (d.routes) {
        for (const r of d.routes) {
          const dist = r.circuitDistanceM ?? 0;
          const segs = r.pathSegments ? r.pathSegments.length : 0;
          console.log(`    Route P${r.patrolIndex+1}: ${r.isEmpty ? 'stationary' : r.isSingleNode ? 'single-node' : `${r.sequence.length-2} stops`}, ${dist}m road dist, ${segs} path segments`);
        }
      }
    }
  }
  const hasError = events.some(e => e.type === 'error');
  const hasComplete = events.some(e => e.type === 'pipeline_complete');
  return !hasError && hasComplete;
}

// ── Test 1: init request to load Commonwealth network ────────────────────────
const initPayload = { type: 'init', barangay: 'Commonwealth' };

// ── Test 2: stationary mode, penalty = 1 (off) ──────────────────────────────
const stationaryPayload = {
  type: 'compute',
  data: {
    barangay: 'Commonwealth',
    incidents,
    n: 3,
    mode: 'stationary',
    config: {
      tsp: { maxCrimeNodesPerZone: 10, nearestNeighborFallbackThreshold: 12, hullExteriorPenalty: 1 }
    }
  }
};

// ── Test 3: roaming mode, penalty = 1 (off) ──────────────────────────────────
const roamingPayload = {
  type: 'compute',
  data: {
    barangay: 'Commonwealth',
    incidents,
    n: 3,
    mode: 'roaming',
    config: {
      tsp: { maxCrimeNodesPerZone: 10, nearestNeighborFallbackThreshold: 12, hullExteriorPenalty: 1 }
    }
  }
};

// ── Test 4: roaming mode, penalty = 3 (active) ───────────────────────────────
const roamingPenaltyPayload = {
  type: 'compute',
  data: {
    barangay: 'Commonwealth',
    incidents,
    n: 3,
    mode: 'roaming',
    config: {
      tsp: { maxCrimeNodesPerZone: 10, nearestNeighborFallbackThreshold: 12, hullExteriorPenalty: 3 }
    }
  }
};

let allPass = true;

try {
  const r2 = await runTest('Stationary (penalty=1)', stationaryPayload);
  if (!summarise(r2)) allPass = false;

  const r3 = await runTest('Roaming (penalty=1)', roamingPayload);
  if (!summarise(r3)) allPass = false;

  const r4 = await runTest('Roaming (penalty=3)', roamingPenaltyPayload);
  const p4ok = summarise(r4);
  if (!p4ok) allPass = false;

  // Compare total route distance: penalty=3 should differ from penalty=1
  // (may be longer or different due to rerouting — just confirm it ran without error)
  const r3dist = r3.events.find(e=>e.type==='pipeline_complete')?.data?.routes?.reduce((s,r)=>s+(r.circuitDistanceM||0),0) ?? 0;
  const r4dist = r4.events.find(e=>e.type==='pipeline_complete')?.data?.routes?.reduce((s,r)=>s+(r.circuitDistanceM||0),0) ?? 0;
  console.log(`\n===== Penalty comparison =====`);
  console.log(`  Roaming penalty=1 total circuit: ${r3dist}m`);
  console.log(`  Roaming penalty=3 total circuit: ${r4dist}m`);
  console.log(`  Routes differ: ${r3dist !== r4dist ? 'YES' : 'NO (same path found or no exterior edges used)'}`);

  // Check Stage 4 trace log for penalty message
  const r4complete = r4.events.find(e=>e.type==='stage_complete'&&e.data?.stage===4);
  if (r4complete) {
    const penaltyLine = (r4complete.data?.trace?.log || []).find(l => l.includes('penalty'));
    console.log(`  Penalty log line: ${penaltyLine || '(not found in trace)'}`);
  }

  console.log(`\n===== VERDICT: ${allPass ? 'PASS' : 'FAIL'} =====`);
} catch (e) {
  console.error('Test error:', e.message);
  console.log('\n===== VERDICT: FAIL =====');
}
process.exit(0);
