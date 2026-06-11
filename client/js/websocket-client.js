// PatrolPoint V2 — websocket-client.js
// WebSocket connection, reconnection, ping keepalive, and message handling.
// All map rendering delegated to placeholder functions — replaced by map.js in Part 8D.
// This file handles communication and state management only — nothing visual.

// ── Module-level state ─────────────────────────────────────────────────────────
let ws                = null;
let reconnectAttempts = 0;
let pingInterval      = null;
let lastPongTimestamp = null;
let initialized       = false; // guard against double-init from main.js and ui.js

// Pipeline warning/state tracking across message handlers
let pipelineWarnings      = [];    // warnings accumulated per pipeline run for banner consolidation
let _emptyZoneCount       = 0;     // set by stage 3 handler, used in pipeline_complete summary
let _overlapEdgeCount     = 0;     // set by stage 4 handler, used in pipeline_complete summary
let _lastMinPairwiseDist  = null;  // set by stage 2 result, used in comparison capture
let _lastConfidence       = null;  // set by stage 2 result, used for confidence badge
let _lastTotalRuntimeMs   = null;  // set by pipeline_complete, used in comparison capture

const MAX_RECONNECT   = 5;
const RECONNECT_DELAY = 3000;  // ms between reconnect attempts
const PING_INTERVAL   = 30000; // ms between keepalive pings

const STAGE_NAMES = {
    1: 'Brute Force Convex Hull',
    2: 'Hill Climbing',
    3: 'Zone Assignment',
    4: 'Backtracking TSP'
};

// ── Placeholder functions ──────────────────────────────────────────────────────
// Exported so map.js can call replacePlaceholder() to wire real rendering functions.

export let onConnected        = ()       => console.log('placeholder: onConnected');
export let onNetworkLoaded    = (data)   => console.log('placeholder: onNetworkLoaded', data);
export let onStageProgress    = (data)   => console.log('placeholder: onStageProgress', data);
export let onHullComplete     = (result) => console.log('placeholder: onHullComplete', result);
export let onPatrolsComplete  = (result) => console.log('placeholder: onPatrolsComplete', result);
export let onZonesComplete    = (result) => console.log('placeholder: onZonesComplete', result);
export let onRoutesComplete   = (result) => console.log('placeholder: onRoutesComplete', result);
export let onPipelineComplete = (data)   => console.log('placeholder: onPipelineComplete', data);

export function replacePlaceholder(name, fn) {
    switch (name) {
        case 'onConnected':        onConnected        = fn; break;
        case 'onNetworkLoaded':    onNetworkLoaded    = fn; break;
        case 'onStageProgress':    onStageProgress    = fn; break;
        case 'onHullComplete':     onHullComplete     = fn; break;
        case 'onPatrolsComplete':  onPatrolsComplete  = fn; break;
        case 'onZonesComplete':    onZonesComplete    = fn; break;
        case 'onRoutesComplete':   onRoutesComplete   = fn; break;
        case 'onPipelineComplete': onPipelineComplete = fn; break;
    }
}

