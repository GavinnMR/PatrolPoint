/* ============================================================
   PatrolPoint — main.js
   ============================================================ */

// ── CONFIG ────────────────────────────────────────────────────
const CONFIG = {
    hillClimbing: {
        restarts: 10,
        maxIterations: 500,
        radiusMultiplier: 2
    },
    convexHull: {
        areaThresholdDivisor: 100,
        outlierMultiplier: 2.5,
        collinearityEpsilon: 1e-10
    },
    tsp: {
        maxCrimeNodesPerZone: 10
    },
    snapping: {
        boundingBoxEpsilon: 1e-7
    },
    display: {
        showZoneLines: true,
        showRouteArrows: true,
        showOverlapColoring: true
    },
    convexHull_includeOutliers: false
};

const CONFIG_DEFAULTS = JSON.parse(JSON.stringify(CONFIG));

// ── STATE VARIABLES ───────────────────────────────────────────
let P = [];                        // raw incident coordinate objects {lat, lng}
let S_star = [];                   // optimal patrol positions from Hill Climbing
let zones = [];                    // n zone arrays of assigned crime node objects
let currentHull = null;            // ordered array of hull vertex {lat, lng}
let validCandidates = null;        // intersection nodes inside hull
let validCandidatesHullCache = null;
let lastRemovedPoint = null;       // single crime node for undo
let pipelineRunning = false;
let nodeMap = new Map();           // node ID → node object
let adjacencyList = new Map();     // node ID → [{neighborId, weight}]
let dijkstraCache = {};            // cleared each pipeline run
let intersectionNodes = [];        // nodes with degree >= 3
let n_max = 30;                    // soft cap, computed from intersection count
let barangayArea_m2 = 0;           // bounding-box area of road network
let barangayBounds = { minLat: 0, maxLat: 0, minLng: 0, maxLng: 0 };
let deploymentMode = 'stationary'; // 'stationary' | 'roaming'
let pipelineResults = false;       // true if any pipeline results exist on map

// ── MAP LAYER REFERENCES ──────────────────────────────────────
let hullPolygon = null;
let patrolMarkers = [];
let routePolylines = [];
let zoneLines = [];
let overlapLayer = null;
let nearestHighlightMarkers = [];
let crimeMarkers = [];             // parallel array to P

// ── PATROL COLOR PALETTE ──────────────────────────────────────
const PATROL_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4'
];

function patrolColor(i) {
    return PATROL_COLORS[i % PATROL_COLORS.length];
}

// ── CANONICAL HAVERSINE DISTANCE ──────────────────────────────
// Parameters always in order: lat1, lng1, lat2, lng2
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

// ── LEAFLET MAP ───────────────────────────────────────────────
const MAP_CENTER = [14.7028, 121.0944];
const MAP_ZOOM   = 15;

const map = L.map('map', {
    center: MAP_CENTER,
    zoom:   MAP_ZOOM,
    minZoom: 14,
    maxZoom: 19
});

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

window.addEventListener('resize', () => map.invalidateSize());

// Reset View button
const ResetViewControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
        const btn = L.DomUtil.create('button', 'reset-view-btn');
        btn.textContent = 'Reset View';
        L.DomEvent.on(btn, 'click', (e) => {
            L.DomEvent.stopPropagation(e);
            map.setView(MAP_CENTER, MAP_ZOOM);
        });
        return btn;
    }
});
map.addControl(new ResetViewControl());

// ── COMMONWEALTH ADMINISTRATIVE BOUNDARY ──────────────────────
// Approximate boundary polygon of Barangay Commonwealth, Quezon City
const COMMONWEALTH_BOUNDARY = {
    type: 'Feature',
    geometry: {
        type: 'Polygon',
        coordinates: [[
            [121.0830, 14.6940],
            [121.0830, 14.7160],
            [121.1070, 14.7160],
            [121.1070, 14.6940],
            [121.0830, 14.6940]
        ]]
    }
};

L.geoJSON(COMMONWEALTH_BOUNDARY, {
    style: {
        color: '#888888',
        weight: 1.5,
        dashArray: '4 6',
        fill: false,
        opacity: 0.7
    }
}).addTo(map);

