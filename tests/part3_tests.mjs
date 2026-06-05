/**
 * PatrolPoint V2 — Build Steps 2 & 3 Test Suite
 * Tests: auth endpoints, network endpoint, static file checks, logic tests.
 * Usage: node tests/part3_tests.mjs
 */

import http from 'http';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { processOverpassResponse } from '../server/services/networkProcessor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:3000';

let passed = 0;
let failed = 0;
const results = [];

// ── helpers ───────────────────────────────────────────────────────────────────

function report(id, what, expected, actual, status, action = 'None') {
    results.push({ id, what, expected, actual, status, action });
    if (status === 'PASS') passed++;
    else failed++;
}

function get(url, extraHeaders = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers: extraHeaders }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    });
}

function post(url, body, headers = {}, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
        };
        const req = http.request(url, opts, (res) => {
            let b = '';
            res.on('data', d => b += d);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

function readFile(rel) {
    const full = path.join(ROOT, rel);
    if (!existsSync(full)) return null;
    return readFileSync(full, 'utf8');
}

// ── ST-series: Static/structural checks for Build Steps 2-3 ──────────────────

function runStructureTests() {

    // ST1: Build Step 3 service files exist
    const bs3Files = [
        'server/services/overpass.js',
        'server/services/networkProcessor.js',
        'server/services/cache.js',
        'server/routes/network.js'
    ];
    const missingBs3 = bs3Files.filter(f => !existsSync(path.join(ROOT, f)));
    if (missingBs3.length === 0) {
        report('ST1', 'All Build Step 3 service/route files exist',
            'All 4 files present', 'All found', 'PASS');
    } else {
        report('ST1', 'All Build Step 3 service/route files exist',
            'All 4 files present', `Missing: ${missingBs3.join(', ')}`, 'FAIL',
            `Create missing files: ${missingBs3.join(', ')}`);
    }

    // ST2: overpass.js has 3 OVERPASS_SERVERS fallbacks
    const overpassJs = readFile('server/services/overpass.js') || '';
    const serverCount = (overpassJs.match(/overpass/gi) || []).length;
    const hasPrimary = overpassJs.includes('overpass-api.de');
    const hasKumi = overpassJs.includes('overpass.kumi.systems');
    const hasFr = overpassJs.includes('overpass.openstreetmap.fr');
    if (hasPrimary && hasKumi && hasFr) {
        report('ST2', 'overpass.js has all 3 Overpass fallback servers',
            'overpass-api.de + kumi.systems + openstreetmap.fr', 'All 3 found', 'PASS');
    } else {
        const missing = [
            !hasPrimary && 'overpass-api.de',
            !hasKumi && 'overpass.kumi.systems',
            !hasFr && 'overpass.openstreetmap.fr'
        ].filter(Boolean);
        report('ST2', 'overpass.js has all 3 Overpass fallback servers',
            'All 3 servers', `Missing: ${missing.join(', ')}`, 'FAIL',
            'Add missing Overpass fallback server URLs to OVERPASS_SERVERS');
    }

    // ST3: overpass.js exports fetchBarangayData and has both query builders
    const hasExport = overpassJs.includes('export async function fetchBarangayData');
    const hasRoadQuery = overpassJs.includes('buildRoadQuery');
    const hasBoundaryQuery = overpassJs.includes('buildBoundaryQuery');
    if (hasExport && hasRoadQuery && hasBoundaryQuery) {
        report('ST3', 'overpass.js exports fetchBarangayData with buildRoadQuery and buildBoundaryQuery',
            'All 3 functions present', 'All found', 'PASS');
    } else {
        const missing = [
            !hasExport && 'fetchBarangayData export',
            !hasRoadQuery && 'buildRoadQuery',
            !hasBoundaryQuery && 'buildBoundaryQuery'
        ].filter(Boolean);
        report('ST3', 'overpass.js exports fetchBarangayData with query builders',
            'All 3 functions', `Missing: ${missing.join(', ')}`, 'FAIL',
            'Add missing function exports');
    }

    // ST4: networkProcessor.js exports processOverpassResponse and defines haversineDistance
    const npJs = readFile('server/services/networkProcessor.js') || '';
    const hasProcess = npJs.includes('export function processOverpassResponse');
    const hasHaversine = npJs.includes('haversineDistance');
    if (hasProcess && hasHaversine) {
        report('ST4', 'networkProcessor.js exports processOverpassResponse and defines haversineDistance',
            'Both present', 'Both found', 'PASS');
    } else {
        report('ST4', 'networkProcessor.js exports processOverpassResponse + haversineDistance',
            'Both present',
            `processOverpassResponse export: ${hasProcess}, haversineDistance: ${hasHaversine}`, 'FAIL',
            'Ensure processOverpassResponse is exported and haversineDistance is defined');
    }

    // ST5: cache.js exports getOrFetchNetwork and has BARANGAY_BBOXES with Commonwealth
    const cacheJs = readFile('server/services/cache.js') || '';
    const hasGetOrFetch = cacheJs.includes('export async function getOrFetchNetwork');
    const hasCommonwealth = cacheJs.includes("'Commonwealth'") || cacheJs.includes('"Commonwealth"');
    if (hasGetOrFetch && hasCommonwealth) {
        report('ST5', "cache.js exports getOrFetchNetwork and has 'Commonwealth' in BARANGAY_BBOXES",
            'Both present', 'Both found', 'PASS');
    } else {
        report('ST5', "cache.js exports getOrFetchNetwork + Commonwealth bbox",
            'Both present',
            `getOrFetchNetwork export: ${hasGetOrFetch}, Commonwealth bbox: ${hasCommonwealth}`, 'FAIL',
            'Ensure getOrFetchNetwork is exported and BARANGAY_BBOXES includes Commonwealth');
    }

    // ST6: cache.js has in-memory module-level cache (networkCache)
    const hasMemoryCache = cacheJs.includes('networkCache');
    if (hasMemoryCache) {
        report('ST6', 'cache.js has in-memory module-level networkCache',
            'networkCache variable present', 'Found', 'PASS');
    } else {
        report('ST6', 'cache.js has in-memory module-level networkCache',
            'networkCache variable', 'Not found', 'FAIL',
            'Add module-level networkCache = {} for in-memory caching');
    }

    // ST7: network route mounted in server/index.js at /api/network
    const indexJs = readFile('server/index.js') || '';
    const networkMounted = indexJs.includes('/api/network') && indexJs.includes('networkRouter');
    if (networkMounted) {
        report('ST7', 'network route mounted in server/index.js at /api/network',
            'app.use("/api/network", networkRouter) present', 'Found', 'PASS');
    } else {
        report('ST7', 'network route mounted in server/index.js at /api/network',
            'networkRouter at /api/network', 'Not found', 'FAIL',
            "Add app.use('/api/network', networkRouter) to server/index.js");
    }

    // ST8: auth route mounted in server/index.js at /api/auth
    const authMounted = indexJs.includes('/api/auth') && indexJs.includes('authRouter');
    if (authMounted) {
        report('ST8', 'auth route mounted in server/index.js at /api/auth',
            'app.use("/api/auth", authRouter) present', 'Found', 'PASS');
    } else {
        report('ST8', 'auth route mounted in server/index.js at /api/auth',
            'authRouter at /api/auth', 'Not found', 'FAIL',
            "Add app.use('/api/auth', authRouter) to server/index.js");
    }

    // ST9: middleware/auth.js exports requireAuth and uses Bearer scheme
    const authMiddleware = readFile('server/middleware/auth.js') || '';
    const hasRequireAuth = authMiddleware.includes('export function requireAuth');
    const hasBearer = authMiddleware.includes('Bearer');
    if (hasRequireAuth && hasBearer) {
        report('ST9', 'middleware/auth.js exports requireAuth with Bearer token scheme',
            'requireAuth export + Bearer present', 'Both found', 'PASS');
    } else {
        report('ST9', 'middleware/auth.js exports requireAuth + Bearer scheme',
            'Both present',
            `requireAuth: ${hasRequireAuth}, Bearer: ${hasBearer}`, 'FAIL',
            'Ensure requireAuth is exported and uses Authorization: Bearer header');
    }

    // ST10: db/queries.js has all 7 required query functions
    const queriesJs = readFile('server/db/queries.js') || '';
    const requiredFns = [
        'getRoadNetwork', 'saveRoadNetwork', 'getSessionsByUser', 'getSessionById',
        'saveSession', 'deleteSession', 'getUserByUsername', 'createUser', 'updateLastLogin'
    ];
    const missingFns = requiredFns.filter(fn => !queriesJs.includes(`function ${fn}`));
    if (missingFns.length === 0) {
        report('ST10', 'db/queries.js contains all 9 required query functions',
            'All 9 functions', 'All found', 'PASS');
    } else {
        report('ST10', 'db/queries.js contains all 9 required query functions',
            'All 9 present', `Missing: ${missingFns.join(', ')}`, 'FAIL',
            `Add missing query functions: ${missingFns.join(', ')}`);
    }
}

// ── LP-series: Logic tests — pure JS, no HTTP ─────────────────────────────────

function runLogicTests() {

    // LP1: processOverpassResponse deduplicates edges correctly
    // Two ways sharing the same node pair in opposite directions → one edge
    const mockRoadData = {
        elements: [
            { type: 'node', id: 1, lat: 14.700, lon: 121.090 },
            { type: 'node', id: 2, lat: 14.701, lon: 121.091 },
            { type: 'node', id: 3, lat: 14.702, lon: 121.092 },
            { type: 'way', id: 10, tags: { highway: 'residential' }, nodes: [1, 2, 3] },
            { type: 'way', id: 11, tags: { highway: 'residential' }, nodes: [3, 2, 1] }
        ]
    };
    try {
        const result = processOverpassResponse(mockRoadData, { elements: [] });
        const edgeCount = result.edges.length;
        if (edgeCount === 2) {
            report('LP1', 'processOverpassResponse deduplicates reversed duplicate edges',
                '2 unique edges (not 4)', `${edgeCount} edges`, 'PASS');
        } else {
            report('LP1', 'processOverpassResponse deduplicates reversed duplicate edges',
                '2 unique edges', `${edgeCount} edges`, 'FAIL',
                'Edge deduplication using canonical key (sorted numeric) must merge reversed duplicates');
        }
    } catch (e) {
        report('LP1', 'processOverpassResponse deduplicates edges',
            '2 edges', `Error: ${e.message}`, 'FAIL', 'Fix processOverpassResponse to handle mock data');
    }

    // LP2: processOverpassResponse computes intersection nodes correctly (degree >= 3)
    // Node 2 connects to 1, 3, 4 — degree 3 — must be intersection
    const mockRoadData2 = {
        elements: [
            { type: 'node', id: 1, lat: 14.700, lon: 121.090 },
            { type: 'node', id: 2, lat: 14.701, lon: 121.091 },
            { type: 'node', id: 3, lat: 14.702, lon: 121.092 },
            { type: 'node', id: 4, lat: 14.703, lon: 121.090 },
            // way A: 1-2-3
            { type: 'way', id: 20, tags: { highway: 'residential' }, nodes: [1, 2, 3] },
            // way B: 4-2 (connects to node 2, giving it degree 3)
            { type: 'way', id: 21, tags: { highway: 'residential' }, nodes: [4, 2] }
        ]
    };
    try {
        const result = processOverpassResponse(mockRoadData2, { elements: [] });
        const isNode2Intersection = result.intersectionNodeIds.some(id => {
            const node = result.nodes[id];
            return node && Math.abs(node.lat - 14.701) < 0.0001 && Math.abs(node.lng - 121.091) < 0.0001;
        });
        if (isNode2Intersection) {
            report('LP2', 'processOverpassResponse identifies degree-3 node as intersection',
                'Node at (14.701, 121.091) in intersectionNodeIds', 'Found', 'PASS');
        } else {
            report('LP2', 'processOverpassResponse identifies degree-3 node as intersection',
                'Center node (degree 3) in intersectionNodeIds',
                `intersectionNodeIds: [${result.intersectionNodeIds.join(', ')}]`, 'FAIL',
                'Intersection detection requires degree >= 3; check degree counting logic');
        }
    } catch (e) {
        report('LP2', 'processOverpassResponse intersection detection',
            'Center node in intersectionNodeIds', `Error: ${e.message}`, 'FAIL',
            'Fix processOverpassResponse');
    }

    // LP3: processOverpassResponse bbox is computed from actual node coordinates
    try {
        const result = processOverpassResponse(mockRoadData, { elements: [] });
        const { south, west, north, east } = result.bbox;
        const bboxOk = Math.abs(south - 14.700) < 0.001 &&
                       Math.abs(north - 14.702) < 0.001 &&
                       Math.abs(west - 121.090) < 0.001 &&
                       Math.abs(east - 121.092) < 0.001;
        if (bboxOk) {
            report('LP3', 'processOverpassResponse computes correct bbox from node coordinates',
                'south~14.700, north~14.702, west~121.090, east~121.092',
                `south=${south}, north=${north}, west=${west}, east=${east}`, 'PASS');
        } else {
            report('LP3', 'processOverpassResponse computes correct bbox',
                'south~14.700, north~14.702, west~121.090, east~121.092',
                `south=${south}, north=${north}, west=${west}, east=${east}`, 'FAIL',
                'Check min/max lat/lng logic in processOverpassResponse');
        }
    } catch (e) {
        report('LP3', 'processOverpassResponse bbox computation',
            'Correct min/max from node coords', `Error: ${e.message}`, 'FAIL',
            'Fix processOverpassResponse');
    }

    // LP4: processOverpassResponse throws when roadData has no nodes
    let threw = false;
    try {
        processOverpassResponse({ elements: [] }, { elements: [] });
    } catch (e) {
        threw = true;
    }
    if (threw) {
        report('LP4', 'processOverpassResponse throws when roadData has no road nodes',
            'Error thrown', 'Error thrown', 'PASS');
    } else {
        report('LP4', 'processOverpassResponse throws when roadData has no road nodes',
            'Error thrown', 'No error thrown', 'FAIL',
            "Add guard: if (nodeCount === 0) throw new Error('...')");
    }

    // LP5: steps highway type excluded from edges
    const stepsData = {
        elements: [
            { type: 'node', id: 1, lat: 14.700, lon: 121.090 },
            { type: 'node', id: 2, lat: 14.701, lon: 121.091 },
            { type: 'node', id: 3, lat: 14.702, lon: 121.092 },
            { type: 'way', id: 30, tags: { highway: 'steps' }, nodes: [1, 2] },
            { type: 'way', id: 31, tags: { highway: 'residential' }, nodes: [2, 3] }
        ]
    };
    try {
        const result = processOverpassResponse(stepsData, { elements: [] });
        if (result.edgeCount === 1) {
            report('LP5', 'processOverpassResponse excludes highway=steps edges',
                '1 edge (steps excluded)', `${result.edgeCount} edges`, 'PASS');
        } else {
            report('LP5', 'processOverpassResponse excludes highway=steps edges',
                '1 edge (steps way excluded)', `${result.edgeCount} edges`, 'FAIL',
                "Filter out ways where tags.highway === 'steps'");
        }
    } catch (e) {
        report('LP5', 'processOverpassResponse excludes steps',
            '1 edge', `Error: ${e.message}`, 'FAIL', 'Fix processOverpassResponse');
    }

    // LP6: adjacencyList is undirected — edge A→B also adds B→A
    try {
        const result = processOverpassResponse(mockRoadData, { elements: [] });
        // Find internal ID for osm node 1 (first node)
        const n0 = Object.values(result.nodes).find(n => Math.abs(n.lat - 14.700) < 0.0001);
        const n1 = Object.values(result.nodes).find(n => Math.abs(n.lat - 14.701) < 0.0001);
        if (!n0 || !n1) {
            report('LP6', 'adjacencyList is undirected (both directions present)',
                'Both directions', 'Could not find test nodes', 'FAIL', 'Fix node lookup');
        } else {
            const n0Neighbors = result.adjacencyList[n0.id] || [];
            const n1Neighbors = result.adjacencyList[n1.id] || [];
            const n0HasN1 = n0Neighbors.some(nb => nb.neighborId === n1.id);
            const n1HasN0 = n1Neighbors.some(nb => nb.neighborId === n0.id);
            if (n0HasN1 && n1HasN0) {
                report('LP6', 'adjacencyList is undirected — edge A→B and B→A both stored',
                    'Both directions in adjacencyList', 'Both directions found', 'PASS');
            } else {
                report('LP6', 'adjacencyList is undirected',
                    'A→B and B→A both present',
                    `n0→n1: ${n0HasN1}, n1→n0: ${n1HasN0}`, 'FAIL',
                    'Build adjacencyList by adding both directions for each edge');
            }
        }
    } catch (e) {
        report('LP6', 'adjacencyList undirected check',
            'Both directions', `Error: ${e.message}`, 'FAIL', 'Fix processOverpassResponse');
    }
}

// ── AU-series: Auth endpoint tests ────────────────────────────────────────────

async function runAuthTests() {
    // Use timestamp-based username to avoid conflicts across test runs
    const testUsername = `testuser_${Date.now()}`;
    const testPassword = 'TestPass123!';
    let authToken = null;

    // AU1: POST /api/auth/register with valid data → 201
    try {
        const r = await post(`${BASE}/api/auth/register`, {
            username: testUsername, password: testPassword, displayName: 'Test User'
        });
        const body = JSON.parse(r.body);
        if (r.status === 201 && body.message) {
            report('AU1', 'POST /api/auth/register with valid data returns 201',
                '201 + { message: "..." }', `${r.status} + message: "${body.message}"`, 'PASS');
        } else {
            report('AU1', 'POST /api/auth/register with valid data returns 201',
                '201 + message', `${r.status} — ${r.body.slice(0, 100)}`, 'FAIL',
                'Check register route response format and DB connectivity');
        }
    } catch (e) {
        report('AU1', 'POST /api/auth/register valid registration',
            '201', `Error: ${e.message}`, 'FAIL', 'Server may not be running or DB unreachable');
    }

    // AU2: POST /api/auth/register with invalid username (too short) → 400
    try {
        const r = await post(`${BASE}/api/auth/register`, { username: 'ab', password: testPassword });
        if (r.status === 400) {
            report('AU2', 'POST /api/auth/register with 2-char username returns 400',
                '400', `${r.status}`, 'PASS');
        } else {
            report('AU2', 'POST /api/auth/register with 2-char username returns 400',
                '400', `${r.status} — ${r.body.slice(0, 80)}`, 'FAIL',
                'Username validation must reject usernames shorter than 3 chars');
        }
    } catch (e) {
        report('AU2', 'POST /api/auth/register invalid username',
            '400', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // AU3: POST /api/auth/register with short password → 400
    try {
        const r = await post(`${BASE}/api/auth/register`, { username: testUsername + 'x', password: 'short' });
        if (r.status === 400) {
            report('AU3', 'POST /api/auth/register with <8 char password returns 400',
                '400', `${r.status}`, 'PASS');
        } else {
            report('AU3', 'POST /api/auth/register with <8 char password returns 400',
                '400', `${r.status} — ${r.body.slice(0, 80)}`, 'FAIL',
                'Password validation must reject passwords shorter than 8 chars');
        }
    } catch (e) {
        report('AU3', 'POST /api/auth/register short password',
            '400', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // AU4: POST /api/auth/register duplicate username → 409
    try {
        const r = await post(`${BASE}/api/auth/register`, {
            username: testUsername, password: testPassword
        });
        if (r.status === 409) {
            report('AU4', 'POST /api/auth/register with duplicate username returns 409',
                '409', `${r.status}`, 'PASS');
        } else {
            report('AU4', 'POST /api/auth/register with duplicate username returns 409',
                '409', `${r.status} — ${r.body.slice(0, 80)}`, 'FAIL',
                'Duplicate username check must return 409 Conflict');
        }
    } catch (e) {
        report('AU4', 'POST /api/auth/register duplicate username',
            '409', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // AU5: POST /api/auth/login with correct credentials → 200 + token + user
    try {
        const r = await post(`${BASE}/api/auth/login`, {
            username: testUsername, password: testPassword
        });
        const body = JSON.parse(r.body);
        if (r.status === 200 && body.token && body.user && body.user.username === testUsername) {
            authToken = body.token;
            report('AU5', 'POST /api/auth/login with valid credentials returns 200 + JWT + user',
                '200 + { token, user }', `${r.status} + token present, user.username = "${body.user.username}"`, 'PASS');
        } else {
            report('AU5', 'POST /api/auth/login with valid credentials returns 200 + JWT + user',
                '200 + token + user', `${r.status} — ${r.body.slice(0, 100)}`, 'FAIL',
                'Check login route: must return token and user object');
        }
    } catch (e) {
        report('AU5', 'POST /api/auth/login valid credentials',
            '200 + token', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // AU6: POST /api/auth/login with wrong password → 401
    try {
        const r = await post(`${BASE}/api/auth/login`, {
            username: testUsername, password: 'WrongPassword!'
        });
        if (r.status === 401) {
            report('AU6', 'POST /api/auth/login with wrong password returns 401',
                '401', `${r.status}`, 'PASS');
        } else {
            report('AU6', 'POST /api/auth/login with wrong password returns 401',
                '401', `${r.status} — ${r.body.slice(0, 80)}`, 'FAIL',
                'Wrong password must return 401, not 200 or 400');
        }
    } catch (e) {
        report('AU6', 'POST /api/auth/login wrong password',
            '401', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // AU7: POST /api/auth/login missing fields → 400
    try {
        const r = await post(`${BASE}/api/auth/login`, {});
        if (r.status === 400) {
            report('AU7', 'POST /api/auth/login with missing fields returns 400',
                '400', `${r.status}`, 'PASS');
        } else {
            report('AU7', 'POST /api/auth/login with missing fields returns 400',
                '400', `${r.status} — ${r.body.slice(0, 80)}`, 'FAIL',
                'Login route must validate that username and password are provided');
        }
    } catch (e) {
        report('AU7', 'POST /api/auth/login missing fields',
            '400', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // AU8: GET /api/auth/me without token → 401
    try {
        const r = await get(`${BASE}/api/auth/me`);
        if (r.status === 401) {
            report('AU8', 'GET /api/auth/me without token returns 401',
                '401', `${r.status}`, 'PASS');
        } else {
            report('AU8', 'GET /api/auth/me without token returns 401',
                '401', `${r.status} — ${r.body.slice(0, 80)}`, 'FAIL',
                'requireAuth middleware must block /me without Bearer token');
        }
    } catch (e) {
        report('AU8', 'GET /api/auth/me no token',
            '401', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // AU9: GET /api/auth/me with valid JWT → 200 + user
    if (authToken) {
        try {
            const r = await get(`${BASE}/api/auth/me`, { Authorization: `Bearer ${authToken}` });
            const body = JSON.parse(r.body);
            if (r.status === 200 && body.user && body.user.username === testUsername) {
                report('AU9', 'GET /api/auth/me with valid JWT returns 200 + user',
                    `200 + { user: { username: "${testUsername}" } }`,
                    `${r.status} + user.username = "${body.user.username}"`, 'PASS');
            } else {
                report('AU9', 'GET /api/auth/me with valid JWT returns 200 + user',
                    '200 + user object', `${r.status} — ${r.body.slice(0, 100)}`, 'FAIL',
                    'Check /me route and requireAuth middleware token decoding');
            }
        } catch (e) {
            report('AU9', 'GET /api/auth/me valid JWT',
                '200 + user', `Error: ${e.message}`, 'FAIL', 'Server error');
        }
    } else {
        report('AU9', 'GET /api/auth/me with valid JWT returns 200 + user',
            '200 + user', 'SKIPPED — AU5 did not produce a token', 'FAIL',
            'Fix AU5 (login) first so a token is available for this test');
    }
}

// ── NW-series: Network endpoint tests ────────────────────────────────────────

async function runNetworkTests() {
    let networkData = null;

    // NW1: GET /api/network/Commonwealth → 200 + required fields
    // Long timeout because cold cache requires Overpass API fetch (~30s)
    console.log('\n  [NW1] GET /api/network/Commonwealth — may take up to 60s on cold cache...');
    try {
        const r = await get(`${BASE}/api/network/Commonwealth`, {}, 90000);
        const body = JSON.parse(r.body);
        const hasRequiredFields = (
            typeof body.nodeCount === 'number' &&
            typeof body.edgeCount === 'number' &&
            typeof body.intersectionCount === 'number' &&
            body.bbox !== undefined &&
            body.boundary !== undefined &&
            typeof body.fromCache === 'boolean'
        );
        if (r.status === 200 && hasRequiredFields) {
            networkData = body;
            report('NW1', 'GET /api/network/Commonwealth returns 200 with all required fields',
                '200 + nodeCount + edgeCount + intersectionCount + bbox + boundary + fromCache',
                `200 + nodeCount=${body.nodeCount}, edgeCount=${body.edgeCount}, intersectionCount=${body.intersectionCount}, fromCache=${body.fromCache}`,
                'PASS');
        } else if (r.status === 503) {
            report('NW1', 'GET /api/network/Commonwealth returns 200 with all required fields',
                '200 + all fields',
                '503 — Overpass API unavailable during test run',
                'FAIL',
                'Overpass API unreachable. Test environment may lack internet access. Manually verify with a live connection.');
        } else {
            report('NW1', 'GET /api/network/Commonwealth returns 200 with all required fields',
                '200 + all required fields', `${r.status} — ${r.body.slice(0, 150)}`, 'FAIL',
                'Check network route handler and cache service');
        }
    } catch (e) {
        report('NW1', 'GET /api/network/Commonwealth',
            '200 + fields', `Error: ${e.message}`, 'FAIL', 'Server error or timeout');
    }

    // NW2: Second call → fromCache: true (in-memory hit is instant)
    try {
        const r = await get(`${BASE}/api/network/Commonwealth`, {}, 10000);
        const body = JSON.parse(r.body);
        if (r.status === 200 && body.fromCache === true) {
            report('NW2', 'Second GET /api/network/Commonwealth returns fromCache: true',
                'fromCache: true', `fromCache: ${body.fromCache}`, 'PASS');
        } else if (r.status === 503) {
            report('NW2', 'Second GET /api/network/Commonwealth returns fromCache: true',
                'fromCache: true', '503 — Overpass still unavailable', 'FAIL',
                'Overpass API unreachable');
        } else {
            report('NW2', 'Second GET /api/network/Commonwealth returns fromCache: true',
                'fromCache: true', `${r.status} — fromCache: ${body.fromCache}`, 'FAIL',
                'In-memory cache should return fromCache: true on subsequent calls');
        }
    } catch (e) {
        report('NW2', 'Second GET /api/network/Commonwealth fromCache check',
            'fromCache: true', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // NW3-NW7: Data quality checks — only if NW1 succeeded
    if (networkData) {
        // NW3: nodeCount > 1000
        if (networkData.nodeCount > 1000) {
            report('NW3', 'Commonwealth nodeCount > 1000 (road network is substantial)',
                '> 1000 nodes', `${networkData.nodeCount} nodes`, 'PASS');
        } else {
            report('NW3', 'Commonwealth nodeCount > 1000',
                '> 1000 nodes', `${networkData.nodeCount} nodes`, 'FAIL',
                'Low node count suggests incomplete Overpass data or processing error');
        }

        // NW4: edgeCount > 1000
        if (networkData.edgeCount > 1000) {
            report('NW4', 'Commonwealth edgeCount > 1000',
                '> 1000 edges', `${networkData.edgeCount} edges`, 'PASS');
        } else {
            report('NW4', 'Commonwealth edgeCount > 1000',
                '> 1000 edges', `${networkData.edgeCount} edges`, 'FAIL',
                'Low edge count suggests incomplete Overpass data');
        }

        // NW5: intersectionCount > 100
        if (networkData.intersectionCount > 100) {
            report('NW5', 'Commonwealth intersectionCount > 100',
                '> 100 intersections', `${networkData.intersectionCount} intersections`, 'PASS');
        } else {
            report('NW5', 'Commonwealth intersectionCount > 100',
                '> 100 intersections', `${networkData.intersectionCount} intersections`, 'FAIL',
                'Low intersection count — check degree >= 3 logic in networkProcessor');
        }

        // NW6: bbox has all 4 numeric fields within Philippines range
        const { south, west, north, east } = networkData.bbox || {};
        const bboxValid = (
            typeof south === 'number' && typeof west === 'number' &&
            typeof north === 'number' && typeof east === 'number' &&
            south > 14 && south < 15 && north > 14 && north < 15 &&
            west > 121 && west < 122 && east > 121 && east < 122
        );
        if (bboxValid) {
            report('NW6', 'Commonwealth bbox has 4 numeric fields within Philippines coordinate range',
                'south/west/north/east all numbers in range [14..15, 121..122]',
                `south=${south}, west=${west}, north=${north}, east=${east}`, 'PASS');
        } else {
            report('NW6', 'Commonwealth bbox valid coordinate range',
                'All 4 fields, Philippines range',
                `south=${south}, west=${west}, north=${north}, east=${east}`, 'FAIL',
                'Check bbox computation in processOverpassResponse');
        }

        // NW7: boundary is array with at least 3 vertices
        const boundary = networkData.boundary;
        if (Array.isArray(boundary) && boundary.length >= 3) {
            report('NW7', 'Commonwealth boundary polygon has at least 3 vertices',
                'Array with >= 3 lat/lng objects', `Array with ${boundary.length} vertices`, 'PASS');
        } else {
            report('NW7', 'Commonwealth boundary polygon has at least 3 vertices',
                '>= 3 vertices', `boundary is ${JSON.stringify(boundary)?.slice(0, 80)}`, 'FAIL',
                'Check extractBoundaryPolygon in networkProcessor.js');
        }
    } else {
        for (const id of ['NW3', 'NW4', 'NW5', 'NW6', 'NW7']) {
            report(id, `${id} data quality check — skipped because NW1 failed`,
                'Data from NW1', 'SKIPPED', 'FAIL', 'Fix NW1 first');
        }
    }

    // NW8: GET /api/network/!invalid! → 400 (invalid chars)
    try {
        const r = await get(`${BASE}/api/network/!invalid!`);
        if (r.status === 400) {
            report('NW8', 'GET /api/network/!invalid! returns 400 for invalid name chars',
                '400', `${r.status}`, 'PASS');
        } else {
            report('NW8', 'GET /api/network/!invalid! returns 400',
                '400', `${r.status} — ${r.body.slice(0, 80)}`, 'FAIL',
                'Barangay name validation must reject non-alphanumeric characters');
        }
    } catch (e) {
        report('NW8', 'GET /api/network invalid chars',
            '400', `Error: ${e.message}`, 'FAIL', 'Server error');
    }

    // NW9: GET /api/network/UnknownBarangay → 400 (no bbox configured)
    try {
        const r = await get(`${BASE}/api/network/UnknownBarangay`, {}, 10000);
        if (r.status === 400) {
            report('NW9', 'GET /api/network/UnknownBarangay returns 400 (no bbox configured)',
                '400 — no bounding box configured', `${r.status}`, 'PASS');
        } else {
            report('NW9', 'GET /api/network/UnknownBarangay returns 400 (no bbox)',
                '400', `${r.status} — ${r.body.slice(0, 100)}`, 'FAIL',
                'cache.getOrFetchNetwork should throw when barangay has no BARANGAY_BBOXES entry');
        }
    } catch (e) {
        report('NW9', 'GET /api/network unknown barangay',
            '400', `Error: ${e.message}`, 'FAIL', 'Server error');
    }
}

// ── Print results ─────────────────────────────────────────────────────────────

function printResults() {
    console.log('\n' + '='.repeat(70));
    console.log('  PatrolPoint V2 — Build Steps 2 & 3 Test Results');
    console.log('='.repeat(70));

    for (const r of results) {
        const icon = r.status === 'PASS' ? '✓' : '✗';
        console.log(`\n[${r.status}] ${icon} ${r.id}: ${r.what}`);
        if (r.status === 'FAIL') {
            console.log(`  Expected : ${r.expected}`);
            console.log(`  Actual   : ${r.actual}`);
            if (r.action !== 'None') console.log(`  Action   : ${r.action}`);
        }
    }

    console.log('\n' + '='.repeat(70));
    console.log(`  TOTAL: ${passed + failed} tests | ${passed} PASSED | ${failed} FAILED`);
    console.log('='.repeat(70) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('Starting PatrolPoint V2 Build Steps 2 & 3 tests...\n');

    runStructureTests();
    runLogicTests();
    await runAuthTests();
    await runNetworkTests();

    printResults();
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Test runner error:', e); process.exit(1); });
