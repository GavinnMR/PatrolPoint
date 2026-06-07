// test_part6.js — PatrolPoint Part 6 Comprehensive Tests
// Covers: rate limiting, input sanitization, auth middleware, sessions CRUD,
//         PDF/CSV export, and error recovery.
//
// Run: node test_part6.js   (server must be running: node server/index.js)
//
// Section execution order:
//   1  Sanitize unit tests  — no server needed
//   2  Auth middleware       — server required, no DB needed
//   3  Sessions             — server + DB (DB sections skipped if unavailable)
//   4  Export PDF           — server + optional DB
//   5  Export CSV           — server + optional DB
//   6  Error recovery       — server required
//   7  Rate limiting        — RUNS LAST (exhausts the /api request budget)

import 'dotenv/config';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import {
    validateIncidents,
    validateN,
    validateMode,
    validateConfig,
    validateBarangay
} from './server/middleware/sanitize.js';

const BASE   = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000';

// ── Test infrastructure ───────────────────────────────────────────────────────

let pass = 0, fail = 0, skipped = 0;
let apiRequestCount = 0; // tracks /api requests for rate-limit budget

function section(name) {
    console.log(`\n${'─'.repeat(68)}`);
    console.log(`  ${name}`);
    console.log('─'.repeat(68));
}

function ok(label, cond, got, want) {
    if (cond) {
        console.log(`  PASS  ${label}`);
        pass++;
    } else {
        console.log(`  FAIL  ${label}`);
        if (got  !== undefined) console.log(`          got : ${JSON.stringify(got)?.slice(0, 120)}`);
        if (want !== undefined) console.log(`          want: ${JSON.stringify(want)?.slice(0, 120)}`);
        fail++;
    }
}

function skip(label, reason) {
    console.log(`  SKIP  ${label} — ${reason}`);
    skipped++;
}

// Verify fn() throws and the message contains expectedSub (case-insensitive)
function assertThrows(label, fn, expectedSub) {
    try {
        fn();
        ok(label, false, 'no throw', `throw containing "${expectedSub}"`);
    } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
        const hit = !expectedSub || msg.includes(expectedSub.toLowerCase());
        ok(label, hit, `"${msg.slice(0, 80)}"`, `contains "${expectedSub}"`);
    }
}

function assertNoThrow(label, fn) {
    try { fn(); ok(label, true); }
    catch (e) { ok(label, false, e.message, 'no throw'); }
}

// HTTP helper — increments apiRequestCount for /api paths
async function api(method, path, body, token) {
    if (path.startsWith('/api')) apiRequestCount++;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch(`${BASE}${path}`, opts);
}

// WebSocket helper — resolves once 'connected' message received
function wsConnect(timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(WS_URL);
        const t = setTimeout(() => {
            settled = true; ws.terminate();
            reject(new Error('WS timeout'));
        }, timeoutMs);
        ws.on('error', err => {
            if (!settled) { settled = true; clearTimeout(t); reject(err); }
        });
        ws.on('message', raw => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'connected' && !settled) {
                settled = true; clearTimeout(t); resolve(ws);
            }
        });
    });
}

// Unique suffix so test users never collide across runs
const RUN   = Date.now();
const USER1 = { username: `pp_u1_${RUN}`, password: 'Password1!', displayName: 'Test User One' };
const USER2 = { username: `pp_u2_${RUN}`, password: 'Password2@', displayName: 'Test User Two' };

// Realistic results payload used by both export and session save tests
const RESULTS = {
    hull: [
        { lat: 14.700, lng: 121.090 },
        { lat: 14.710, lng: 121.090 },
        { lat: 14.705, lng: 121.100 }
    ],
    patrols: [
        { id: 1, nodeId: 'n100', lat: 14.7023, lng: 121.0934, color: '#e74c3c' },
        { id: 2, nodeId: 'n200', lat: 14.7045, lng: 121.0950, color: '#3498db' }
    ],
    zones: [
        [{ crimeId: 'CRIME-001', lat: 14.7020, lng: 121.0930, snappedNodeId: 'n101' }],
        [{ crimeId: 'CRIME-002', lat: 14.7048, lng: 121.0955, snappedNodeId: 'n201' }]
    ],
    routes: [
        { patrolId: 1, sequence: ['n100', 'n101'], circuitDistanceM: 150.5, pathSegments: [] },
        { patrolId: 2, sequence: ['n200', 'n201'], circuitDistanceM: 200.3, pathSegments: [] }
    ]
};

const SESSION_BODY = {
    session_name:    `Part6 Test ${RUN}`,
    barangay_name:   'Commonwealth',
    n_patrols:       2,
    deployment_mode: 'roaming',
    incidents:       [{ lat: 14.7020, lng: 121.0930 }, { lat: 14.7048, lng: 121.0955 }],
    config:          { hillClimbing: { restarts: 10, maxIterations: 500, radiusMultiplier: 2 } },
    results:         RESULTS,
    trace:           { stage1: { status: 'success' }, stage2: { status: 'success' } },
    total_runtime_ms: 1234
};

