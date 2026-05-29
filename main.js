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
let traceStageOpenState = {};      // expand/collapse state per stage, keyed by stage num (1–4)

// ── MAP LAYER REFERENCES ──────────────────────────────────────
let hullPolygon = null;
let patrolMarkers = [];
let routePolylines = [];
let zoneLines = [];
let overlapLayer = null;
let nearestHighlightMarkers = [];
let crimeMarkers = [];             // parallel array to P

// ── PATROL COLOR PALETTE ──────────────────────────────────────
// Okabe-Ito colorblind-safe palette — validated for deuteranopia, protanopia, tritanopia
const PATROL_COLORS = [
    '#0072B2',  // Deep blue
    '#D55E00',  // Vermillion
    '#009E73',  // Teal
    '#CC79A7',  // Mauve
    '#E69F00',  // Amber
    '#56B4E9',  // Sky blue
    '#332288',  // Indigo
    '#44AA99',  // Cyan-teal
    '#882255',  // Wine
    '#DDCC77',  // Sand gold
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

function normalNodeIcon() {
    return L.divIcon({
        className: 'crime-node-icon',
        html: '<span style="color:#dc2626;text-shadow:-1px -1px 0 #7f1d1d,1px -1px 0 #7f1d1d,-1px 1px 0 #7f1d1d,1px 1px 0 #7f1d1d;">✕</span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
    });
}

function outlierNodeIcon() {
    return L.divIcon({
        className: 'crime-node-icon',
        html: '<span style="color:#E69F00;text-shadow:-1px -1px 0 #78350f,1px -1px 0 #78350f,-1px 1px 0 #78350f,1px 1px 0 #78350f;">✕</span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
    });
}

function flashNodeIcon() {
    return L.divIcon({
        className: 'crime-node-icon',
        html: '<span style="color:#fff;text-shadow:-1px -1px 0 #dc2626,1px -1px 0 #dc2626,-1px 1px 0 #dc2626,1px 1px 0 #dc2626;">✕</span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
    });
}

function excludedNodeIcon() {
    return L.divIcon({
        className: 'crime-node-icon',
        html: '<span style="color:#9ca3af;text-shadow:-1px -1px 0 #6b7280,1px -1px 0 #6b7280,-1px 1px 0 #6b7280,1px 1px 0 #6b7280;">✕</span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
    });
}

function makePatrolIcon(color, num, isStationary) {
    const label = isStationary ? 'S' : String(num);
    const bg    = isStationary ? 'transparent' : color;
    const border = isStationary ? `2px dashed ${color}` : `2px solid ${color}`;
    const textColor = isStationary ? color : '#fff';
    return L.divIcon({
        className: '',
        html: `<div style="width:26px;height:26px;border-radius:50%;background:${bg};border:${border};display:flex;align-items:center;justify-content:center;color:${textColor};font-weight:700;font-size:11px;box-shadow:0 1px 4px rgba(0,0,0,0.3);">${label}</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13]
    });
}

function addCrimeNode(point, isOutlier = false) {
    P.push(point);
    const marker = L.marker([point.lat, point.lng], {
        icon: isOutlier ? outlierNodeIcon() : normalNodeIcon(),
        zIndexOffset: 1000
    }).addTo(map);
    marker.on('click', (e) => {
        if (pipelineRunning) return;
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

    marker.setIcon(flashNodeIcon());
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

    if (traceStageOpenState[num]) logEl.classList.add('open');
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
    let n = Number(rawN);

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
    if (deploymentMode === 'roaming' && P.length === 0) {
        showBanner('error', 'Roaming mode requires at least one incident coordinate. Plot incidents or switch to Stationary mode.');
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
    zones = [];
    // Save expand/collapse state before wiping trace panel
    traceStageOpenState = {};
    document.querySelectorAll('#trace-stages .trace-stage').forEach((div, idx) => {
        const logEl = div.querySelector('.trace-log');
        if (logEl) traceStageOpenState[idx + 1] = logEl.classList.contains('open');
    });
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

        // Re-icon crime markers per outlier detection result
        crimeMarkers.forEach(m => m.setIcon(normalNodeIcon()));
        if (r1.data.outlierIndices && r1.data.outlierIndices.length > 0) {
            r1.data.outlierIndices.forEach(i => {
                if (crimeMarkers[i]) crimeMarkers[i].setIcon(outlierNodeIcon());
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

        // "Outlier removal reduced below minimum" — warning with no hull
        if (!r1.data.hull) {
            addTraceStage(1, 'Brute Force Convex Hull', 'warning', [
                `Input: ${P.length} incident coordinates`,
                `Outliers flagged: ${(r1.data.outlierIndices || []).length}`,
                `Status: ⚠️ ${r1.message}`,
                `Runtime: ${t1ms}ms`
            ], r1.data.traceLog);
            showBanner('warning', r1.message);
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

        // ── Stage 2: Hill Climbing ─────────────────────────────
        recalcBtn.textContent = 'Running Stage 2 — Hill Climbing…';
        loadingMessage.textContent = 'Running Stage 2 — Hill Climbing…';
        await yieldControl();

        const t2 = performance.now();
        const r2 = computeHillClimbing(validCandidates, r1.data.hullAreaM2, n, CONFIG);
        const t2ms = Math.round(performance.now() - t2);

        // Cap n if Stage 2 reduced it
        if (r2.data.cappedN) {
            n = r2.data.actualN;
            patrolCountInput.value = n;
        }

        // Propagate Stage 2 warnings
        if (r2.warnings.length > 0) {
            r2.warnings.forEach(w => { if (!pipelineWarnings.includes(w)) pipelineWarnings.push(w); });
            showBanner('warning', pipelineWarnings.length === 1 ? pipelineWarnings[0] : pipelineWarnings);
        }

        if (r2.status === 'error') {
            clearMapResults({ clearPatrols: true, clearRoutes: true, clearZoneLines: true });
            showBanner('error', r2.message);
            addTraceStage(2, 'Hill Climbing', 'error', [
                `Status: ❌ ${r2.message}`,
                `Runtime: ${t2ms}ms`
            ], r2.data.traceLog);
            stopPipeline();
            return;
        }

        // Apply patrol colors and store S_star
        S_star = r2.data.positions.map((p, i) => ({ ...p, color: patrolColor(i) }));

        // Render patrol markers — update in place if count matches, else rebuild
        const isStationary = deploymentMode === 'stationary';
        if (patrolMarkers.length === S_star.length) {
            S_star.forEach((pos, i) => {
                patrolMarkers[i].setLatLng([pos.lat, pos.lng]);
                patrolMarkers[i].setIcon(makePatrolIcon(pos.color, i + 1, isStationary));
            });
        } else {
            patrolMarkers.forEach(m => m.remove());
            patrolMarkers = [];
            S_star.forEach((pos, i) => {
                const marker = L.marker([pos.lat, pos.lng], {
                    icon: makePatrolIcon(pos.color, i + 1, isStationary),
                    zIndexOffset: 500
                }).addTo(map);
                patrolMarkers.push(marker);
            });
        }

        await yieldControl();

        const isN1 = r2.data.bestRestartIdx === null;
        addTraceStage(2, 'Hill Climbing', r2.status, [
            `Valid candidates: ${validCandidates.length} nodes`,
            `Patrols: ${r2.data.actualN}${r2.data.cappedN ? ` (capped from ${r2.data.cappedN})` : ''}`,
            `Radius R: ${r2.data.R > 0 ? Math.round(r2.data.R) + 'm' : 'N/A (single patrol)'}`,
            `Restarts: ${isN1 ? 'N/A (single patrol)' : `${r2.data.restartsCompleted}`}`,
            `Best restart: ${isN1 ? 'N/A' : r2.data.bestRestartIdx}`,
            `Best min pairwise dist: ${r2.data.R > 0 ? Math.round(r2.data.bestMinPairwiseDist) + 'm' : 'N/A'}`,
            `Radius expansions: ${r2.data.radiusExpansions}`,
            `Max iter warnings: ${r2.data.maxIterWarnings}`,
            `Duplicate config warnings: ${r2.data.duplicateConfigWarnings}`,
            `Status: ${r2.status === 'success' ? '✅' : '⚠️'} ${r2.message}`,
            `Runtime: ${t2ms}ms`
        ], r2.data.traceLog);

        // ── Stage 3: Zone Assignment ───────────────────────────
        recalcBtn.textContent = 'Running Stage 3 — Zone Assignment…';
        loadingMessage.textContent = 'Running Stage 3 — Zone Assignment…';
        await yieldControl();

        const t3 = performance.now();
        const r3 = computeZoneAssignment(P, S_star, validCandidates, currentHull, CONFIG);
        const t3ms = Math.round(performance.now() - t3);

        if (r3.warnings.length > 0) {
            r3.warnings.forEach(w => { if (!pipelineWarnings.includes(w)) pipelineWarnings.push(w); });
            showBanner('warning', pipelineWarnings.length === 1 ? pipelineWarnings[0] : pipelineWarnings);
        }

        if (r3.status === 'error') {
            showBanner('error', r3.message);
            addTraceStage(3, 'Zone Assignment', 'error', [
                `Status: ❌ ${r3.message}`,
                `Runtime: ${t3ms}ms`
            ], r3.data.traceLog);
            stopPipeline();
            return;
        }

        zones = r3.data.zones;
        const { zoneTypes, excludedPIndices, cappedExcludedPIndices, snappingStats, cappedZonesCount } = r3.data;

        // Grey markers for zone-cap excluded crime nodes
        cappedExcludedPIndices.forEach(pIdx => {
            if (crimeMarkers[pIdx]) crimeMarkers[pIdx].setIcon(excludedNodeIcon());
        });

        // Empty zone patrol markers → stationary style
        zoneTypes.forEach((type, i) => {
            if (type === 'empty') {
                patrolMarkers[i].setIcon(makePatrolIcon(S_star[i].color, i + 1, true));
            }
        });

        // Patrol marker tooltips — show status and node count on hover
        patrolMarkers.forEach((marker, i) => {
            const type = zoneTypes[i];
            const count = zones[i].length;
            const countStr = `${count} node${count !== 1 ? 's' : ''}`;
            let text;
            if (deploymentMode !== 'roaming' || type === 'empty') {
                text = `Patrol ${i + 1} — Stationary · ${countStr}`;
            } else if (type === 'single') {
                text = `Patrol ${i + 1} — Roaming · ${countStr} (direct visit)`;
            } else {
                text = `Patrol ${i + 1} — Roaming · ${countStr}`;
            }
            marker.bindTooltip(text, { direction: 'top', offset: [0, -13] });
        });

        // Zone assignment lines — original crime marker position → patrol position
        for (let i = 0; i < S_star.length; i++) {
            for (const sn of zones[i]) {
                const p = P[sn.pIdx];
                zoneLines.push(
                    L.polyline([[p.lat, p.lng], [S_star[i].lat, S_star[i].lng]], {
                        color: S_star[i].color, weight: 1, opacity: 0.4, dashArray: '4 6'
                    }).addTo(map)
                );
            }
        }

        // Single-node dashed routes — patrol → snapped node
        zoneTypes.forEach((type, i) => {
            if (type === 'single') {
                const sn = zones[i][0];
                routePolylines.push(
                    L.polyline([[S_star[i].lat, S_star[i].lng], [sn.lat, sn.lng]], {
                        color: S_star[i].color, weight: 4, opacity: 0.9, dashArray: '8 10'
                    }).addTo(map)
                );
            }
        });

        await yieldControl();

        const emptyCount3    = zoneTypes.filter(t => t === 'empty').length;
        const singleCount3   = zoneTypes.filter(t => t === 'single').length;
        const multipleCount3 = zoneTypes.filter(t => t === 'multiple').length;
        const bestRestartLabel = r2.data.bestRestartIdx !== null
            ? `restart ${r2.data.bestRestartIdx}`
            : 'N/A (single patrol)';

        addTraceStage(3, 'Zone Assignment', r3.status, [
            `Zone assignment using final optimized patrol positions from Hill Climbing ${bestRestartLabel}`,
            `Crime nodes processed: ${P.length}`,
            `Crime nodes excluded (no nearby intersection): ${snappingStats.excludedCount}`,
            `Duplicate snapped nodes merged: ${snappingStats.mergedCount}`,
            `Zero distance waypoints: ${snappingStats.waypointCount}`,
            `Average snapping distance: ${Math.round(snappingStats.avgDist)}m`,
            `Maximum snapping distance: ${Math.round(snappingStats.maxDist)}m`,
            ...S_star.map((_, i) => `Patrol ${i + 1}: ${zones[i].length} node${zones[i].length !== 1 ? 's' : ''} (${zoneTypes[i]})`),
            `Empty zones: ${emptyCount3} patrol${emptyCount3 !== 1 ? 's' : ''} stationary`,
            `Single node zones: ${singleCount3} patrol${singleCount3 !== 1 ? 's' : ''} direct visit`,
            `Multiple node zones: ${multipleCount3} patrol${multipleCount3 !== 1 ? 's' : ''} proceeding to TSP`,
            `Zones capped: ${cappedZonesCount}`,
            `Status: ${r3.status === 'success' ? '✅' : '⚠️'} ${r3.message}`,
            `Runtime: ${t3ms}ms`
        ], r3.data.traceLog);

        // ── Stationary mode — pipeline complete after Stage 3 ─
        if (deploymentMode !== 'roaming') {
            const totalMs = Math.round(performance.now() - pipelineStart);
            document.getElementById('pipeline-summary').textContent =
                `Pipeline Complete — Total time: ${totalMs}ms | Stationary mode | ${S_star.length} patrol${S_star.length !== 1 ? 's' : ''}`;
            const traceBodyEl = document.getElementById('trace-body');
            if (traceBodyEl) traceBodyEl.scrollTop = traceBodyEl.scrollHeight;
            stopPipeline();
            return;
        }

        // ── Stage 4: Backtracking TSP ──────────────────────────
        recalcBtn.textContent = 'Running Stage 4 — TSP…';
        loadingMessage.textContent = 'Running Stage 4 — TSP…';
        await yieldControl();

        const t4 = performance.now();
        const stage4Warnings = [];
        const stage4Log = [];
        let tspCount = 0, stationaryCount4 = 0, directCount4 = 0;
        let totalDijkstraCalls = 0, totalCacheHits = 0;
        let stage4Status = 'success';
        const stage4CircuitSummaries = [];

        // Edges rendered across all patrol routes — for overlap detection
        const allRenderedPaths = []; // [{ path: [nodeId, ...], color }]

        const multipleZoneCount = zoneTypes.filter(t => t === 'multiple').length;

        for (let i = 0; i < S_star.length; i++) {
            if (zoneTypes[i] === 'empty') { stationaryCount4++; continue; }
            if (zoneTypes[i] === 'single') { directCount4++; continue; }
            // zoneTypes[i] === 'multiple'

            const r4 = computeTSP(i, S_star[i], zones[i], nodeMap, adjacencyList, dijkstraCache, CONFIG);

            totalDijkstraCalls += r4.data.dijkstraCalls;
            totalCacheHits    += r4.data.cacheHits;
            r4.data.traceLog.forEach(l => stage4Log.push(l));
            r4.warnings.forEach(w => { if (!stage4Warnings.includes(w)) stage4Warnings.push(w); });

            if (r4.data.emptyZone) {
                // All crime nodes unreachable — treat zone as empty
                patrolMarkers[i].setIcon(makePatrolIcon(S_star[i].color, i + 1, true));
                stationaryCount4++;
                stage4Status = 'warning';
                stage4Log.push(`Patrol ${i + 1}: all crime nodes excluded — patrol stationary.`);
                continue;
            }

            tspCount++;
            const { circuitNodes, legPaths, totalDistance } = r4.data;
            const circSumStr = [...circuitNodes, circuitNodes[0]]
                .map(n => `${n.id} (${n.lat.toFixed(4)}, ${n.lng.toFixed(4)})`)
                .join(' → ');
            stage4CircuitSummaries.push(`Patrol ${i + 1}: optimal circuit: ${circSumStr}. Total: ${Math.round(totalDistance)}m`);
            const color = S_star[i].color;

            // Render each leg as a road-following polyline
            for (let leg = 0; leg < circuitNodes.length; leg++) {
                const path = legPaths[leg]; // array of node IDs
                if (!path || path.length < 2) continue;

                const latLngs = path.map(id => {
                    const nd = nodeMap.get(id);
                    return [nd.lat, nd.lng];
                });

                // White casing underneath makes the colored route stand out on OSM tiles
                const casing = L.polyline(latLngs, {
                    color: '#ffffff', weight: 7, opacity: 0.75, lineCap: 'round', lineJoin: 'round'
                }).addTo(map);
                routePolylines.push(casing);

                const polyline = L.polyline(latLngs, {
                    color, weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round'
                }).addTo(map);
                routePolylines.push(polyline);

                if (CONFIG.display.showRouteArrows && typeof L.polylineDecorator === 'function') {
                    const decorator = L.polylineDecorator(polyline, {
                        patterns: [{
                            offset: '10%',
                            repeat: '20%',
                            symbol: L.Symbol.arrowHead({
                                pixelSize: 9,
                                polygon: false,
                                pathOptions: { color, weight: 2, opacity: 1.0 }
                            })
                        }]
                    }).addTo(map);
                    routePolylines.push(decorator);
                }

                allRenderedPaths.push({ path, color });
            }

            await yieldControl();
        }

        // All multi-node zones failed AND no single-node routes exist → no reachable crime nodes
        if (multipleZoneCount > 0 && tspCount === 0 && directCount4 === 0) {
            showBanner('error', 'No reachable crime nodes found for any patrol. Check road network connectivity.');
            addTraceStage(4, 'Backtracking TSP', 'error', [
                `Status: ❌ No reachable crime nodes for any patrol.`,
                `Runtime: ${Math.round(performance.now() - t4)}ms`
            ], stage4Log);
            zoneLines.forEach(l => l.remove());
            zoneLines = [];
            stopPipeline();
            return;
        }

        // Remove zone assignment lines — replaced by route polylines in roaming mode
        zoneLines.forEach(l => l.remove());
        zoneLines = [];

        // Overlap tracking — render overlay layer for shared edges
        let overlapEdges2 = 0, overlapEdges3 = 0;
        if (CONFIG.display.showOverlapColoring && allRenderedPaths.length > 0) {
            const edgeUsage = new Map();
            for (const { path } of allRenderedPaths) {
                for (let e = 0; e < path.length - 1; e++) {
                    const key = normalizeEdgeKey(path[e], path[e + 1]);
                    edgeUsage.set(key, (edgeUsage.get(key) || 0) + 1);
                }
            }

            const overlapLines = [];
            for (const [key, count] of edgeUsage) {
                if (count < 2) continue;
                const [idA, idB] = key.split('|');
                const nA = nodeMap.get(idA), nB = nodeMap.get(idB);
                if (!nA || !nB) continue;
                const overlapColor = count === 2 ? '#FFA500' : '#FF0000';
                overlapLines.push(L.polyline([[nA.lat, nA.lng], [nB.lat, nB.lng]], {
                    color: overlapColor, weight: 7, opacity: 0.55
                }));
                if (count === 2) overlapEdges2++; else overlapEdges3++;
            }

            if (overlapLines.length > 0) {
                overlapLayer = L.layerGroup(overlapLines).addTo(map);
            }
        }

        // Propagate Stage 4 warnings to banner
        if (stage4Warnings.length > 0) {
            stage4Warnings.forEach(w => { if (!pipelineWarnings.includes(w)) pipelineWarnings.push(w); });
            showBanner('warning', pipelineWarnings.length === 1 ? pipelineWarnings[0] : pipelineWarnings);
        }

        const t4ms = Math.round(performance.now() - t4);
        if (stage4Warnings.length > 0 && stage4Status === 'success') stage4Status = 'warning';

        addTraceStage(4, 'Backtracking TSP', stage4Status, [
            `Patrols with TSP routes: ${tspCount}`,
            `Patrols stationary (empty zone): ${stationaryCount4}`,
            `Patrols with direct visit (single node): ${directCount4}`,
            ...stage4CircuitSummaries,
            `Total Dijkstra calls: ${totalDijkstraCalls}`,
            `Dijkstra calls avoided (cache): ${totalCacheHits}`,
            `Route overlap: ${overlapEdges2} edge${overlapEdges2 !== 1 ? 's' : ''} with 2 patrols, ${overlapEdges3} edge${overlapEdges3 !== 1 ? 's' : ''} with 3+ patrols`,
            `Status: ${stage4Status === 'success' ? '✅' : '⚠️'} ${stage4Warnings.length > 0 ? stage4Warnings[0] : 'All circuits computed'}`,
            `Runtime: ${t4ms}ms`
        ], stage4Log);

        // Pipeline complete
        const totalMs = Math.round(performance.now() - pipelineStart);
        document.getElementById('pipeline-summary').textContent =
            `Pipeline Complete — Total time: ${totalMs}ms | ${tspCount} roaming patrol${tspCount !== 1 ? 's' : ''} | ${stationaryCount4} stationary | ${directCount4} direct visit`;

        const traceBodyEl = document.getElementById('trace-body');
        if (traceBodyEl) traceBodyEl.scrollTop = traceBodyEl.scrollHeight;

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
        const isTextInput = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
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

    runPipeline();
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
        if (d > threshold) { markers[i].setIcon(outlierNodeIcon()); count++; }
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
