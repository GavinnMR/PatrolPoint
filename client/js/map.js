// PatrolPoint V2 — map.js
// Complete Leaflet map initialization, layer management, and all rendering functions.
// Covers Build Steps 8B and 8C from SPEC.md Section 19.

import { replacePlaceholder } from './websocket-client.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const MAP_CENTER  = [14.7028, 121.0944];
const MAP_ZOOM    = 15;
const MAP_MIN_ZOOM = 14;
const MAP_MAX_ZOOM = 18; // BUG FIX: V1 used 19, OSM tiles unavailable there

const PATROL_COLORS = window.PATROL_COLORS || [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#34495e',
    '#e91e63', '#00bcd4'
];

// ── Module-level state ─────────────────────────────────────────────────────────
let map              = null;
let minimapInstance  = null;
let minimapViewport  = null;
let lightTileLayer   = null;
let darkTileLayer    = null;
let currentTileLayer = null;

let hullPolygon             = null;
let barangayMask            = null;
let barangayOutline         = null;
let patrolClusterGroup      = null;
let patrolMarkerMap         = {};    // patrolId → { marker, color, num, style, coverageCircle }
let zoneLinesList           = [];
let routePolylines          = {};    // patrolId → { outbound:[], return:[], decorators:[] }
let overlapOverlayLines     = [];
let nearestHighlightMarkers = [];
let crimeMarkerMap          = {};    // crimeId → Leaflet marker
let osmGraphLayers          = [];

let _lastRoutes = null;              // stored for zoom-level redraw

// Comparison overlay layers
let comparisonLayersA = [];   // Leaflet layers for Run A
let comparisonLayersB = [];   // Leaflet layers for Run B

// ── Utility: ray casting point-in-polygon ─────────────────────────────────────
function pointInHull(lat, lng, hull) {
    if (!hull || hull.length < 3) return true;
    let inside = false;
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
        const xi = hull[i].lng, yi = hull[i].lat;
        const xj = hull[j].lng, yj = hull[j].lat;
        const cross = ((yi > lat) !== (yj > lat)) &&
                      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
        if (cross) inside = !inside;
    }
    return inside;
}

