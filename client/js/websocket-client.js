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
let _lastConvergenceCurve = null;  // set by stage 2 result, used for curve chart
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

    // Store both counts globally so applySettings() can recompute nMax on toggle
    window._nodeCount         = data.nodeCount;
    window._intersectionCount = data.intersectionCount;

    // Update Alpine component with network metadata
    const ui = window.uiApp;
    if (ui) {
        ui.networkInfo = `${data.nodeCount} nodes · ${data.edgeCount} edges · ${data.fromCache ? 'cached' : 'live OSM'}`;
        const candidateNodes = ui.activeConfig?.candidateNodes ?? 'all';
        const count = candidateNodes === 'intersection' ? data.intersectionCount : data.nodeCount;
        if (count) ui.nMax = Math.floor(Math.sqrt(count));
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
    window.validCandidates  = null;
    window.pipelineComplete = false;
    window.pipelineRunning  = true;

    // Reset per-run tracking
    pipelineWarnings      = [];
    _emptyZoneCount       = 0;
    _overlapEdgeCount     = 0;
    _lastMinPairwiseDist  = null;
    _lastConfidence       = null;
    _lastConvergenceCurve = null;
    _lastTotalRuntimeMs   = null;

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
        ui.pipelineStageText = `Running Stage ${data.stage}: ${data.name}...`;
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
        // expose for test runner — synthetic array-like with .length matching server count
        const count = result.validCandidateCount ?? 0;
        window.validCandidates = count > 0 ? { length: count } : null;
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

    // Stage 2: capture confidence + min pairwise dist + convergence curve
    if (stage === 2) {
        _lastMinPairwiseDist        = result.bestMinPairwiseDist ?? null;
        _lastConfidence             = result.confidence  ?? null;
        window._lastMinPairwiseDist = _lastMinPairwiseDist;
        window._pipelineConfidence  = _lastConfidence;

        // Build convergence curve array for bar chart rendering.
        // Each entry: { bestSoFar (meters), pct (0–100 relative to final best), improved (bool) }
        const bsf = result.bestSoFarCurve;
        if (bsf && bsf.length > 0) {
            const max = bsf[bsf.length - 1] || 1;
            _lastConvergenceCurve = bsf.map((val, i) => ({
                bestSoFar: val,
                pct:       Math.round((val / max) * 100),
                improved:  i === 0 ? true : val > bsf[i - 1]
            }));
        } else {
            _lastConvergenceCurve = null;
        }
    }

    // Cache hull area from Stage 1 so Stage 2 metrics can compute spread quality
    if (stage === 1 && result.hullArea != null) {
        window._lastHullArea = result.hullArea;
    }

    const ui = window.uiApp;
    if (ui) {
        // Preserve 'warning' status if already set by a preceding warning message for this stage.
        // Also merge any warning log lines already appended to fullLog before overwriting with
        // the server's full trace log.
        const existing    = ui.traceStages.find(s => s.id === stage);
        const existStatus = existing?.status;
        const existLog    = existing?.fullLog || '';
        const rawLog      = trace?.log ?? '';
        const serverLog   = Array.isArray(rawLog) ? rawLog.join('\n') : rawLog;
        const preamble    = buildFullLogPreamble(stage, result, runtimeMs);
        const combinedLog = [existLog, preamble, serverLog].filter(Boolean).join('\n');

        const stageUpdate = {
            status:    existStatus === 'warning' ? 'warning' : 'success',
            summary:   buildTraceSummary(stage, result, runtimeMs),
            metrics:   buildTraceMetrics(stage, result),
            fullLog:   combinedLog,
            runtimeMs: Math.round(runtimeMs)
        };
        // Attach Stage 2 convergence data for trace panel display
        if (stage === 2) {
            if (_lastConfidence !== null)    stageUpdate.confidence        = _lastConfidence;
            if (_lastConvergenceCurve)       stageUpdate.convergenceCurve  = _lastConvergenceCurve;
            stageUpdate.convergenceRestart  = result.convergenceRestart  ?? null;
            stageUpdate.redundancy          = result.redundancy          ?? null;
            stageUpdate.restartsCompleted   = result.restartsCompleted   ?? null;
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
                    ? `${stage.fullLog}\n[WARN] ${data.message}`
                    : `[WARN] ${data.message}`;
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
        // Show nearest intersection hints when validCandidates is empty
        if (data.nearestHighlights && data.nearestHighlights.length > 0) {
            window.renderNearestHighlights?.(data.nearestHighlights);
        }
    } else {
        // Non-fatal — append to relevant stage's fullLog only, pipeline continues
        const ui = window.uiApp;
        if (ui && data.stage != null) {
            const stage = ui.traceStages.find(s => s.id === data.stage);
            if (stage) {
                stage.fullLog = stage.fullLog
                    ? `${stage.fullLog}\n[FAIL] ${data.message}`
                    : `[FAIL] ${data.message}`;
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

        // Sync reactive routes mirror — only animatable routes (non-empty pathSegments)
        const animatableRoutes = (routes || [])
            .filter(r => r.pathSegments && r.pathSegments.length > 0)
            .sort((a, b) => (a.patrolIndex ?? 0) - (b.patrolIndex ?? 0));
        ui.routes = animatableRoutes;

        // Show route playback controls bar in roaming mode
        if (ui.deploymentMode === 'roaming' && animatableRoutes.length > 0) {
            ui.playbackPatrolId = animatableRoutes[0].patrolId;
            ui.showPlayback     = true;
        }

        // Build and append pipeline summary to trace panel
        const roamingCount    = routes ? routes.length : 0;
        const stationaryCount = _emptyZoneCount;
        const overlapEdges    = _overlapEdgeCount;

        const summaryLines = [
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `Pipeline Complete  Total time: ${Math.round(totalRuntimeMs)}ms`,
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

        // Structured summary for the redesigned pipeline summary card
        ui.pipelineSummaryData = {
            totalRuntimeMs:       Math.round(totalRuntimeMs),
            roamingCount:         roamingCount,
            stationaryCount:      stationaryCount,
            overlapEdges:         overlapEdges,
            verificationPass:     verificationReport ? verificationReport.overallPass : null,
            verificationFailCount: verificationReport ? (verificationReport.failureCount || 0) : 0
        };

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

// ── Full log preamble builder ──────────────────────────────────────────────────
// Adds a structured header before the raw server trace log so the full log
// reads as a complete account of what the algorithm received and produced.
function buildFullLogPreamble(stage, result, runtimeMs) {
    const rt = runtimeMs != null ? `${Math.round(runtimeMs)} ms` : 'unknown';
    const hr = '─'.repeat(48);
    switch (stage) {
        case 1: {
            const vertexCount    = result.hull?.length ?? 0;
            const areaKm2        = result.hullArea != null ? (result.hullArea / 1e6).toFixed(4) : '—';
            const areaM2         = result.hullArea != null ? Math.round(result.hullArea).toLocaleString() : '—';
            const candidates     = result.validCandidateCount ?? 0;
            const outliers       = result.outlierCount ?? 0;
            return [
                hr,
                'STAGE 1  Brute Force Convex Hull',
                hr,
                `Runtime          : ${rt}`,
                `Outliers flagged : ${outliers} (threshold: ${window.uiApp?.activeConfig?.convexHull?.outlierMultiplier ?? 2.5}x avg distance from centroid)`,
                `Hull vertices    : ${vertexCount}`,
                `Hull area        : ${areaM2} m²  (${areaKm2} km²)`,
                `Road intersections inside hull : ${candidates} of ${window._intersectionCount ?? '?'} total`,
                result.linearHandlerTriggered ? 'Linear handler   : TRIGGERED (patrols placed along incident line)' : 'Collinearity     : passed (full hull computed)',
                result.skipped ? 'Cache            : hull unchanged (valid candidates reused from previous run)' : '',
                hr
            ].filter(Boolean).join('\n');
        }
        case 2: {
            const n              = result.patrols?.length ?? 0;
            const candidates     = result.validCandidateCount ?? result.patrols?.length ?? '?';
            const best           = result.bestMinPairwiseDist != null ? result.bestMinPairwiseDist.toFixed(1) + ' m' : 'N/A';
            const restartBest    = result.convergenceRestart ?? 'N/A';
            const totalRestarts  = result.restartsCompleted ?? 'N/A';
            const redundancy     = result.redundancy != null ? result.redundancy.toFixed(1) + '%' : 'N/A';
            const confidence     = result.confidence != null ? result.confidence.toFixed(1) + '%' : 'N/A';
            const cappedNote     = result.cappedFrom != null ? `(capped from ${result.cappedFrom})` : '';
            return [
                hr,
                'STAGE 2  Hill Climbing Patrol Placement',
                hr,
                `Runtime               : ${rt}`,
                `Patrols requested     : ${n} ${cappedNote}`,
                `Candidate nodes       : ${candidates}`,
                `Restarts completed    : ${totalRestarts}`,
                `Best result at restart: #${restartBest}`,
                `Best min pairwise dist: ${best}`,
                `Redundancy            : ${redundancy}  (% of restarts that confirmed without improving)`,
                `Confidence            : ${confidence}  (60% consistency + 40% confirmation)`,
                hr
            ].filter(Boolean).join('\n');
        }
        case 3: {
            const zoneCount      = result.zones?.length ?? 0;
            const emptyCount     = result.emptyZones?.length ?? 0;
            const singleCount    = result.singleNodeZones?.length ?? 0;
            const multiCount     = zoneCount - emptyCount - singleCount;
            const avgSnap        = result.avgSnappingDist != null ? result.avgSnappingDist.toFixed(1) + ' m' : 'N/A';
            const maxSnap        = result.maxSnappingDist != null ? result.maxSnappingDist.toFixed(1) + ' m' : 'N/A';
            const nonEmptyZones  = (result.zones || []).filter(z => z && z.length > 0);
            const zoneSizes      = nonEmptyZones.map(z => z.length);
            const minZone        = zoneSizes.length > 0 ? Math.min(...zoneSizes) : 0;
            const maxZone        = zoneSizes.length > 0 ? Math.max(...zoneSizes) : 0;
            const balance        = maxZone > 0 ? Math.round((minZone / maxZone) * 100) : 100;
            const zoneBreakdown  = (result.zones || []).map((z, i) =>
                `  Patrol s${i + 1}: ${z?.length ?? 0} crime node(s)`
            ).join('\n');
            return [
                hr,
                'STAGE 3  Zone Assignment',
                hr,
                `Runtime              : ${rt}`,
                `Total zones          : ${zoneCount}  (${emptyCount} empty, ${singleCount} single-node, ${multiCount} multi-node)`,
                `Avg snapping distance: ${avgSnap}`,
                `Max snapping distance: ${maxSnap}`,
                `Zone balance ratio   : ${balance}%  (min zone / max zone; 100% = perfectly even)`,
                'Zone breakdown:',
                zoneBreakdown,
                hr
            ].filter(Boolean).join('\n');
        }
        case 4: {
            const routeCount     = result.routes?.length ?? 0;
            const dijkstraCalls  = result.totalDijkstraCalls ?? 'N/A';
            const cacheHits      = result.totalCacheHits ?? 'N/A';
            const cacheRate      = (result.totalDijkstraCalls > 0)
                ? Math.round((result.totalCacheHits / result.totalDijkstraCalls) * 100) + '%'
                : 'N/A';
            const overlapEdges   = result.overlapEdges?.length ?? 0;
            const routeLines     = (result.routes || []).map(r => {
                const dist = r.circuitDistanceM != null ? Math.round(r.circuitDistanceM) + ' m' : 'N/A';
                const seq  = (r.sequence || []).join(' → ');
                return `  Patrol ${r.patrolId}: circuit = ${seq || '(no sequence)'}  total = ${dist}`;
            }).join('\n');
            return [
                hr,
                'STAGE 4  Backtracking TSP + Dijkstra Road Paths',
                hr,
                `Runtime           : ${rt}`,
                `TSP circuits built: ${routeCount}`,
                `Dijkstra calls    : ${dijkstraCalls}`,
                `Cache hits        : ${cacheHits}  (${cacheRate} hit rate)`,
                `Overlapping edges : ${overlapEdges}`,
                'Optimal circuits:',
                routeLines || '  (none)',
                hr
            ].filter(Boolean).join('\n');
        }
        default:
            return '';
    }
}

// ── Trace summary builder ──────────────────────────────────────────────────────
function buildTraceSummary(stage, result, runtimeMs) {
    const rt = runtimeMs != null ? `${Math.round(runtimeMs)}ms` : 'N/A';
    switch (stage) {
        case 1:
            return [
                result.skipped
                    ? 'Hull unchanged (incremental skip).'
                    : `Hull: ${result.hull?.length ?? 0} vertices, area: ${result.hullArea != null ? (result.hullArea / 1e6).toFixed(4) + ' km2' : 'N/A'}`,
                `Outliers detected: ${result.outlierCount ?? 0}`,
                `Valid candidates inside hull: ${result.validCandidateCount ?? 0}`,
                result.linearHandlerTriggered ? 'Linear handler triggered.' : '',
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        case 2:
            return [
                `Best min pairwise distance: ${result.bestMinPairwiseDist?.toFixed(1) ?? 'N/A'}m`,
                `Converged at restart #${result.convergenceRestart ?? 'N/A'} of ${result.restartsCompleted ?? 'N/A'}`,
                `Redundancy: ${result.redundancy?.toFixed(1) ?? 'N/A'}%`,
                `Confidence: ${result.confidence?.toFixed(1) ?? 'N/A'}%`,
                result.cappedFrom != null ? `Patrol count capped: ${result.cappedFrom} to ${result.patrols?.length}` : '',
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        case 3:
            return [
                `Zones: ${result.zones?.length ?? 0} total`,
                `Empty zones: ${result.emptyZones?.length ?? 0}`,
                `Single-node zones: ${result.singleNodeZones?.length ?? 0}`,
                `Avg snapping distance: ${result.avgSnappingDist?.toFixed(1) ?? 'N/A'}m`,
                `Max snapping distance: ${result.maxSnappingDist?.toFixed(1) ?? 'N/A'}m`,
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        case 4:
            return [
                `Routes: ${result.routes?.length ?? 0} patrol circuits`,
                `Dijkstra calls: ${result.totalDijkstraCalls ?? 'N/A'}, cache hits: ${result.totalCacheHits ?? 'N/A'}`,
                `Overlap edges: ${result.overlapEdges?.length ?? 0}`,
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');

        default:
            return `Runtime: ${rt}`;
    }
}

// ── Trace metrics builder ──────────────────────────────────────────────────────
// Returns a structured array of {label, value, warn?, tooltip} for each stage.
// Tooltips show simplified definitions when user hovers the label.
function buildTraceMetrics(stage, result) {
    switch (stage) {
        case 1: {
            const totalIntersections = window._intersectionCount ?? null;
            const inside = result.validCandidateCount ?? 0;
            const coveragePct = totalIntersections > 0 ? Math.round((inside / totalIntersections) * 100) : null;
            return [
                {
                    label:   'Hull vertices',
                    value:   result.hull?.length ?? 0,
                    tooltip: 'Number of corner points that form the convex danger zone boundary.'
                },
                {
                    label:   'Area',
                    value:   result.hullArea != null ? (result.hullArea / 1e6).toFixed(3) + ' km²' : 'N/A',
                    tooltip: 'Total area enclosed by the danger zone polygon, in square kilometers.'
                },
                {
                    label:   'Candidate nodes',
                    value:   coveragePct != null ? `${inside} (${coveragePct}% of all)` : inside,
                    tooltip: 'Road intersection nodes inside the danger zone. The only positions eligible for patrol placement.'
                },
                {
                    label:   'Outliers flagged',
                    value:   result.outlierCount ?? 0,
                    tooltip: 'Incident coordinates much farther from the group centroid than average. Shown with a distinct marker. Adjust sensitivity in Settings.'
                },
                ...(result.linearHandlerTriggered ? [{
                    label:   'Linear handler',
                    value:   'Triggered',
                    warn:    true,
                    tooltip: 'All incident points were collinear (on a straight line), so no 2D polygon could be formed. Patrols were placed along the line instead.'
                }] : []),
            ];
        }
        case 2: {
            const n = result.patrols?.length ?? 0;
            // Spread quality: achieved min pairwise dist vs. theoretical sqrt(A/n) ideal spacing
            const hullArea = window._lastHullArea;
            let spreadQuality = null;
            if (hullArea != null && n > 1 && result.bestMinPairwiseDist != null) {
                const idealSpacing = Math.sqrt(hullArea / n);
                spreadQuality = Math.min(100, Math.round((result.bestMinPairwiseDist / idealSpacing) * 100));
            }
            return [
                {
                    label:   'Patrols placed',
                    value:   n,
                    tooltip: 'Number of patrol units successfully positioned inside the danger zone.'
                },
                {
                    label:   'Min pairwise dist',
                    value:   result.bestMinPairwiseDist != null ? Math.round(result.bestMinPairwiseDist) + ' m' : 'N/A',
                    tooltip: 'Shortest straight-line distance between any two patrols. Hill Climbing maximizes this to spread patrols as far apart as possible.'
                },
                {
                    label:   'Spread quality',
                    value:   spreadQuality != null ? spreadQuality + '%' : 'N/A',
                    tooltip: 'How close the achieved patrol spread is to the theoretical ideal spacing for this zone area and patrol count. 100% = perfect grid-like distribution.'
                },
                {
                    label:   'Confidence',
                    value:   result.confidence != null ? result.confidence.toFixed(1) + '%' : 'N/A',
                    tooltip: 'How reliable this result is: 60% weighted by restart consistency (do all restarts agree?) + 40% by confirmation rate (how many restarts confirmed the best without improving it?).'
                },
                {
                    label:   'Restarts',
                    value:   result.restartsCompleted ?? 'N/A',
                    tooltip: 'Number of independent Hill Climbing runs performed. More restarts reduce the chance of being stuck in a local optimum.'
                },
                {
                    label:   'Best at restart',
                    value:   result.convergenceRestart != null ? '#' + result.convergenceRestart : 'N/A',
                    tooltip: 'The restart number that found the overall best patrol configuration. If this is early (e.g. #2 of 10), later restarts confirmed it.'
                },
                {
                    label:   'Redundancy',
                    value:   result.redundancy != null ? result.redundancy.toFixed(1) + '%' : 'N/A',
                    tooltip: 'Percentage of restarts that confirmed the best result without finding anything better. Higher redundancy means the solution is stable and well-verified.'
                },
                ...(result.cappedFrom != null ? [{
                    label:   'Count capped',
                    value:   `${result.cappedFrom} → ${n}`,
                    warn:    true,
                    tooltip: 'Requested patrol count exceeded the number of eligible positions inside the zone, so it was reduced to the maximum possible.'
                }] : []),
            ];
        }
        case 3: {
            const nonEmptyZones = (result.zones || []).filter(z => z && z.length > 0);
            const zoneSizes     = nonEmptyZones.map(z => z.length);
            const minZone       = zoneSizes.length > 0 ? Math.min(...zoneSizes) : 0;
            const maxZone       = zoneSizes.length > 0 ? Math.max(...zoneSizes) : 0;
            const balance       = maxZone > 0 ? Math.round((minZone / maxZone) * 100) : 100;
            const totalPlotted  = (result.zones || []).reduce((s, z) => s + (z?.length ?? 0), 0) + (result.excludedCount ?? 0);
            const covered       = (result.zones || []).reduce((s, z) => s + (z?.length ?? 0), 0);
            const coverageRate  = totalPlotted > 0 ? Math.round((covered / totalPlotted) * 100) : 100;
            return [
                {
                    label:   'Coverage rate',
                    value:   coverageRate + '%',
                    tooltip: 'Percentage of plotted incidents that were successfully assigned to a patrol zone. Incidents too far from any road intersection are excluded.'
                },
                {
                    label:   'Zone balance',
                    value:   balance + '%',
                    tooltip: 'How evenly incidents are distributed across patrols. 100% = all patrols have the same number of incidents. Low values mean some patrols are overloaded.'
                },
                {
                    label:   'Patrol zones',
                    value:   result.zones?.length ?? 0,
                    tooltip: 'Total number of patrol zones, one per patrol unit.'
                },
                {
                    label:   'Empty zones',
                    value:   result.emptyZones?.length ?? 0,
                    tooltip: 'Patrols with no assigned incidents. These patrols remain stationary at their computed position.'
                },
                {
                    label:   'Single-incident',
                    value:   result.singleNodeZones?.length ?? 0,
                    tooltip: 'Zones with exactly one incident. These patrols make a direct out-and-back visit rather than a full TSP circuit.'
                },
                {
                    label:   'Avg snap dist',
                    value:   result.avgSnappingDist != null ? result.avgSnappingDist.toFixed(1) + ' m' : 'N/A',
                    tooltip: 'Average distance between a plotted incident coordinate and the nearest road intersection it was snapped to. Snapping aligns incidents to the road network.'
                },
                {
                    label:   'Max snap dist',
                    value:   result.maxSnappingDist != null ? result.maxSnappingDist.toFixed(1) + ' m' : 'N/A',
                    warn:    (result.maxSnappingDist ?? 0) > 200,
                    tooltip: 'Largest individual snapping distance. Values above 200m indicate an incident was plotted far from any road. Its assigned road position may not match the original intent.'
                },
            ];
        }
        case 4: {
            const totalCalls = result.totalDijkstraCalls ?? 0;
            const cacheHits  = result.totalCacheHits ?? 0;
            const cacheRate  = totalCalls > 0 ? Math.round((cacheHits / totalCalls) * 100) : null;
            const totalCircuitDist = (result.routes || []).reduce((s, r) => s + (r.circuitDistanceM || 0), 0);
            return [
                {
                    label:   'TSP circuits',
                    value:   result.routes?.length ?? 0,
                    tooltip: 'Number of closed-loop patrol routes generated. Each route visits all assigned incidents and returns to the starting position.'
                },
                {
                    label:   'Total circuit dist',
                    value:   totalCircuitDist > 0 ? (totalCircuitDist / 1000).toFixed(2) + ' km' : 'N/A',
                    tooltip: 'Sum of all patrol circuit lengths following actual road paths. Represents the total distance all patrols would travel on one complete round.'
                },
                {
                    label:   'Dijkstra calls',
                    value:   totalCalls,
                    tooltip: 'Number of shortest-path computations run against the full road network graph.'
                },
                {
                    label:   'Cache hit rate',
                    value:   cacheRate != null ? cacheRate + '%' : 'N/A',
                    tooltip: 'Percentage of required paths found in the Dijkstra result cache rather than recomputed. Higher is better. Shared road segments between patrol zones are reused automatically.'
                },
                {
                    label:   'Overlap edges',
                    value:   result.overlapEdges?.length ?? 0,
                    warn:    (result.overlapEdges?.length ?? 0) > 0,
                    tooltip: 'Road segments used by more than one patrol circuit. Shown as orange (2 patrols) or red (3+) overlays on the map. High overlap may indicate patrol territory consolidation could help.'
                },
            ];
        }
        default:
            return [];
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
        data: { incidents, n, mode, config, barangay, removedNodes: Array.from(window.removedNodes || []) }
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