// ── MAP LEGEND ────────────────────────────────────────────────
const Legend = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = `
            <h4>Legend</h4>
            <div class="legend-row"><span class="legend-dot crime"></span>Crime incident</div>
            <div class="legend-row"><span class="legend-dot outlier"></span>Potential outlier</div>
            <div class="legend-row"><span class="legend-dot filled"></span>Roaming patrol</div>
            <div class="legend-row"><span class="legend-dot hollow"></span>Stationary patrol</div>
            <div class="legend-row"><span class="legend-line zone"></span>Zone assignment</div>
            <div class="legend-row"><span class="legend-line route"></span>Patrol route</div>
            <div class="legend-row"><span class="legend-line overlap-2"></span>Route overlap ×2</div>
            <div class="legend-row"><span class="legend-line overlap-3"></span>Route overlap ×3+</div>
        `;
        return div;
    }
});
map.addControl(new Legend());

// ── MAP CLICK HANDLER (stub — crime node plotting in Step 2) ──
map.on('click', onMapClick);

function onMapClick(e) {
    if (pipelineRunning) return;
    const { lat, lng } = e.latlng;

    // Duplicate check: within 1e-7 degrees
    const isDuplicate = P.some(p =>
        Math.abs(p.lat - lat) < 1e-7 && Math.abs(p.lng - lng) < 1e-7
    );
    if (isDuplicate) {
        showBanner('warning', 'Incident already plotted at this location.');
        return;
    }

    // Hull membership check — only if hull exists
    if (currentHull && !isPointInHull({ lat, lng }, currentHull)) {
        showBanner('warning', 'Incident plotted outside the current danger zone boundary. Point ignored.');
        return;
    }

    addCrimeNode({ lat, lng });
}

function normalMarkerStyle() {
    return { radius: 7, color: '#c0392b', fillColor: '#e74c3c', fillOpacity: 0.9, weight: 2 };
}

function outlierMarkerStyle() {
    return { radius: 7, color: '#e67e22', fillColor: '#f39c12', fillOpacity: 0.75, weight: 2, dashArray: '4 4' };
}

function addCrimeNode(point, isOutlier = false) {
    P.push(point);
    const marker = L.circleMarker([point.lat, point.lng], isOutlier ? outlierMarkerStyle() : normalMarkerStyle()).addTo(map);
    marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        removeCrimeNodeByMarker(marker);
    });
    crimeMarkers.push(marker);
    updateUndoButton();
}

function removeCrimeNodeByMarker(marker) {
    const idx = crimeMarkers.indexOf(marker);
    if (idx === -1) return;

    lastRemovedPoint = P[idx];

    // Flash marker before removing
    const origColor = marker.options.fillColor;
    marker.setStyle({ fillColor: '#fff', color: '#fff' });
    setTimeout(() => {
        marker.remove();
        P.splice(idx, 1);
        crimeMarkers.splice(idx, 1);
        updateUndoButton();
    }, 300);
}

function updateUndoButton() {
    document.getElementById('undo-btn').style.display = lastRemovedPoint ? 'block' : 'none';
}

// Ray casting — cast ray in +lng direction, count hull edge crossings
function rayCast(point, hull) {
    let crossings = 0;
    const m = hull.length;
    for (let i = 0; i < m; i++) {
        const a = hull[i], b = hull[(i + 1) % m];
        if ((a.lat <= point.lat && b.lat > point.lat) ||
            (b.lat <= point.lat && a.lat > point.lat)) {
            const t = (point.lat - a.lat) / (b.lat - a.lat);
            if (a.lng + t * (b.lng - a.lng) > point.lng) crossings++;
        }
    }
    return crossings % 2 === 1;
}

function isPointInHull(point, hull) {
    if (!hull || hull.length < 3) return false;
    const eps = CONFIG.snapping.boundingBoxEpsilon;
    const lats = hull.map(v => v.lat);
    const lngs = hull.map(v => v.lng);
    if (point.lat < Math.min(...lats) - eps || point.lat > Math.max(...lats) + eps ||
        point.lng < Math.min(...lngs) - eps || point.lng > Math.max(...lngs) + eps) return false;
    return rayCast(point, hull);
}

// Pre-filter all intersection nodes against hull using bounding box + ray casting
function runRayCastPreFilter(hull) {
    const eps = CONFIG.snapping.boundingBoxEpsilon;
    const lats = hull.map(v => v.lat);
    const lngs = hull.map(v => v.lng);
    const minLat = Math.min(...lats) - eps, maxLat = Math.max(...lats) + eps;
    const minLng = Math.min(...lngs) - eps, maxLng = Math.max(...lngs) + eps;

    const candidates = [];
    for (const id of intersectionNodes) {
        const node = nodeMap.get(id);
        if (!node) continue;
        if (node.lat < minLat || node.lat > maxLat || node.lng < minLng || node.lng > maxLng) continue;
        if (rayCast(node, hull)) candidates.push(node);
    }
    return candidates;
}