// ── Map initialization ─────────────────────────────────────────────────────────
function initMap(ui) {
    map = L.map('map', {
        center: MAP_CENTER,
        zoom:   MAP_ZOOM,
        minZoom: MAP_MIN_ZOOM,
        maxZoom: MAP_MAX_ZOOM,
        zoomControl: true
    });

    // Tile layers
    lightTileLayer = L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { attribution: '© OpenStreetMap contributors', maxZoom: MAP_MAX_ZOOM }
    );
    darkTileLayer = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { attribution: '© OpenStreetMap contributors © CartoDB', maxZoom: MAP_MAX_ZOOM }
    );

    currentTileLayer = window.darkMode ? darkTileLayer : lightTileLayer;
    currentTileLayer.addTo(map);

    // Resize handler
    window.addEventListener('resize', () => map.invalidateSize());

    // Live coordinate display
    const coordEl = document.getElementById('coord-display');
    map.on('mousemove', (e) => {
        if (coordEl) {
            coordEl.classList.remove('hidden');
            coordEl.textContent =
                `Lat: ${e.latlng.lat.toFixed(6)}  Lng: ${e.latlng.lng.toFixed(6)}`;
        }
    });
    map.on('mouseout', () => {
        if (coordEl) coordEl.classList.add('hidden');
    });

    // Map click → add crime node
    map.on('click', (e) => {
        if (window.pipelineRunning) return;
        const { lat, lng } = e.latlng;

        // Duplicate check
        const dup = (window.P || []).find(
            p => Math.abs(p.lat - lat) < 1e-7 && Math.abs(p.lng - lng) < 1e-7
        );
        if (dup) {
            if (ui) ui.showBanner('Incident already plotted at this location.', 'warning');
            return;
        }

        // Hull membership check — only when a hull exists
        if (window.currentHull && window.currentHull.length > 0) {
            if (!pointInHull(lat, lng, window.currentHull)) {
                if (ui) ui.showBanner(
                    'Incident plotted outside the current danger zone boundary. Point ignored.',
                    'warning'
                );
                return;
            }
        }

        if (ui) ui.addCrimeNode(lat, lng);
    });

    // Zoom end: redraw offset routes and minimap viewport
    map.on('zoomend', () => {
        if (_lastRoutes) _redrawRoutesAtCurrentZoom();
        _updateMinimapViewport();
    });
    map.on('moveend', _updateMinimapViewport);

    // Patrol cluster group — disabled at zoom >= 14 (clustering only below min zoom)
    patrolClusterGroup = L.markerClusterGroup({
        maxClusterRadius: 30,
        disableClusteringAtZoom: MAP_MIN_ZOOM,
        iconCreateFunction: (cluster) => L.divIcon({
            html: `<div style="background:#3b82f6;color:#fff;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);">${cluster.getChildCount()}</div>`,
            className: '',
            iconSize: [28, 28]
        })
    });
    map.addLayer(patrolClusterGroup);

    // Initialise minimap
    _initMinimap();

    // Wire WebSocket placeholder callbacks
    replacePlaceholder('onConnected', () => {
        console.log('[map.js] WS connected');
    });

    replacePlaceholder('onNetworkLoaded', (data) => {
        if (data.boundaryPolygon && data.boundaryPolygon.length >= 3) {
            renderBarangayBoundary(data.boundaryPolygon);
        }
        if (window.osmGraphMode) toggleOsmGraphMode(true);
    });

    replacePlaceholder('onStageProgress', (data) => {
        // Stage 2 real-time patrol positions during Hill Climbing
        if (data.stage === 2 && Array.isArray(data.patrolPositions)) {
            updatePatrolPositionsInstant(data.patrolPositions);
        }
    });

    replacePlaceholder('onHullComplete', (result) => {
        if (result.hull && result.hull.length >= 3) renderHull(result.hull);
        if (result.nearestHighlights) renderNearestHighlights(result.nearestHighlights);
    });

    replacePlaceholder('onPatrolsComplete', (result) => {
        if (result.patrols && result.patrols.length > 0) renderPatrolMarkers(result.patrols);
    });

    replacePlaceholder('onZonesComplete', (result) => {
        clearZoneLines();
        if (result.zones && result.patrols) {
            renderZoneLines(result.zones, result.patrols);
            // Mark empty-zone patrols as stationary
            (result.emptyZones || []).forEach(idx => {
                const p = result.patrols[idx];
                if (p) updatePatrolMarkerStyle(p.id || `p${idx}`, 'stationary');
            });
        }
        const showRadius = window.uiApp?.activeConfig?.display?.showCoverageRadius;
        if (showRadius && result.patrols) renderCoverageRadius(result.patrols);
    });

    replacePlaceholder('onRoutesComplete', (result) => {
        clearZoneLines();
        if (result.routes && result.routes.length > 0) {
            renderRoutes(result.routes);
            if ((result.overlapEdges || []).length > 0) {
                renderOverlapOverlay(result.routes);
            }
        }
    });

    replacePlaceholder('onPipelineComplete', (_data) => {
        // All rendering already handled in per-stage handlers
    });
}

// ── Minimap ────────────────────────────────────────────────────────────────────
function _initMinimap() {
    const container = document.getElementById('minimap');
    if (!container) return;

    minimapInstance = L.map('minimap', {
        center: MAP_CENTER,
        zoom: 13,
        zoomControl:        false,
        attributionControl: false,
        dragging:           false,
        touchZoom:          false,
        doubleClickZoom:    false,
        scrollWheelZoom:    false,
        boxZoom:            false,
        keyboard:           false
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18 })
        .addTo(minimapInstance);

    minimapViewport = L.rectangle(map.getBounds(), {
        color: '#3b82f6',
        weight: 1.5,
        fill: true,
        fillColor: '#3b82f6',
        fillOpacity: 0.1,
        interactive: false
    }).addTo(minimapInstance);

    // Prevent minimap clicks from reaching main map
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
}

function _updateMinimapViewport() {
    if (minimapViewport && map) minimapViewport.setBounds(map.getBounds());
}

// ── Barangay boundary darkening ────────────────────────────────────────────────
function renderBarangayBoundary(boundaryPolygon) {
    if (barangayMask)   { map.removeLayer(barangayMask);   barangayMask   = null; }
    if (barangayOutline){ map.removeLayer(barangayOutline); barangayOutline = null; }

    if (!boundaryPolygon || boundaryPolygon.length < 3) return;

    // World rect as outer ring; boundary polygon as hole → darkens everything outside boundary
    const worldRect = [[-90,-180],[90,-180],[90,180],[-90,180]];

    barangayMask = L.polygon([worldRect, boundaryPolygon], {
        fillColor: '#000',
        fillOpacity: 0.45,
        stroke: false,
        interactive: false
    }).addTo(map);

    const isDark = document.documentElement.classList.contains('dark');
    barangayOutline = L.polyline(
        [...boundaryPolygon, boundaryPolygon[0]].map(v => [v.lat, v.lng]),
        { color: isDark ? '#6b7280' : '#9ca3af', weight: 1.5, dashArray: '6 4', opacity: 0.8, interactive: false }
    ).addTo(map);

    window.barangayMask = barangayMask;
}