// ── WebSocket URL ──────────────────────────────────────────────────────────────
// Dynamically derived from current page — never hardcoded.
// Uses wss in production (https) and ws in development (http) automatically.
function getWebSocketUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}`;
}

// ── Ping keepalive ─────────────────────────────────────────────────────────────
function startPingInterval() {
    clearPingInterval();
    pingInterval = setInterval(sendPing, PING_INTERVAL);
}

function clearPingInterval() {
    if (pingInterval !== null) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

export function sendInitRequest(barangay) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'init', data: { barangay } }));
    }
}

export function sendPing() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
    }
}

// ── Connection status ──────────────────────────────────────────────────────────
function setConnectionStatus(state) {
    const ui = window.uiApp;
    if (!ui) return;
    switch (state) {
        case 'connected':
            ui.wsConnected  = true;
            ui.wsStatusText = 'Connected';
            break;
        case 'connecting':
            ui.wsConnected  = false;
            ui.wsStatusText = reconnectAttempts > 0
                ? `Reconnecting… (attempt ${reconnectAttempts} of ${MAX_RECONNECT})`
                : 'Connecting to server…';
            break;
        case 'disconnected':
            ui.wsConnected  = false;
            ui.wsStatusText = 'Disconnected from server.';
            break;
    }
}

// ── Connect / reconnect ────────────────────────────────────────────────────────
function connect() {
    const url = getWebSocketUrl();
    console.log(`[WS] Connecting to ${url}${reconnectAttempts > 0 ? ` (attempt ${reconnectAttempts + 1})` : ''}`);

    ws = new WebSocket(url);
    ws.addEventListener('open',    handleOpen);
    ws.addEventListener('message', handleMessage);
    ws.addEventListener('close',   handleClose);
    ws.addEventListener('error',   handleError);
}

function handleOpen() {
    // Successful TCP connection — reset counter and start ping interval.
    // UI switches to 'connected' only when the server sends its 'connected' message.
    reconnectAttempts = 0;
    startPingInterval();
    console.log('[WS] Connection open — awaiting "connected" confirmation from server');
}

function handleClose(event) {
    clearPingInterval();
    console.log(`[WS] Connection closed (code: ${event.code}, reason: "${event.reason || 'none'}")`);

    reconnectAttempts++;

    if (reconnectAttempts >= MAX_RECONNECT) {
        console.error('[WS] Maximum reconnect attempts reached. Stopping.');
        setConnectionStatus('disconnected');
        const ui = window.uiApp;
        if (ui) {
            ui.showBanner(
                'Unable to connect to PatrolPoint server. Please refresh the page.',
                'error'
            );
        }
    } else {
        setConnectionStatus('connecting');
        console.log(`[WS] Reconnecting in ${RECONNECT_DELAY / 1000}s…`);
        setTimeout(connect, RECONNECT_DELAY);
    }
}

function handleError(event) {
    // Error always fires before close — only log here, reconnect logic lives in handleClose.
    console.error('[WS] WebSocket error:', event.message || event.type || event);
}

// ── Message dispatch ───────────────────────────────────────────────────────────
function handleMessage(event) {
    let msg;
    try {
        msg = JSON.parse(event.data);
    } catch {
        console.warn('[WS] Received non-JSON message:', event.data);
        return;
    }

    const { type, data } = msg;

    switch (type) {
        case 'connected':         handleConnected();              break;
        case 'network_loaded':    handleNetworkLoaded(data);      break;
        case 'pipeline_start':    handlePipelineStart(data);      break;
        case 'stage_start':       handleStageStart(data);         break;
        case 'stage_progress':    handleStageProgress(data);      break;
        case 'stage_complete':    handleStageComplete(data);      break;
        case 'warning':           handleWarning(data);            break;
        case 'error':             handleServerError(data);        break;
        case 'pipeline_complete': handlePipelineComplete(data);   break;
        case 'pong':              handlePong();                   break;
        default:
            console.warn(`[WS] Unknown message type: "${type}"`);
    }
}

// ── Individual message handlers ────────────────────────────────────────────────

function handleConnected() {
    console.log('CONNECTED: PatrolPoint server connected');
    setConnectionStatus('connected');
    onConnected();

    // Request boundary polygon immediately so the darkening mask renders on open
    const initialBarangay = window.uiApp?.selectedBarangay || 'Commonwealth';
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'init', data: { barangay: initialBarangay } }));
    }
}

function handleNetworkLoaded(data) {
    console.log('NETWORK_LOADED:', {
        barangay:          data.barangay,
        nodeCount:         data.nodeCount,
        edgeCount:         data.edgeCount,
        intersectionCount: data.intersectionCount,
        fromCache:         data.fromCache
    });

    // Store boundary polygon globally for map.js to render the darkening mask
    if (data.boundaryPolygon) {
        window.barangayBoundary = data.boundaryPolygon;
    }

    // nodeMap, adjacencyList, intersectionNodeIds live server-side in V2 —
    // the backend runs all algorithm computation and sends only results to the client.

    // Update Alpine component with network metadata
    const ui = window.uiApp;
    if (ui) {
        ui.networkInfo = `${data.nodeCount} nodes · ${data.edgeCount} edges · ${data.fromCache ? 'cached' : 'live OSM'}`;
        if (data.intersectionCount) {
            ui.nMax = Math.floor(Math.sqrt(data.intersectionCount));
        }
    }

    onNetworkLoaded(data);
}

function handlePipelineStart(data) {
    console.log('PIPELINE_START:', { totalStages: data.totalStages, mode: data.mode });

    // Clear previous pipeline result globals
    window.currentHull      = null;
    window.S_star           = [];
    window.zones            = [];
    window.routes           = [];
    window.pipelineComplete = false;
    window.pipelineRunning  = true;

    // Reset per-run tracking
    pipelineWarnings     = [];
    _emptyZoneCount      = 0;
    _overlapEdgeCount    = 0;
    _lastMinPairwiseDist = null;
    _lastConfidence      = null;
    _lastTotalRuntimeMs  = null;

    const ui = window.uiApp;
    if (ui) {
        ui.initTracePanel();

        // Initialize one trace entry per stage that will actually run
        const stageCount = data.mode === 'roaming' ? data.totalStages : 3;
        for (let i = 1; i <= stageCount; i++) {
            ui.addTraceStage(i, STAGE_NAMES[i]);
        }

        ui.clearBanner();
        ui.pipelineRunning   = true;
        ui.pipelineComplete  = false;
        ui.pipelineStageText = 'Computing…';
    }
}

function handleStageStart(data) {
    console.log(`STAGE_START: Stage ${data.stage} — ${data.name}`);

    const ui = window.uiApp;
    if (ui) {
        ui.pipelineStageText = `Running Stage ${data.stage} — ${data.name}…`;
        ui.updateTraceStage(data.stage, { status: 'running' });
    }
}

function handleStageProgress(data) {
    console.log(
        `STAGE_PROGRESS: Stage ${data.stage}, ` +
        `Restart ${data.restart ?? '—'}, ` +
        `Iteration ${data.iteration ?? '—'}, ` +
        `BestDist ${data.bestMinDist != null ? data.bestMinDist.toFixed(1) + 'm' : '—'}, ` +
        `Patrols: ${data.patrolPositions ? data.patrolPositions.length : 0}`
    );
    onStageProgress(data);
}

function handleStageComplete(data) {
    const { stage, result, trace, runtimeMs } = data;

    // Abbreviated result summary for console log
    let resultSummary;
    if (stage === 1) {
        resultSummary = `hull vertices: ${result.hull?.length ?? 0}, candidates: ${result.validCandidateCount ?? 0}`;
    } else if (stage === 2) {
        resultSummary = `patrols: ${result.patrols?.length ?? 0}, minDist: ${result.bestMinPairwiseDist?.toFixed(1) ?? '—'}m`;
    } else if (stage === 3) {
        resultSummary = `zones: ${result.zones?.length ?? 0}, emptyZones: ${result.emptyZones?.length ?? 0}`;
    } else {
        resultSummary = `routes: ${result.routes?.length ?? 0}`;
    }
    console.log(`STAGE_COMPLETE: Stage ${stage}, Runtime ${runtimeMs?.toFixed(1) ?? '—'}ms — ${resultSummary}`);

    // Capture stage-level data used in pipeline_complete summary
    if (stage === 3) _emptyZoneCount   = result.emptyZones?.length ?? 0;
    if (stage === 4) _overlapEdgeCount = result.overlapEdges?.length ?? 0;

    // Stage 2: capture confidence + min pairwise dist for comparison mode and badge
    if (stage === 2) {
        _lastMinPairwiseDist        = result.bestMinPairwiseDist ?? null;
        _lastConfidence             = result.confidence ?? null;
        window._lastMinPairwiseDist = _lastMinPairwiseDist;
        window._pipelineConfidence  = _lastConfidence;
    }

    const ui = window.uiApp;
    if (ui) {
        // Preserve 'warning' status if already set by a preceding warning message for this stage.
        // Also merge any warning log lines already appended to fullLog before overwriting with
        // the server's full trace log.
        const existing    = ui.traceStages.find(s => s.id === stage);
        const existStatus = existing?.status;
        const existLog    = existing?.fullLog || '';
        const serverLog   = trace?.log || '';
        const combinedLog = [existLog, serverLog].filter(Boolean).join('\n');

        const stageUpdate = {
            status:    existStatus === 'warning' ? 'warning' : 'success',
            summary:   buildTraceSummary(stage, result, runtimeMs),
            fullLog:   combinedLog,
            runtimeMs: Math.round(runtimeMs)
        };
        // Attach confidence to stage 2 for color-coded display in trace panel
        if (stage === 2 && _lastConfidence !== null) {
            stageUpdate.confidence = _lastConfidence;
        }
        ui.updateTraceStage(stage, stageUpdate);
    }

    // Branch per stage number and call correct placeholder
    switch (stage) {
        case 1: onHullComplete(result);    break;
        case 2: onPatrolsComplete(result); break;
        case 3: onZonesComplete(result);   break;
        case 4: onRoutesComplete(result);  break;
    }
}

function handleWarning(data) {
    console.log(`WARNING: Stage ${data.stage ?? '?'} — ${data.message}`);

    const ui = window.uiApp;
    if (ui) {
        // Append warning to the corresponding stage's fullLog and mark stage as warning
        if (data.stage != null) {
            const stage = ui.traceStages.find(s => s.id === data.stage);
            if (stage) {
                stage.fullLog = stage.fullLog
                    ? `${stage.fullLog}\n⚠ ${data.message}`
                    : `⚠ ${data.message}`;
                stage.status = 'warning';
            }
        }

        // Consolidate all pipeline warnings into a single banner with list format
        pipelineWarnings.push(data.message);
        ui.showBanner(pipelineWarnings[0], 'warning', [...pipelineWarnings]);
    }
}

function handleServerError(data) {
    console.log(`ERROR: Stage ${data.stage ?? '?'} — ${data.message}, fatal: ${data.fatal}`);

    if (data.fatal) {
        const ui = window.uiApp;
        if (ui) {
            ui.showBanner(data.message, 'error');
            ui.pipelineRunning   = false;
            ui.pipelineComplete  = false;
            ui.pipelineStageText = 'Recalculate';

            // Mark the relevant stage as errored if stage is known
            if (data.stage != null) {
                ui.updateTraceStage(data.stage, { status: 'error' });
            }
        }
        window.pipelineRunning = false;
    } else {
        // Non-fatal — append to relevant stage's fullLog only, pipeline continues
        const ui = window.uiApp;
        if (ui && data.stage != null) {
            const stage = ui.traceStages.find(s => s.id === data.stage);
            if (stage) {
                stage.fullLog = stage.fullLog
                    ? `${stage.fullLog}\n✗ ${data.message}`
                    : `✗ ${data.message}`;
            }
        }
    }
}

function handlePipelineComplete(data) {
    const { hull, patrols, zones, routes, totalRuntimeMs, verificationReport } = data;

    console.log(
        `PIPELINE_COMPLETE: TotalRuntime ${totalRuntimeMs?.toFixed(1) ?? '—'}ms, ` +
        `OverallPass: ${verificationReport?.overallPass ?? 'n/a'}`
    );

    // Store all results in main.js globals
    window.currentHull       = hull;
    window.S_star            = patrols;
    window.zones             = zones;
    window.routes            = routes;
    window.pipelineComplete  = true;
    window.pipelineRunning   = false;
    _lastTotalRuntimeMs      = totalRuntimeMs;
    window._lastTotalRuntimeMs = totalRuntimeMs;

    const ui = window.uiApp;
    if (ui) {
        ui.pipelineComplete  = true;
        ui.pipelineRunning   = false;
        ui.pipelineStageText = 'Recalculate';

        // Sync reactive routes mirror for route playback selector
        ui.routes = routes || [];

        // Show route playback controls bar in roaming mode
        if (ui.deploymentMode === 'roaming' && routes && routes.length > 0) {
            ui.routePlaybackActive = true;
            ui.showPlayback        = true;
        }

        // Build and append pipeline summary to trace panel
        const roamingCount    = routes ? routes.length : 0;
        const stationaryCount = _emptyZoneCount;
        const overlapEdges    = _overlapEdgeCount;

        const summaryLines = [
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `Pipeline Complete — Total time: ${Math.round(totalRuntimeMs)}ms`,
            `${roamingCount} roaming patrol${roamingCount !== 1 ? 's' : ''} · ${stationaryCount} stationary · ${overlapEdges} overlapping edge${overlapEdges !== 1 ? 's' : ''}`
        ];

        if (verificationReport) {
            summaryLines.push(
                verificationReport.overallPass
                    ? 'Verification: all checks passed'
                    : `Verification: ${verificationReport.failureCount} check(s) failed`
            );
        }

        summaryLines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        ui.setPipelineSummary(summaryLines.join('\n'));

        // Auto-scroll trace panel after summary is written — must fire after setPipelineSummary
        if (typeof ui.scrollTracePanelToBottom === 'function') {
            ui.scrollTracePanelToBottom();
        }

        // Verification report — store on Alpine component and optionally banner if failed
        ui.verificationReport = verificationReport || null;
        if (verificationReport && !verificationReport.overallPass && verificationReport.failureCount > 0) {
            const vMsg = 'Algorithm verification detected issues. Results may be suboptimal. Check the trace panel for details.';
            pipelineWarnings.push(vMsg);
            ui.showBanner(pipelineWarnings[0], 'warning', [...pipelineWarnings]);
        }

        // Comparison mode: auto-store current result as Run B when Run A already exists
        if (window.comparisonModeActive && ui.comparisonRunA) {
            const totalCircuitDist = (routes || []).reduce((s, r) => s + (r.circuitDistanceM || 0), 0);
            const stationaryCount  = (zones  || []).filter(z => !z || z.length === 0).length;
            const runB = {
                barangay:        ui.selectedBarangay,
                patrols:         patrols ? [...patrols] : [],
                hull:            hull    ? [...hull]    : [],
                zones:           zones   ? [...zones]   : [],
                routes:          routes  ? [...routes]  : [],
                mode:            ui.deploymentMode,
                minPairwiseDist: _lastMinPairwiseDist,
                totalCircuitDist,
                stationaryCount,
                totalRuntimeMs,
                config:          JSON.parse(JSON.stringify(ui.activeConfig))
            };
            ui.comparisonRunB        = runB;
            window.comparisonResultB = runB;
            if (typeof window.renderComparisonResults === 'function') {
                window.renderComparisonResults(ui.comparisonRunA, runB);
            }
        }

        // Auto-prompt session save if user is logged in
        if (window.authToken) {
            setTimeout(() => ui.promptSaveSession(), 300);
        }
    }

    onPipelineComplete(data);
}

function handlePong() {
    lastPongTimestamp = Date.now();
    console.log(`PONG: received at ${new Date(lastPongTimestamp).toISOString()}`);
}

// ── Trace summary builder ──────────────────────────────────────────────────────
function buildTraceSummary(stage, result, runtimeMs) {
    const rt = runtimeMs != null ? `${Math.round(runtimeMs)}ms` : '—';
    switch (stage) {
        case 1:
            return [
                result.skipped
                    ? 'Hull unchanged (incremental skip).'
                    : `Hull: ${result.hull?.length ?? 0} vertices, area: ${result.hullArea != null ? (result.hullArea / 1e6).toFixed(4) + ' km²' : '—'}`,
                `Outliers detected: ${result.outlierCount ?? 0}`,
                `Valid candidates inside hull: ${result.validCandidateCount ?? 0}`,
                result.linearHandlerTriggered ? 'Linear handler triggered.' : '',
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        case 2:
            return [
                `Best min pairwise distance: ${result.bestMinPairwiseDist?.toFixed(1) ?? '—'}m`,
                `Best restart: #${result.bestRestart ?? '—'}`,
                `Confidence: ${result.confidence?.toFixed(1) ?? '—'}%`,
                result.cappedFrom != null ? `Patrol count capped: ${result.cappedFrom} → ${result.patrols?.length}` : '',
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        case 3:
            return [
                `Zones: ${result.zones?.length ?? 0} total`,
                `Empty zones: ${result.emptyZones?.length ?? 0}`,
                `Single-node zones: ${result.singleNodeZones?.length ?? 0}`,
                `Avg snapping distance: ${result.avgSnappingDist?.toFixed(1) ?? '—'}m`,
                `Max snapping distance: ${result.maxSnappingDist?.toFixed(1) ?? '—'}m`,
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        case 4:
            return [
                `Routes: ${result.routes?.length ?? 0} patrol circuits`,
                `Dijkstra calls: ${result.totalDijkstraCalls ?? '—'}, cache hits: ${result.totalCacheHits ?? '—'}`,
                `Overlap edges: ${result.overlapEdges?.length ?? 0}`,
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        default:
            return `Runtime: ${rt}`;
    }
}