function hullsEqual(hull1, hull2) {
    if (!hull1 || !hull2 || hull1.length !== hull2.length) return false;
    const eps = CONFIG.convexHull.collinearityEpsilon;
    return hull1.every((v, i) =>
        Math.abs(v.lat - hull2[i].lat) < eps && Math.abs(v.lng - hull2[i].lng) < eps
    );
}

// ── BANNER SYSTEM ─────────────────────────────────────────────
const warningBanner = document.getElementById('warning-banner');

function showBanner(type, messages) {
    warningBanner.className = type;
    if (Array.isArray(messages)) {
        warningBanner.innerHTML = '<ul>' + messages.map(m => `<li>${m}</li>`).join('') + '</ul>';
    } else {
        warningBanner.textContent = messages;
    }
    warningBanner.style.display = 'block';
}

function clearBanner() {
    warningBanner.style.display = 'none';
    warningBanner.textContent = '';
    warningBanner.className = '';
}

// ── CLEAR MAP RESULTS ─────────────────────────────────────────
function clearMapResults({ clearHull = false, clearPatrols = false, clearRoutes = false, clearZoneLines = false, clearNearestHighlights = false } = {}) {
    if (clearHull && hullPolygon) {
        hullPolygon.remove();
        hullPolygon = null;
        currentHull = null;
    }
    if (clearPatrols) {
        patrolMarkers.forEach(m => m.remove());
        patrolMarkers = [];
        S_star = [];
    }
    if (clearRoutes) {
        routePolylines.forEach(p => p.remove());
        routePolylines = [];
        if (overlapLayer) { overlapLayer.remove(); overlapLayer = null; }
    }
    if (clearZoneLines) {
        zoneLines.forEach(l => l.remove());
        zoneLines = [];
    }
    if (clearNearestHighlights) {
        nearestHighlightMarkers.forEach(m => m.remove());
        nearestHighlightMarkers = [];
    }
}

// ── PIPELINE ──────────────────────────────────────────────────

function yieldControl() {
    return new Promise(r => setTimeout(r, 0));
}

function stopPipeline() {
    pipelineRunning = false;
    recalcBtn.disabled = false;
    recalcBtn.textContent = 'Recalculate (Ctrl+Enter)';
    loadingOverlay.style.display = 'none';
    loadingMessage.style.color = '#444';
    map.on('click', onMapClick);
}

function addTraceStage(num, name, status, summaryLines, logLines) {
    const stagesEl = document.getElementById('trace-stages');
    const icon = { success: '✅', warning: '⚠️', error: '❌' }[status] || '❓';
    const logId = `trace-log-s${num}`;

    const div = document.createElement('div');
    div.className = 'trace-stage';

    const header = document.createElement('div');
    header.className = 'trace-stage-header';
    header.innerHTML = `<span>Stage ${num} — ${name}</span><span class="trace-status">${icon}</span>`;

    const summary = document.createElement('div');
    summary.className = 'trace-summary';
    summary.textContent = summaryLines.join('\n');

    const logBtn = document.createElement('button');
    logBtn.className = 'collapsible-toggle';
    logBtn.style.marginTop = '4px';
    logBtn.textContent = 'Full Log ▼';

    const logEl = document.createElement('div');
    logEl.className = 'trace-log';
    logEl.id = logId;
    logEl.textContent = (logLines || []).join('\n');

    logBtn.addEventListener('click', () => logEl.classList.toggle('open'));
    div.append(header, summary, logBtn, logEl);
    stagesEl.appendChild(div);
}

function showNearestIntersectionHighlights(hull) {
    const centroid = {
        lat: hull.reduce((s, v) => s + v.lat, 0) / hull.length,
        lng: hull.reduce((s, v) => s + v.lng, 0) / hull.length
    };

    const outside = [];
    for (const id of intersectionNodes) {
        const node = nodeMap.get(id);
        if (!node || isPointInHull(node, hull)) continue;
        outside.push({ node, dist: haversineDistance(centroid.lat, centroid.lng, node.lat, node.lng) });
    }
    outside.sort((a, b) => a.dist - b.dist);

    outside.slice(0, 5).forEach(({ node }) => {
        const m = L.circleMarker([node.lat, node.lng], {
            radius: 10, color: '#ff9800', fillColor: '#ffb74d', fillOpacity: 0.7, weight: 3
        })
            .bindTooltip('Nearest available road intersection — plot incident coordinates near here.')
            .addTo(map);
        nearestHighlightMarkers.push(m);
    });
}