// ── Dark mode ──────────────────────────────────────────────────────────────────
function onDarkModeChange(isDark) {
    if (!map) return;
    if (currentTileLayer) map.removeLayer(currentTileLayer);
    currentTileLayer = isDark ? darkTileLayer : lightTileLayer;
    currentTileLayer.addTo(map);
    if (barangayOutline) barangayOutline.setStyle({ color: isDark ? '#6b7280' : '#9ca3af' });
}

// ── OSM graph-only mode ────────────────────────────────────────────────────────
function toggleOsmGraphMode(active) {
    osmGraphLayers.forEach(l => map.removeLayer(l));
    osmGraphLayers = [];
    window.osmGraphLayers = osmGraphLayers;

    if (active) {
        if (currentTileLayer) map.removeLayer(currentTileLayer);

        const nm  = window.nodeMap       || {};
        const adj = window.adjacencyList || {};
        const drawn = new Set();

        for (const nodeId of Object.keys(adj)) {
            const from = nm[nodeId];
            if (!from) continue;
            for (const edge of adj[nodeId]) {
                const key = [nodeId, edge.neighborId].sort().join('|');
                if (drawn.has(key)) continue;
                drawn.add(key);
                const to = nm[edge.neighborId];
                if (!to) continue;
                const line = L.polyline(
                    [[from.lat, from.lng],[to.lat, to.lng]],
                    { color: '#6b7280', weight: 1, opacity: 0.5, interactive: false }
                ).addTo(map);
                osmGraphLayers.push(line);
            }
        }

        for (const nodeId of (window.intersectionNodeIds || [])) {
            const node = nm[nodeId];
            if (!node) continue;
            const dot = L.circleMarker([node.lat, node.lng], {
                radius: 2, color: '#3b82f6', fillColor: '#3b82f6',
                fillOpacity: 0.8, weight: 0, interactive: false
            }).addTo(map);
            osmGraphLayers.push(dot);
        }
    } else {
        currentTileLayer.addTo(map);
    }
}

// ── Reset view ─────────────────────────────────────────────────────────────────
function mapResetView() {
    if (map) map.setView(MAP_CENTER, MAP_ZOOM);
}

// ── Crime node markers ─────────────────────────────────────────────────────────
function plotCrimeMarker(point) {
    const { crimeId, lat, lng } = point;

    const icon = L.divIcon({
        className: '',
        html: `<div class="crime-marker" id="cm-${crimeId}"></div><div class="crime-marker-label">${crimeId}</div>`,
        iconSize:   [14, 26],
        iconAnchor: [7, 7]
    });

    const marker = L.marker([lat, lng], {
        icon,
        draggable:   true,
        zIndexOffset: 1000,
        title: crimeId
    }).addTo(map);

    // Click to remove with 300ms flash
    marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (window.pipelineRunning) return;
        const el = document.getElementById(`cm-${crimeId}`);
        if (el) {
            const orig = el.style.backgroundColor;
            el.style.backgroundColor = '#ffffff';
            setTimeout(() => { el.style.backgroundColor = orig; }, 150);
        }
        setTimeout(() => {
            const ui = window.uiApp;
            if (ui) ui.removeCrimeNode(crimeId);
        }, 300);
    });

    // Drag with hull boundary validation
    let savedLat = lat, savedLng = lng;
    marker.on('dragstart', () => {
        savedLat = marker.getLatLng().lat;
        savedLng = marker.getLatLng().lng;
    });
    marker.on('dragend', () => {
        const { lat: nLat, lng: nLng } = marker.getLatLng();
        if (window.currentHull && window.currentHull.length > 0 &&
            !pointInHull(nLat, nLng, window.currentHull)) {
            marker.setLatLng([savedLat, savedLng]);
            const ui = window.uiApp;
            if (ui) ui.showBanner('Crime node moved outside danger zone — snapped back.', 'warning');
            return;
        }
        const ui = window.uiApp;
        if (ui) ui.dragCrimeNode(crimeId, savedLat, savedLng, nLat, nLng);
        savedLat = nLat; savedLng = nLng;
    });

    crimeMarkerMap[crimeId]      = marker;
    window.crimeMarkers[crimeId] = marker;
}

function removeCrimeMarker(crimeId) {
    const m = crimeMarkerMap[crimeId];
    if (m) {
        map.removeLayer(m);
        delete crimeMarkerMap[crimeId];
        delete window.crimeMarkers[crimeId];
    }
}

