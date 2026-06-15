# PatrolPoint

A full-stack patrol deployment optimizer for Philippine barangays. Plot crime incident coordinates on a map, set the number of patrol units, and the system computes an optimal danger zone boundary, spreads patrols across it with maximum separation, assigns each incident to the nearest patrol by road distance, and generates closed-loop roaming circuits that follow actual road paths.

---

## Problem Statement

Barangay-level patrol deployment is typically done by intuition. PatrolPoint gives a data-driven alternative: mark where incidents occurred, and the system derives the danger zone, places patrol units to cover it evenly, and routes each patrol through its assigned incidents along real roads, not straight lines through walls and buildings.

---

## Algorithm Pipeline

Each **Recalculate** runs four sequential stages on the Node.js server. Results stream to the browser stage-by-stage via WebSocket.

### Stage 1: Brute Force Convex Hull
Computes the smallest convex polygon enclosing all plotted incidents. This defines the operational danger zone; all patrol candidates and routes are constrained within it.

O(n³) brute-force edge testing: for each ordered point pair (A → B), check whether all remaining points lie to the left. Valid edges are chained into the polygon. The cubic cost is negligible at the 5–30 incidents typical of a barangay deployment. Includes outlier detection, collinearity handling, and a degenerate (linear) fallback. An incremental check skips full recomputation if all new incidents already fall inside the previous hull.

### Stage 2: Hill Climbing Patrol Placement
Places *n* patrol units at road nodes inside the danger zone, maximising the minimum pairwise **road-network distance** between any two patrols.

Each patrol iterates: find all road neighbors within radius R, move to the neighbor that most improves the global minimum spacing. Multiple restarts escape local optima. V2 additions:
- **Adaptive restart count**: stops early when the last 3 restarts converge within 0.1%. Range: 5 to the configured maximum (default 100).
- **Seeded RNG**: initial placement is derived from incident coordinates via FNV-1a hash → mulberry32 PRNG, so the same incident set always produces the same result.
- **Synchronous mode**: all patrols compute their best move based on the current snapshot, then apply simultaneously, as opposed to the default sequential mode where each patrol sees the moves of the previous one.
- **Confidence indicator**: (1 − σ/μ) × 100 across all restart results. High confidence means restarts converged on the same answer; low confidence means the landscape has many comparable local optima.
- **candidateNodes setting**: choose between all road nodes (default, gives finer placement granularity) or intersection nodes only.

### Stage 3: Zone Assignment
Assigns each crime incident to its nearest patrol by **shortest road-network distance** (Dijkstra), forming *n* patrol responsibility zones.

Road distance, not straight-line distance, determines assignment; two map-adjacent points can be far apart if a wall or block lies between them. Dijkstra runs once per unique snapped incident position and returns distances to all nodes simultaneously, so *m* incidents require only *m* Dijkstra calls. An optional zone rebalancing pass reassigns boundary incidents from overloaded zones to underloaded ones (capped at 10 reassignment iterations).

### Stage 4: Backtracking TSP + Dijkstra Road Paths
Finds the optimal closed-loop visiting sequence for each patrol through its assigned incidents, then reconstructs the actual road-following path for each leg.

Exact solution via backtracking with branch-and-bound pruning; any partial route whose accumulated cost already exceeds the current best complete circuit is discarded. For zones larger than the nearest-neighbor fallback threshold (default 12 nodes), a greedy O(k²) nearest-neighbor heuristic is used instead.

Road paths between waypoints are computed via Dijkstra with a per-run cache so each node pair is computed at most once and reused across all patrol zones. A configurable hull-exterior penalty multiplies path weights for segments that pass outside the danger zone, biasing routes toward interior roads.

---

## Architecture

```
Browser (Alpine.js + Leaflet)
        │  WebSocket (real-time stage updates)
        │  HTTP (network metadata)
        ▼
Express + ws
        │
        ├── algorithms/    convexHull · hillClimbing · zoneAssignment · tsp · dijkstra · verifier
        ├── services/      cache · pipeline
        ├── websocket/     pipelineSocket
        └── data/barangays/  358 pre-processed Quezon City road networks (local .json files)
```

