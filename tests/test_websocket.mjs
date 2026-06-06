// tests/test_websocket.mjs
// WebSocket integration tests — requires server running at ws://localhost:3000
// Run: node tests/test_websocket.mjs

import WebSocket from 'ws';

const WS_URL = 'ws://localhost:3000';

// 5 Commonwealth incidents — confirmed inside the road network (lng 121.075–121.092)
const INCIDENTS = [
    { lat: 14.7000, lng: 121.0780 },
    { lat: 14.7120, lng: 121.0780 },
    { lat: 14.7120, lng: 121.0900 },
    { lat: 14.7000, lng: 121.0900 },
    { lat: 14.7060, lng: 121.0840 }
];

// ── Runner ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function ok(id, label)                       { console.log(`  PASS  [${id}] ${label}`); passed++; }
function fail(id, label, extra = '')         { console.log(`  FAIL  [${id}] ${label}${extra ? ' — ' + extra : ''}`); failed++; failures.push(id); }
function assert(cond, id, label, extra = '') { cond ? ok(id, label) : fail(id, label, extra); }

// ── Client factory ────────────────────────────────────────────────────────────
// Attaches message collection BEFORE the open event fires so no messages are lost.

function makeClient() {
    const msgs = [];                 // all received messages — never cleared
    const listeners = new Set();     // active next() predicates

    const ws = new WebSocket(WS_URL);

    // Attach IMMEDIATELY — before open fires — so `connected` is never missed
    ws.on('message', raw => {
        const m = JSON.parse(raw.toString());
        msgs.push(m);
        for (const fn of listeners) fn(m);
    });

    const ready = new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            ws.terminate();
            const err = new Error(`Cannot connect to ${WS_URL} — is the server running? (npm start)`);
            err.code = 'ENOSERVER';
            reject(err);
        }, 5000);
        ws.on('open',  () => { clearTimeout(t); resolve(); });
        ws.on('error', err => { clearTimeout(t); reject(err); });
    });

    // Resolves with the first message (in buffer or future) satisfying pred.
    // Does NOT remove the message from msgs so all callers can inspect msgs freely.
    function next(pred, timeoutMs = 30000, label = '') {
        const hit = msgs.find(pred);
        if (hit) return Promise.resolve(hit);

        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                listeners.delete(fn);
                reject(new Error(
                    `Timeout (${timeoutMs}ms)${label ? ' waiting for ' + label : ''}. ` +
                    `Got: [${msgs.map(m => m.type).join(', ')}]`
                ));
            }, timeoutMs);

            function fn(m) {
                if (pred(m)) {
                    clearTimeout(t);
                    listeners.delete(fn);
                    resolve(m);
                }
            }
            listeners.add(fn);
        });
    }

    function send(obj) { ws.send(JSON.stringify(obj)); }

    return { ws, msgs, ready, next, send, close: () => ws.close(), terminate: () => ws.terminate() };
}

// ── Test 1: Happy path ────────────────────────────────────────────────────────

async function testHappyPath() {
    console.log('\nTest 1 — happy path: 5 incidents, n=3, roaming mode');

    const c = makeClient();
    await c.ready;

    // Register listener BEFORE sending so we don't miss early stage_completes
    // 120s — first run may need to fetch from Overpass API (30–60s) before pipeline runs
    const pcPromise = c.next(m => m.type === 'pipeline_complete', 120000, 'pipeline_complete');

    c.send({ type: 'compute', data: { incidents: INCIDENTS, n: 3, mode: 'roaming', barangay: 'Commonwealth' } });

    let pc;
    try {
        pc = await pcPromise;
    } finally {
        c.close();
    }

    // stage_complete messages in order 1 → 4
    const stageNums = c.msgs
        .filter(m => m.type === 'stage_complete')
        .map(m => m.data.stage);

    assert(stageNums.length === 4,
        'T1-1', '4 stage_complete messages received',
        `got ${JSON.stringify(stageNums)}`);

    assert(JSON.stringify(stageNums) === '[1,2,3,4]',
        'T1-2', 'stage_complete arrive in order 1–4',
        `got ${JSON.stringify(stageNums)}`);

    // pipeline_complete fields
    const d = pc.data;

    assert(Array.isArray(d.hull) && d.hull.length >= 3,
        'T1-3', 'hull is array with ≥3 vertices',
        `length=${d.hull?.length}`);

    assert(Array.isArray(d.patrols) && d.patrols.length === 3,
        'T1-4', 'patrols array has 3 entries',
        `length=${d.patrols?.length}`);

    assert(Array.isArray(d.zones) && d.zones.length === 3,
        'T1-5', 'zones array has 3 entries',
        `length=${d.zones?.length}`);

    assert(d.routes !== null && d.routes !== undefined,
        'T1-6', 'routes present in pipeline_complete',
        `routes=${JSON.stringify(d.routes)?.slice(0, 80)}`);
}