function moveCrimeMarker(crimeId, lat, lng) {
    const m = crimeMarkerMap[crimeId];
    if (m) m.setLatLng([lat, lng]);
}

function updateCrimeMarkerStyle(crimeId, style) {
    const el = document.getElementById(`cm-${crimeId}`);
    if (!el) return;
    el.className = 'crime-marker';
    if (style === 'outlier')  el.classList.add('outlier');
    if (style === 'excluded') el.classList.add('excluded');
}

function restoreCrimeMarkers(points) {
    Object.keys(crimeMarkerMap).forEach(id => map.removeLayer(crimeMarkerMap[id]));
    crimeMarkerMap      = {};
    window.crimeMarkers = {};
    for (const pt of (points || [])) plotCrimeMarker(pt);
}

// ── Hull rendering ─────────────────────────────────────────────────────────────
function renderHull(hullVertices) {
    const latlngs = hullVertices.map(v => [v.lat, v.lng]);
    if (hullPolygon) {
        hullPolygon.setLatLngs(latlngs);
    } else {
        hullPolygon = L.polygon(latlngs, {
            fillColor: '#3b82f6',
            fillOpacity: 0.12,
            color: '#3b82f6',
            weight: 2,
            dashArray: '6 4',
            interactive: false
        }).addTo(map);
    }
    window.hullPolygon = hullPolygon;
}

// ── Patrol markers ─────────────────────────────────────────────────────────────
function renderPatrolMarkers(patrols) {
    const activeIds = new Set();

    patrols.forEach((patrol, idx) => {
        const patrolId = patrol.id || `p${idx}`;
        const color    = patrol.color || PATROL_COLORS[idx % PATROL_COLORS.length];
        const num      = idx + 1;
        activeIds.add(patrolId);

        if (patrolMarkerMap[patrolId]) {
            patrolMarkerMap[patrolId].marker.setLatLng([patrol.lat, patrol.lng]);
        } else {
            const icon = _roamingIcon(color, num);
            const marker = L.marker([patrol.lat, patrol.lng], {
                icon,
                interactive: false,
                zIndexOffset: 500
            });
            patrolClusterGroup.addLayer(marker);
            patrolMarkerMap[patrolId] = { marker, color, num, style: 'roaming', coverageCircle: null };
            window.patrolMarkers[patrolId] = marker;
        }
    });

    // Remove stale patrol markers
    for (const pid of Object.keys(patrolMarkerMap)) {
        if (!activeIds.has(pid)) {
            const entry = patrolMarkerMap[pid];
            patrolClusterGroup.removeLayer(entry.marker);
            if (entry.coverageCircle) map.removeLayer(entry.coverageCircle);
            delete patrolMarkerMap[pid];
            delete window.patrolMarkers[pid];
        }
    }
}

function updatePatrolPositionsInstant(positions) {
    positions.forEach((pos, idx) => {
        const patrolId = pos.id || `p${idx}`;
        const color    = pos.color || PATROL_COLORS[idx % PATROL_COLORS.length];
        const num      = idx + 1;

        if (patrolMarkerMap[patrolId]) {
            patrolMarkerMap[patrolId].marker.setLatLng([pos.lat, pos.lng]);
        } else {
            const marker = L.marker([pos.lat, pos.lng], {
                icon: _roamingIcon(color, num),
                interactive: false,
                zIndexOffset: 500
            });
            patrolClusterGroup.addLayer(marker);
            patrolMarkerMap[patrolId] = { marker, color, num, style: 'roaming', coverageCircle: null };
            window.patrolMarkers[patrolId] = marker;
        }
    });
}

function updatePatrolMarkerStyle(patrolId, style) {
    const entry = patrolMarkerMap[patrolId];
    if (!entry) return;
    entry.style = style;
    const icon = style === 'stationary'
        ? _stationaryIcon(entry.color, entry.num)
        : _roamingIcon(entry.color, entry.num);
    entry.marker.setIcon(icon);
}

function _roamingIcon(color, num, confidence) {
    let badge = '';
    if (confidence !== undefined && confidence !== null) {
        const badgeColor = confidence >= 80 ? '#22c55e' : confidence >= 50 ? '#eab308' : '#ef4444';
        badge = `<div class="patrol-confidence-badge" style="background:${badgeColor};" title="Hill Climbing confidence: ${Math.round(confidence)}%"></div>`;
    }
    return L.divIcon({
        className: '',
        html: `<div class="patrol-marker-roaming" style="background:${color};width:24px;height:24px;">${num}${badge}</div>`,
        iconSize:   [24, 24],
        iconAnchor: [12, 12]
    });
}

