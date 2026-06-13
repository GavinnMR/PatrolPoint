// server/websocket/pipelineSocket.js
// WebSocket connection handler and compute orchestrator.
//
// Each connected client gets its own per-ws state:
//   ws.cancelled:       true when client disconnected or sent 'cancel' — stops pipeline
//   ws.pipelineRunning: true during compute — prevents concurrent runs on the same connection
//   ws.previousState:   hull/validCandidates/incidents from last run — incremental hull opt
//
// Message protocol (client → server):
//   { type: 'init', data: { barangay } }   — sent on connect to warm cache and get boundary
//   { type: 'compute', data: { incidents, n, mode, config, barangay } }
//   { type: 'ping' }
//   { type: 'cancel' }
//
// Message protocol (server → client):
//   { type: 'connected' }
//   { type: 'network_loaded', data: { barangay, nodeCount, edgeCount, intersectionCount, fromCache, boundaryPolygon } }
//   { type: 'pipeline_start', data: { totalStages, mode } }
//   { type: 'stage_start', data: { stage, name } }
//   { type: 'stage_progress', data: { stage, restart?, iteration?, patrolPositions?, bestMinDist? } }
//   { type: 'stage_complete', data: { stage, result, trace, runtimeMs } }
//   { type: 'warning', data: { stage, message } }
//   { type: 'error', data: { stage?, message, fatal } }
//   { type: 'pipeline_complete', data: { hull, patrols, zones, routes, trace, totalRuntimeMs, verificationReport } }
//   { type: 'pong' }

import { validateIncidents, validateN, validateMode, validateConfig, validateBarangay } from '../middleware/sanitize.js';
import { getOrFetchNetwork } from '../services/cache.js';
import { runPipeline } from '../services/pipeline.js';

// ── Global concurrent pipeline cap ────────────────────────────────────────────
// Prevents CPU saturation when many users hit Recalculate simultaneously.
// Requests beyond the cap are rejected immediately with a friendly message.
let activePipelines          = 0;
const MAX_CONCURRENT_PIPELINES = 3;

// ── Compute rate limiter (per IP, WebSocket) ──────────────────────────────────
// 20 compute requests per 5 minutes per IP. Tracked in a module-level Map so it
// persists across connections from the same IP.
const computeRateLimiter = new Map(); // ip → { count, windowStart }
const RATE_LIMIT_MAX     = 20;
const RATE_LIMIT_WINDOW  = 5 * 60 * 1000; // 5 minutes in ms

function checkComputeRateLimit(ip) {
    // Bypass rate limit for localhost in development — lets automated test suites run without hitting cap
    if (process.env.NODE_ENV !== 'production' && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return true;
    const now = Date.now();
    const entry = computeRateLimiter.get(ip);

    if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW) {
        computeRateLimiter.set(ip, { count: 1, windowStart: now });
        return true;
    }

    if (entry.count >= RATE_LIMIT_MAX) return false;

    entry.count++;
    return true;
}

// ── Push helper ───────────────────────────────────────────────────────────────
// Safely serialize and send. Sets ws.cancelled if connection is no longer open.
function pushToClient(ws, message) {
    if (ws.readyState === ws.OPEN) {
        try {
            ws.send(JSON.stringify(message));
        } catch (err) {
            console.error('WebSocket send error:', err.message);
            ws.cancelled = true;
        }
    } else {
        ws.cancelled = true;
    }
}

// ── Connection handler ────────────────────────────────────────────────────────
// Called by server/index.js on every new WebSocket connection.
export function handlePipelineConnection(ws, req) {
    // Extract client IP — handles both direct connections and Render/proxy headers
    const clientIp = (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        'unknown'
    );

    // Per-connection state attached directly to the ws object
    ws.cancelled        = false;
    ws.pipelineRunning  = false;
    ws.previousState    = {}; // { hull, validCandidates, incidents, hullAreaM2 }

    // Send 'connected' immediately so the frontend knows the WebSocket handshake succeeded
    pushToClient(ws, { type: 'connected' });

    // ── Incoming message handler ──────────────────────────────────────────────
    ws.on('message', async (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            pushToClient(ws, {
                type: 'error',
                data: { message: 'Invalid JSON message format.', fatal: false }
            });
            return;
        }

        switch (msg.type) {
            case 'compute':
                if (ws.pipelineRunning) {
                    pushToClient(ws, {
                        type: 'error',
                        data: { message: 'Pipeline already running. Send cancel first or wait for completion.', fatal: false }
                    });
                    return;
                }
                await handleCompute(ws, msg.data, clientIp);
                break;

            case 'init':
                await handleInit(ws, msg.data);
                break;

            case 'ping':
                pushToClient(ws, { type: 'pong' });
                break;

            case 'cancel':
                ws.cancelled = true;
                break;

            default:
                pushToClient(ws, {
                    type: 'error',
                    data: { message: `Unknown message type: "${msg.type}"`, fatal: false }
                });
        }
    });

    ws.on('close', () => {
        ws.cancelled = true;
    });

    ws.on('error', (err) => {
        console.error(`WebSocket error [${clientIp}]:`, err.message);
        ws.cancelled = true;
    });
}

