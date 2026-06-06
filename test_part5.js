// test_part5.js — comprehensive Part 5 WebSocket / pipeline server tests
// Requires server running at ws://localhost:3000
// Run: node test_part5.js

import WebSocket from 'ws';

// ── Test infrastructure ───────────────────────────────────────────────────────

let pass = 0, fail = 0;

function ok(label, cond, got, want) {
    if (cond) {
        console.log(`  PASS  ${label}`);
        pass++;
    } else {
        const gotStr  = JSON.stringify(got)  ?? String(got);
        const wantStr = JSON.stringify(want) ?? String(want);
        console.log(`  FAIL  ${label}`);
        console.log(`          got : ${gotStr}`);
        console.log(`          want: ${wantStr}`);
        fail++;
    }
}

// Open a WebSocket to localhost:3000 and resolve once the 'connected' message arrives.
// Rejects on timeout or connection error.
function connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        let settled = false;

        const ws = new WebSocket('ws://localhost:3000');

        const timer = setTimeout(() => {
            if (!settled) { settled = true; ws.terminate(); reject(new Error('connect timeout')); }
        }, timeoutMs);

        ws.on('error', (err) => {
            if (!settled) { settled = true; clearTimeout(timer); reject(err); }
        });

        // Accumulate messages until 'connected' arrives (it is always the first message).
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'connected' && !settled) {
                settled = true;
                clearTimeout(timer);
                resolve(ws);
            }
        });
    });
}

// Collect all WebSocket messages on ws until endCondition(msg, allSoFar) returns true,
// or until timeoutMs elapses.  Removes all 'message' listeners before resolving.
function collectUntil(ws, endCondition, timeoutMs = 120000) {
    return new Promise((resolve) => {
        const msgs = [];

        const timer = setTimeout(() => {
            ws.removeAllListeners('message');
            resolve(msgs);
        }, timeoutMs);

        function handler(raw) {
            const msg = JSON.parse(raw.toString());
            msgs.push(msg);
            if (endCondition(msg, msgs)) {
                clearTimeout(timer);
                ws.removeAllListeners('message');
                resolve(msgs);
            }
        }

        ws.on('message', handler);
    });
}

// Returns true when a message is either pipeline_complete or a fatal error.
const isPipelineTerminal = (m) =>
    m.type === 'pipeline_complete' || (m.type === 'error' && m.data?.fatal === true);

// ── Valid test payload ────────────────────────────────────────────────────────
// 6 coordinates chosen so their convex hull spans most of the Commonwealth bbox
// (south:14.69, west:121.08, north:14.72, east:121.11).  The V2 Overpass data
// has 827 intersection nodes whose roads are concentrated west of lng 121.094;
// these coordinates produce a hull that contains 722 of those 827 nodes.
const VALID_INCIDENTS = [
    { lat: 14.693, lng: 121.082 },  // SW — inside barangay boundary
    { lat: 14.693, lng: 121.108 },  // SE — east of roads, still a valid incident
    { lat: 14.718, lng: 121.108 },  // NE — north+east extent
    { lat: 14.718, lng: 121.082 },  // NW — north+west extent
    { lat: 14.705, lng: 121.095 },  // center
    { lat: 14.700, lng: 121.089 },  // south-center (inside barangay)
];

const VALID_COMPUTE = {
    type: 'compute',
    data: {
        incidents: VALID_INCIDENTS,
        n:         3,
        mode:      'roaming',
        barangay:  'Commonwealth'
    }
};

// ── Helpers ───────────────────────────────────────────────────────────────────

// Wait for a single response message after sending a request.
// Skips any messages that don't match the predicate (e.g. stage_progress).
function waitForMessage(ws, predicate, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeAllListeners('message');
            reject(new Error('waitForMessage timeout'));
        }, timeoutMs);

        function handler(raw) {
            const msg = JSON.parse(raw.toString());
            if (predicate(msg)) {
                clearTimeout(timer);
                ws.removeAllListeners('message');
                resolve(msg);
            }
        }

        ws.on('message', handler);
    });
}