// Direct export body — provides results inline, no sessionId needed
const EXPORT_DIRECT = {
    barangay_name:   'Commonwealth',
    n_patrols:       2,
    deployment_mode: 'roaming',
    config:          { hillClimbing: { restarts: 10 } },
    results:         RESULTS
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Sanitize unit tests (no server needed)
// ═══════════════════════════════════════════════════════════════════════════════

section('SECTION 1A — validateIncidents');

assertThrows('empty array',               () => validateIncidents([]),                                           'at least 1');
assertThrows('301 elements (> 300 max)',  () => validateIncidents(Array(301).fill({ lat: 14.7, lng: 121.0 })), '300');
assertThrows('null element',              () => validateIncidents([null]),                                        'object');
assertThrows('undefined element',         () => validateIncidents([undefined]),                                  'object');
assertThrows('primitive element (42)',    () => validateIncidents([42]),                                         'object');
assertThrows('element missing lat',       () => validateIncidents([{ lng: 121.0 }]),                            'number');
assertThrows('element missing lng',       () => validateIncidents([{ lat: 14.7 }]),                             'number');
assertThrows('lat above 90',             () => validateIncidents([{ lat:  91,  lng: 121.0 }]),                  '90');
assertThrows('lat below -90',            () => validateIncidents([{ lat: -91,  lng: 121.0 }]),                  '90');
assertThrows('lng above 180',            () => validateIncidents([{ lat: 14.7, lng:  181  }]),                  '180');
assertThrows('lng below -180',           () => validateIncidents([{ lat: 14.7, lng: -181  }]),                  '180');
assertThrows('lat as string',            () => validateIncidents([{ lat: '14.7', lng: 121.0 }]),                'number');
assertThrows('lng as string',            () => validateIncidents([{ lat: 14.7,   lng: '121.0' }]),              'number');
assertThrows('lat = NaN',                () => validateIncidents([{ lat: NaN,    lng: 121.0 }]),                'number');
assertThrows('lng = Infinity',           () => validateIncidents([{ lat: 14.7,   lng: Infinity }]),             'number');
assertNoThrow('single valid element',    () => validateIncidents([{ lat: 14.7023, lng: 121.0934 }]));
assertNoThrow('exactly 300 elements',    () => validateIncidents(Array(300).fill({ lat: 14.7, lng: 121.0 })));
assertNoThrow('boundary ±90 / ±180',    () => validateIncidents([{ lat: 90, lng: 180 }, { lat: -90, lng: -180 }]));

section('SECTION 1B — validateN');

assertThrows('n = 0',            () => validateN(0),        'between 1');
assertThrows('n = -1',           () => validateN(-1),       'between 1');
assertThrows('n = 101 (> 100)', () => validateN(101),      'between 1');
assertThrows('n = 2.5 decimal', () => validateN(2.5),      'whole number');
assertThrows('n = 0.9 decimal', () => validateN(0.9),      'whole number');
assertThrows('n as string "5"', () => validateN('5'),      'whole number');
assertThrows('n = NaN',         () => validateN(NaN),      'whole number');
assertThrows('n = Infinity',    () => validateN(Infinity), 'whole number');
assertNoThrow('n = 1',          () => validateN(1));
assertNoThrow('n = 30',         () => validateN(30));
assertNoThrow('n = 100',        () => validateN(100));

section('SECTION 1C — validateMode');

assertThrows('empty string',       () => validateMode(''),           'stationary');
assertThrows('random word',        () => validateMode('walking'),    'stationary');
assertThrows('null',               () => validateMode(null),         'stationary');
assertThrows('ROAMING uppercase',  () => validateMode('ROAMING'),   'stationary');
assertThrows('number 1',           () => validateMode(1),            'stationary');
assertNoThrow('"stationary"',      () => validateMode('stationary'));
assertNoThrow('"roaming"',         () => validateMode('roaming'));

section('SECTION 1D — validateBarangay');

assertThrows('empty string',               () => validateBarangay(''),                  'non-empty');
assertThrows('whitespace only',            () => validateBarangay('   '),               'non-empty');
assertThrows('256 chars (> 255 max)',      () => validateBarangay('a'.repeat(256)),     '255');
assertThrows('contains <script> tag',      () => validateBarangay('<script>alert(1)'),  'alphanumeric');
assertThrows('SQL injection ; DROP TABLE', () => validateBarangay('x; DROP TABLE u'),   'alphanumeric');
assertThrows('contains forward slash',     () => validateBarangay('a/b'),               'alphanumeric');
assertThrows('contains dot',               () => validateBarangay('Commonwealth.QC'),   'alphanumeric');
assertThrows('contains ampersand',         () => validateBarangay('A & B'),              'alphanumeric');
assertNoThrow('"Commonwealth"',            () => validateBarangay('Commonwealth'));
assertNoThrow('alphanumeric with spaces',  () => validateBarangay('Barangay 101 A'));
assertNoThrow('exactly 255 chars',         () => validateBarangay('a'.repeat(255)));

section('SECTION 1E — validateConfig');

assertThrows('restarts = 0',              () => validateConfig({ hillClimbing: { restarts: 0 } }),               'restarts');
assertThrows('restarts = 101',            () => validateConfig({ hillClimbing: { restarts: 101 } }),              'restarts');
assertThrows('maxIterations = 0',         () => validateConfig({ hillClimbing: { maxIterations: 0 } }),           'maxIterations');
assertThrows('maxIterations = 10001',     () => validateConfig({ hillClimbing: { maxIterations: 10001 } }),       'maxIterations');
assertThrows('radiusMultiplier = 0',      () => validateConfig({ hillClimbing: { radiusMultiplier: 0 } }),        'radiusMultiplier');
assertThrows('radiusMultiplier = 21',     () => validateConfig({ hillClimbing: { radiusMultiplier: 21 } }),       'radiusMultiplier');
assertThrows('synchronousMode = "true"',  () => validateConfig({ hillClimbing: { synchronousMode: 'true' } }),   'boolean');
assertThrows('synchronousMode = 1',       () => validateConfig({ hillClimbing: { synchronousMode: 1 } }),        'boolean');
assertThrows('outlierMultiplier = 0',     () => validateConfig({ convexHull: { outlierMultiplier: 0 } }),        'outlierMultiplier');
assertThrows('outlierMultiplier = 11',    () => validateConfig({ convexHull: { outlierMultiplier: 11 } }),       'outlierMultiplier');
assertThrows('areaThresholdDivisor = 0',  () => validateConfig({ convexHull: { areaThresholdDivisor: 0 } }),    'areaThresholdDivisor');
assertThrows('collinearityEpsilon = 0',   () => validateConfig({ convexHull: { collinearityEpsilon: 0 } }),     'collinearityEpsilon');
assertThrows('collinearityEpsilon neg',   () => validateConfig({ convexHull: { collinearityEpsilon: -1e-10 } }), 'collinearityEpsilon');
assertThrows('maxCrimeNodes = 0',         () => validateConfig({ tsp: { maxCrimeNodesPerZone: 0 } }),            'maxCrimeNodesPerZone');
assertThrows('maxCrimeNodes = 51',        () => validateConfig({ tsp: { maxCrimeNodesPerZone: 51 } }),           'maxCrimeNodesPerZone');
assertThrows('boundingBoxEpsilon = 0',    () => validateConfig({ snapping: { boundingBoxEpsilon: 0 } }),        'boundingBoxEpsilon');
assertThrows('boundingBoxEpsilon < 0',    () => validateConfig({ snapping: { boundingBoxEpsilon: -1 } }),       'boundingBoxEpsilon');
assertThrows('initialSearchRadius = 0',   () => validateConfig({ snapping: { initialSearchRadiusMeters: 0 } }), 'initialSearchRadiusMeters');
assertNoThrow('null config — no-op',      () => validateConfig(null));
assertNoThrow('empty object — no-op',     () => validateConfig({}));
assertNoThrow('valid full config', () => validateConfig({
    hillClimbing: { restarts: 10, maxIterations: 500, radiusMultiplier: 2, synchronousMode: false },
    convexHull:   { outlierMultiplier: 2.5, areaThresholdDivisor: 100, collinearityEpsilon: 1e-10 },
    tsp:          { maxCrimeNodesPerZone: 10 },
    snapping:     { boundingBoxEpsilon: 1e-7, initialSearchRadiusMeters: 500 }
}));

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP / WebSocket sections — require running server
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {

    // ── Server liveness check ─────────────────────────────────────────────────
    try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`status ${r.status}`);
    } catch (e) {
        console.error(`\n  ERROR: server not reachable at ${BASE} — ${e.message}`);
        console.error('  Start it with: node server/index.js\n');
        process.exit(1);
    }

    // ── Database availability probe ───────────────────────────────────────────
    // A 400 or 401 means the route reached the DB (or passed without needing it).
    // A 500 typically means DB connection refused.
    let dbAvailable = false;
    try {
        const probe = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: '__probe__', password: '__probe__' })
        });
        apiRequestCount++;
        dbAvailable = probe.status !== 500;
    } catch {}

    if (!dbAvailable) {
        console.log('\n  NOTE: Database appears unavailable (login probe returned 500).');
        console.log('  Sections that require DB (register/login, sessions CRUD, sessionId export)');
        console.log('  will be SKIPPED. All other sections run normally.\n');
    }

    // ── Sign a JWT directly with the env secret ───────────────────────────────
    // Used to test auth middleware and export routes without needing a real DB user.
    const FAKE_USER_ID = 42;
    const FAKE_USERNAME = `pp_fake_${RUN}`;
    const directToken = jwt.sign(
        { userId: FAKE_USER_ID, username: FAKE_USERNAME, barangay: 'Commonwealth' },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
    );

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 2A — Auth middleware: missing / malformed Authorization header
    // Uses GET /api/auth/me — protected by requireAuth, no DB needed for 401 paths
    // ─────────────────────────────────────────────────────────────────────────

    section('SECTION 2A — Auth middleware: missing / malformed header');

    {
        const r = await api('GET', '/api/auth/me');
        const b = await r.json();
        ok('no header → 401',                                    r.status === 401, r.status, 401);
        ok('no header → message mentions authorization token',   b.error?.toLowerCase().includes('authorization token'), b.error, '...authorization token...');
    }
    {
        // Wrong scheme — does not start with "Bearer "
        const r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: 'Token abc123' } });
        apiRequestCount++;
        const b = await r.json();
        ok('wrong scheme (Token) → 401',                         r.status === 401, r.status, 401);
        ok('wrong scheme → "authorization token" in message',    b.error?.toLowerCase().includes('authorization token'), b.error, '...authorization token...');
    }
    {
        // "Bearer" with no trailing space — startsWith('Bearer ') fails
        const r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: 'Bearer' } });
        apiRequestCount++;
        const b = await r.json();
        ok('"Bearer" (no space) → 401',                          r.status === 401, r.status, 401);
        ok('"Bearer" no space → authorization token message',    b.error?.toLowerCase().includes('authorization token'), b.error, '...authorization token...');
    }
    {
        // "Bearer " with only whitespace after — token is empty string, jwt.verify throws
        const r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: 'Bearer ' } });
        apiRequestCount++;
        ok('"Bearer " trailing space → 401 (no crash)',          r.status === 401, r.status, 401);
    }
    {
        // Clearly invalid token string
        const r = await fetch(`${BASE}/api/auth/me`, { headers: { Authorization: 'Bearer not.a.real.token' } });
        apiRequestCount++;
        const b = await r.json();
        ok('garbage token → 401',                                r.status === 401, r.status, 401);
        ok('garbage token → "Invalid authorization" message',    b.error?.toLowerCase().includes('invalid authorization'), b.error, '...Invalid authorization...');
    }

    section('SECTION 2B — Auth middleware: expired and wrong-secret tokens');

    {
        // Expired token — signed with correct secret, expiresIn -1s
        const expired = jwt.sign(
            { userId: 9999, username: 'ghost', barangay: 'Commonwealth' },
            process.env.JWT_SECRET,
            { expiresIn: '-1s' }
        );
        const r = await api('GET', '/api/auth/me', undefined, expired);
        const b = await r.json();
        ok('expired JWT → 401',                                  r.status === 401, r.status, 401);
        ok('expired JWT → "expired" in message',                 b.error?.toLowerCase().includes('expired'), b.error, '...expired...');
        ok('expired JWT message ≠ "Invalid authorization"',      !b.error?.toLowerCase().includes('invalid authorization'), b.error, 'NOT "Invalid authorization"');
    }
    {
        // Wrong secret — valid structure but signed with wrong key
        const wrongSig = jwt.sign(
            { userId: 9999, username: 'ghost', barangay: 'Commonwealth' },
            'totally-wrong-secret-xyz'
        );
        const r = await api('GET', '/api/auth/me', undefined, wrongSig);
        const b = await r.json();
        ok('wrong-secret JWT → 401',                             r.status === 401, r.status, 401);
        ok('wrong-secret JWT → "Invalid authorization" message', b.error?.toLowerCase().includes('invalid authorization'), b.error, '...Invalid authorization...');
        ok('wrong-secret JWT message ≠ "expired"',               !b.error?.toLowerCase().includes('expired'), b.error, 'NOT "expired"');
    }
    {
        // Completely garbled — not even a valid JWT structure
        const r = await api('GET', '/api/auth/me', undefined, 'this.is.garbage');
        const b = await r.json();
        ok('garbled JWT → 401',                                  r.status === 401, r.status, 401);
        ok('garbled JWT → "Invalid authorization" message',      b.error?.toLowerCase().includes('invalid authorization'), b.error, '...Invalid authorization...');
    }

    section('SECTION 2C — Auth middleware: valid JWT → next() called, req.user populated');

    {
        const r = await api('GET', '/api/auth/me', undefined, directToken);
        const b = await r.json();
        ok('valid JWT → 200',                     r.status === 200, r.status, 200);
        ok('valid JWT → user object returned',    !!b.user, !!b.user, true);
        ok('valid JWT → correct username',        b.user?.username === FAKE_USERNAME, b.user?.username, FAKE_USERNAME);
        ok('valid JWT → userId is a number',      typeof b.user?.userId === 'number', typeof b.user?.userId, 'number');
        ok('valid JWT → correct userId',          b.user?.userId === FAKE_USER_ID, b.user?.userId, FAKE_USER_ID);
        ok('valid JWT → barangay is a string',    typeof b.user?.barangay === 'string', typeof b.user?.barangay, 'string');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 3 — Sessions CRUD
    // ─────────────────────────────────────────────────────────────────────────

    section('SECTION 3A — Sessions: auth enforcement (no token → 401)');

    {
        const r = await api('GET', '/api/sessions');
        ok('GET /api/sessions without auth → 401',          r.status === 401, r.status, 401);
    }
    {
        const r = await api('POST', '/api/sessions', SESSION_BODY);
        ok('POST /api/sessions without auth → 401',         r.status === 401, r.status, 401);
    }
    {
        const r = await api('DELETE', '/api/sessions/1');
        ok('DELETE /api/sessions/:id without auth → 401',   r.status === 401, r.status, 401);
    }
    {
        const r = await api('GET', '/api/sessions/1');
        ok('GET /api/sessions/:id without auth → 401',      r.status === 401, r.status, 401);
    }

    // ── DB-dependent sessions tests ───────────────────────────────────────────

    let token1 = null, token2 = null, sessionId1 = null, sessionId2 = null;

    if (!dbAvailable) {
        const dbSections = [
            'SECTION 3B — Sessions: POST field validation',
            'SECTION 3C — Sessions: full CRUD lifecycle',
            'SECTION 3D — Sessions: DELETE ownership and 404 isolation'
        ];
        for (const s of dbSections) { section(s); skip('all tests', 'DB unavailable — start server with working DATABASE_URL'); }
    } else {

        // Register both test users
        await api('POST', '/api/auth/register', USER1);
        await api('POST', '/api/auth/register', USER2);
        const l1 = await (await api('POST', '/api/auth/login', { username: USER1.username, password: USER1.password })).json();
        const l2 = await (await api('POST', '/api/auth/login', { username: USER2.username, password: USER2.password })).json();
        token1 = l1.token;
        token2 = l2.token;

        // ── 3B: POST field validation ─────────────────────────────────────────

        section('SECTION 3B — Sessions: POST field validation');

        {
            // Only session_name provided — all required fields missing
            const r = await api('POST', '/api/sessions', { session_name: 'test only' }, token1);
            const b = await r.json();
            ok('POST missing all required fields → 400',             r.status === 400, r.status, 400);
            ok('error message names missing fields',                  b.error?.toLowerCase().includes('missing') || b.error?.toLowerCase().includes('n_patrols'), b.error, '...n_patrols...');
        }
        {
            const { results: _, ...noResults } = SESSION_BODY;
            const r = await api('POST', '/api/sessions', noResults, token1);
            ok('POST without results → 400',                         r.status === 400, r.status, 400);
        }
        {
            const { trace: _, ...noTrace } = SESSION_BODY;
            const r = await api('POST', '/api/sessions', noTrace, token1);
            ok('POST without trace → 400',                           r.status === 400, r.status, 400);
        }
        {
            const { incidents: _, ...noIncidents } = SESSION_BODY;
            const r = await api('POST', '/api/sessions', noIncidents, token1);
            ok('POST without incidents → 400',                       r.status === 400, r.status, 400);
        }

        // ── 3C: Full CRUD lifecycle ───────────────────────────────────────────

        section('SECTION 3C — Sessions: full CRUD lifecycle');

        // CREATE — user1 creates a session
        const postR = await api('POST', '/api/sessions', SESSION_BODY, token1);
        const postB = await postR.json();
        ok('POST session → 201',                       postR.status === 201,              postR.status, 201);
        ok('POST session → returns numeric id',        typeof postB.id === 'number',      typeof postB.id, 'number');
        ok('POST session → message is "Session saved"', postB.message === 'Session saved', postB.message, 'Session saved');
        sessionId1 = postB.id;

        // LIST — GET /api/sessions returns summary rows (no results, no trace)
        const listR = await api('GET', '/api/sessions', undefined, token1);
        const listB = await listR.json();
        ok('GET sessions → 200',                       listR.status === 200,              listR.status, 200);
        ok('GET sessions → response is array',         Array.isArray(listB),              typeof listB, 'array');
        const entry = listB.find(s => s.id === sessionId1);
        ok('GET sessions → created session is listed', !!entry,                           !!entry, true);
        ok('GET sessions → results field NOT returned', entry?.results === undefined,     entry?.results, undefined);
        ok('GET sessions → trace field NOT returned',   entry?.trace   === undefined,     entry?.trace,   undefined);
        ok('GET sessions → has id',                    typeof entry?.id === 'number',     typeof entry?.id, 'number');
        ok('GET sessions → has barangay_name',         entry?.barangay_name === 'Commonwealth', entry?.barangay_name, 'Commonwealth');
        ok('GET sessions → has n_patrols = 2',         Number(entry?.n_patrols) === 2,    entry?.n_patrols, 2);
        ok('GET sessions → has deployment_mode',       entry?.deployment_mode === 'roaming', entry?.deployment_mode, 'roaming');
        ok('GET sessions → has created_at string',     typeof entry?.created_at === 'string', typeof entry?.created_at, 'string');

        // GET BY ID — full session including results and trace
        const getR = await api('GET', `/api/sessions/${sessionId1}`, undefined, token1);
        const getB = await getR.json();
        ok('GET session/:id → 200',                    getR.status === 200,               getR.status, 200);
        ok('GET session/:id → results present',        getB.results !== null && getB.results !== undefined, !!getB.results, true);
        ok('GET session/:id → trace present',          getB.trace   !== null && getB.trace   !== undefined, !!getB.trace,   true);
        ok('GET session/:id → correct n_patrols',      Number(getB.n_patrols) === 2,      getB.n_patrols, 2);
        ok('GET session/:id → correct mode',           getB.deployment_mode === 'roaming', getB.deployment_mode, 'roaming');

        // Cross-user isolation: user2 requests user1's session → 404 (not 403)
        const crossR = await api('GET', `/api/sessions/${sessionId1}`, undefined, token2);
        ok('GET session with wrong-user token → 404 not 403', crossR.status === 404, crossR.status, 404);

        // Non-integer session ID → 400
        const badIdR = await api('GET', '/api/sessions/not-a-number', undefined, token1);
        ok('GET session with non-integer id → 400',    badIdR.status === 400, badIdR.status, 400);

        // Non-existent integer session ID → 404
        const noExistR = await api('GET', '/api/sessions/9999999', undefined, token1);
        ok('GET non-existent session → 404',           noExistR.status === 404, noExistR.status, 404);

        // Create user2's session for cross-user delete and export tests
        const post2R = await api('POST', '/api/sessions', SESSION_BODY, token2);
        sessionId2 = (await post2R.json()).id;
        ok('user2 session created successfully',       typeof sessionId2 === 'number', typeof sessionId2, 'number');

        // ── 3D: DELETE ownership ──────────────────────────────────────────────

        section('SECTION 3D — Sessions: DELETE ownership and 404 isolation');

        // Wrong-user delete → 404 (must not reveal existence via 403)
        const wrongDelR = await api('DELETE', `/api/sessions/${sessionId1}`, undefined, token2);
        ok('DELETE wrong user → 404 not 403',          wrongDelR.status === 404, wrongDelR.status, 404);

        // Session still exists after failed wrong-user delete
        const stillR = await api('GET', `/api/sessions/${sessionId1}`, undefined, token1);
        ok('session intact after wrong-user delete attempt', stillR.status === 200, stillR.status, 200);

        // Correct-user delete → 200
        const delR = await api('DELETE', `/api/sessions/${sessionId1}`, undefined, token1);
        const delB = await delR.json();
        ok('DELETE correct user → 200',                delR.status === 200,              delR.status, 200);
        ok('DELETE response message',                  delB.message === 'Session deleted', delB.message, 'Session deleted');

        // Verify session is gone
        const afterDelR = await api('GET', `/api/sessions/${sessionId1}`, undefined, token1);
        ok('GET deleted session → 404',                afterDelR.status === 404, afterDelR.status, 404);

        // Double-delete → 404 not 500
        const dblDelR = await api('DELETE', `/api/sessions/${sessionId1}`, undefined, token1);
        ok('double DELETE → 404 not 500',              dblDelR.status === 404, dblDelR.status, 404);

        // Non-integer id on DELETE → 400
        const badDelR = await api('DELETE', '/api/sessions/not-a-number', undefined, token1);
        ok('DELETE non-integer id → 400',              badDelR.status === 400, badDelR.status, 400);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 4 — Export PDF
    // ─────────────────────────────────────────────────────────────────────────

    section('SECTION 4A — Export PDF: auth enforcement');

    {
        const r = await api('POST', '/api/export/pdf', EXPORT_DIRECT);
        ok('PDF without auth → 401', r.status === 401, r.status, 401);
    }

    section('SECTION 4B — Export PDF: direct results (no DB needed)');

    {
        // Happy path — results provided directly in body
        const r = await api('POST', '/api/export/pdf', EXPORT_DIRECT, directToken);
        ok('PDF with direct results → 200',                       r.status === 200, r.status, 200);

        const ct = r.headers.get('content-type') || '';
        ok('PDF → Content-Type: application/pdf',                  ct.includes('application/pdf'), ct, 'application/pdf');

        const cd = r.headers.get('content-disposition') || '';
        ok('PDF → Content-Disposition: attachment',                cd.includes('attachment'), cd, 'attachment...');
        ok('PDF → Content-Disposition has filename',               cd.includes('filename'),   cd, 'filename=...');

        const buf = Buffer.from(await r.arrayBuffer());
        ok('PDF → starts with %PDF magic bytes',                   buf.slice(0, 4).toString() === '%PDF', buf.slice(0, 4).toString(), '%PDF');
        ok('PDF → non-empty body (> 1000 bytes)',                  buf.length > 1000,          buf.length, '> 1000');

        // Title is stored in PDF info metadata dictionary — readable in raw bytes
        const raw = buf.toString('latin1');
        ok('PDF → info.Title contains "PatrolPoint Deployment Plan"', raw.includes('PatrolPoint Deployment Plan'), '(PDF binary)', 'contains "PatrolPoint Deployment Plan"');
        ok('PDF → producer string "PDFKit" present',               raw.includes('PDFKit'),     '(PDF binary)', 'contains "PDFKit"');
    }
    {
        // Empty body — resolveExportData throws before any DB query
        const r = await api('POST', '/api/export/pdf', {}, directToken);
        ok('PDF with empty body → 400',                           r.status === 400, r.status, 400);
    }
    {
        // Non-integer sessionId — parseInt fails immediately
        const r = await api('POST', '/api/export/pdf', { sessionId: 'abc' }, directToken);
        ok('PDF with non-integer sessionId → 400',                r.status === 400, r.status, 400);
    }

    if (!dbAvailable) {
        section('SECTION 4C — Export PDF: sessionId path (DB required)');
        skip('PDF via sessionId', 'DB unavailable');
        section('SECTION 4D — Export PDF: cross-user isolation (DB required)');
        skip('PDF cross-user sessionId', 'DB unavailable');
    } else {
        section('SECTION 4C — Export PDF: sessionId path (DB required)');

        {
            // Non-existent sessionId → DB returns null → 404
            const r = await api('POST', '/api/export/pdf', { sessionId: 9999999 }, directToken);
            ok('PDF with non-existent sessionId → 404',           r.status === 404, r.status, 404);
        }
        {
            // Valid sessionId (user2's session) fetched by user2's token → 200
            const r = await api('POST', '/api/export/pdf', { sessionId: sessionId2 }, token2);
            ok('PDF from valid sessionId → 200',                  r.status === 200, r.status, 200);
            const ct = r.headers.get('content-type') || '';
            ok('PDF from sessionId → Content-Type: application/pdf', ct.includes('application/pdf'), ct, 'application/pdf');
        }

        section('SECTION 4D — Export PDF: cross-user isolation (DB required)');

        {
            // user1's directToken (userId=42) requesting user2's real session → 404
            const r = await api('POST', '/api/export/pdf', { sessionId: sessionId2 }, directToken);
            ok('PDF with wrong-user sessionId → 404',             r.status === 404, r.status, 404);
        }
        {
            // user2 token requesting a session that does not belong to user2 — create temp user1 session
            const tmpR = await api('POST', '/api/sessions', SESSION_BODY, token1);
            const tmpId = (await tmpR.json()).id;
            const r = await api('POST', '/api/export/pdf', { sessionId: tmpId }, token2);
            ok('PDF user2 requests user1 session → 404',          r.status === 404, r.status, 404);
            // Cleanup
            await api('DELETE', `/api/sessions/${tmpId}`, undefined, token1);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 5 — Export CSV
    // ─────────────────────────────────────────────────────────────────────────

    section('SECTION 5A — Export CSV: auth enforcement');

    {
        const r = await api('POST', '/api/export/csv', EXPORT_DIRECT);
        ok('CSV without auth → 401', r.status === 401, r.status, 401);
    }

    section('SECTION 5B — Export CSV: content and structure (no DB needed)');

    {
        const r = await api('POST', '/api/export/csv', EXPORT_DIRECT, directToken);
        ok('CSV with direct results → 200',                      r.status === 200, r.status, 200);

        const ct = r.headers.get('content-type') || '';
        ok('CSV → Content-Type: text/csv',                       ct.includes('text/csv'), ct, 'text/csv');

        const cd = r.headers.get('content-disposition') || '';
        ok('CSV → Content-Disposition: attachment',              cd.includes('attachment'), cd, 'attachment...');
        ok('CSV → Content-Disposition has filename',             cd.includes('filename'),   cd, 'filename=...');

        const text = await r.text();

        // Section markers
        ok('CSV → # patrol_positions section marker present',    text.includes('# patrol_positions'), text.slice(0, 300), '...');
        ok('CSV → # crime_nodes section marker present',         text.includes('# crime_nodes'),      text.slice(0, 600), '...');

        // Exact header rows
        ok('CSV → patrol_positions header row exact',
            text.includes('patrolId,lat,lng,zoneSize,circuitDistanceM,status'),
            'headers', 'patrolId,lat,lng,zoneSize,circuitDistanceM,status');
        ok('CSV → crime_nodes header row exact',
            text.includes('crimeId,lat,lng,assignedPatrolId'),
            'headers', 'crimeId,lat,lng,assignedPatrolId');

        // Row count verification
        const lines     = text.split('\n');
        const ppHdrIdx  = lines.findIndex(l => l.startsWith('patrolId,'));
        const cnHdrIdx  = lines.findIndex(l => l.startsWith('crimeId,'));

        // Patrol rows: between patrol header and crime_nodes section (skip blank separator)
        const patrolRows = lines.slice(ppHdrIdx + 1, cnHdrIdx - 1).filter(l => l.trim() && !l.startsWith('#'));
        // Crime node rows: everything after crime_nodes header
        const crimeRows  = lines.slice(cnHdrIdx + 1).filter(l => l.trim());

        // RESULTS has 2 patrols and 1 crime node per zone = 2 crime nodes total
        ok('CSV → 2 patrol rows matching RESULTS.patrols',  patrolRows.length === 2, patrolRows.length, 2);
        ok('CSV → 2 crime node rows matching zones total',  crimeRows.length  === 2, crimeRows.length,  2);

        // First patrol row structure and values
        if (patrolRows.length > 0) {
            const fields = patrolRows[0].split(',');
            ok('CSV patrol row → 6 columns',           fields.length === 6, fields.length, 6);
            ok('CSV patrol row → patrolId = 1',        fields[0] === '1',   fields[0], '1');
            ok('CSV patrol row → lat matches',         fields[1] === '14.7023', fields[1], '14.7023');
            ok('CSV patrol row → lng matches',         fields[2] === '121.0934', fields[2], '121.0934');
            ok('CSV patrol row → zoneSize = 1',        fields[3] === '1',   fields[3], '1');
            // zoneSize=1 → circuit is empty string (only filled for zoneSize > 1 roaming)
            ok('CSV patrol row → circuit empty for single-node zone', fields[4] === '', fields[4], '');
            ok('CSV patrol row → status = roaming',    fields[5] === 'roaming', fields[5], 'roaming');
        }

        // First crime node row structure and values
        if (crimeRows.length > 0) {
            const fields = crimeRows[0].split(',');
            ok('CSV crime row → 4 columns',            fields.length === 4, fields.length, 4);
            ok('CSV crime row → crimeId = CRIME-001',  fields[0] === 'CRIME-001', fields[0], 'CRIME-001');
            ok('CSV crime row → lat matches',          fields[1] === '14.702',    fields[1], '14.702');
            ok('CSV crime row → lng matches',          fields[2] === '121.093',   fields[2], '121.093');
            ok('CSV crime row → assignedPatrolId = 1', fields[3] === '1',         fields[3], '1');
        }
    }
    {
        const r = await api('POST', '/api/export/csv', {}, directToken);
        ok('CSV with empty body → 400', r.status === 400, r.status, 400);
    }

    if (!dbAvailable) {
        section('SECTION 5C — Export CSV: cross-user isolation (DB required)');
        skip('CSV cross-user sessionId', 'DB unavailable');
    } else {
        section('SECTION 5C — Export CSV: cross-user isolation (DB required)');

        {
            // Non-existent sessionId → 404
            const r = await api('POST', '/api/export/csv', { sessionId: 9999999 }, directToken);
            ok('CSV with non-existent sessionId → 404',   r.status === 404, r.status, 404);
        }
        {
            // user2 requests user1's session via CSV → 404
            const tmpR = await api('POST', '/api/sessions', SESSION_BODY, token1);
            const tmpId = (await tmpR.json()).id;
            const r = await api('POST', '/api/export/csv', { sessionId: tmpId }, token2);
            ok('CSV wrong-user sessionId → 404',          r.status === 404, r.status, 404);
            // Cleanup
            await api('DELETE', `/api/sessions/${tmpId}`, undefined, token1);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 6 — Error recovery
    // ─────────────────────────────────────────────────────────────────────────

    section('SECTION 6A — Error recovery: malformed JSON body');

    {
        // Malformed JSON — express.json() calls next(err) with status 400
        apiRequestCount++;
        const r = await fetch(`${BASE}/api/sessions`, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${directToken}`
            },
            body: '{not valid json here'
        });
        ok('malformed JSON body → 400 (not crash)',           r.status === 400, r.status, 400);
        ok('malformed JSON → server still responds (alive)', r.status < 600,   r.status, '< 600');
    }
    {
        // Non-JSON content-type — express.json() skips parsing, body is undefined
        // sessions POST destructures req.body → internal error → 500
        // We only assert "not 0 / not crash" — the route catches it
        apiRequestCount++;
        const r = await fetch(`${BASE}/api/sessions`, {
            method:  'POST',
            headers: {
                'Content-Type':  'text/plain',
                'Authorization': `Bearer ${directToken}`
            },
            body: 'session_name=test'
        });
        ok('text/plain body → server responds (no crash)',   r.status >= 400 && r.status < 600, r.status, '4xx or 5xx');
    }
    {
        // Completely unknown /api route — should not 500, should get 404
        const r = await api('GET', '/api/totally-unknown-route-xyz');
        ok('/api/unknown route → not 500',                   r.status !== 500, r.status, '!= 500');
    }

    section('SECTION 6B — Error recovery: DB connection failure simulation');

    if (!dbAvailable) {
        // DB is actually down in this run — verify routes fail gracefully with 5xx, not crash
        const r = await api('GET', '/api/sessions', undefined, directToken);
        ok('GET /api/sessions with DB down → 5xx not crash',   r.status >= 500 && r.status < 600, r.status, '5xx');

        // Verify server is still alive after DB error
        const healthR = await fetch(`${BASE}/health`);
        ok('server still alive after DB error (health check)', healthR.status === 200, healthR.status, 200);
    } else {
        // DB is up — can't easily simulate connection failure without stopping Postgres.
        // Verify that try/catch in each route protects against unexpected errors by
        // testing the "session not found" path, which exercises the DB error-handling machinery.
        const r = await api('GET', '/api/sessions/9999999', undefined, directToken);
        ok('GET non-existent session → 404 (graceful not crash)', r.status === 404, r.status, 404);
        const healthR = await fetch(`${BASE}/health`);
        ok('server healthy after error path exercises',          healthR.status === 200, healthR.status, 200);
        console.log('  NOTE: Full DB failure simulation skipped (DB is up).');
        console.log('        To test: stop Postgres, restart server, run this test again.');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cleanup — delete remaining DB sessions BEFORE rate limit section
    // ─────────────────────────────────────────────────────────────────────────

    if (dbAvailable && sessionId2) {
        await api('DELETE', `/api/sessions/${sessionId2}`, undefined, token2).catch(() => {});
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SECTION 7 — Rate limiting   ★ RUNS LAST — exhausts /api budget ★
    //
    // The limiter is max: 100 per IP per 15-minute window.
    // All prior sections have consumed some budget. This section sends enough
    // additional requests to hit the 101st, triggering 429.
    // ─────────────────────────────────────────────────────────────────────────

    section('SECTION 7 — Rate limiting (runs last — exhausts /api budget)');

    const remaining = Math.max(1, 101 - apiRequestCount);
    console.log(`  Prior /api requests this run: ${apiRequestCount}`);
    console.log(`  Sending ≈${remaining} more to trigger 429 (max 150 attempts)...`);

    let got429 = false;
    let body429 = null;
    let ct429   = null;
    let reqsSent = 0;
    const LOOP_MAX = 150;

    for (let i = 0; i < LOOP_MAX; i++) {
        // GET /api/auth/me with no token: cheap, no DB, fast
        const r = await fetch(`${BASE}/api/auth/me`);
        apiRequestCount++;
        reqsSent++;
        if (r.status === 429) {
            body429 = await r.text();
            ct429   = r.headers.get('content-type') || '';
            got429  = true;
            console.log(`  Rate limit hit after ${reqsSent} additional requests (${apiRequestCount} total this run)`);
            break;
        }
    }

    ok('rate limit 429 received within 150 additional requests', got429, got429, true);

    if (got429 && body429 !== null) {
        let parsed = null;
        let isJson = false;
        try { parsed = JSON.parse(body429); isJson = true; } catch {}

        ok('rate limit response is valid JSON (not HTML)',        isJson,                                   body429.slice(0, 80), '{...}');
        ok('rate limit Content-Type is application/json',         ct429.includes('application/json'),       ct429, 'application/json');
        ok('rate limit JSON has "error" field',                   typeof parsed?.error === 'string',        typeof parsed?.error, 'string');
        ok('rate limit error message is descriptive (> 10 chars)', (parsed?.error?.length ?? 0) > 10,       parsed?.error, 'descriptive string');
        ok('rate limit error mentions wait/retry',                 parsed?.error?.toLowerCase().includes('wait') || parsed?.error?.toLowerCase().includes('minute') || parsed?.error?.toLowerCase().includes('try'), parsed?.error, 'mentions wait/minute/try');
    }

    // Static files are NOT behind /api — must not be rate limited
    {
        const r = await fetch(`${BASE}/`);
        ok('GET / (static file) → not rate limited (not 429)', r.status !== 429, r.status, '!= 429');
    }

    // Health check is NOT under /api prefix — must not be rate limited
    {
        const r = await fetch(`${BASE}/health`);
        ok('GET /health → not rate limited (not 429)',         r.status !== 429, r.status, '!= 429');
    }

    // WebSocket connections bypass Express middleware entirely
    {
        try {
            const ws = await wsConnect(6000);
            ok('WebSocket connects despite /api rate limit exhausted', ws.readyState === WebSocket.OPEN, ws.readyState, WebSocket.OPEN);
            ws.terminate();
        } catch (e) {
            ok('WebSocket connects despite /api rate limit exhausted', false, e.message, 'OPEN');
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────

    const total = pass + fail + skipped;
    console.log(`\n${'═'.repeat(68)}`);
    console.log(`  TOTAL: ${total}  |  PASS: ${pass}  |  FAIL: ${fail}  |  SKIP: ${skipped}`);
    if (fail === 0 && skipped === 0) {
        console.log('  All tests passed.');
    } else if (fail === 0) {
        console.log(`  All executed tests passed. ${skipped} skipped (DB unavailable).`);
        console.log('  Start the server with a working DATABASE_URL to run skipped sections.');
    } else {
        console.log(`  ${fail} test(s) failed — see FAIL lines above.`);
    }
    console.log('═'.repeat(68));

    if (fail > 0) process.exit(1);
}

main().catch(err => {
    console.error('\nFatal error:', err);
    process.exit(1);
});