// ── Test 2: Invalid inputs → error, not crash ─────────────────────────────────

async function testInvalidInputs() {
    console.log('\nTest 2 — invalid inputs produce error message, not server crash');

    // n=0
    {
        const c = makeClient();
        await c.ready;
        const errP = c.next(m => m.type === 'error', 5000, 'error for n=0');
        c.send({ type: 'compute', data: { incidents: INCIDENTS, n: 0, mode: 'roaming', barangay: 'Commonwealth' } });
        const err = await errP;
        c.close();
        assert(!!err,                                        'T2-1', 'n=0 → error message received');
        assert(typeof err.data.message === 'string' && err.data.message.length > 0,
            'T2-2', 'error.data.message is a non-empty string');
    }

    // empty incidents array
    {
        const c = makeClient();
        await c.ready;
        const errP = c.next(m => m.type === 'error', 5000, 'error for empty incidents');
        c.send({ type: 'compute', data: { incidents: [], n: 3, mode: 'roaming', barangay: 'Commonwealth' } });
        const err = await errP;
        c.close();
        assert(!!err, 'T2-3', 'empty incidents array → error message received');
    }

    // invalid mode value
    {
        const c = makeClient();
        await c.ready;
        const errP = c.next(m => m.type === 'error', 5000, 'error for invalid mode');
        c.send({ type: 'compute', data: { incidents: INCIDENTS, n: 3, mode: 'teleport', barangay: 'Commonwealth' } });
        const err = await errP;
        c.close();
        assert(!!err, 'T2-4', 'invalid mode → error message received');
    }

    // malformed JSON — server must respond with error, not crash
    {
        const c = makeClient();
        await c.ready;
        const errP = c.next(m => m.type === 'error', 5000, 'error for malformed JSON');
        c.ws.send('not json at all!!!');
        const err = await errP;
        c.close();
        assert(!!err, 'T2-5', 'malformed JSON → error message, server stays up');
    }
}

// ── Test 3: Ping → pong ───────────────────────────────────────────────────────

async function testPingPong() {
    console.log('\nTest 3 — ping → pong');

    const c = makeClient();
    await c.ready;
    const pongP = c.next(m => m.type === 'pong', 3000, 'pong');
    c.send({ type: 'ping' });
    const pong = await pongP;
    c.close();

    assert(!!pong, 'T3-1', 'received pong in response to ping');
}

// ── Test 4: Disconnect mid-pipeline → server stays alive ─────────────────────

async function testDisconnectMidPipeline() {
    console.log('\nTest 4 — disconnect mid-pipeline does not crash server');

    let disconnectedAfterStage1 = false;

    // First connection: send compute, disconnect after stage 1 completes
    await new Promise((resolve, reject) => {
        const c = makeClient();
        const timeout = setTimeout(
            () => { c.terminate(); reject(new Error('Timeout waiting for stage 1')); },
            120000
        );

        c.ready.then(() => {
            c.next(m => m.type === 'stage_complete' && m.data.stage === 1, 120000, 'stage_complete stage=1')
                .then(() => {
                    disconnectedAfterStage1 = true;
                    c.terminate();      // abrupt close — no clean WebSocket handshake
                    clearTimeout(timeout);
                    resolve();
                })
                .catch(err => { clearTimeout(timeout); reject(err); });

            c.send({ type: 'compute', data: { incidents: INCIDENTS, n: 3, mode: 'roaming', barangay: 'Commonwealth' } });
        }).catch(err => { clearTimeout(timeout); reject(err); });
    });

    assert(disconnectedAfterStage1, 'T4-1', 'client disconnected abruptly after stage 1');

    // Give the server 500ms to process the disconnect and update ws.cancelled
    await new Promise(r => setTimeout(r, 500));

    // New connection must work — proves server did not crash
    const c2 = makeClient();
    await c2.ready;
    const pongP = c2.next(m => m.type === 'pong', 3000, 'pong after disconnect');
    c2.send({ type: 'ping' });
    const pong = await pongP;
    c2.close();

    assert(!!pong, 'T4-2', 'server accepts new connections and responds after mid-pipeline disconnect');
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
    console.log('PatrolPoint WebSocket integration tests');
    console.log(`Target: ${WS_URL}`);
    console.log('─'.repeat(55));

    try {
        await testPingPong();
        await testInvalidInputs();
        await testHappyPath();             // full pipeline — may take 30-60s on cold start
        await testDisconnectMidPipeline(); // benefits from network cached by testHappyPath
    } catch (err) {
        if (err.code === 'ENOSERVER' || err.code === 'ECONNREFUSED') {
            console.error('\n' + err.message);
        } else {
            console.error('\nFatal test error:', err.message);
            if (err.stack) console.error(err.stack);
        }
        failed++;
        failures.push('FATAL');
    }

    console.log('\n' + '─'.repeat(55));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failures.length) console.log(`Failed: ${failures.join(', ')}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Unexpected:', err); process.exit(1); });