// ── Init handler ─────────────────────────────────────────────────────────────
// Loads the road network (warming the cache) and sends network_loaded so the
// client can render the barangay darkening mask before the first pipeline run.
async function handleInit(ws, data) {
    const barangay = data?.barangay || 'Commonwealth';
    try {
        const networkData = await getOrFetchNetwork(barangay);
        pushToClient(ws, {
            type: 'network_loaded',
            data: {
                barangay,
                nodeCount:         networkData.nodeCount,
                edgeCount:         networkData.edgeCount,
                intersectionCount: networkData.intersectionCount,
                fromCache:         networkData.fromCache,
                boundaryPolygon:   networkData.boundary
            }
        });
    } catch (err) {
        console.error(`[init] Failed to load network for "${barangay}":`, err.message);
    }
}

// ── Compute handler ───────────────────────────────────────────────────────────
// Core pipeline orchestration. Validates inputs, loads network, delegates to runPipeline.
async function handleCompute(ws, data, clientIp) {
    ws.pipelineRunning = true;
    ws.cancelled       = false; // reset on each new compute request
    let countedActive  = false; // tracks whether we incremented activePipelines

    try {
        // 1. Global concurrency cap — reject immediately if server is at capacity
        if (activePipelines >= MAX_CONCURRENT_PIPELINES) {
            pushToClient(ws, {
                type: 'error',
                data: {
                    message: `Server is at capacity (${MAX_CONCURRENT_PIPELINES} concurrent pipelines running). PatrolPoint is computationally intensive and each active pipeline consumes significant RAM, so live deployment capacity is intentionally limited. Please try again in a moment. To run without limits on your own machine: (1) clone the repository, (2) install dependencies with "npm install", (3) start the server with "DEMO_MODE=true npm start", (4) open http://localhost:3000 in your browser.`,
                    fatal: true
                }
            });
            return;
        }

        activePipelines++;
        countedActive = true;

        // 2. Rate limit check (WebSocket compute — sends error message, not HTTP 429)
        if (!checkComputeRateLimit(clientIp)) {
            pushToClient(ws, {
                type: 'error',
                data: {
                    message: 'Too many compute requests. Please wait a few minutes before trying again.',
                    fatal: true
                }
            });
            return;
        }

        // 2. Input validation — throws descriptive Error on invalid
        try {
            const barangay = data?.barangay || 'Commonwealth';
            validateBarangay(barangay);
            validateIncidents(data?.incidents);
            validateN(data?.n);
            validateMode(data?.mode);
            if (data?.config) validateConfig(data.config);
        } catch (validationErr) {
            pushToClient(ws, {
                type: 'error',
                data: { message: validationErr.message, fatal: true }
            });
            return;
        }

        const barangay = data.barangay || 'Commonwealth';

        // 3. Load road network — in-memory cache → PostgreSQL cache → Overpass API
        let networkData;
        try {
            networkData = await getOrFetchNetwork(barangay);
        } catch (netErr) {
            pushToClient(ws, {
                type: 'error',
                data: { message: `Failed to load road network: ${netErr.message}`, fatal: true }
            });
            return;
        }

        if (ws.cancelled) return;

        // 4. Confirm network loaded to the client
        pushToClient(ws, {
            type: 'network_loaded',
            data: {
                barangay,
                nodeCount:         networkData.nodeCount,
                edgeCount:         networkData.edgeCount,
                intersectionCount: networkData.intersectionCount,
                fromCache:         networkData.fromCache,
                boundaryPolygon:   networkData.boundary
            }
        });

        // 5. Signal pipeline start
        pushToClient(ws, {
            type: 'pipeline_start',
            data: { totalStages: 4, mode: data.mode }
        });

        // 6. Run pipeline — pushMessage wraps pushToClient so pipeline.js has no ws reference
        const pushMessage  = (msg) => pushToClient(ws, msg);
        const isCancelled  = ()    => ws.cancelled;

        const pipelineResult = await runPipeline(
            networkData,
            data,
            pushMessage,
            isCancelled,
            ws.previousState
        );

        // 7. Update per-connection state for the next run's incremental hull optimization
        if (pipelineResult?.previousState) {
            ws.previousState = pipelineResult.previousState;
        }

    } catch (unexpectedErr) {
        console.error('Unexpected pipeline error:', unexpectedErr);
        pushToClient(ws, {
            type: 'error',
            data: {
                message: 'An unexpected error occurred. Please check your inputs and try again.',
                fatal: true
            }
        });
    } finally {
        if (countedActive) activePipelines--;
        ws.pipelineRunning = false;
    }
}