function _stationaryIcon(color, num) {
    return L.divIcon({
        className: '',
        html: `
          <div class="patrol-marker-stationary">
            <div class="patrol-pin">
              <svg viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 0C6.268 0 0 6.268 0 14c0 9.333 14 22 14 22s14-12.667 14-22C28 6.268 21.732 0 14 0z"
                      fill="${color}"/>
              </svg>
              <span class="patrol-pin-label">${num}S</span>
            </div>
          </div>`,
        iconSize:   [28, 36],
        iconAnchor: [14, 36]
    });
}

// ── Zone lines ─────────────────────────────────────────────────────────────────
function renderZoneLines(zones, patrols) {
    clearZoneLines();
    if (window.uiApp?.activeConfig?.display?.showZoneLines === false) return;

    patrols.forEach((patrol, pi) => {
        const zone  = zones[pi];
        if (!zone || zone.length === 0) return;
        const color = patrol.color || PATROL_COLORS[pi % PATROL_COLORS.length];

        zone.forEach(node => {
            const line = L.polyline(
                [[patrol.lat, patrol.lng],[node.lat, node.lng]],
                { color, weight: 1, opacity: 0.4, dashArray: '4 6', interactive: false }
            ).addTo(map);
            zoneLinesList.push(line);
        });
    });
}

function clearZoneLines() {
    zoneLinesList.forEach(l => map.removeLayer(l));
    zoneLinesList    = [];
    window.zoneLines = zoneLinesList;
}

// ── Coverage radius circles ────────────────────────────────────────────────────
function renderCoverageRadius(patrols) {
    // Clear old coverage circles
    Object.values(patrolMarkerMap).forEach(entry => {
        if (entry.coverageCircle) { map.removeLayer(entry.coverageCircle); entry.coverageCircle = null; }
    });
    if (!patrols) return;

    const radiusM = window.uiApp?.activeConfig?.display?.coverageRadiusMeters ?? 500;

    patrols.forEach((patrol, idx) => {
        const patrolId = patrol.id || `p${idx}`;
        const color    = patrol.color || PATROL_COLORS[idx % PATROL_COLORS.length];
        const circle   = L.circle([patrol.lat, patrol.lng], {
            radius: radiusM,
            color, weight: 1, fillColor: color, fillOpacity: 0.1, interactive: false
        }).addTo(map);
        if (patrolMarkerMap[patrolId]) patrolMarkerMap[patrolId].coverageCircle = circle;
    });
}

// ── Parallel offset line rendering ─────────────────────────────────────────────

// computeOffsetPolyline — shifts a polyline perpendicularly by offsetMeters * direction (+1 or -1).
// For each consecutive segment A→B, the perpendicular is computed and both endpoints are shifted.
function computeOffsetPolyline(coordinates, offsetMeters, direction) {
    if (!coordinates || coordinates.length < 2) return coordinates || [];

    const offsetDeg = offsetMeters / 111000;
    const result    = [];

    for (let i = 0; i < coordinates.length - 1; i++) {
        const A = coordinates[i];
        const B = coordinates[i + 1];

        const dirLat = B.lat - A.lat;
        const dirLng = B.lng - A.lng;

        // Perpendicular (rotate 90 degrees CCW)
        let perpLat = -dirLng;
        let perpLng =  dirLat;

        const len = Math.sqrt(perpLat * perpLat + perpLng * perpLng);
        if (len === 0) {
            if (i === 0) result.push({ lat: A.lat, lng: A.lng });
            result.push({ lat: B.lat, lng: B.lng });
            continue;
        }
        perpLat /= len;
        perpLng /= len;

        const shiftedA = {
            lat: A.lat + perpLat * offsetDeg * direction,
            lng: A.lng + perpLng * offsetDeg * direction
        };
        const shiftedB = {
            lat: B.lat + perpLat * offsetDeg * direction,
            lng: B.lng + perpLng * offsetDeg * direction
        };

        if (i === 0) result.push(shiftedA);
        result.push(shiftedB);
    }

    return result;
}

// getZoomOffset — offset in meters for parallel lines at each zoom level
function getZoomOffset(zoom) {
    if (zoom <= 14) return 3;
    if (zoom === 15) return 5;
    if (zoom === 16) return 8;
    if (zoom === 17) return 11;
    return 15; // zoom >= 18
}