// Utility: delay
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main test runner ──────────────────────────────────────────────────────────

async function runTests() {
    console.log('PatrolPoint Part 5 — WebSocket / Pipeline Server Tests');
    console.log('='.repeat(62));
    console.log('  Requires server running at ws://localhost:3000');
    console.log('  First run may take up to 120 s while network data is fetched.\n');

    // ── Pre-flight: verify server is reachable ────────────────────────────────
    {
        let preflight;
        try {
            preflight = await connect(6000);
            preflight.close();
        } catch (e) {
            console.error('\n  FATAL: Cannot connect to ws://localhost:3000');
            console.error(`  ${e.message}`);
            console.error('  Start the server with "node server/index.js" before running tests.\n');
            process.exit(1);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [1] Connection and Protocol
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[1] Connection and Protocol\n');

    // 1.1  WebSocket connects successfully and sends 'connected' immediately.
    {
        let ws;
        try {
            ws = await connect(6000);
            ok('WebSocket connects successfully to ws://localhost:3000', true);
            ok('connected message received immediately on connection', true);
            ws.close();
        } catch (e) {
            ok('WebSocket connects successfully to ws://localhost:3000', false, e.message, 'connected');
            ok('connected message received immediately on connection', false, e.message, 'connected');
        }
    }

    // 1.2  ping → pong
    {
        let ws;
        try {
            ws = await connect();
            ws.send(JSON.stringify({ type: 'ping' }));
            const pong = await waitForMessage(ws, m => m.type === 'pong', 5000);
            ok('ping produces pong response', pong.type === 'pong', pong.type, 'pong');
            ws.close();
        } catch (e) {
            ok('ping produces pong response', false, e.message, 'pong');
        }
    }

    // 1.3  Unknown message type: error returned, server stays alive.
    {
        let ws;
        try {
            ws = await connect();
            ws.send(JSON.stringify({ type: 'totally_unknown_garbage_xyz' }));
            const errMsg = await waitForMessage(ws, m => m.type === 'error', 5000);
            ok('Unknown message type returns error (not crash)', errMsg.type === 'error', errMsg.type, 'error');

            // Server must still be responsive after the unknown message.
            ws.send(JSON.stringify({ type: 'ping' }));
            const pong = await waitForMessage(ws, m => m.type === 'pong', 5000);
            ok('Server stays alive after unknown message (ping still works)', pong.type === 'pong', pong.type, 'pong');
            ws.close();
        } catch (e) {
            ok('Unknown message type returns error (not crash)', false, e.message, 'error');
            ok('Server stays alive after unknown message (ping still works)', false, e.message, 'pong');
        }
    }

    // 1.4  Multiple simultaneous clients: independent pipeline state.
    //      ws1 is cancelled; ws2 must complete independently.
    {
        let ws1, ws2;
        try {
            ws1 = await connect();
            ws2 = await connect();

            // Start a fast (stationary, n=1) compute on ws2 so the test is quick.
            const ws2Compute = {
                type: 'compute',
                data: { incidents: VALID_INCIDENTS, n: 1, mode: 'stationary', barangay: 'Commonwealth' }
            };

            // Collect ws2 messages while cancelling ws1.
            const ws2Done = collectUntil(ws2, isPipelineTerminal, 120000);

            ws1.send(JSON.stringify(VALID_COMPUTE));
            ws2.send(JSON.stringify(ws2Compute));

            // Cancel ws1 shortly after starting.
            await sleep(300);
            ws1.send(JSON.stringify({ type: 'cancel' }));

            const ws2Msgs = await ws2Done;
            const ws2Complete = ws2Msgs.some(m => m.type === 'pipeline_complete');
            ok(
                'Multiple simultaneous clients: client 2 completes after client 1 cancelled',
                ws2Complete,
                ws2Complete,
                true
            );

            ws1.close();
            ws2.close();
        } catch (e) {
            ok('Multiple simultaneous clients: client 2 completes after client 1 cancelled', false, e.message, true);
            try { ws1?.close(); ws2?.close(); } catch (_) {}
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [2] Input Validation
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[2] Input Validation\n');

    function isValidErrorStructure(msg) {
        return (
            msg !== null &&
            msg.type === 'error' &&
            msg.data !== undefined &&
            typeof msg.data.message === 'string' &&
            msg.data.message.length > 0 &&
            msg.data.fatal === true
        );
    }

    // Send a compute message and return the first error response, or null on timeout.
    async function firstError(computePayload, timeoutMs = 8000) {
        let ws;
        try {
            ws = await connect();
            ws.send(JSON.stringify(computePayload));
            const msg = await waitForMessage(ws, m => m.type === 'error', timeoutMs);
            ws.close();
            return msg;
        } catch (e) {
            try { ws?.close(); } catch (_) {}
            return null;
        }
    }

    // 2.1  Missing incidents field
    {
        const errMsg = await firstError({
            type: 'compute',
            data: { n: 3, mode: 'stationary', barangay: 'Commonwealth' }
        });
        ok('Missing incidents field produces error (not server crash)', errMsg !== null, errMsg, 'error object');
        ok('Missing incidents error has structure { type:error, data:{ message, fatal:true } }',
            isValidErrorStructure(errMsg), errMsg?.data, '{ message, fatal: true }');
    }

    // 2.2  n = 0
    {
        const errMsg = await firstError({
            type: 'compute',
            data: { incidents: VALID_INCIDENTS, n: 0, mode: 'stationary', barangay: 'Commonwealth' }
        });
        ok('n=0 produces error message', errMsg !== null, errMsg, 'error object');
        ok('n=0 error has correct structure { type:error, data:{ message, fatal:true } }',
            isValidErrorStructure(errMsg), errMsg?.data, '{ message, fatal: true }');
    }

    // 2.3  n = 2.5 (non-integer)
    {
        const errMsg = await firstError({
            type: 'compute',
            data: { incidents: VALID_INCIDENTS, n: 2.5, mode: 'stationary', barangay: 'Commonwealth' }
        });
        ok('n=2.5 produces error message', errMsg !== null, errMsg, 'error object');
        ok('n=2.5 error has correct structure { type:error, data:{ message, fatal:true } }',
            isValidErrorStructure(errMsg), errMsg?.data, '{ message, fatal: true }');
    }

    // 2.4  Invalid coordinate — lat > 90
    {
        const errMsg = await firstError({
            type: 'compute',
            data: {
                incidents: [{ lat: 91, lng: 121.09 }, { lat: 14.70, lng: 121.09 }],
                n: 1, mode: 'stationary', barangay: 'Commonwealth'
            }
        });
        ok('lat > 90 produces error message', errMsg !== null, errMsg, 'error object');
        ok('lat > 90 error has correct structure { type:error, data:{ message, fatal:true } }',
            isValidErrorStructure(errMsg), errMsg?.data, '{ message, fatal: true }');
    }

    // 2.5  Invalid barangay name (contains special characters)
    {
        const errMsg = await firstError({
            type: 'compute',
            data: {
                incidents: VALID_INCIDENTS, n: 3, mode: 'stationary',
                barangay: 'Invalid!@#Barangay<script>'
            }
        });
        ok('Invalid barangay name produces error message', errMsg !== null, errMsg, 'error object');
        ok('Invalid barangay error has correct structure { type:error, data:{ message, fatal:true } }',
            isValidErrorStructure(errMsg), errMsg?.data, '{ message, fatal: true }');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [3] Pipeline Message Sequence  (reused in [4])
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[3] Pipeline Message Sequence\n');
    console.log('  Sending compute (roaming, n=3) — waiting for pipeline_complete ...');

    let pipelineMsgs = [];   // all messages from the full pipeline run
    {
        let ws;
        try {
            ws = await connect();
            ws.send(JSON.stringify(VALID_COMPUTE));
            pipelineMsgs = await collectUntil(ws, isPipelineTerminal, 120000);
            ws.close();
        } catch (e) {
            console.log(`  ERROR collecting pipeline messages: ${e.message}`);
            try { ws?.close(); } catch (_) {}
        }
    }

    // Label each message for readability
    function msgLabel(m) {
        if (m.type === 'stage_start')    return `stage_start(${m.data?.stage})`;
        if (m.type === 'stage_complete') return `stage_complete(${m.data?.stage})`;
        if (m.type === 'stage_progress') return `stage_progress(${m.data?.stage})`;
        return m.type;
    }

    const allLabels  = pipelineMsgs.map(msgLabel);
    // Core labels — strip warnings and stage_progress for order checking
    const coreLabels = allLabels.filter(l =>
        l !== 'warning' && !l.startsWith('stage_progress'));

    // Fatal error check — print clearly so developer can diagnose
    const fatalErr = pipelineMsgs.find(m => m.type === 'error' && m.data?.fatal);
    if (fatalErr) {
        console.log(`  ⚠ Pipeline fatal error: ${fatalErr.data.message}`);
    }

    const has = (label) => allLabels.includes(label);

    ok('network_loaded received',       has('network_loaded'),    allLabels, 'includes network_loaded');
    ok('pipeline_start received',       has('pipeline_start'),    allLabels, 'includes pipeline_start');
    ok('stage_start(1) received',       has('stage_start(1)'),    allLabels, 'includes stage_start(1)');
    ok('stage_complete(1) received',    has('stage_complete(1)'), allLabels, 'includes stage_complete(1)');
    ok('stage_start(2) received',       has('stage_start(2)'),    allLabels, 'includes stage_start(2)');
    ok('stage_complete(2) received',    has('stage_complete(2)'), allLabels, 'includes stage_complete(2)');
    ok('stage_start(3) received',       has('stage_start(3)'),    allLabels, 'includes stage_start(3)');
    ok('stage_complete(3) received',    has('stage_complete(3)'), allLabels, 'includes stage_complete(3)');
    ok('stage_start(4) received (roaming mode)',    has('stage_start(4)'),    allLabels, 'includes stage_start(4)');
    ok('stage_complete(4) received (roaming mode)', has('stage_complete(4)'), allLabels, 'includes stage_complete(4)');
    ok('pipeline_complete received',    has('pipeline_complete'), allLabels, 'includes pipeline_complete');

    // Verify correct ordering — each expected core label must appear after the previous.
    const expectedCore = [
        'network_loaded', 'pipeline_start',
        'stage_start(1)', 'stage_complete(1)',
        'stage_start(2)', 'stage_complete(2)',
        'stage_start(3)', 'stage_complete(3)',
        'stage_start(4)', 'stage_complete(4)',
        'pipeline_complete'
    ];
    let orderOk = true, searchFrom = 0;
    for (const expected of expectedCore) {
        const idx = coreLabels.indexOf(expected, searchFrom);
        if (idx === -1) { orderOk = false; break; }
        searchFrom = idx + 1;
    }
    ok('Messages arrive in correct order (no stage skipped or out of order)', orderOk, coreLabels, expectedCore);

    // No stage repeated in core sequence
    const stageStartCount    = coreLabels.filter(l => l.startsWith('stage_start')).length;
    const stageCompleteCount = coreLabels.filter(l => l.startsWith('stage_complete')).length;
    ok('Exactly 4 stage_start messages (no stage skipped or repeated)',
        stageStartCount === 4, stageStartCount, 4);
    ok('Exactly 4 stage_complete messages (no stage skipped or repeated)',
        stageCompleteCount === 4, stageCompleteCount, 4);

    // stage_progress fires during Stage 2 with patrolPositions array
    const s2Progress = pipelineMsgs.filter(m => m.type === 'stage_progress' && m.data?.stage === 2);
    ok('stage_progress fires at least once during Stage 2',
        s2Progress.length > 0, s2Progress.length, '>0');
    const s2ProgressHasPositions = s2Progress.some(m => Array.isArray(m.data?.patrolPositions));
    ok('stage_progress Stage 2 contains patrolPositions array',
        s2ProgressHasPositions, s2ProgressHasPositions, true);

    // ══════════════════════════════════════════════════════════════════════════
    // [4] Stage Result Correctness  (uses pipelineMsgs from [3])
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[4] Stage Result Correctness\n');

    function stageComplete(stage) {
        return pipelineMsgs.find(m => m.type === 'stage_complete' && m.data?.stage === stage);
    }

    const sc1 = stageComplete(1);
    const sc2 = stageComplete(2);
    const sc3 = stageComplete(3);
    const sc4 = stageComplete(4);
    const pcMsg = pipelineMsgs.find(m => m.type === 'pipeline_complete');

    // Stage 1
    {
        const r = sc1?.data?.result;
        ok('Stage 1 result: hull is array with ≥3 vertices',
            Array.isArray(r?.hull) && r.hull.length >= 3, r?.hull?.length, '>=3');
        ok('Stage 1 result: hullArea > 0',
            typeof r?.hullArea === 'number' && r.hullArea > 0, r?.hullArea, '>0');
        ok('Stage 1 result: validCandidateCount > 0',
            typeof r?.validCandidateCount === 'number' && r.validCandidateCount > 0,
            r?.validCandidateCount, '>0');
    }

    // Stage 2
    {
        const r = sc2?.data?.result;
        ok('Stage 2 result: patrols array has exactly n=3 entries',
            Array.isArray(r?.patrols) && r.patrols.length === 3, r?.patrols?.length, 3);

        const p0 = r?.patrols?.[0];
        ok('Stage 2 result: patrol[0] has id (string)',
            typeof p0?.id === 'string' && p0.id.length > 0, typeof p0?.id, 'string');
        ok('Stage 2 result: patrol[0] has lat (number)',
            typeof p0?.lat === 'number', typeof p0?.lat, 'number');
        ok('Stage 2 result: patrol[0] has lng (number)',
            typeof p0?.lng === 'number', typeof p0?.lng, 'number');
        ok('Stage 2 result: patrol[0] has color (string)',
            typeof p0?.color === 'string' && p0.color.startsWith('#'), p0?.color, '#rrggbb');
        ok('Stage 2 result: confidence is between 0 and 100',
            typeof r?.confidence === 'number' && r.confidence >= 0 && r.confidence <= 100,
            r?.confidence, '0–100');
    }

    // Stage 3
    {
        const r = sc3?.data?.result;
        ok('Stage 3 result: zones array has exactly n=3 entries',
            Array.isArray(r?.zones) && r.zones.length === 3, r?.zones?.length, 3);
        ok('Stage 3 result: avgSnappingDist > 0',
            typeof r?.avgSnappingDist === 'number' && r.avgSnappingDist > 0,
            r?.avgSnappingDist, '>0');
    }

    // Stage 4
    {
        const r = sc4?.data?.result;
        ok('Stage 4 result: routes is an array',
            Array.isArray(r?.routes), typeof r?.routes, 'array');

        // Find a non-trivial route (multi-node) to check structure
        const multiRoute = (r?.routes ?? []).find(rt => !rt.isEmpty && !rt.isSingleNode);
        if (multiRoute) {
            ok('Stage 4 result: non-trivial route has sequence array',
                Array.isArray(multiRoute.sequence), typeof multiRoute.sequence, 'array');
            ok('Stage 4 result: non-trivial route has circuitDistanceM (number)',
                typeof multiRoute.circuitDistanceM === 'number', typeof multiRoute.circuitDistanceM, 'number');
            ok('Stage 4 result: non-trivial route has pathSegments array',
                Array.isArray(multiRoute.pathSegments), typeof multiRoute.pathSegments, 'array');
        } else {
            // All zones are empty/single — check any route object
            const anyRoute = (r?.routes ?? [])[0];
            ok('Stage 4 result: route object exists (isEmpty or isSingleNode)',
                anyRoute !== undefined, anyRoute, 'route object');
            ok('Stage 4 result: route has patrolId',
                typeof anyRoute?.patrolId === 'string', typeof anyRoute?.patrolId, 'string');
            ok('Stage 4 result: route has pathSegments (may be empty array)',
                Array.isArray(anyRoute?.pathSegments), typeof anyRoute?.pathSegments, 'array');
        }
    }

    // pipeline_complete
    {
        const d = pcMsg?.data;
        ok('pipeline_complete has hull with ≥3 vertices',
            Array.isArray(d?.hull) && d.hull.length >= 3, d?.hull?.length, '>=3');
        ok('pipeline_complete has patrols array (length=3)',
            Array.isArray(d?.patrols) && d.patrols.length === 3, d?.patrols?.length, 3);
        ok('pipeline_complete has zones array',
            Array.isArray(d?.zones), typeof d?.zones, 'array');
        ok('pipeline_complete has routes array (roaming mode)',
            Array.isArray(d?.routes), typeof d?.routes, 'array');
        ok('pipeline_complete has verificationReport (object)',
            d?.verificationReport !== null && typeof d?.verificationReport === 'object',
            typeof d?.verificationReport, 'object');
        ok('verificationReport has overallPass (boolean)',
            typeof d?.verificationReport?.overallPass === 'boolean',
            typeof d?.verificationReport?.overallPass, 'boolean');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [5] Caching Behavior
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[5] Caching Behavior\n');

    {
        // Run the pipeline a second time on a fresh connection.
        // The network data must already be in the in-memory cache from the [3] run.
        let ws5;
        let run2Msgs = [];
        try {
            ws5 = await connect();
            console.log('  Sending second compute request — checking cache hit ...');
            ws5.send(JSON.stringify(VALID_COMPUTE));
            run2Msgs = await collectUntil(ws5, isPipelineTerminal, 120000);
            ws5.close();
        } catch (e) {
            console.log(`  ERROR in caching test: ${e.message}`);
            try { ws5?.close(); } catch (_) {}
        }

        const netLoaded2  = run2Msgs.find(m => m.type === 'network_loaded');
        const pc2         = run2Msgs.find(m => m.type === 'pipeline_complete');
        ok('Second compute request: network_loaded has fromCache: true',
            netLoaded2?.data?.fromCache === true, netLoaded2?.data?.fromCache, true);
        ok('Second compute request: pipeline completes successfully after cache hit',
            pc2 !== undefined, !!pc2, true);

        // Dijkstra cache from Stage 3 must produce hits in Stage 4
        const sc4Run1 = sc4; // sc4 was populated from the [3] run
        ok('Stage 4 Dijkstra cache hits > 0 (shared from Stage 3)',
            (sc4Run1?.data?.result?.totalCacheHits ?? 0) > 0,
            sc4Run1?.data?.result?.totalCacheHits, '>0');
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [6] Cancellation and Disconnection
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[6] Cancellation and Disconnection\n');

    // 6.1  Abrupt disconnect mid-pipeline: server must not crash.
    {
        let wsDisconnect;
        try {
            wsDisconnect = await connect();
            wsDisconnect.send(JSON.stringify(VALID_COMPUTE));
            await sleep(300);          // let pipeline start
            wsDisconnect.terminate(); // hard close — simulates client crash
            await sleep(1500);        // give server time to handle close event

            // Verify server is still accepting new connections
            const checkWs = await connect(6000);
            checkWs.close();
            ok('Server survives abrupt client disconnect mid-pipeline', true);
        } catch (e) {
            ok('Server survives abrupt client disconnect mid-pipeline', false, e.message, 'server still alive');
            try { wsDisconnect?.terminate(); } catch (_) {}
        }
    }

    // 6.2  Cancel message during Stage 2: pipeline must stop before Stage 3 begins.
    //      Mechanism: cancel is processed at the yieldToEventLoop() call between
    //      stage_complete(2) and stage_start(3) in pipeline.js.
    {
        let wsCancel;
        try {
            wsCancel = await connect();

            let cancelSent    = false;
            let resolved      = false;
            const cancelMsgs  = [];

            await new Promise((resolve) => {
                const outerTimer = setTimeout(() => {
                    if (!resolved) { resolved = true; resolve(); }
                }, 60000);

                wsCancel.on('message', (raw) => {
                    const m = JSON.parse(raw.toString());
                    cancelMsgs.push(m);

                    // Send cancel immediately when Stage 2 starts
                    if (m.type === 'stage_start' && m.data?.stage === 2 && !cancelSent) {
                        cancelSent = true;
                        wsCancel.send(JSON.stringify({ type: 'cancel' }));
                    }

                    // After stage_complete(2), give the server 4 s to potentially
                    // send stage_start(3) — if it does, we catch it.
                    if (cancelSent && m.type === 'stage_complete' && m.data?.stage === 2) {
                        setTimeout(() => {
                            if (!resolved) {
                                clearTimeout(outerTimer);
                                wsCancel.removeAllListeners('message');
                                resolved = true;
                                resolve();
                            }
                        }, 4000);
                    }

                    // If pipeline completes anyway, resolve immediately
                    if (isPipelineTerminal(m) && !resolved) {
                        clearTimeout(outerTimer);
                        wsCancel.removeAllListeners('message');
                        resolved = true;
                        resolve();
                    }
                });

                wsCancel.send(JSON.stringify(VALID_COMPUTE));
            });

            const hadStage3Start    = cancelMsgs.some(m => m.type === 'stage_start'    && m.data?.stage === 3);
            const hadPipelineComplete = cancelMsgs.some(m => m.type === 'pipeline_complete');

            ok('Cancel sent during Stage 2: Stage 3 does not start',
                !hadStage3Start, hadStage3Start, false);
            ok('Cancel sent during Stage 2: pipeline_complete is not sent',
                !hadPipelineComplete, hadPipelineComplete, false);

            wsCancel.close();
        } catch (e) {
            ok('Cancel sent during Stage 2: Stage 3 does not start', false, e.message, false);
            ok('Cancel sent during Stage 2: pipeline_complete is not sent', false, e.message, false);
            try { wsCancel?.close(); } catch (_) {}
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // [7] Error Recovery
    // ══════════════════════════════════════════════════════════════════════════
    console.log('\n[7] Error Recovery\n');

    // After receiving a fatal error, the same connection should accept and process
    // a valid compute request correctly — no restart required.
    {
        let wsRecovery;
        try {
            wsRecovery = await connect();

            // Trigger a fatal validation error
            wsRecovery.send(JSON.stringify({
                type: 'compute',
                data: { incidents: null, n: 3, mode: 'stationary', barangay: 'Commonwealth' }
            }));
            const fatalErrMsg = await waitForMessage(wsRecovery, m => m.type === 'error', 8000);
            ok('After fatal error: error message received on connection',
                fatalErrMsg?.type === 'error' && fatalErrMsg?.data?.fatal === true,
                fatalErrMsg?.type, 'error (fatal:true)');

            // Now send a valid compute request — it must complete successfully
            console.log('  Sending valid compute after fatal error — waiting for pipeline_complete ...');
            wsRecovery.send(JSON.stringify(VALID_COMPUTE));
            const recoveryMsgs = await collectUntil(wsRecovery, isPipelineTerminal, 120000);
            const recoveryComplete = recoveryMsgs.some(m => m.type === 'pipeline_complete');
            ok('After fatal error: same connection processes next valid compute correctly',
                recoveryComplete, recoveryComplete, true);

            wsRecovery.close();
        } catch (e) {
            ok('After fatal error: error message received on connection', false, e.message, 'error');
            ok('After fatal error: same connection processes next valid compute correctly', false, e.message, true);
            try { wsRecovery?.close(); } catch (_) {}
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Final summary
    // ══════════════════════════════════════════════════════════════════════════
    const total = pass + fail;
    console.log('\n' + '='.repeat(62));
    console.log(`  Total: ${total} tests — ${pass} passed, ${fail} failed`);
    if (fail === 0) {
        console.log('  ALL TESTS PASSED');
    } else {
        console.log(`  ${fail} TEST(S) FAILED`);
        process.exitCode = 1;
    }
    console.log('='.repeat(62));
}

runTests().catch((err) => {
    console.error('\nTest runner crashed unexpectedly:', err);
    process.exitCode = 1;
});