async function runPipeline() {
    if (pipelineRunning) return;

    // ── Pre-pipeline validation ────────────────────────────────
    clearBanner();

    const rawN = patrolCountInput.value.trim();
    const n = Number(rawN);

    if (rawN === '' || !Number.isFinite(n)) {
        showBanner('error', 'Number of patrols must be a positive whole number.');
        return;
    }
    if (!Number.isInteger(n)) {
        showBanner('error', 'Number of patrols must be a whole number.');
        return;
    }
    if (n <= 0) {
        showBanner('error', 'Number of patrols must be a positive whole number.');
        return;
    }
    if (P.length === 0) {
        showBanner('error', 'No incident coordinates plotted. Please click the map to add incident coordinates.');
        return;
    }
    if (P.length === 1) {
        showBanner('error', 'At least 2 incident coordinates are needed. Please plot more points.');
        return;
    }

    // Collect non-blocking warnings
    const pipelineWarnings = [];
    if (n > n_max) {
        pipelineWarnings.push(`Number of patrols (${n}) exceeds recommended maximum of ${n_max}. Results may be suboptimal.`);
        showBanner('warning', pipelineWarnings);
    }

    // ── Start pipeline ─────────────────────────────────────────
    pipelineRunning = true;
    pipelineResults = false;
    recalcBtn.disabled = true;
    map.off('click', onMapClick);

    clearMapResults({ clearHull: true, clearPatrols: true, clearRoutes: true, clearZoneLines: true, clearNearestHighlights: true });
    document.getElementById('trace-stages').innerHTML = '';
    document.getElementById('pipeline-summary').textContent = '';
    dijkstraCache = {};

    loadingOverlay.style.display = 'flex';
    loadingMessage.style.color = '#444';

    const pipelineStart = performance.now();

    try {
        // ── Stage 1: Convex Hull ───────────────────────────────
        recalcBtn.textContent = 'Running Stage 1 — Convex Hull…';
        loadingMessage.textContent = 'Running Stage 1 — Convex Hull…';
        await yieldControl();

        const t1 = performance.now();
        const r1 = computeConvexHull(P, n, CONFIG);
        const t1ms = Math.round(performance.now() - t1);

        // Re-style crime markers per outlier detection result
        crimeMarkers.forEach(m => m.setStyle(normalMarkerStyle()));
        if (r1.data.outlierIndices && r1.data.outlierIndices.length > 0) {
            r1.data.outlierIndices.forEach(i => {
                if (crimeMarkers[i]) crimeMarkers[i].setStyle(outlierMarkerStyle());
            });
        }

        // Propagate Stage 1 warnings to pipeline banner
        if (r1.warnings.length > 0) {
            r1.warnings.forEach(w => { if (!pipelineWarnings.includes(w)) pipelineWarnings.push(w); });
            showBanner('warning', pipelineWarnings.length === 1 ? pipelineWarnings[0] : pipelineWarnings);
        }

        if (r1.status === 'error') {
            clearMapResults({ clearHull: true, clearPatrols: true, clearRoutes: true, clearZoneLines: true });
            showBanner('error', r1.message);
            addTraceStage(1, 'Brute Force Convex Hull', 'error', [
                `Status: ❌ ${r1.message}`,
                `Runtime: ${t1ms}ms`
            ], r1.data.traceLog);
            stopPipeline();
            return;
        }

        if (r1.data.linearHandler && r1.data.linearHandler.triggered) {
            clearMapResults({ clearHull: true, clearPatrols: true, clearRoutes: true, clearZoneLines: true });

            // Render patrol positions along line
            const positions = r1.data.linearHandler.patrolPositions;
            positions.forEach((pos, i) => {
                const color = patrolColor(i);
                const marker = L.circleMarker([pos.lat, pos.lng], {
                    radius: 9, color, fillColor: color, fillOpacity: 0.85, weight: 2
                }).bindTooltip(`Patrol ${i + 1}`).addTo(map);
                patrolMarkers.push(marker);
            });

            showBanner('warning', r1.message);

            addTraceStage(1, 'Brute Force Convex Hull', 'warning', [
                `Input: ${P.length} incident coordinates`,
                `Outliers flagged: ${(r1.data.outlierIndices || []).length}`,
                `Linear handler: ${r1.data.linearHandler.reason}`,
                `Patrol positions placed: ${positions.length}`,
                `Status: ⚠️ ${r1.message}`,
                `Runtime: ${t1ms}ms`
            ], r1.data.traceLog);

            pipelineResults = true;
            stopPipeline();
            return;
        }

        // Hull computed — render polygon
        currentHull = r1.data.hull;
        if (hullPolygon) {
            hullPolygon.setLatLngs(currentHull.map(v => [v.lat, v.lng]));
        } else {
            hullPolygon = L.polygon(currentHull.map(v => [v.lat, v.lng]), {
                color: '#c0392b',
                fillColor: '#e74c3c',
                fillOpacity: 0.25,
                weight: 2
            }).addTo(map);
        }

        await yieldControl();

        // Ray Casting pre-filter (with cache)
        let usedCache = false;
        if (hullsEqual(currentHull, validCandidatesHullCache)) {
            usedCache = true;
        } else {
            validCandidates = runRayCastPreFilter(currentHull);
            validCandidatesHullCache = currentHull.map(v => ({ lat: v.lat, lng: v.lng }));
        }

        addTraceStage(1, 'Brute Force Convex Hull', r1.status, [
            `Input: ${P.length} incident coordinates`,
            `Outliers flagged: ${(r1.data.outlierIndices || []).length}`,
            `Collinearity check: passed`,
            `Hull vertices: ${r1.data.hull.length}`,
            `Hull area: ${Math.round(r1.data.hullAreaM2)} m²`,
            `Area threshold: ${r1.warnings.some(w => w.includes('clustered')) ? 'warning' : 'passed'}`,
            `Valid candidates: ${validCandidates.length} of ${intersectionNodes.length} intersection nodes`,
            `Ray cast cache: ${usedCache ? 'hit' : 'miss — recomputed'}`,
            `Status: ${r1.status === 'success' ? '✅' : '⚠️'} ${r1.message}`,
            `Runtime: ${t1ms}ms`
        ], r1.data.traceLog);

        if (validCandidates.length === 0) {
            showBanner('error', 'No road intersections found inside the danger zone. Please plot incident coordinates closer to road intersections or expand the incident area.');
            clearMapResults({ clearPatrols: true, clearRoutes: true, clearZoneLines: true });
            showNearestIntersectionHighlights(currentHull);
            stopPipeline();
            return;
        }

        await yieldControl();

        pipelineResults = true;

        // ── Stage 2 placeholder (Build Step 4) ────────────────
        recalcBtn.textContent = 'Running Stage 2 — Hill Climbing…';
        loadingMessage.textContent = 'Running Stage 2 — Hill Climbing…';
        await yieldControl();
        // TODO: implement Hill Climbing in Build Step 4

        stopPipeline();

    } catch (err) {
        showBanner('error', 'An unexpected error occurred. Please check your inputs and try again.');
        console.error('[PatrolPoint] Pipeline error:', err);
        stopPipeline();
    }
}