Road network data is pre-processed from OpenStreetMap and stored as local JSON files. No live Overpass API call is made at runtime. The server loads each barangay file on first request and keeps it in memory for the lifetime of the process.

**Server layout:**

```
server/
├── index.js
├── routes/          network
├── algorithms/      convexHull · hillClimbing · zoneAssignment · tsp · dijkstra · verifier
├── services/        cache · pipeline
├── websocket/       pipelineSocket
└── middleware/      rateLimit · sanitize
```

**Client layout:**

```
client/
├── index.html
└── js/
    ├── main.js              global state (P, S★, zones, routes)
    ├── ui.js                Alpine.js component, all reactive data + interaction logic
    ├── map.js               Leaflet rendering, layer management
    └── websocket-client.js  WebSocket connection, message handlers, reconnection
```

---

## Supported Barangays

358 Quezon City barangays are available, all pre-processed from OSM data. The barangay selector in the control panel is a searchable combobox. Start typing a name to filter. Selecting a new barangay clears all incident points and loads the new road network.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, vanilla JS, Tailwind CSS (CDN), Alpine.js (CDN), GSAP (CDN) |
| Map | Leaflet.js 1.9.4, Leaflet.markercluster, Leaflet.PolylineDecorator |
| Tiles | OpenStreetMap (light) / CartoDB Dark Matter (dark mode) |
| Backend | Node.js, Express 4, ws (WebSocket) |
| Road data | Pre-processed OSM files (local), no live Overpass calls at runtime |
| Hosting | Render |

---

## How to Run Locally

**Prerequisites:** Node.js 22+, npm.

```bash
git clone https://github.com/GavinnMR/patrolpoint.git
cd patrolpoint
npm install
npm start
```

Open `http://localhost:3000`. No database or external API keys are required; road network data is bundled as local files.

Optional `.env` (only `PORT` is needed for local development):

```env
NODE_ENV=development
PORT=3000
```

---

## WebSocket Message Protocol

**Client → Server**

```javascript
{ type: 'init',    data: { barangay } }
{ type: 'compute', data: { incidents, n, mode, config, barangay } }
{ type: 'cancel' }
{ type: 'ping' }
```

**Server → Client**

```javascript
{ type: 'connected' }
{ type: 'network_loaded',    data: { barangay, nodeCount, edgeCount, intersectionCount, fromCache, boundaryPolygon } }
{ type: 'pipeline_start',    data: { totalStages, mode } }
{ type: 'stage_start',       data: { stage, name } }
{ type: 'stage_progress',    data: { stage, restart?, iteration?, patrolPositions?, bestMinDist? } }
{ type: 'stage_complete',    data: { stage, result, trace, runtimeMs } }
{ type: 'pipeline_complete', data: { hull, patrols, zones, routes, trace, totalRuntimeMs, verificationReport } }
{ type: 'warning',           data: { stage, message } }
{ type: 'error',             data: { stage?, message, fatal } }
{ type: 'pong' }
```

---

## Algorithm Configuration

All parameters are adjustable via the Settings panel (gear icon). Changes take effect on the next Recalculate.