function renderRoutes(routes) {
    _clearRoutePolylines();
    _lastRoutes = routes;
    window.patrolRoutes = routePolylines;

    const zoom      = map.getZoom();
    const offsetM   = getZoomOffset(zoom);
    const showArrows = window.uiApp?.activeConfig?.display?.showRouteArrows !== false;

    routes.forEach((route, idx) => {
        const patrolId = route.patrolId || `p${idx}`;
        // Color from S_star globals, or fall back to index-based palette
        let color = PATROL_COLORS[idx % PATROL_COLORS.length];
        if (window.S_star && window.S_star[idx] && window.S_star[idx].color) {
            color = window.S_star[idx].color;
        }

        routePolylines[patrolId] = { outbound: [], return: [], decorators: [] };

        if (!route.pathSegments || route.pathSegments.length === 0) return;

        route.pathSegments.forEach((seg) => {
            if (!seg || seg.length < 2) return;

            // Outbound: solid, +offset
            const outCoords = computeOffsetPolyline(seg, offsetM, +1);
            const outLine   = L.polyline(
                outCoords.map(c => [c.lat, c.lng]),
                { color, weight: 3, opacity: 0.9, interactive: false }
            ).addTo(map);
            routePolylines[patrolId].outbound.push(outLine);

            // Return: dashed, -offset
            const retCoords = computeOffsetPolyline(seg, offsetM, -1);
            const retLine   = L.polyline(
                retCoords.map(c => [c.lat, c.lng]),
                { color, weight: 2, opacity: 0.65, dashArray: '8 4', interactive: false }
            ).addTo(map);
            routePolylines[patrolId].return.push(retLine);

            // Direction arrows via Leaflet.polylineDecorator
            if (showArrows && typeof L.polylineDecorator !== 'undefined') {
                try {
                    const dec = L.polylineDecorator(outLine, {
                        patterns: [{
                            offset: '15%',
                            repeat: '30%',
                            symbol: L.Symbol.arrowHead({
                                pixelSize: 6,
                                headAngle: 40,
                                polygon: false,
                                pathOptions: { color, weight: 2, opacity: 0.9 }
                            })
                        }]
                    }).addTo(map);
                    routePolylines[patrolId].decorators.push(dec);
                } catch (_) { /* polylineDecorator unavailable */ }
            }
        });
    });
}

function _redrawRoutesAtCurrentZoom() {
    if (!_lastRoutes) return;
    renderRoutes(_lastRoutes);
    renderOverlapOverlay(_lastRoutes);
}

function _clearRoutePolylines() {
    Object.values(routePolylines).forEach(entry => {
        [...(entry.outbound || []), ...(entry.return || []), ...(entry.decorators || [])]
            .forEach(l => map.removeLayer(l));
    });
    routePolylines      = {};
    window.patrolRoutes = routePolylines;

    overlapOverlayLines.forEach(l => map.removeLayer(l));
    overlapOverlayLines  = [];
    window.overlapOverlay = overlapOverlayLines;
}

// ── Overlap overlay ────────────────────────────────────────────────────────────
function renderOverlapOverlay(routes) {
    overlapOverlayLines.forEach(l => map.removeLayer(l));
    overlapOverlayLines  = [];
    window.overlapOverlay = overlapOverlayLines;

    if (!window.uiApp?.activeConfig?.display?.showOverlapColoring) return;
    if (!routes || routes.length === 0) return;

    // First pass: count usage per edge key
    const edgeCount = new Map();

    for (const route of routes) {
        for (const seg of (route.pathSegments || [])) {
            for (let i = 0; i < seg.length - 1; i++) {
                const key = _edgeKey(seg[i], seg[i + 1]);
                edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
            }
        }
    }

    // Second pass: draw overlay once per edge that has count >= 2
    const drawn = new Set();

    for (const route of routes) {
        for (const seg of (route.pathSegments || [])) {
            for (let i = 0; i < seg.length - 1; i++) {
                const key   = _edgeKey(seg[i], seg[i + 1]);
                const count = edgeCount.get(key) || 0;
                if (count < 2 || drawn.has(key)) continue;
                drawn.add(key);

                const color = count === 2 ? 'rgba(255,165,0,0.6)' : 'rgba(255,0,0,0.6)';
                const line  = L.polyline(
                    [[seg[i].lat, seg[i].lng],[seg[i+1].lat, seg[i+1].lng]],
                    { color, weight: 4, opacity: 1, interactive: false }
                ).addTo(map);
                overlapOverlayLines.push(line);
            }
        }
    }
}

function _edgeKey(a, b) {
    // Use nodeId if present, else rounded lat/lng
    const aId = a.nodeId ? parseInt(a.nodeId.replace(/\D/g, ''), 10) : null;
    const bId = b.nodeId ? parseInt(b.nodeId.replace(/\D/g, ''), 10) : null;
    if (aId !== null && bId !== null && !isNaN(aId) && !isNaN(bId)) {
        return Math.min(aId, bId) + '|' + Math.max(aId, bId);
    }
    const aKey = `${a.lat.toFixed(7)},${a.lng.toFixed(7)}`;
    const bKey = `${b.lat.toFixed(7)},${b.lng.toFixed(7)}`;
    return [aKey, bKey].sort().join('|');
}