// ── PATROL COUNT INPUT VALIDATION ────────────────────────────
const patrolCountInput = document.getElementById('patrol-count');
const patrolCountError = document.getElementById('patrol-count-error');

function validatePatrolCount() {
    const raw = patrolCountInput.value.trim();
    const val = Number(raw);
    if (raw === '' || isNaN(val)) {
        setPatrolCountError('Number of patrols is required.');
        return false;
    }
    if (!Number.isInteger(val)) {
        setPatrolCountError('Number of patrols must be a whole number.');
        return false;
    }
    if (val <= 0) {
        setPatrolCountError('Number of patrols must be a positive whole number.');
        return false;
    }
    clearPatrolCountError();
    return true;
}

function setPatrolCountError(msg) {
    patrolCountError.textContent = msg;
    patrolCountError.style.display = 'block';
    patrolCountInput.classList.add('input-error');
}

function clearPatrolCountError() {
    patrolCountError.style.display = 'none';
    patrolCountInput.classList.remove('input-error');
}

patrolCountInput.addEventListener('input', validatePatrolCount);

// ── MODE TOGGLE ───────────────────────────────────────────────
document.querySelectorAll('#mode-toggle input[type=radio]').forEach(radio => {
    radio.addEventListener('change', () => {
        deploymentMode = radio.value;
        document.querySelectorAll('.mode-option').forEach(el => el.classList.remove('mode-active'));
        radio.closest('.mode-option').classList.add('mode-active');
    });
});

// ── RECALCULATE BUTTON ────────────────────────────────────────
const recalcBtn = document.getElementById('recalculate-btn');
recalcBtn.addEventListener('click', () => {
    if (pipelineRunning) return;
    runPipeline();
});