| Parameter | Default | Description |
|---|---|---|
| candidateNodes | `all` | Node pool for patrol placement: `all` road nodes or `intersection` nodes only |
| hillClimbing.restarts | 100 | Maximum Hill Climbing restarts (adaptive early stop may halt sooner) |
| hillClimbing.maxIterations | 1000 | Iterations per restart |
| hillClimbing.radiusMultiplier | 2 | Neighbourhood radius = mean patrol spacing × this multiplier |
| hillClimbing.synchronousMode | false | Move all patrols simultaneously (vs. sequential default) |
| convexHull.outlierMultiplier | 2.5 | Distance threshold for outlier flagging (× average distance from centroid) |
| convexHull.includeOutliers | true | Whether outlier incidents contribute to hull computation |
| tsp.maxCrimeNodesPerZone | 12 | Hard cap on waypoints per patrol (excess incidents shown as excluded) |
| tsp.nearestNeighborFallbackThreshold | 12 | Use nearest-neighbor heuristic instead of exact backtracking above this zone size |
| tsp.hullExteriorPenalty | 1 | Multiplier on road path weights outside the hull (1 = no penalty) |
| zoneAssignment.strongRebalancing | false | More aggressive zone-size equalization |

---

## UI Features

- **Stationary / Roaming mode**: Stationary shows zone assignment lines only; Roaming adds TSP road-following circuits with direction arrows and parallel offset rendering for outbound vs. return legs.
- **Algorithm trace panel**: Collapsible side panel showing per-stage metrics, algorithm descriptions, log output, Hill Climbing convergence curve, and a post-pipeline correctness verification report.
- **Dark mode**: Switches Leaflet tiles to CartoDB Dark Matter. Persisted in `localStorage`.
- **Undo / Redo**: Full history of incident add, remove, drag, bulk import, and reset actions. Keyboard shortcuts: `Ctrl+Z` / `Ctrl+Shift+Z`.
- **Import coordinates**: Paste bulk `lat, lng` pairs (one per line) into the Import section. Points outside the barangay boundary are rejected. Outlier flagging runs immediately.
- **Drag incidents**: Drag existing crime markers to new positions. Points snapped back if dragged outside the boundary.
- **OSM graph mode**: Toggle ("Road Graph" button) replaces tiles with the raw road graph drawn as grey polylines. Individual road nodes can be right-clicked and excluded from routing, narrowing the patrol candidate pool for the next run.
- **Comparison mode**: Store Run A, change settings or patrol count, run again, store Run B. Both sets of patrol markers render simultaneously (solid vs. hollow) with side-by-side summary metrics.
- **Route playback**: Animate a selected patrol marker along its road-following circuit. Adjustable speed (0.5× – 3×), pause/resume/stop.
- **Patrol info panel**: Click any patrol marker to open a detail panel (top-right) showing zone size, circuit distance, and assigned incidents.
- **Coverage radius**: Optional translucent circle around each patrol (configurable radius, default 500 m).
- **Print view**: `window.print()` with CSS rules that hide all UI chrome and show only the map with markers and routes.
- **Mobile layout**: Control panel becomes a draggable bottom sheet on viewports narrower than 768 px.
- **Recalculate shortcut**: `Ctrl+Enter` triggers Recalculate when no input is focused.

---

## Post-Pipeline Verification

After each pipeline run, `server/algorithms/verifier.js` checks:

1. All incidents lie inside the computed hull
2. All patrol positions are inside the hull, on distinct nodes, and drawn from the valid candidate set
3. Every incident appears in exactly one zone, assigned to its nearest patrol by road distance
4. Each TSP circuit visits all waypoints exactly once and returns the shortest sequence (exhaustive check for zone size ≤ 6; noted-but-skipped for larger zones)

The verification report appears at the bottom of the trace panel after `pipeline_complete`.

---

## Known Limitations

- **Barangay scope**: Only Quezon City barangays are currently bundled. Other cities require generating new pre-processed network files.
- **Hill Climbing is heuristic**: Placement is not guaranteed globally optimal. The adaptive restart and seeded RNG reduce but do not eliminate local-optima risk.
- **TSP zone cap**: Zones are limited to 12 waypoints (default) for tractability. Incidents above the cap are excluded from routing and shown with grey markers.
- **No offline map tiles**: OSM and CartoDB tiles require internet; CDN scripts (Tailwind, Alpine, GSAP, Leaflet) also require internet. Road network data and the algorithm server are fully local.
- **Single barangay per run**: Multi-barangay joint deployment planning is not supported.