// ── Nearest intersection highlights ───────────────────────────────────────────
function renderNearestHighlights(nodes) {
    clearNearestHighlights();
    (nodes || []).forEach(node => {
        const m = L.circleMarker([node.lat, node.lng], {
            radius: 8, color: '#f59e0b', fillColor: '#fbbf24',
            fillOpacity: 0.8, weight: 2, interactive: true
        })
        .bindTooltip(
            'Nearest available road intersection — plot incident coordinates near here',
            { permanent: false, direction: 'top' }
        )
        .addTo(map);
        nearestHighlightMarkers.push(m);
    });
    window.nearestHighlights = nearestHighlightMarkers;
}

function clearNearestHighlights() {
    nearestHighlightMarkers.forEach(m => map.removeLayer(m));
    nearestHighlightMarkers  = [];
    window.nearestHighlights = nearestHighlightMarkers;
}

// ── Clear all pipeline results ─────────────────────────────────────────────────
function clearAllMapResults() {
    // Hull
    if (hullPolygon) { map.removeLayer(hullPolygon); hullPolygon = null; window.hullPolygon = null; }

    // Patrol markers + coverage circles
    patrolClusterGroup.clearLayers();
    Object.values(patrolMarkerMap).forEach(entry => {
        if (entry.coverageCircle) map.removeLayer(entry.coverageCircle);
    });
    patrolMarkerMap      = {};
    window.patrolMarkers = {};
    window.S_star        = [];

    // Routes and overlap
    _clearRoutePolylines();

    // Zone lines
    clearZoneLines();

    // Nearest highlights
    clearNearestHighlights();

    // Crime markers
    Object.keys(crimeMarkerMap).forEach(id => map.removeLayer(crimeMarkerMap[id]));
    crimeMarkerMap       = {};
    window.crimeMarkers  = {};
    window.P             = [];

    window.currentHull     = null;
    window.pipelineComplete = false;
    _lastRoutes            = null;
}

// ── Algorithm comparison overlay ──────────────────────────────────────────────

function _comparisonRunBIcon(color, num) {
    return L.divIcon({
        className: '',
        html: `<div class="patrol-marker-comparison-b" style="border-color:${color};color:${color};width:24px;height:24px;">${num}</div>`,
        iconSize:   [24, 24],
        iconAnchor: [12, 12]
    });
}

function _renderComparisonRun(layers, run, isRunB) {
    if (!run) return;

    const opacity = isRunB ? 0.6 : 1.0;

    // Patrol markers
    (run.patrols || []).forEach((patrol, idx) => {
        const color = patrol.color || PATROL_COLORS[idx % PATROL_COLORS.length];
        const num   = idx + 1;
        const icon  = isRunB ? _comparisonRunBIcon(color, num) : _roamingIcon(color, num);
        const marker = L.marker([patrol.lat, patrol.lng], {
            icon,
            interactive: false,
            opacity,
            zIndexOffset: isRunB ? 450 : 400
        }).addTo(map);
        layers.push(marker);
    });

    // Route lines
    (run.routes || []).forEach((route, idx) => {
        const color = (run.patrols && run.patrols[idx])
            ? (run.patrols[idx].color || PATROL_COLORS[idx % PATROL_COLORS.length])
            : PATROL_COLORS[idx % PATROL_COLORS.length];
        const dashArray = isRunB ? '8 6' : null;

        for (const seg of (route.pathSegments || [])) {
            const latlngs = seg.map(n => [n.lat, n.lng]);
            if (latlngs.length < 2) continue;
            const line = L.polyline(latlngs, {
                color,
                weight:    isRunB ? 2 : 3,
                opacity,
                dashArray,
                interactive: false
            }).addTo(map);
            layers.push(line);
        }
    });
}

function renderComparisonResults(runA, runB) {
    clearComparisonOverlay();
    if (runA) _renderComparisonRun(comparisonLayersA, runA, false);
    if (runB) _renderComparisonRun(comparisonLayersB, runB, true);
}

function showComparisonRunA(visible) {
    comparisonLayersA.forEach(l => visible ? l.addTo(map) : map.removeLayer(l));
}

function showComparisonRunB(visible) {
    comparisonLayersB.forEach(l => visible ? l.addTo(map) : map.removeLayer(l));
}