// Ctrl+Enter shortcut
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
        const active = document.activeElement;
        const isTextInput = active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text'));
        if (!isTextInput && !recalcBtn.disabled && !pipelineRunning) {
            runPipeline();
        }
    }
});

// ── RESET BUTTON ──────────────────────────────────────────────
document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm('Reset will clear all incident coordinates and results. Continue?')) return;
    P = [];
    crimeMarkers.forEach(m => m.remove());
    crimeMarkers = [];
    lastRemovedPoint = null;
    pipelineResults = false;
    clearMapResults({ clearHull: true, clearPatrols: true, clearRoutes: true, clearZoneLines: true, clearNearestHighlights: true });
    clearBanner();
    document.getElementById('trace-stages').innerHTML = '';
    document.getElementById('pipeline-summary').textContent = '';
    updateUndoButton();
});

// ── UNDO BUTTON ───────────────────────────────────────────────
document.getElementById('undo-btn').addEventListener('click', () => {
    if (!lastRemovedPoint) return;
    addCrimeNode(lastRemovedPoint);
    lastRemovedPoint = null;
    updateUndoButton();
});

// ── COLLAPSIBLE SECTIONS ──────────────────────────────────────
document.getElementById('import-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    const body = document.getElementById('import-body');
    body.classList.toggle('open');
    e.target.textContent = body.classList.contains('open') ? 'Hide' : 'Import Coordinates';
});

document.getElementById('trace-toggle').addEventListener('click', (e) => {
    e.preventDefault();
    const body = document.getElementById('trace-body');
    body.classList.toggle('open');
    e.target.textContent = body.classList.contains('open') ? 'Hide' : 'Show';
});

// ── IMPORT BUTTON ─────────────────────────────────────────────
document.getElementById('import-btn').addEventListener('click', () => {
    const raw = document.getElementById('coord-input').value.trim();
    if (!raw) return;

    const lines = raw.split('\n');
    const parsed = [];
    let skipped = 0;

    for (const line of lines) {
        const parts = line.split(',').map(s => s.trim());
        if (parts.length < 2) { skipped++; continue; }
        const lat = parseFloat(parts[0]);
        const lng = parseFloat(parts[1]);
        if (isNaN(lat) || isNaN(lng)) { skipped++; continue; }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { skipped++; continue; }
        parsed.push({ lat, lng });
    }

    if (parsed.length === 0) {
        showImportMessage('No valid coordinates found.', 'error');
        return;
    }

    // Commonwealth bounding box check — warn but still import
    // Buffer of 0.005° (~550m) accounts for road network not reaching barangay edges
    const BB_BUFFER = 0.005;
    const outsideCount = parsed.filter(p =>
        p.lat < barangayBounds.minLat - BB_BUFFER || p.lat > barangayBounds.maxLat + BB_BUFFER ||
        p.lng < barangayBounds.minLng - BB_BUFFER || p.lng > barangayBounds.maxLng + BB_BUFFER
    ).length;
    if (outsideCount > 0) {
        showBanner('warning',
            `${outsideCount} coordinate${outsideCount !== 1 ? 's' : ''} fall outside Barangay Commonwealth. ` +
            `These points may produce no valid patrol positions.`
        );
    }

    const existingCount = P.length;
    const confirmMsg = `Importing will replace ${existingCount} existing incident point${existingCount !== 1 ? 's' : ''}. Continue?`;
    if (existingCount > 0 && !confirm(confirmMsg)) return;

    // Clear existing
    P = [];
    crimeMarkers.forEach(m => m.remove());
    crimeMarkers = [];
    lastRemovedPoint = null;
    updateUndoButton();

    // Plot imported points
    parsed.forEach(pt => addCrimeNode(pt));

    // Outlier detection — restyle flagged markers after all are plotted
    const outlierCount = detectAndMarkOutliers(parsed, crimeMarkers);

    document.getElementById('coord-input').value = '';

    let msg = `${parsed.length} point${parsed.length !== 1 ? 's' : ''} imported successfully.`;
    if (skipped > 0) msg += ` ${skipped} line${skipped !== 1 ? 's' : ''} skipped due to invalid format.`;
    if (outlierCount > 0) msg += ` ${outlierCount} flagged as potential outlier${outlierCount !== 1 ? 's' : ''} (orange markers).`;
    showImportMessage(msg, 'success');
    setTimeout(() => { document.getElementById('import-message').style.display = 'none'; }, 3000);
});

function showImportMessage(text, type) {
    const el = document.getElementById('import-message');
    el.textContent = text;
    el.className = type;
    el.style.display = 'block';
}