// ── sendComputeRequest ─────────────────────────────────────────────────────────
// Pre-validates inputs then sends compute message over WebSocket.
// Also exposed globally so ui.js recalculate() can call it as window.sendComputeRequest.
export function sendComputeRequest(incidents, n, mode, config, barangay) {
    const ui = window.uiApp;

    // Defensive input checks — ui.js recalculate() also validates, but guard here too
    if (!incidents || incidents.length === 0) {
        if (ui) ui.showBanner('No incident coordinates plotted. Please click the map to add incident coordinates.', 'error');
        return;
    }
    if (incidents.length === 1) {
        if (ui) ui.showBanner('At least 2 incident coordinates are needed. Please plot more points.', 'error');
        return;
    }
    if (!Number.isInteger(n) || n <= 0) {
        if (ui) ui.showBanner('Number of patrols must be a positive whole number.', 'error');
        return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        if (ui) ui.showBanner('Not connected to server. Please wait and try again.', 'error');
        return;
    }

    ws.send(JSON.stringify({
        type: 'compute',
        data: { incidents, n, mode, config, barangay }
    }));
}

// ── initWebSocket ──────────────────────────────────────────────────────────────
// Called by main.js DOMContentLoaded and ui.js Alpine init.
// The initialized guard makes it idempotent — second call is a no-op.
export function initWebSocket() {
    if (initialized) return;
    initialized = true;

    // Show connecting overlay immediately
    setConnectionStatus('connecting');
    connect();
}

// Expose to global scope so main.js and ui.js can call without an ES module import.
// map.js uses the named exports directly via import.
window.initWebSocket      = initWebSocket;
window.sendComputeRequest = sendComputeRequest;
window.sendInitRequest    = sendInitRequest;