function clearComparisonOverlay() {
    comparisonLayersA.forEach(l => map.removeLayer(l));
    comparisonLayersB.forEach(l => map.removeLayer(l));
    comparisonLayersA = [];
    comparisonLayersB = [];
}

// ── Session result rendering ───────────────────────────────────────────────────

function renderSessionResults(session, ui) {
    if (!session || !session.results) return;
    const { hull, patrols, zones, routes } = session.results;

    // Reset to a clean state first (keep crime markers)
    if (hullPolygon) { map.removeLayer(hullPolygon); hullPolygon = null; }
    patrolClusterGroup.clearLayers();
    Object.values(patrolMarkerMap).forEach(entry => {
        if (entry.coverageCircle) map.removeLayer(entry.coverageCircle);
    });
    patrolMarkerMap      = {};
    window.patrolMarkers = {};
    _clearRoutePolylines();
    clearZoneLines();

    // Hull
    if (hull && hull.length >= 3) {
        renderHull(hull);
        window.currentHull = hull;
    }

    // Patrols + zones + routes
    if (patrols && patrols.length > 0) {
        renderPatrolMarkers(patrols);
        window.S_star = patrols;

        if (zones) {
            window.zones = zones;
            const mode = session.deployment_mode || 'stationary';
            if (mode === 'roaming' && routes && routes.length > 0) {
                renderRoutes(routes);
                renderOverlapOverlay(routes);
                window.routes = routes;
            } else {
                renderZoneLines(zones, patrols);
            }

            // Mark stationary patrols
            patrols.forEach((patrol, idx) => {
                const zone = zones[idx];
                if (!zone || zone.length === 0) {
                    updatePatrolMarkerStyle(patrol.id || `p${idx}`, 'stationary');
                }
            });
        }
    }

    window.pipelineComplete = true;
    if (ui) {
        ui.pipelineComplete = true;
        ui.deploymentMode   = session.deployment_mode || 'stationary';
        ui.nPatrols         = session.n_patrols;
    }
}

// ── Barangay network switch ────────────────────────────────────────────────────
function loadBarangayNetwork(barangay) {
    window.currentBarangay = barangay;
    // Remove old boundary layers — new ones arrive via onNetworkLoaded after compute
    if (barangayMask)    { map.removeLayer(barangayMask);    barangayMask    = null; }
    if (barangayOutline) { map.removeLayer(barangayOutline); barangayOutline = null; }
    window.barangayMask = null;
    console.log(`[map.js] Barangay switched to: ${barangay}`);
}

// ── Global exports ─────────────────────────────────────────────────────────────
window.initMap                    = initMap;
window.mapResetView               = mapResetView;
window.onDarkModeChange           = onDarkModeChange;
window.toggleOsmGraphMode         = toggleOsmGraphMode;
window.loadBarangayNetwork        = loadBarangayNetwork;

window.plotCrimeMarker            = plotCrimeMarker;
window.removeCrimeMarker          = removeCrimeMarker;
window.moveCrimeMarker            = moveCrimeMarker;
window.updateCrimeMarkerStyle     = updateCrimeMarkerStyle;
window.restoreCrimeMarkers        = restoreCrimeMarkers;

window.renderHull                 = renderHull;
window.renderPatrolMarkers        = renderPatrolMarkers;
window.updatePatrolPositionsInstant = updatePatrolPositionsInstant;
window.updatePatrolMarkerStyle    = updatePatrolMarkerStyle;
window.renderBarangayBoundary     = renderBarangayBoundary;
window.renderZoneLines            = renderZoneLines;
window.clearZoneLines             = clearZoneLines;
window.renderRoutes               = renderRoutes;
window.renderOverlapOverlay       = renderOverlapOverlay;
window.renderCoverageRadius       = renderCoverageRadius;
window.renderNearestHighlights    = renderNearestHighlights;
window.clearNearestHighlights     = clearNearestHighlights;
window.clearAllMapResults         = clearAllMapResults;

window.computeOffsetPolyline      = computeOffsetPolyline;
window.getZoomOffset              = getZoomOffset;

window.renderComparisonResults    = renderComparisonResults;
window.showComparisonRunA         = showComparisonRunA;
window.showComparisonRunB         = showComparisonRunB;
window.clearComparisonOverlay     = clearComparisonOverlay;
window.renderSessionResults       = renderSessionResults;

// Alias used by ui.js bulk-import: clears visual markers without touching P array
window.clearCrimeMarkers = function () {
    Object.keys(crimeMarkerMap).forEach(id => map.removeLayer(crimeMarkerMap[id]));
    crimeMarkerMap      = {};
    window.crimeMarkers = {};
};