function detectAndMarkOutliers(points, markers) {
    if (CONFIG.convexHull_includeOutliers || points.length < 3) return 0;
    const centLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const centLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
    const dists = points.map(p => haversineDistance(centLat, centLng, p.lat, p.lng));
    const avg = dists.reduce((s, d) => s + d, 0) / dists.length;
    const threshold = CONFIG.convexHull.outlierMultiplier * avg;
    let count = 0;
    dists.forEach((d, i) => {
        if (d > threshold) { markers[i].setStyle(outlierMarkerStyle()); count++; }
    });
    return count;
}

// ── SETTINGS MODAL ────────────────────────────────────────────
const settingsModal = document.getElementById('settings-modal');

function openSettings() {
    // Populate current CONFIG values
    document.getElementById('cfg-hc-restarts').value   = CONFIG.hillClimbing.restarts;
    document.getElementById('cfg-hc-maxiter').value    = CONFIG.hillClimbing.maxIterations;
    document.getElementById('cfg-hc-radius').value     = CONFIG.hillClimbing.radiusMultiplier;
    document.getElementById('cfg-ch-area').value       = CONFIG.convexHull.areaThresholdDivisor;
    document.getElementById('cfg-ch-outlier').value    = CONFIG.convexHull.outlierMultiplier;
    document.getElementById('cfg-tsp-max').value       = CONFIG.tsp.maxCrimeNodesPerZone;
    document.getElementById('cfg-show-zone-lines').checked = CONFIG.display.showZoneLines;
    document.getElementById('cfg-show-arrows').checked     = CONFIG.display.showRouteArrows;
    document.getElementById('cfg-show-overlap').checked    = CONFIG.display.showOverlapColoring;
    document.getElementById('cfg-include-outliers').checked = CONFIG.convexHull_includeOutliers;
    settingsModal.classList.add('open');
}

function closeSettings() {
    settingsModal.classList.remove('open');
}

document.getElementById('settings-btn').addEventListener('click', openSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);

document.getElementById('settings-apply').addEventListener('click', () => {
    CONFIG.hillClimbing.restarts            = parseInt(document.getElementById('cfg-hc-restarts').value) || CONFIG_DEFAULTS.hillClimbing.restarts;
    CONFIG.hillClimbing.maxIterations       = parseInt(document.getElementById('cfg-hc-maxiter').value)  || CONFIG_DEFAULTS.hillClimbing.maxIterations;
    CONFIG.hillClimbing.radiusMultiplier    = parseFloat(document.getElementById('cfg-hc-radius').value) || CONFIG_DEFAULTS.hillClimbing.radiusMultiplier;
    CONFIG.convexHull.areaThresholdDivisor  = parseInt(document.getElementById('cfg-ch-area').value)     || CONFIG_DEFAULTS.convexHull.areaThresholdDivisor;
    CONFIG.convexHull.outlierMultiplier     = parseFloat(document.getElementById('cfg-ch-outlier').value)|| CONFIG_DEFAULTS.convexHull.outlierMultiplier;
    CONFIG.tsp.maxCrimeNodesPerZone         = parseInt(document.getElementById('cfg-tsp-max').value)     || CONFIG_DEFAULTS.tsp.maxCrimeNodesPerZone;
    CONFIG.display.showZoneLines            = document.getElementById('cfg-show-zone-lines').checked;
    CONFIG.display.showRouteArrows          = document.getElementById('cfg-show-arrows').checked;
    CONFIG.display.showOverlapColoring      = document.getElementById('cfg-show-overlap').checked;
    CONFIG.convexHull_includeOutliers       = document.getElementById('cfg-include-outliers').checked;
    closeSettings();
});

document.getElementById('settings-reset').addEventListener('click', () => {
    Object.assign(CONFIG.hillClimbing, CONFIG_DEFAULTS.hillClimbing);
    Object.assign(CONFIG.convexHull,   CONFIG_DEFAULTS.convexHull);
    Object.assign(CONFIG.tsp,          CONFIG_DEFAULTS.tsp);
    Object.assign(CONFIG.display,      CONFIG_DEFAULTS.display);
    CONFIG.convexHull_includeOutliers = CONFIG_DEFAULTS.convexHull_includeOutliers;
    openSettings(); // repopulate fields with defaults
});

// Close modal on backdrop click
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
});

// ── BROWSER NAVIGATION WARNING ────────────────────────────────
window.addEventListener('beforeunload', (e) => {
    if (P.length > 0 || pipelineResults) {
        e.preventDefault();
        e.returnValue = 'You have unsaved patrol deployment data. Leave anyway?';
    }
});

