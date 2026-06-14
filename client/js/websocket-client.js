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
        // Attach stage subpart breakdowns and supporting chart data
        if (stage === 1) stageUpdate.subparts = buildStage1Subparts(result);
        if (stage === 2) stageUpdate.subparts = buildStage2Subparts(result);
        if (stage === 3) {
            stageUpdate.subparts  = buildStage3Subparts(result);
            stageUpdate.zoneChart = buildZoneChart(result);
        }
        if (stage === 4) {
            stageUpdate.subparts     = buildStage4Subparts(result);
            stageUpdate.circuitChart = buildCircuitChart(result);
        }
        const _narrative = buildNarrative(stage, result);
        if (_narrative) stageUpdate.narrative = _narrative;
        // Attach Stage 2 convergence data for trace panel display
        if (stage === 2) {
            stageUpdate.confidence         = _lastConfidence;             // always include — null if server didn't provide
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

        // Verification report — store on Alpine component for trace panel only
        ui.verificationReport = verificationReport || null;

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
            const areaKm2        = result.hullArea != null ? (result.hullArea / 1e6).toFixed(4) : 'N/A';
            const areaM2         = result.hullArea != null ? Math.round(result.hullArea).toLocaleString() : 'N/A';
            const candidates     = result.validCandidateCount ?? 0;
            const outliers       = result.outlierCount ?? 0;
            return [
                hr,
                'STAGE 1  Brute Force Convex Hull',
                hr,
                `Runtime          : ${rt}`,
                `Outliers flagged : ${outliers} (threshold: ${window.uiApp?.activeConfig?.convexHull?.outlierMultiplier ?? 2.5}x avg distance from centroid)`,
                `Hull vertices    : ${vertexCount}`,
                `Hull area        : ~${areaM2} m²  (~${areaKm2} km²)  [Shoelace approx.]`,
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
            const matrixMs       = result.matrixRuntimeMs != null ? result.matrixRuntimeMs + ' ms' : 'N/A';
            const matrixNodes    = result.matrixCandidateCount ?? '?';
            return [
                hr,
                'STAGE 2  Hill Climbing Patrol Placement',
                hr,
                `Runtime               : ${rt}`,
                `Road dist matrix      : ${matrixNodes} candidate(s) × full graph, built in ${matrixMs}  [pre-Stage 2]`,
                `Patrols requested     : ${n} ${cappedNote}`,
                `Candidate nodes       : ${candidates}`,
                `Restarts completed    : ${totalRestarts}`,
                `Best result at restart: #${restartBest}`,
                `Best min pairwise dist: ${best}`,
                `Redundancy            : ${redundancy}  (% of restarts that confirmed without improving)`,
                `Confidence            : ${confidence}  (50% consistency + 50% confirmation)`,
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
            const overlapEdges    = result.overlapEdges?.length ?? 0;
            const approxCount     = (result.routes || []).filter(r => r.approximate).length;
            const circuitsLabel   = approxCount > 0
                ? `Circuits (${approxCount} approximate - nearest neighbor heuristic):`
                : 'Optimal circuits:';
            const routeLines      = (result.routes || []).map(r => {
                const dist   = r.circuitDistanceM != null ? Math.round(r.circuitDistanceM) + ' m' : 'N/A';
                const approx = r.approximate ? ' [approx]' : '';
                const algo   = r.algorithmUsed ? ` (${r.algorithmUsed})` : '';
                const adj    = r.sequenceAdjustmentsMade > 0 ? `, ${r.sequenceAdjustmentsMade} seq. adj.` : '';
                return `  Patrol ${r.patrolId}${approx}: total = ${dist}${algo}${adj}`;
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
                circuitsLabel,
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
                    : `Hull: ${result.hull?.length ?? 0} vertices, area: ${result.hullArea != null ? '~' + (result.hullArea / 1e6).toFixed(4) + ' km²' : 'N/A'} (approx.)`,
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

        case 4: {
            const approxCount  = (result.routes || []).filter(r => r.approximate).length;
            const bd           = result.algorithmBreakdown || {};
            const algoDetails  = [
                bd.backtracking    > 0 ? `${bd.backtracking} backtracking`     : null,
                bd.nearestNeighbor > 0 ? `${bd.nearestNeighbor} nearest-neighbor` : null,
                bd.k2Shortcut      > 0 ? `${bd.k2Shortcut} k=2 shortcut`      : null,
            ].filter(Boolean).join(', ');
            const adjCount     = result.totalSequenceAdjustments ?? 0;
            return [
                `Routes: ${result.routes?.length ?? 0} patrol circuits` +
                    (approxCount > 0 ? ` (${approxCount} approximate)` : ''),
                algoDetails ? `Algorithm: ${algoDetails}` : null,
                adjCount > 0 ? `Sequence adjustments: ${adjCount}` : null,
                `Dijkstra calls: ${result.totalDijkstraCalls ?? 'N/A'}, cache hits: ${result.totalCacheHits ?? 'N/A'}`,
                `Overlap edges: ${result.overlapEdges?.length ?? 0}`,
                `Runtime: ${rt}`
            ].filter(Boolean).join('\n');
        }

        default:
            return `Runtime: ${rt}`;
    }
}

// ── Stage 1 subpart builder ────────────────────────────────────────────────────
// Returns step-by-step breakdown of what Stage 1 computed and in what order.
// Each subpart: { name, status ('ok'|'warn'|'skip'), detail }
function buildStage1Subparts(result) {
    const subparts = [];

    // Step 0 — Incremental cache check
    if (result.skipped) {
        subparts.push({ name: 'Incremental cache', status: 'skip',
            detail: 'Hull reused from previous run - all new incidents inside previous danger zone' });
        return subparts;
    }
    subparts.push({ name: 'Incremental cache', status: 'ok',
        detail: 'No reusable hull - full computation required' });

    // Step 1 — Outlier detection
    const outliers  = result.outlierCount ?? 0;
    const remaining = result.filteredCount ?? 0;
    const total     = remaining + outliers;
    if (outliers > 0) {
        subparts.push({ name: 'Outlier detection', status: 'warn',
            detail: `${outliers} of ${total} incident${total !== 1 ? 's' : ''} flagged - ${remaining} remaining` });
    } else {
        subparts.push({ name: 'Outlier detection', status: 'ok',
            detail: `No outliers - all ${remaining} incident${remaining !== 1 ? 's' : ''} retained` });
    }

    // Step 2 — Minimum points check
    const reason = result.linearHandlerReason;
    if (reason === 'two_points') {
        subparts.push({ name: 'Minimum points', status: 'warn',
            detail: `Only ${remaining} incident${remaining !== 1 ? 's' : ''} after outlier removal - need 3+ for a polygon, linear handler triggered` });
        return subparts;
    }
    subparts.push({ name: 'Minimum points', status: 'ok',
        detail: `${remaining} incident${remaining !== 1 ? 's' : ''} - hull computable` });

    // Step 3 — Collinearity check
    if (reason === 'collinear') {
        subparts.push({ name: 'Collinearity check', status: 'warn',
            detail: 'All incidents lie on one line - no 2D polygon possible, linear handler triggered' });
        return subparts;
    }
    subparts.push({ name: 'Collinearity check', status: 'ok',
        detail: 'Non-collinear - 2D convex hull computable' });

    // Step 4 — Brute force O(n³)
    const edges = result.validEdgesCount;
    if (edges != null) {
        subparts.push({ name: 'Brute force O(n³)', status: 'ok',
            detail: `${edges} valid directed edge${edges !== 1 ? 's' : ''} identified` });
    }

    // Step 5 — Edge count validation
    if (reason === 'few_edges') {
        subparts.push({ name: 'Edge count check', status: 'warn',
            detail: `${edges ?? 0} valid edge${(edges ?? 0) !== 1 ? 's' : ''} - fewer than 3 required for polygon, linear handler triggered` });
        return subparts;
    }
    if (edges != null) {
        subparts.push({ name: 'Edge count check', status: 'ok',
            detail: `${edges} edge${edges !== 1 ? 's' : ''} - sufficient for a polygon` });
    }

    // Step 6 — Edge ordering
    const vertices = result.hull?.length;
    if (vertices != null) {
        subparts.push({ name: 'Edge ordering', status: 'ok',
            detail: `${vertices} hull ${vertices === 1 ? 'vertex' : 'vertices'} chained into closed polygon` });
    }

    // Steps 7+8 — Shoelace area and winding normalization (shown together)
    if (result.hullArea != null) {
        const areaM2  = Math.round(result.hullArea).toLocaleString();
        const areaKm2 = (result.hullArea / 1e6).toFixed(4);
        let windingNote = '';
        if      (result.windingReversed === true)  windingNote = ' - winding reversed to CCW';
        else if (result.windingReversed === false)  windingNote = ' - winding already CCW';
        subparts.push({ name: 'Shoelace + winding', status: 'ok',
            detail: `~${areaM2} m² (~${areaKm2} km²)${windingNote}` });
    }

    // Step 9 — Area validation (only show if hull was valid)
    if (result.hull && result.hull.length > 0) {
        subparts.push({ name: 'Area validation', status: 'ok', detail: 'Hull area > 0' });
    }

    // Step 10 — Ray cast pre-filter (only show if hull was valid)
    if (result.hull && result.hull.length > 0) {
        const rc = result.rayCastStats;
        if (rc) {
            subparts.push({ name: 'Ray cast filter', status: rc.passed === 0 ? 'warn' : 'ok',
                detail: `${rc.passed.toLocaleString()} of ${rc.totalNodes.toLocaleString()} road nodes inside hull ` +
                        `(${rc.bboxRejected.toLocaleString()} bbox-rejected, ${rc.rayCastRejected.toLocaleString()} ray-cast-rejected)` });
        } else {
            subparts.push({ name: 'Ray cast filter', status: 'skip',
                detail: `Hull-candidate cache reused - ${(result.validCandidateCount ?? 0).toLocaleString()} candidates` });
        }
    }

    return subparts;
}

// ── Stage 3 subpart builder ────────────────────────────────────────────────────
function buildStage3Subparts(result) {
    const subparts = [];

    // Step 1 — Crime node snapping
    const snapped  = result.snappedCount ?? 0;
    const excluded = (result.excludedCrimeNodes || []).filter(e => e.reason === 'no_reachable_intersection').length;
    const total    = snapped + excluded;
    subparts.push({
        name:   'Crime node snapping',
        status: excluded > 0 ? 'warn' : 'ok',
        detail: excluded > 0
            ? `${snapped} of ${total} snapped to road nodes - ${excluded} excluded (no reachable intersection)`
            : `All ${snapped} crime node${snapped !== 1 ? 's' : ''} snapped to nearest road node`
    });

    // Step 2 — Deduplication
    const merged   = result.mergedCount ?? 0;
    const unique   = snapped - merged;
    subparts.push({
        name:   'Deduplication',
        status: merged > 0 ? 'warn' : 'ok',
        detail: merged > 0
            ? `${merged} duplicate${merged !== 1 ? 's' : ''} merged - ${unique} unique position${unique !== 1 ? 's' : ''} remaining`
            : 'No duplicate snapping positions'
    });

    // Step 3 — Road distance pre-computation (Dijkstra)
    const calls  = result.dijkstraCalls    ?? 0;
    const hits   = result.dijkstraCacheHits ?? 0;
    const total3 = calls + hits;
    subparts.push({
        name:   'Road distance (Dijkstra)',
        status: 'ok',
        detail: total3 > 0
            ? `${total3} source${total3 !== 1 ? 's' : ''} - ${calls} computed, ${hits} cache hit${hits !== 1 ? 's' : ''}`
            : 'No Dijkstra runs needed'
    });

    // Step 4 — Zone assignment
    const fallbacks = result.euclideanFallbacks ?? 0;
    const byRoad    = unique - fallbacks;
    subparts.push({
        name:   'Zone assignment',
        status: fallbacks > 0 ? 'warn' : 'ok',
        detail: fallbacks > 0
            ? `${byRoad} by road distance, ${fallbacks} by straight-line fallback (road graph disconnected)`
            : `${unique} node${unique !== 1 ? 's' : ''} assigned by road distance`
    });

    // Step 5 — Zone rebalancing
    const iters = result.rebalanceIterations ?? 0;
    const mode  = result.rebalanceMode ?? 'light';
    subparts.push({
        name:   'Zone rebalancing',
        status: 'ok',
        detail: iters > 0
            ? `${iters} iteration${iters !== 1 ? 's' : ''} (${mode} mode)`
            : `Balanced - no rebalancing needed (${mode} mode)`
    });

    // Step 6 — Zone cap
    const capped = result.cappedZonesCount ?? 0;
    const maxN   = window.uiApp?.activeConfig?.tsp?.maxCrimeNodesPerZone ?? 12;
    subparts.push({
        name:   'Zone cap',
        status: capped > 0 ? 'warn' : 'ok',
        detail: capped > 0
            ? `${capped} zone${capped !== 1 ? 's' : ''} capped at ${maxN} nodes - excess excluded`
            : `No zones exceeded the ${maxN}-node cap`
    });

    // Step 7 — Zone classification
    const empty  = result.emptyZones?.length      ?? 0;
    const single = result.singleNodeZones?.length  ?? 0;
    const multi  = result.multiNodeZones?.length   ?? 0;
    subparts.push({
        name:   'Zone classification',
        status: empty > 0 ? 'warn' : 'ok',
        detail: [
            empty  > 0 ? `${empty} empty (stationary)`    : null,
            single > 0 ? `${single} single-node (direct)` : null,
            multi  > 0 ? `${multi} multi-node (→ TSP)`    : null
        ].filter(Boolean).join(', ') || 'No zones classified'
    });

    return subparts;
}

// ── Patrol color palette (client-side mirror of server hillClimbing.js) ───────
const PATROL_COLORS_CLIENT = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4'
];

// ── Stage 2 subparts builder ───────────────────────────────────────────────────
// Shows algorithm steps: radius computation, restart budget, convergence, best result.
function buildStage2Subparts(result) {
    const subparts = [];
    const n          = result.patrols?.length ?? 0;
    const config     = window.uiApp?.activeConfig?.hillClimbing ?? {};
    const hullArea   = window._lastHullArea;
    // Stage 2 result sends matrixCandidateCount (= validCandidates.length passed by pipeline)
    const candidates = result.matrixCandidateCount ?? result.validCandidateCount ?? null;

    if (n === 1) {
        subparts.push({ name: 'Single patrol mode', status: 'ok',
            detail: 'Placed at the most central intersection node - minimises average road distance to all other candidates' });
        return subparts;
    }

    // Step 1: Radius R
    if (hullArea != null && candidates != null && candidates > 0) {
        const baseR = Math.round(Math.sqrt(hullArea / candidates) * (config.radiusMultiplier ?? 2));
        subparts.push({ name: 'Search radius R', status: 'ok',
            detail: `sqrt(${Math.round(hullArea)}m² ÷ ${candidates}) × ${config.radiusMultiplier ?? 2} ≈ ${baseR}m - each patrol only considers unoccupied neighbors within this radius per iteration` });
    } else {
        subparts.push({ name: 'Search radius R', status: 'ok',
            detail: `Computed as sqrt(hull area / candidates) × ${config.radiusMultiplier ?? 2}` });
    }

    // Step 2: Restart budget
    const completed = result.restartsCompleted ?? null;
    const maxR      = (config.restarts ?? 100) * n;
    const minR      = Math.max(5, n);
    subparts.push({ name: 'Restart budget', status: 'ok',
        detail: completed != null
            ? `${completed} of max ${maxR} restarts (min ${minR}) - each begins from a new random patrol configuration`
            : `Min ${minR} restarts, max ${maxR} (${config.restarts ?? 100} × n)` });

    // Step 3: Convergence / early stopping
    const convRestart = result.convergenceRestart ?? null;
    if (convRestart != null && completed != null) {
        const confirmed = completed - convRestart;
        if (confirmed > 0) {
            subparts.push({ name: 'Early convergence', status: 'ok',
                detail: `Best found at restart #${convRestart} - confirmed ${confirmed}x more without improvement, adaptive stop triggered` });
        } else {
            subparts.push({ name: 'No early stop', status: 'warn',
                detail: `Still improving at restart #${completed} - increase the restart budget in Settings for higher confidence` });
        }
    }

    // Step 4: Best result selected
    const bestDist = result.bestMinPairwiseDist != null ? Math.round(result.bestMinPairwiseDist) : null;
    subparts.push({ name: 'Best result (S★)', status: 'ok',
        detail: `Min pairwise distance: ${bestDist != null ? bestDist + 'm' : 'N/A'} - the shortest gap between any two patrols, maximized across all restarts` });

    return subparts;
}

// ── Stage 4 subparts builder ───────────────────────────────────────────────────
// One subpart per patrol: shows zone size, algorithm chosen, and circuit distance.
function buildStage4Subparts(result) {
    const subparts = [];
    const routes    = result.routes || [];
    const threshold = window.uiApp?.activeConfig?.tsp?.nearestNeighborFallbackThreshold ?? 12;

    for (const r of routes) {
        if (r.isEmpty) {
            subparts.push({ name: `Patrol ${r.patrolId}: empty zone`, status: 'skip',
                detail: 'No incidents assigned - patrol remains stationary at deployment position' });
            continue;
        }
        if (r.isSingleNode) {
            subparts.push({ name: `Patrol ${r.patrolId}: 1 incident`, status: 'ok',
                detail: `Direct out-and-back visit (${r.patrolId} -> crime node -> ${r.patrolId}): ${Math.round(r.circuitDistanceM)}m circuit` });
            continue;
        }
        // Multi-node: k = sequence length - 2 (sequence includes patrol start and end)
        const k   = r.sequence ? Math.max(r.sequence.length - 2, 0) : '?';
        let detail = '';
        if (r.algorithmUsed === 'backtracking') {
            const fact = typeof k === 'number' ? _factorial(k) : null;
            detail = fact != null
                ? `backtracking (exact): evaluated all ${fact.toLocaleString()} orderings (${k}!) → optimal ${Math.round(r.circuitDistanceM)}m circuit`
                : `backtracking (exact) - ${k} waypoints -> ${Math.round(r.circuitDistanceM)}m circuit`;
        } else if (r.algorithmUsed === 'nearest-neighbor') {
            detail = `nearest-neighbor heuristic (k=${k} > threshold ${threshold}) - approximate, not guaranteed optimal -> ~${Math.round(r.circuitDistanceM)}m circuit`;
        } else if (r.algorithmUsed === 'k2-shortcut') {
            detail = `k=2 shortcut: both orderings produce identical distance on undirected graph → ${Math.round(r.circuitDistanceM)}m circuit`;
        } else {
            detail = `${r.algorithmUsed ?? 'unknown'} → ${Math.round(r.circuitDistanceM)}m circuit`;
        }
        if (r.sequenceAdjustmentsMade > 0) {
            detail += `, ${r.sequenceAdjustmentsMade} in-path sequence adjustment${r.sequenceAdjustmentsMade !== 1 ? 's' : ''}`;
        }
        subparts.push({
            name:   `Patrol ${r.patrolId}: ${k} incident${k !== 1 ? 's' : ''}`,
            status: r.approximate ? 'warn' : 'ok',
            detail
        });
    }

    return subparts;
}

function _factorial(n) {
    if (typeof n !== 'number' || n < 0 || n > 12) return null;
    let f = 1;
    for (let i = 2; i <= n; i++) f *= i;
    return f;
}

// ── Zone distribution chart builder ───────────────────────────────────────────
// Returns { patrolId, size, pct, color } per patrol zone for Stage 3 bar chart.
function buildZoneChart(result) {
    const zones   = result.zones || [];
    const sizes   = zones.map(z => z?.length ?? 0);
    const maxSize = Math.max(...sizes, 1);
    return zones.map((z, i) => ({
        patrolId: `s${i + 1}`,
        size:     z?.length ?? 0,
        pct:      Math.round(((z?.length ?? 0) / maxSize) * 100),
        color:    PATROL_COLORS_CLIENT[i % PATROL_COLORS_CLIENT.length]
    }));
}

// ── Circuit distance chart builder ────────────────────────────────────────────
// Returns { patrolId, distM, pct, approximate, isEmpty, color } per patrol for Stage 4 bar chart.
function buildCircuitChart(result) {
    const routes  = result.routes || [];
    const maxDist = Math.max(...routes.map(r => r.circuitDistanceM ?? 0), 1);
    return routes.map(r => ({
        patrolId:    r.patrolId,
        distM:       r.circuitDistanceM ?? 0,
        pct:         Math.round(((r.circuitDistanceM ?? 0) / maxDist) * 100),
        approximate: r.approximate,
        isEmpty:     r.isEmpty,
        color:       PATROL_COLORS_CLIENT[(r.patrolIndex ?? 0) % PATROL_COLORS_CLIENT.length]
    }));
}

// ── Run-specific narrative builder ────────────────────────────────────────────
// One concise sentence per stage describing what THIS run did — complements the
// static algorithm notes with data-driven context for demos and discussion.
function buildNarrative(stage, result) {
    switch (stage) {
        case 1: {
            if (result.skipped) return 'Hull unchanged from previous run - all new incidents fall within the existing danger zone.';
            const n          = result.filteredCount ?? 0;
            const pairs      = n > 1 ? (n * (n - 1)).toLocaleString() : '0';
            const vertices   = result.hull?.length ?? 0;
            const candidates = result.validCandidateCount ?? 0;
            if (result.linearHandlerTriggered) {
                return `All ${n} incident${n !== 1 ? 's' : ''} are collinear - no 2D polygon possible. Patrols placed along the incident line instead.`;
            }
            return `With ${n} incident${n !== 1 ? 's' : ''}, the algorithm tested ${pairs} directed edge pairs (${n}×${n > 0 ? n - 1 : 0}) and produced a ${vertices}-vertex danger zone containing ${candidates} road intersections eligible for patrol placement.`;
        }
        case 2: {
            const n           = result.patrols?.length ?? 0;
            const best        = result.bestMinPairwiseDist != null ? Math.round(result.bestMinPairwiseDist) : null;
            const convRestart = result.convergenceRestart ?? null;
            const completed   = result.restartsCompleted  ?? null;
            const confidence  = result.confidence != null ? Math.round(result.confidence) : null;
            if (n === 1) return 'Single patrol placed at the most central road intersection - minimises average distance to all candidates.';
            let s = `${n} patrol${n !== 1 ? 's' : ''} placed with ${best != null ? best + 'm' : 'N/A'} minimum separation`;
            if (convRestart != null && completed != null) {
                const confirmed = completed - convRestart;
                s += `; best found at restart #${convRestart}${confirmed > 0 ? `, confirmed ${confirmed}× more` : ''}`;
            }
            if (confidence != null) s += `. Confidence: ${confidence}%.`;
            return s;
        }
        case 3: {
            const n       = result.zones?.length  ?? 0;
            const covered = (result.zones || []).reduce((s, z) => s + (z?.length ?? 0), 0);
            const calls   = result.dijkstraCalls     ?? 0;
            const hits    = result.dijkstraCacheHits ?? 0;
            const empty   = result.emptyZones?.length ?? 0;
            let s = `${covered} incident${covered !== 1 ? 's' : ''} assigned across ${n} zone${n !== 1 ? 's' : ''} using road-network Dijkstra (${calls} run${calls !== 1 ? 's' : ''}, ${hits} cache hit${hits !== 1 ? 's' : ''})`;
            if (empty > 0) s += `; ${empty} patrol${empty !== 1 ? 's' : ''} have empty zones and remain stationary`;
            return s + '.';
        }
        case 4: {
            const routes      = result.routes || [];
            const active      = routes.filter(r => !r.isEmpty);
            const totalDist   = active.reduce((s, r) => s + (r.circuitDistanceM ?? 0), 0);
            const approx      = routes.filter(r => r.approximate).length;
            const hits        = result.totalCacheHits     ?? 0;
            const calls       = result.totalDijkstraCalls ?? 0;
            const totalLookups = hits + calls;
            const hitRate     = totalLookups > 0 ? Math.round((hits / totalLookups) * 100) : 0;
            let s = `${active.length} active circuit${active.length !== 1 ? 's' : ''} totalling ${Math.round(totalDist)}m`;
            if (approx > 0) s += ` (${approx} approximate via nearest-neighbor)`;
            if (totalLookups > 0) s += `; Dijkstra cache: ${hitRate}% hit rate (${hits} of ${totalLookups} lookups)`;
            return s + '.';
        }
        default:
            return '';
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
                    label:   'Area (approx.)',
                    value:   result.hullArea != null ? '~' + (result.hullArea / 1e6).toFixed(3) + ' km²' : 'N/A',
                    tooltip: 'Approximate area enclosed by the danger zone polygon. Computed using the Shoelace formula with a flat-plane projection - accurate to under 1% at barangay scale, not a geodetic measurement.'
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
                    label:   'Matrix build',
                    value:   result.matrixRuntimeMs != null ? result.matrixRuntimeMs + ' ms' : 'N/A',
                    tooltip: 'Time to precompute road distances between all valid candidate nodes before Hill Climbing starts. Shared by Stage 2 (neighbor evaluation) and Stage 3 (zone assignment).'
                },
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
                    tooltip: 'How reliable this result is: 50% restart consistency (do all restarts agree on the same answer?) + 50% confirmation rate (how many restarts confirmed the best without improving it?).'
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
            const totalPlotted  = (result.zones || []).reduce((s, z) => s + (z?.length ?? 0), 0) + (result.excludedCount ?? 0);
            const covered       = (result.zones || []).reduce((s, z) => s + (z?.length ?? 0), 0);
            const coverageRate  = totalPlotted > 0 ? Math.round((covered / totalPlotted) * 100) : 100;

            // Zone balance — MAD-based score
            // First check if distribution is already optimal (all zones within [floor, ceil] of target).
            // If optimal, show "Optimal" regardless of the raw ratio.
            // Otherwise use mean absolute deviation from target, normalised to 0–100%.
            let balanceValue   = 'N/A';
            let balanceWarn    = false;
            if (zoneSizes.length > 0) {
                const target      = covered / nonEmptyZones.length;
                const floorTarget = Math.floor(target);
                const ceilTarget  = Math.ceil(target);
                const isOptimal   = zoneSizes.every(s => s >= floorTarget && s <= ceilTarget);
                if (isOptimal) {
                    balanceValue = 'Optimal';
                } else {
                    const mad    = zoneSizes.reduce((s, sz) => s + Math.abs(sz - target), 0) / zoneSizes.length;
                    const score  = target > 0 ? Math.max(0, Math.round((1 - mad / target) * 100)) : 100;
                    balanceValue = score + '%';
                    balanceWarn  = score < 70;
                }
            }

            return [
                {
                    label:   'Coverage rate',
                    value:   coverageRate + '%',
                    tooltip: 'Percentage of plotted incidents that were successfully assigned to a patrol zone. Incidents too far from any road intersection are excluded.'
                },
                {
                    label:   'Zone balance',
                    value:   balanceValue,
                    warn:    balanceWarn,
                    tooltip: 'How evenly incidents are spread across patrols. "Optimal" means every patrol is within one incident of the ideal equal split - the best mathematically possible. A percentage shows how far the distribution is from equal, using average deviation across all patrols (not just the best and worst).'
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
                {
                    label:   'Seq. adjustments',
                    value:   result.totalSequenceAdjustments ?? 0,
                    tooltip: 'Number of times a crime node was moved earlier in the visit sequence because it was a natural intermediate stop on the road path to the next waypoint. Eliminates redundant backtracking.'
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