// ── LOADING STATE ─────────────────────────────────────────────
const loadingOverlay = document.getElementById('loading-overlay');
const loadingMessage = document.getElementById('loading-message');

function showLoadingError(msg) {
    loadingMessage.textContent = msg;
    loadingMessage.style.color = '#dc3545';
}

// ── ROAD NETWORK LOAD AND INITIALIZATION ──────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        let response;
        try {
            response = await fetch('./data/road_network.json');
        } catch (networkErr) {
            showLoadingError('Failed to load road network data. Please check your internet connection.');
            return;
        }

        if (response.status === 404) {
            showLoadingError('Road network data file not found. Please verify road_network.json is in the data folder.');
            return;
        }
        if (!response.ok) {
            showLoadingError(`Failed to load road network data (HTTP ${response.status}).`);
            return;
        }

        let data;
        try {
            data = await response.json();
        } catch (jsonErr) {
            showLoadingError('Road network data file is corrupted. Please regenerate road_network.json.');
            return;
        }

        buildGraph(data);
        computeIntersectionsAndNmax();
        runConnectivityCheck();
        computeBarangayArea();
        finalizeLoad();

    } catch (err) {
        showLoadingError('An unexpected error occurred while loading. Please refresh the page.');
        console.error('[PatrolPoint] Load error:', err);
    }
});

// Single O(V+E) pass: build nodeMap and adjacencyList
function buildGraph(data) {
    const { nodes, edges } = data;

    for (const node of nodes) {
        nodeMap.set(node.id, { id: node.id, lat: node.lat, lng: node.lng });
        adjacencyList.set(node.id, []);
    }

    for (const edge of edges) {
        adjacencyList.get(edge.from).push({ neighborId: edge.to,   weight: edge.weight });
        adjacencyList.get(edge.to).push(  { neighborId: edge.from, weight: edge.weight });
    }

    console.log(`[PatrolPoint] Graph built: ${nodeMap.size} nodes, ${edges.length} edges`);
}

function computeIntersectionsAndNmax() {
    intersectionNodes = [];
    for (const [id, neighbors] of adjacencyList) {
        if (neighbors.length >= 3) intersectionNodes.push(id);
    }
    n_max = Math.floor(Math.sqrt(intersectionNodes.length));
    document.getElementById('patrol-count').placeholder = `Enter number of patrols (max: ${n_max})`;
    console.log(`[PatrolPoint] Intersection nodes: ${intersectionNodes.length}, n_max: ${n_max}`);
}

function runConnectivityCheck() {
    const firstId = nodeMap.keys().next().value;
    const visited = new Set();
    const queue = [firstId];
    visited.add(firstId);

    while (queue.length > 0) {
        const current = queue.shift();
        for (const { neighborId } of adjacencyList.get(current)) {
            if (!visited.has(neighborId)) {
                visited.add(neighborId);
                queue.push(neighborId);
            }
        }
    }

    let removedCount = 0;
    for (const id of nodeMap.keys()) {
        if (!visited.has(id)) {
            nodeMap.delete(id);
            adjacencyList.delete(id);
            removedCount++;
        }
    }

    // Remove edges pointing to deleted nodes
    for (const [id, neighbors] of adjacencyList) {
        const filtered = neighbors.filter(n => nodeMap.has(n.neighborId));
        adjacencyList.set(id, filtered);
    }

    console.log(`[PatrolPoint] Connectivity check: removed ${removedCount} disconnected nodes`);
}

function computeBarangayArea() {
    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (const node of nodeMap.values()) {
        if (node.lat < minLat) minLat = node.lat;
        if (node.lat > maxLat) maxLat = node.lat;
        if (node.lng < minLng) minLng = node.lng;
        if (node.lng > maxLng) maxLng = node.lng;
    }

    const centroidLat = (minLat + maxLat) / 2;
    const lngScale = 111000 * Math.cos(centroidLat * Math.PI / 180);
    barangayArea_m2 = (maxLat - minLat) * 111000 * (maxLng - minLng) * lngScale;
    barangayBounds = { minLat, maxLat, minLng, maxLng };
    console.log(`[PatrolPoint] Barangay bounding area: ${Math.round(barangayArea_m2)} m²`);
}

function finalizeLoad() {
    loadingOverlay.style.display = 'none';
    recalcBtn.disabled = false;
    console.log('[PatrolPoint] Ready.');
}
