# PatrolPoint V2 Technical Documentation

**Version:** 2.0.0
**Stack:** Node.js + Express, WebSocket, vanilla JavaScript, Leaflet.js
**Deployment:** Render (live server), Supabase-ready (deferred), 358 barangays via local GeoJSON files

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture](#2-architecture)
3. [Project Structure](#3-project-structure)
4. [Dependencies and Stack](#4-dependencies-and-stack)
5. [Server Entry Point](#5-server-entry-point)
6. [Road Network Data Layer](#6-road-network-data-layer)
7. [WebSocket Protocol](#7-websocket-protocol)
8. [Pipeline Orchestrator](#8-pipeline-orchestrator)
9. [Algorithm Deep Dive](#9-algorithm-deep-dive)
   - [9.1 Dijkstra and Haversine (dijkstra.js)](#91-dijkstra-and-haversine-dijkstrajs)
   - [9.2 Stage 1: Brute Force Convex Hull (convexHull.js)](#92-stage-1-brute-force-convex-hull-convexhulljs)
   - [9.3 Stage 2: Hill Climbing (hillClimbing.js)](#93-stage-2-hill-climbing-hillclimbingjs)
   - [9.4 Stage 3: Zone Assignment (zoneAssignment.js)](#94-stage-3-zone-assignment-zoneassignmentjs)
   - [9.5 Stage 4: Backtracking TSP (tsp.js)](#95-stage-4-backtracking-tsp-tspjs)
   - [9.6 Post-Pipeline Verifier (verifier.js)](#96-post-pipeline-verifier-verifierjs)
10. [Middleware](#10-middleware)
11. [Frontend Architecture](#11-frontend-architecture)
    - [11.1 main.js](#111-mainjs)
    - [11.2 websocket-client.js](#112-websocket-clientjs)
    - [11.3 map.js](#113-mapjs)
    - [11.4 ui.js](#114-uijs)
12. [Configuration System](#12-configuration-system)
13. [Data Flow: Full Pipeline Run](#13-data-flow-full-pipeline-run)
14. [Error Handling and Edge Cases](#14-error-handling-and-edge-cases)
15. [Local Development Setup](#15-local-development-setup)

---

## 1. System Overview

PatrolPoint V2 is a full-stack patrol deployment optimization system for barangay-level law enforcement (tanod units) in Quezon City, Philippines. The user plots crime incident coordinates on a Leaflet map, sets a patrol count, selects a deployment mode, and clicks Recalculate. The server runs a four-stage algorithm pipeline and pushes real-time results back to the browser via WebSocket.

**Deployment modes:**

- **Stationary:** Runs Stages 1, 2, and 3. Places n patrols at optimal positions and assigns each patrol a zone of responsibility. No routes computed.
- **Roaming:** Runs all four stages. Adds Stage 4 (TSP) to generate closed-loop patrol circuits that follow actual road paths.

**Key properties:**

- All algorithm computation happens on the server. The browser only renders results.
- Road network data is loaded from pre-processed local GeoJSON files at startup, not fetched live from Overpass API (DEMO_MODE is the production baseline).
- 358 Quezon City barangays are supported via a manifest file and per-barangay network JSON.
- The same incident set always produces the same result (deterministic via FNV-1a seeded PRNG in Hill Climbing).

---

## 2. Architecture

```
Browser (Leaflet + Alpine.js + vanilla JS)
         |
         |  HTTP GET /api/network/:barangay  (summary only)
         |  WebSocket (full pipeline, real-time stage messages)
         |
Express Server (Node.js, port 3000)
         |
         |-- server/websocket/pipelineSocket.js   (WS handler, rate limit, concurrency cap)
         |-- server/services/pipeline.js           (4-stage orchestrator)
         |-- server/algorithms/                    (pure algorithm modules)
         |-- server/services/cache.js              (in-memory network cache)
         |-- server/routes/network.js              (HTTP summary endpoint)
         |
         |-- data/barangays/                       (358 pre-processed network JSON files)
         |-- data/barangays/manifest.json          (name → slug + bbox index)
         |
         |-- client/                              (served as static files by Express)
```

The HTTP server and WebSocket server share the same port via `http.createServer(app)` at `server/index.js:16--18`:

```js
const httpServer = http.createServer(app);
const wss        = new WebSocketServer({ server: httpServer });
```

---

## 3. Project Structure

```
patrolpoint/
├── client/
│   ├── index.html
│   ├── css/custom.css
│   └── js/
│       ├── main.js                 global state, DOMContentLoaded init
│       ├── map.js                  Leaflet map, all rendering
│       ├── ui.js                   Alpine.js component
│       └── websocket-client.js     WS connection, message dispatch, trace panel
├── server/
│   ├── index.js                    Express + WS entry point
│   ├── routes/
│   │   └── network.js              GET /api/network/:barangay
│   ├── algorithms/
│   │   ├── dijkstra.js             Haversine, binary min-heap Dijkstra, path reconstruction
│   │   ├── convexHull.js           Stage 1
│   │   ├── hillClimbing.js         Stage 2
│   │   ├── zoneAssignment.js       Stage 3
│   │   ├── tsp.js                  Stage 4
│   │   └── verifier.js             Post-pipeline correctness checks
│   ├── services/
│   │   ├── cache.js                In-memory network cache + local file loader
│   │   └── pipeline.js             Stage orchestration, CONFIG merge, seed derivation
│   ├── middleware/
│   │   ├── rateLimit.js            express-rate-limit (100 req / 15 min)
│   │   └── sanitize.js             Input validation functions
│   └── websocket/
│       └── pipelineSocket.js       WS handler, concurrency cap, per-connection state
├── data/
│   └── barangays/
│       ├── manifest.json           358-entry index: name → {slug, bbox}
│       ├── commonwealth.json       {nodes[], edges[], boundary[]}
│       └── *.json                  one file per barangay
├── .env.example
├── package.json
└── render.yaml
```

---

## 4. Dependencies and Stack

**package.json** (from `package.json:11--21`):

```json
{
  "type": "module",
  "dependencies": {
    "express":           "^4.18.2",
    "ws":                "^8.14.2",
    "cors":              "^2.8.5",
    "express-rate-limit":"^7.1.5",
    "dotenv":            "^16.3.1"
  },
  "devDependencies": {
    "playwright": "^1.60.0"
  }
}
```

The project uses ES modules (`"type": "module"`). All server-side `import`/`export` statements are native ESM, not CommonJS.

**Frontend CDN libraries (loaded in index.html):**

- Leaflet.js -- map rendering, click events, marker management
- Leaflet.markercluster -- patrol marker clustering at low zoom
- Leaflet.polylineDecorator -- direction arrows on routes
- Alpine.js -- lightweight reactivity for UI controls, modals, trace panel
- Tailwind CSS -- utility-first styling (dark mode via `class` strategy)

**Environment variables** (from `.env.example`):

```
NODE_ENV=development
PORT=3000
```

No `DATABASE_URL` or `JWT_SECRET` are required in the current DEMO_MODE baseline. The database and auth layers are deferred.

---

## 5. Server Entry Point

File: `server/index.js`

```
Initialization order (server/index.js:1-53):
1. Load dotenv
2. Create Express app
3. Create HTTP server from Express app
4. Create WebSocket server attached to HTTP server (shared port)
5. Apply cors(), express.json({ limit: '1mb' }), express.static('client')
6. Serve /data directory for barangay JSON files
7. Serve /tests directory in non-production (Playwright test runner)
8. Apply apiLimiter to /api routes
9. Mount GET /health endpoint (returns { status:'ok', version:'2.0' })
10. Mount /api/network router
11. Catch-all route: serve client/index.html for all non-API GETs
12. Bind WebSocket connections to handlePipelineConnection
13. Listen on PORT (default 3000)
```

**CORS policy** (`server/index.js:20-24`):

```js
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? /\.onrender\.com$/
        : '*'
}));
```

Production restricts origins to `*.onrender.com`. Development accepts all.

---

## 6. Road Network Data Layer

### 6.1 Local File Format

Each barangay network file (e.g. `data/barangays/commonwealth.json`) contains:

```json
{
  "nodes": [{ "id": "n0", "lat": 14.7028, "lng": 121.0944 }, ...],
  "edges": [{ "from": "n0", "to": "n1", "weight": 45.3 }, ...],
  "boundary": [{ "lat": 14.695, "lng": 121.080 }, ...]
}
```

- `nodes`: all road graph nodes. Commonwealth has **3,593 nodes**.
- `edges`: undirected edges. Commonwealth has **4,091 edges**. `weight` is Haversine distance in meters.
- `boundary`: ordered polygon vertices (161 points for Commonwealth) used to render the darkening mask.

### 6.2 Manifest

`data/barangays/manifest.json` maps 358 barangay names to their file slug and bounding box:

```json
{
  "Commonwealth": { "slug": "commonwealth", "bbox": { "south": ..., "west": ..., "north": ..., "east": ... } },
  ...
}
```

### 6.3 Cache Service (server/services/cache.js)

`getOrFetchNetwork(barangayName)` is the single entry point for all network access.

**Layer 1 -- In-memory cache** (`cache.js:81-83`):
```js
if (networkCache[barangayName]) {
    return { ...networkCache[barangayName], fromCache: true };
}
```
Once loaded, a network stays in process memory for the server lifetime. Subsequent requests are O(1).

**Layer 2 -- Local file** (`cache.js:86-93`):
Reads the per-barangay JSON, reconstructs the adjacency list and intersection node set, computes bbox from node coordinates, and stores in `networkCache`.

```js
// Adjacency list reconstruction (cache.js:43-47):
for (const edge of raw.edges) {
    adjacencyList[edge.from].push({ neighborId: edge.to,   weight: edge.weight });
    adjacencyList[edge.to  ].push({ neighborId: edge.from, weight: edge.weight });
}
```

**Intersection node detection** (`cache.js:49`):
```js
const intersectionNodeIds = Object.keys(degree).filter(id => degree[id] >= 3);
```
A node is an intersection if three or more edges connect to it.

**Layer 3 -- Error**: if no manifest entry exists, the function throws with a message directing the developer to run `scripts/preprocess_barangays.py`.

### 6.4 Network Route (server/routes/network.js)

`GET /api/network/:barangay` returns a summary (no full nodes/edges -- those are too large for HTTP):

```json
{
  "barangay": "Commonwealth",
  "nodeCount": 3593,
  "edgeCount": 4091,
  "intersectionCount": 914,
  "bbox": { "south": ..., "west": ..., "north": ..., "east": ... },
  "boundary": [...],
  "fromCache": true
}
```

The full node map and adjacency list are kept server-side and accessed during pipeline execution.

---

## 7. WebSocket Protocol

### 7.1 Message Definitions

All messages are JSON objects with a `type` field and optional `data` field.

**Client to Server:**

| Type | Payload | Description |
|------|---------|-------------|
| `init` | `{ barangay }` | Load network and return boundary polygon |
| `compute` | `{ incidents, n, mode, config, barangay, removedNodes }` | Trigger pipeline |
| `ping` | (none) | Keepalive |
| `cancel` | (none) | Abort running pipeline |

**Server to Client:**

| Type | Payload | Trigger |
|------|---------|---------|
| `connected` | (none) | On WebSocket handshake |
| `network_loaded` | `{ barangay, nodeCount, edgeCount, intersectionCount, fromCache, boundaryPolygon }` | After `init` or `compute` loads network |
| `pipeline_start` | `{ totalStages, mode }` | Before Stage 1 |
| `stage_start` | `{ stage, name }` | Before each stage |
| `stage_progress` | `{ stage, restart?, iteration?, patrolPositions?, bestMinDist? }` | During Hill Climbing (Stage 2) |
| `stage_complete` | `{ stage, result, trace, runtimeMs }` | After each stage |
| `warning` | `{ stage, message }` | Non-fatal warnings mid-pipeline |
| `error` | `{ stage?, message, fatal }` | Validation or algorithm failure |
| `pipeline_complete` | `{ hull, patrols, zones, routes, trace, totalRuntimeMs, verificationReport }` | All stages done |
| `pong` | (none) | Response to `ping` |

### 7.2 Connection Handler (server/websocket/pipelineSocket.js)

**Per-connection state** is attached directly to the `ws` object (`pipelineSocket.js:87-89`):

```js
ws.cancelled        = false;
ws.pipelineRunning  = false;
ws.previousState    = {};   // { hull, validCandidates, incidents, hullAreaM2 }
```

`ws.previousState` enables incremental hull optimization: if all new incidents fall inside the previous hull, Stage 1 skips recomputation.

**Concurrency cap** (`pipelineSocket.js:34-36`):
```js
let activePipelines = 0;
const MAX_CONCURRENT_PIPELINES = 3;
```
A fourth concurrent compute request is rejected immediately with an informative error explaining how to run locally.

**WebSocket rate limiter** (`pipelineSocket.js:40-59`):
20 compute requests per 5-minute window per IP. Localhost is exempt in development so automated test suites are not blocked.

**`pushToClient` helper** (`pipelineSocket.js:63-74`):
```js
function pushToClient(ws, message) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        ws.cancelled = true;
    }
}
```
Sets `ws.cancelled = true` if the connection closed mid-pipeline, which short-circuits the remaining stages.

### 7.3 Compute Flow (handleCompute)

```
handleCompute (pipelineSocket.js:174-288):
1. Check activePipelines < MAX_CONCURRENT_PIPELINES
2. Increment activePipelines, set ws.pipelineRunning = true
3. Check WebSocket rate limit for this IP
4. Validate all inputs via sanitize.js (throws on invalid)
5. Load road network via getOrFetchNetwork(barangay)
6. Push network_loaded to client
7. Push pipeline_start to client
8. Call runPipeline(networkData, data, pushMessage, isCancelled, ws.previousState)
9. Store returned previousState on ws for next run
10. Decrement activePipelines in finally block
```

---

## 8. Pipeline Orchestrator

File: `server/services/pipeline.js`

`runPipeline` is a single async function that sequences all four stages. It owns the CONFIG merge, the seed derivation, the road distance matrix precomputation, and the shared Dijkstra cache.

### 8.1 CONFIG Merge

Default values live in `pipeline.js:38-63`:

```js
export const DEFAULT_CONFIG = {
    hillClimbing:   { restarts: 100, maxIterations: 1000, radiusMultiplier: 2, synchronousMode: false },
    convexHull:     { areaThresholdDivisor: 100, outlierMultiplier: 2.5, collinearityEpsilon: 1e-10, includeOutliers: true },
    tsp:            { maxCrimeNodesPerZone: 12, nearestNeighborFallbackThreshold: 12, hullExteriorPenalty: 1 },
    zoneAssignment: { strongRebalancing: false },
    snapping:       { boundingBoxEpsilon: 1e-7, initialSearchRadiusMeters: 500 }
};
```

`mergeConfig(userConfig)` performs a shallow spread per section (`pipeline.js:66-75`), so a user can override individual keys without replacing the entire section.

### 8.2 Deterministic Seed

`deriveHCSeed(incidents)` at `pipeline.js:18-28` produces a 32-bit FNV-1a hash from all incident coordinates, sorted by lat then lng before hashing. The sort ensures add-order independence. Same incident set always produces the same seed, and thus the same Hill Climbing result.

### 8.3 Candidate Node Selection

Two modes are controlled by `config.candidateNodes` (`pipeline.js:143-166`):

- `'all'` (default): all road nodes are eligible for patrol placement. For Commonwealth this is 3,593 nodes.
- `'intersection'`: only nodes with degree >= 3 (914 nodes in Commonwealth).

Snap candidates for crime node assignment always use all nodes regardless of the patrol placement toggle, ensuring snapping accuracy is never degraded by that setting.

### 8.4 Road Distance Matrix

Precomputed once before Stage 2 (`pipeline.js:287-289`):

```js
const roadDistMatrix = buildRoadDistMatrix(validCandidates, networkData.adjacencyList);
```

This runs Dijkstra once per valid candidate (nodes inside the hull) against the full road graph and produces a square matrix of road distances. It is passed to Stage 2 (Hill Climbing neighbor evaluation) and is separate from the `dijkstraCache` shared between Stages 3 and 4.

### 8.5 Event Loop Yield

Between every stage (`pipeline.js:87-89`):

```js
function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}
```

Called after each `stage_complete` push so the Node.js event loop can flush the WebSocket send buffer before the next stage begins. Without this, Stage 2 might start before the Stage 1 result arrives at the browser.

### 8.6 Cancellation Checks

`isCancelled()` is checked at the start of each stage. If the WebSocket closed or the client sent `cancel`, the pipeline aborts and returns `{ previousState }` without error.

---

## 9. Algorithm Deep Dive

All algorithm files are pure ES modules with zero side effects. They receive data, compute, and return structured result objects. They never touch the network, database, or WebSocket directly.

### 9.1 Dijkstra and Haversine (dijkstra.js)

This file is the canonical source for all distance computation. Every other algorithm file imports from it and never reimplements inline.

#### Haversine Distance

`haversineDistance(lat1, lng1, lat2, lng2)` at `dijkstra.js:8-16`:

```js
export function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;  // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}
```

Returns meters. Parameter order is always `lat1, lng1, lat2, lng2`.

#### Binary Min-Heap

`MinHeap` at `dijkstra.js:21-97` is a binary min-heap with a `position` map for O(1) index lookup, enabling O(log n) `decreaseKey`. Without the position map, `decreaseKey` would require O(n) linear scan, degrading the overall Dijkstra complexity from O((V+E) log V) to O(V^2 + E).

Key methods:

- `insert(nodeId, priority)` -- sifts up from the tail. O(log n).
- `extractMin()` -- swaps root with tail, deletes tail, sifts down from root. O(log n).
- `decreaseKey(nodeId, newPriority)` -- uses `position[nodeId]` for O(1) index lookup, then sifts up. O(log n).

#### Core Dijkstra Function

`dijkstra(sourceId, adjacencyList, nodeMap, hull, exteriorPenalty, removedNodes)` at `dijkstra.js:129-184`:

```
1. Initialize distances[nodeId] = Infinity for all nodes.
2. Set distances[sourceId] = 0.
3. Insert sourceId into MinHeap with priority 0.
4. Loop:
   a. extractMin → current node
   b. If current distance is Infinity, remaining graph is disconnected -- break
   c. For each neighbor:
      - Skip if in removedNodes set
      - Compute edge weight w (apply exteriorPenalty multiplier if hull penalty is active
        and edge midpoint falls outside the hull)
      - If distances[current] + w < distances[neighbor]:
          Update distances[neighbor], set parents[neighbor] = current
          decreaseKey if already in heap, else insert
5. Return { distances, parents }
```

**Hull exterior penalty**: when `hullExteriorPenalty > 1` and a hull is provided, each edge's midpoint is tested with Ray Casting. If the midpoint is outside the hull, the edge weight is multiplied by the penalty factor, discouraging routes that leave the danger zone (`dijkstra.js:158-168`).

**removedNodes**: a `Set<string>` of node IDs excluded from a particular run (e.g., a node the user blocked). When active, Dijkstra always recomputes from scratch -- never reads from cache -- because the topology differs from the base graph (`dijkstra.js:259`).

#### Path Reconstruction

`reconstructPath(sourceId, destId, parents)` at `dijkstra.js:190-207`:

Follows `parents` pointers from `destId` back to `sourceId`, then reverses. Returns `[sourceId, ..., destId]` or `null` if unreachable.

#### All-Pairs Road Distance Matrix

`buildRoadDistMatrix(candidates, adjacencyList)` at `dijkstra.js:224-236`:

Runs Dijkstra once per candidate (single-source gives distances to all other nodes in one pass). Produces a square matrix `matrix[srcId][dstId]`. Used exclusively by Stage 2 Hill Climbing. For 914 intersection candidates the matrix is approximately 914 x 914 x 8 bytes = ~6.7 MB.

#### Cached Dijkstra Runner

`runDijkstra(sourceId, adjacencyList, dijkstraCache, nodeMap, hull, exteriorPenalty, removedNodes)` at `dijkstra.js:254-265`:

The public entry point for Stages 3 and 4. Checks `dijkstraCache[sourceId]` first. On cache miss, runs the core `dijkstra` function and stores the result. The cache persists for the entire pipeline run lifetime, so Stage 4 benefits from every Dijkstra call Stage 3 already made.

#### Normalized Cache Key

`normalizedCacheKey(idA, idB)` at `dijkstra.js:212-216`:

Extracts the numeric part of each node ID (format `nNNN`), sorts numerically, and joins with `|`. This ensures `n89|n234` regardless of call order, enabling overlap detection in Stage 4.

---

### 9.2 Stage 1: Brute Force Convex Hull (convexHull.js)

**Input:** `incidents` (array of `{lat, lng}`), `n` (patrol count), `config`, `networkData` (`{ nodeMap, barangayAreaM2 }`), `options` (`{ previousHull, previousValidCandidates, previousIncidents, pushProgress }`)

**Output:** `{ status, message, warnings, data: { hull, hullAreaM2, validCandidates, outlierIndices, linearHandler, rayCastStats, skipped, traceLog } }`

#### Step 0: Incremental Hull Update (V2)

Before any computation, checks whether the result from the last pipeline run can be reused (`convexHull.js:176-277`):

```
IF previousHull exists AND previousValidCandidates exists:
  IF previousIncidents provided:
    newPoints = incidents not in previousIncidents (by proximity within eps)
    IF newPoints is empty AND no incidents removed:
      Return previousHull unchanged  (identical incident set)
    IF all newPoints are inside previousHull (Ray Casting):
      Return previousHull unchanged  (new incidents fit inside existing zone)
    ELSE: fall through to full recomputation
  ELSE (no previousIncidents):
    IF ALL current incidents inside previousHull: return unchanged (conservative)
    ELSE: fall through
```

This optimization avoids O(n^3) hull recomputation when the user adds an incident that clearly lies inside the existing danger zone.

#### Step 1: Outlier Detection

When `config.convexHull.includeOutliers === false` and there are >= 3 incidents, points further than `outlierMultiplier * avgDist` from the centroid are flagged (`convexHull.js:284-329`). Default `outlierMultiplier` is 2.5. Outlier indices are tracked separately so the frontend can render them distinctly without removing them from the map.

#### Step 2: Validity Check

If fewer than 3 non-outlier points remain, or exactly 2 remain, the linear handler is triggered.

#### Step 3: Collinearity Check -- O(n)

Fix points A = `filtered[0]` and B = `filtered[1]`. For each remaining point C, compute the cross product `k = (B.lng - A.lng)(C.lat - A.lat) - (B.lat - A.lat)(C.lng - A.lng)`. If `|k| < collinearityEpsilon` for all C, all points are collinear (`convexHull.js:349-365`).

**Shoelace convention**: throughout `convexHull.js`, `x = lng` and `y = lat`. This is consistent across all cross product and area calculations.

#### Step 4: Brute Force Convex Hull -- O(n^3)

For each ordered directed pair `(pi, pj)`, test every other point `pk` (`convexHull.js:374-389`):

```js
const d = (pj.lng - pi.lng) * (pk.lat - pi.lat) -
           (pj.lat - pi.lat) * (pk.lng - pi.lng);
if (d < 0) { valid = false; break; }
```

`d > 0` means `pk` is to the left of the directed edge `pi -> pj` (CCW). A directed edge is valid (belongs to the hull) if and only if all other points have `d >= 0`. The condition `d = 0` (point on the edge line) is allowed.

Time complexity: O(n^2) pairs, O(n) check per pair = O(n^3). This is acceptable because `n` (incident count) is typically under 30.

#### Step 5: Edge Ordering

Collected valid edges are chained into a polygon by matching `to` of one edge to `from` of the next (`convexHull.js:406-437`). If no connecting edge is found (topologically broken hull), returns an error.

#### Step 6: Shoelace Area and Winding Normalization

Signed area via Shoelace formula (`convexHull.js:444-463`):

```js
signedArea += curr.lng * next.lat - next.lng * curr.lat;
signedArea /= 2;
```

Positive signed area means CCW winding (correct). Negative means CW -- the hull is reversed. All Ray Casting logic assumes CCW winding consistently.

The physical area is computed in m^2 using a dynamic longitude scale factor at the hull centroid latitude (`convexHull.js:492-494`):

```js
const lngScale   = 111000 * Math.cos(centroidLat * Math.PI / 180);
const hullAreaM2 = hullAreaDeg * 111000 * lngScale;
```

This is a flat-plane Shoelace approximation with less than 1% error at barangay scale.

#### Step 7: Ray Casting Pre-filter

`runRayCastPreFilter(hull, nodeMap, eps)` at `convexHull.js:61-90`:

Iterates every node in `nodeMap`. First applies a bounding box pre-filter (expands by `eps = 1e-7` to avoid boundary float issues). Nodes passing the bbox check are tested with full Ray Casting. The output is `validCandidates`: all road nodes inside the hull.

A hull-candidate cache (`hullCache`) is checked first. If hull vertices match (within `collinearityEpsilon`), the cached candidates are reused without re-running Ray Casting (`convexHull.js:505-529`).

#### Linear Handler

`makeLinearResult` / `computeLinearPositions` at `convexHull.js:96-143`:

When the linear handler triggers (2 points, all collinear, or fewer than 3 valid hull edges), patrols are placed along the incident line using evenly-spaced positions:

```
position_k = k / (n + 1)  for k = 1..n
```

Dividing by `n+1` ensures equal buffer on both endpoints. The pipeline terminates after Stage 1 when the linear handler fires -- no Hill Climbing or zone assignment is run.

#### Ray Casting

`rayCast(point, hull)` at `convexHull.js:17-29`:

Casts a ray in the `+lng` direction (rightward) from `point`. Counts edge crossings. Odd count = inside. The exported `isPointInHull(point, hull, eps)` adds a bounding box pre-filter before invoking Ray Casting.

---

### 9.3 Stage 2: Hill Climbing (hillClimbing.js)

**Input:** `validCandidates` (nodes inside hull), `n`, `hullAreaM2`, `config`, `options` (`{ seed, pushProgress, roadDistMatrix }`)

**Output:** `{ status, message, warnings, data: { patrols, bestMinPairwiseDist, bestRestart, restartsCompleted, confidence, bestSoFarCurve, convergenceRestart, redundancy, traceLog } }`

**Objective:** place n patrols at distinct road intersection nodes inside the hull to maximize the minimum pairwise distance between any two patrols.

#### PRNG (mulberry32)

`mulberry32(seed)` at `hillClimbing.js:17-24`:

A Vigna 2017 seedable PRNG returning floats in `[0, 1)`. Each restart gets a unique sub-seed: `(masterSeed XOR (restartIdx * 2654435761)) >>> 0`. This ensures determinism while each restart explores a different region of the search space.

#### Special Cases

**n = 1** (`hillClimbing.js:164-200`): Hill Climbing is skipped. The most central valid candidate is found by minimizing average road distance to all other candidates. Confidence is 100.

**n > validCandidates.length** (`hillClimbing.js:203-222`): n is capped to `validCandidates.length` and a warning is emitted.

#### Search Radius R

```js
const baseR = Math.sqrt(hullAreaM2 / validCandidates.length) * config.hillClimbing.radiusMultiplier;
```

R represents the maximum road distance a patrol can move per iteration. It is derived from the average area per candidate node, scaled by `radiusMultiplier` (default 2). If all patrols have no neighbors within R, R expands by 50% (`hillClimbing.js:412-417`).

#### Restart Budget

`maxRestarts = config.hillClimbing.restarts * effectiveN` (`hillClimbing.js:230`).

With default `restarts = 100` and n = 3, this gives 300 maximum restarts. The minimum is `max(5, n)`. Each restart begins from a fresh random configuration via Fisher-Yates shuffle of `validCandidates`.

#### Asynchronous Mode (default)

Each iteration processes patrols in a shuffled order. Each patrol sees the moves applied by earlier patrols in the same iteration. For each patrol `si` at index `idx` (`hillClimbing.js:356-408`):

```
1. Find all unoccupied validCandidates within road distance R of si (findNeighbors)
2. Precompute minPairwiseExcluding(si): min pairwise dist over all pairs not involving si
3. For each neighbor v:
   - Compute min distance from v to all other patrols (O(n))
   - newGlobalMin = min(minExclSi, minFromV)
   - If newGlobalMin > currentBestMin: save as bestNeighbor
4. If bestNeighbor found: move si to bestNeighbor
```

`minPairwiseExcluding` at `hillClimbing.js:62-76` is precomputed once per patrol per iteration so the per-neighbor evaluation is O(n) instead of O(n^2).

`findNeighbors` at `hillClimbing.js:82-113` uses `roadDistMatrix` for O(1) distance lookup per candidate (no bbox pre-filter needed).

#### Synchronous Mode

When `config.hillClimbing.synchronousMode === true` (`hillClimbing.js:285-338`):

```
Phase 1: compute proposed moves for ALL patrols using the current (old) positions.
         No patrol sees another patrol's movement during this phase.
Phase 2: apply all non-conflicting moves simultaneously.
         Conflict: two patrols propose the same target node.
         Resolution: first patrol in the shuffled order claims the node; others skip.
```

This is mathematically different from asynchronous mode because no patrol receives information about other patrols' moves until the next iteration.

#### Adaptive Convergence (V2)

After each restart, once `allRestartResults.length >= minRestarts` (`hillClimbing.js:478-491`):

```
last3 = last 3 restart minDist values
if max(last3) > 0 AND (max(last3) - min(last3)) / max(last3) < 0.001:
    break  // converged: spread < 0.1%
```

This prevents unnecessary restarts when the algorithm has clearly found a stable solution.

#### Confidence Indicator (V2)

After all restarts complete (`hillClimbing.js:541-554`):

```
mean     = average of all restart minDist scores
stdDev   = sqrt(variance across restart scores)
consistency   = max(0, min(100, (1 - stdDev / mean) * 100))
redundancy    = % of restarts that confirmed best without improving
confidence    = 0.5 * consistency + 0.5 * redundancy
```

The composite formula combines two independent signals:
- **Consistency** (50%): how tightly clustered are results across restarts? Low coefficient of variation = high consistency.
- **Confirmation** (50%): what fraction of restarts confirmed the best answer without beating it? High redundancy means the solution is stable.

#### Convergence Curve

`bestSoFarCurve` is a monotonically non-decreasing array where `bestSoFarCurve[i]` is the best `minDist` seen through restart i (`hillClimbing.js:513-526`). The frontend renders this as a bar chart in the trace panel.

`convergenceRestart` is the last restart index (1-based) at which the best result improved. `redundancy` is derived from it.

---

### 9.4 Stage 3: Zone Assignment (zoneAssignment.js)

**Input:** `incidents`, `patrols` (Stage 2 output), `validCandidates`, `hull`, `adjacencyList`, `dijkstraCache` (shared with Stage 4), `config`, `options` (`{ bestRestartIndex, removedNodes, snapCandidates }`)

**Output:** `{ status, message, warnings, data: { zones, emptyZones, singleNodeZones, multiNodeZones, excludedCrimeNodes, avgSnappingDist, maxSnappingDist, distanceMatrix, traceLog } }`

#### Step 1: Silent Snapping

Each crime node is snapped to the nearest road intersection inside the hull. Snapping is "silent" -- the user's plotted marker stays at the clicked position; the snap target is invisible and only used for routing (`zoneAssignment.js:35-60`).

`snapToNearestCandidate` uses a bbox pre-filter then Haversine confirmation. The search radius starts at `config.snapping.initialSearchRadiusMeters` (500m) and expands by 50% on each miss up to `hullDiameterM`. A crime node with no intersection within the hull diameter is excluded.

`snapCandidates` (passed from `pipeline.js`) always uses all road nodes, not just intersection nodes, ensuring snap accuracy even when the patrol placement toggle is set to `'intersection'`.

#### Step 2: Deduplication

Two crime nodes that snap to the same road node are merged -- only the first is kept. The visual markers for both remain on the map. A warning is emitted for each merge (`zoneAssignment.js:299-315`).

#### Step 3: Dijkstra Pre-computation (V2)

For each unique snapped node ID, runs `runDijkstra(snappedNodeId, adjacencyList, dijkstraCache)`. A single Dijkstra run from a source node gives distances to all graph nodes simultaneously, so m unique snapped positions require only m Dijkstra calls (`zoneAssignment.js:320-339`).

The result is `distanceMatrix[snappedNodeId][patrolIndex]` = road distance from that crime node to each patrol's position. This is used for both zone assignment and rebalancing.

`dijkstraCache` is mutated in-place. Stage 4 reuses every result Stage 3 computed, typically achieving high cache hit rates.

#### Step 4: Zone Assignment

Each crime node is assigned to the patrol with minimum road network distance (`zoneAssignment.js:348-384`). Tiebreaker: lower patrol index wins (strict `<`).

**Euclidean fallback**: if all road distances to all patrols are `Infinity` (disconnected graph segment), Haversine straight-line distance is used and a warning is emitted. A `haversineFallback: true` flag is stored on the crime node.

#### Zero Distance Waypoints

Checked post-assignment (`zoneAssignment.js:391-398`). When a crime node's snapped position equals the assigned patrol's node, the road distance is 0. This is valid but noted in the trace log.

#### Step 5: Zone Rebalancing

Two modes, selected by `config.zoneAssignment.strongRebalancing`:

**Light rebalancing** (default, `zoneAssignment.js:67-122`):

```
WHILE iterations < 10:
  Find largest and smallest non-empty zones
  IF largest > 2 * mean AND smallest < 0.5 * mean:
    Find "boundary" crime nodes in largest zone:
      A boundary node has |dToLargest - dToSmallest| / max(d) < 10%
    Move the closest boundary node (by dToSmallest) to smallest zone
    IF new_largest <= 1.5 * mean: break
  ELSE: break
```

**Strong rebalancing** (opt-in, `zoneAssignment.js:130-186`):

Forces all non-empty zones to within `[floor(target), ceil(target)]` nodes. At each step picks the node in any overloaded zone with minimum road distance to any underloaded patrol.

#### Step 6: Zone Cap

Hard limit of `config.tsp.maxCrimeNodesPerZone` (default 12) per zone. Nodes exceeding the cap are sorted by road distance to their patrol (nearest kept), and the rest are added to `excludedCrimeNodes` with `reason: 'zone_cap'` (`zoneAssignment.js:419-438`).

#### Step 7: Zone Classification

Each patrol's zone is classified (`zoneAssignment.js:444-464`):

- **Empty**: 0 nodes. Patrol remains stationary.
- **Single-node**: 1 node. Patrol makes a direct out-and-back visit in Stage 4.
- **Multi-node**: 2+ nodes. Proceeds to TSP in Stage 4.

---

### 9.5 Stage 4: Backtracking TSP (tsp.js)

**Input:** `zones`, `patrols`, `multiNodeZones`, `singleNodeZones`, `nodeMap`, `adjacencyList`, `dijkstraCache`, `config`, `hull`, `options` (`{ pushProgress, removedNodes }`)

**Output:** `{ status, message, warnings, data: { routes, overlapEdges, totalDijkstraCalls, totalCacheHits, totalSequenceAdjustments, algorithmBreakdown, traceLog } }`

#### Hull Exterior Penalty

When `config.tsp.hullExteriorPenalty > 1`, Dijkstra calls in Stage 4 use a fresh local cache (not the shared `dijkstraCache`) with the penalty applied (`tsp.js:129-133`):

```js
const penaltyActive  = exteriorPenalty > 1 && hull && hull.length >= 3;
const effectiveCache = penaltyActive ? {} : dijkstraCache;
```

Penalized distances must not overwrite unpenalized distances in the shared cache, as that would corrupt Stage 3's Dijkstra results.

#### Distance Matrix Construction

For each patrol, `buildDistanceMatrix([sId, ...crimeNodeIds])` runs `trackedDijkstra(sourceId)` for each unique source (`tsp.js:159-169`). Single-source Dijkstra gives distances to all other nodes in one pass, so k crime nodes + 1 patrol start requires k+1 Dijkstra calls total. Cache hits from Stage 3 are automatically reused.

#### Algorithm Selection

For each multi-node zone with k reachable crime nodes (`tsp.js:360-399`):

| Condition | Algorithm | Complexity |
|-----------|-----------|------------|
| k = 2 | k=2 shortcut | O(1): both orders have identical distance on undirected graph |
| k > `nearestNeighborFallbackThreshold` (default 12) | Nearest neighbor heuristic | O(k^2): greedy, approximate |
| Otherwise | Backtracking TSP | O(k!): exact with branch-and-bound pruning |

**Backtracking TSP** at `tsp.js:46-78`:

```
backtrack(current, accumulated, visited, route):
  IF accumulated >= bestCircuit: prune (cannot improve)
  IF all k visited:
    total = accumulated + D[current][start]
    IF total < bestCircuit: update bestCircuit and optimalSequence
    return
  FOR each unvisited crimeNode:
    IF D[current][crimeNode] == Infinity: skip (unreachable)
    backtrack(crimeNode, accumulated + D[current][crimeNode], visited+crimeNode, route+crimeNode)
```

The prune condition `accumulated >= bestCircuit` eliminates branches whose current cost already exceeds the best complete circuit found so far. In practice, this dramatically reduces the effective search space below k!.

**Nearest neighbor heuristic** at `tsp.js:19-41`:

Greedy: always visit the nearest unvisited crime node from the current position. O(k^2). Not guaranteed optimal.

#### Path-Aware Sequence Adjustment

After TSP/nearest-neighbor produces a visit sequence, `adjustSequence` at `tsp.js:217-257` scans each Dijkstra path leg for intermediate nodes that are also crime nodes in the same zone:

```
WHILE any adjustment made this pass:
  FOR each consecutive pair (from, to) in circuit:
    path = Dijkstra path from -> to
    IF any intermediate node mid on path is a crime node scheduled LATER:
      Move mid to immediately after from in the sequence
      Increment adjustmentsMade
```

This eliminates redundant backtracking: if the road path from A to B naturally passes through C, visiting C at that point is free rather than requiring a later detour.

#### Path Segments

Every route includes `pathSegments`: an array of `[{lat, lng}]` arrays, one per leg of the circuit, produced by `processLeg(fromId, toId)` at `tsp.js:194-211`. These are the actual road-following coordinates for the frontend to draw polylines along real roads.

#### Single-Node Zones

`si -> c1 -> si` with two Dijkstra calls (`si -> c1` outbound, `c1 -> si` return). The return leg is always included explicitly and is never omitted (`tsp.js:261-314`).

#### Overlap Detection

`edgeUsage` is a `Map<edgeKey, Set<patrolId>>` accumulated across all `processLeg` calls (`tsp.js:204-208`). After all routes are built, edges shared by 2+ distinct patrols are reported as `overlapEdges`. A per-patrol `Set` prevents a single patrol traversing the same edge twice from being counted as overlap.

---

### 9.6 Post-Pipeline Verifier (verifier.js)

`verifyAll(pipelineResult)` at `verifier.js:312-386` orchestrates four independent checks after all stages complete. The verifier is non-fatal: if it throws internally, the pipeline still returns results.

#### verifyConvexHull

For each non-outlier incident, runs `isPointInHull(inc, hull)`. Returns `pass: false` if any incident is outside the hull (`verifier.js:47-66`).

#### verifyPatrolPositions

Three checks (`verifier.js:70-115`):
1. All patrols inside hull (Ray Casting).
2. All patrol node IDs unique.
3. All patrol node IDs members of `validCandidates`.

#### verifyZoneAssignment

Three checks (`verifier.js:124-200`):
1. No crime node appears in more than one zone.
2. Every non-outlier incident is either in a zone or in `excludedCrimeNodes` (no silent drops from Stage 3).
3. Each assigned crime node is within 10% of the nearest patrol's road distance (10% tolerance allows for zone rebalancing intentional deviations).

#### verifyTSPRoute

Per-route checks (`verifier.js:213-287`):
1. Sequence contains exactly k crime nodes.
2. All k node IDs unique.
3. Recomputed circuit distance matches reported `circuitDistanceM` within 1 meter tolerance.
4. **Exhaustive optimality check** (k <= 6, non-approximate only): enumerates all k! permutations and confirms the returned sequence has minimum total distance.

For k > 6 or approximate routes, the exhaustive check is skipped and noted in the report.

---

## 10. Middleware

### Rate Limiter (server/middleware/rateLimit.js)

```js
export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 100,                    // 100 requests per window per IP
    standardHeaders: true,
    legacyHeaders:   false
});
```

Applied to all `/api` routes. WebSocket compute requests have a separate in-memory rate limiter in `pipelineSocket.js` (20 computes per 5 minutes per IP).

### Input Validation (server/middleware/sanitize.js)

All validation functions throw `Error` with descriptive messages on failure:

| Function | Rules |
|----------|-------|
| `validateIncidents` | Array, 1--300 elements, each `{lat, lng}` finite numbers in valid geographic range |
| `validateN` | Integer, 1--100 |
| `validateMode` | `'stationary'` or `'roaming'` |
| `validateBarangay` | Non-empty string, <= 255 chars, alphanumeric + spaces only |
| `validateConfig` | Per-section range checks on all CONFIG fields |

---

## 11. Frontend Architecture

### 11.1 main.js

Declares all global state on `window` before any other script runs. This is the single source of truth for non-reactive state:

```js
window.P               = [];    // crime node objects { crimeId, lat, lng }
window.crimeIdCounter  = 0;
window.currentHull     = null;
window.S_star          = [];    // Stage 2 output: patrol positions
window.zones           = [];    // Stage 3 output: zone arrays
window.routes          = [];    // Stage 4 output: route objects
window.pipelineRunning = false;
window.removedNodes    = new Set(); // node IDs excluded by user
```

On `DOMContentLoaded` (`main.js:60-79`):
1. Load `darkMode` and `animationsEnabled` from `localStorage`
2. Apply dark mode class immediately (no theme flash)
3. Restore saved auth token
4. Call `initMap()` and `initWebSocket()` if defined

### 11.2 websocket-client.js

The WebSocket client has three responsibilities:

**Connection management** (`websocket-client.js:114-158`):
- Auto-derives `ws://` vs `wss://` from `window.location.protocol`
- Reconnects up to `MAX_RECONNECT = 5` times with a 3-second delay
- Sends a `ping` every 30 seconds via `setInterval`
- On max reconnects exceeded, shows an error banner

**Message dispatch** (`websocket-client.js:162-187`):
Routes each message type to its handler. The switch covers all 10 server-to-client message types.

**Placeholder system** (`websocket-client.js:36-56`):
```js
export let onHullComplete    = (result) => console.log('placeholder');
export function replacePlaceholder(name, fn) { ... }
```
`map.js` calls `replacePlaceholder('onHullComplete', renderHull)` to wire actual rendering. This decouples the WebSocket layer from the map rendering layer.

**Trace panel construction** (`websocket-client.js:569-1351`):

`handleStageComplete` calls four builders for each stage:
- `buildTraceSummary`: one-line status displayed in the collapsed trace card
- `buildTraceMetrics`: array of `{label, value, warn?, tooltip}` for the metrics grid
- `buildStage_Subparts`: step-by-step breakdown of what the algorithm computed
- `buildNarrative`: one-sentence data-driven summary of this specific run

These builders contain all the logic for formatting and contextualizing the server's raw data into human-readable trace panel content.

**sendComputeRequest** (`websocket-client.js:1356-1382`):
Validates inputs client-side then sends:
```js
ws.send(JSON.stringify({
    type: 'compute',
    data: { incidents, n, mode, config, barangay,
            removedNodes: Array.from(window.removedNodes || []) }
}));
```

### 11.3 map.js

#### Constants and Module-Level State

```js
// map.js:8-11
const MAP_CENTER   = [14.7028, 121.0944];
const MAP_ZOOM     = 15;
const MAP_MIN_ZOOM = 10;
const MAP_MAX_ZOOM = 18;  // BUG FIX: V1 used 19, OSM tiles unavailable there
```

Module-level variables track all active Leaflet layers (`map.js:19-53`):

```
mapInitialized        boolean guard (initMap called from both main.js and Alpine init())
lightTileLayer        L.TileLayer (OpenStreetMap standard)
darkTileLayer         L.TileLayer (CartoDB Dark Matter)
currentTileLayer      whichever is active
hullPolygon           L.Polygon
barangayMask          L.Polygon (world rect with boundary hole)
barangayOutline       L.Polyline (dashed boundary outline)
patrolClusterGroup    L.MarkerClusterGroup
patrolMarkerMap       patrolId → { marker, color, num, style, coverageCircle }
zoneLinesList         L.Polyline[]
routePolylines        patrolId → { lines:[], decorators:[] }
overlapOverlayLines   L.Polyline[]
nearestHighlightMarkers  L.CircleMarker[]
crimeMarkerMap        crimeId → L.Marker
osmGraphLayers        L.Layer[] (edges + node circles while graph mode active)
graphNodeMarkers      nodeId → L.CircleMarker (only while graph mode active)
graphNodeEdgeMap      nodeId → [{ line, fromId, toId }] for connected edge style updates
boundaryBounds        L.LatLngBounds (for Reset View fitBounds)
osmNetworkCache       { nodeMap, adjacencyList, intersectionNodeIds } fetched on demand
_lastRoutes           stored for overlap redraw on zoomend and for popup content
_lastPatrols          stored for patrol popup content
_lastZones            stored for patrol popup content
_selectedPatrolId     currently highlighted patrol
_patrolInfoControl    L.Control instance (PatrolInfoPanel, anchored topright)
_crimeStatusMap       crimeId → 'active' | 'outlier' | 'excluded' | 'unreachable'
_crimeAssignmentMap   crimeId → { patrolId, patrolNum, patrolColor, seqIndex, zoneSize }
comparisonLayersA     L.Layer[] for Run A overlay
comparisonLayersB     L.Layer[] for Run B overlay
```

#### Patrol Info Panel (`map.js:70-92`)

`PatrolInfoPanel` extends `L.Control` anchored `topright`. It replaces `L.popup` for patrol detail display. `show(content)` sets innerHTML and wires the close button. `hide()` clears and hides the div. Clicking a patrol marker toggles the panel: same patrol twice closes it, a different patrol switches content.

`_buildPatrolPopupContent(patrolId)` (`map.js:811-865`) reads `_lastZones` and `_lastRoutes` to show: position (lat/lng), circuit distance (if a route exists), crime node count, and a clickable list of assigned crime IDs. Clicking a crime ID calls `window._openCrimePopup(crimeId)`, which pans to that marker and opens its crime popup.

#### Map Initialization (`map.js:95-307`)

`initMap(ui)` is guarded by `mapInitialized = true` on entry. It:

1. Creates the Leaflet map with the constants above.
2. Adds both tile layers and activates the correct one based on `window.darkMode`.
3. Binds `mousemove` to update `#coord-display` with live lat/lng; `mouseout` hides it.
4. Binds `click` to add crime nodes -- validates the barangay boundary via `pointInHull` and checks for coordinate duplicates within `1e-7` degrees before calling `ui.addCrimeNode(lat, lng)`.
5. Binds `zoomend` to re-render the overlap overlay (routes themselves do not need a zoom redraw).
6. Creates `patrolClusterGroup` with `disableClusteringAtZoom: MAP_MIN_ZOOM` (10) and a custom blue cluster icon.
7. Instantiates and adds `_patrolInfoControl`.
8. Exposes three `window.*` handlers for HTML onclick attributes inside crime popup innerHTML: `_crimePopupClose`, `_crimePopupRemove`, `_openCrimePopup`.
9. Fetches `./data/commonwealth_boundary.json` for the initial darkening mask (independent of the WebSocket `network_loaded` boundary).
10. Wires all WebSocket placeholder callbacks via `replacePlaceholder`.

**`onZonesComplete` handler** (`map.js:246-283`) does more than just call `renderZoneLines`. It also builds `_crimeAssignmentMap` from zones/patrols data, marks empty-zone patrols as stationary, refreshes all crime popup content with assignment information, and optionally renders coverage radius circles.

#### Barangay Boundary Darkening (`map.js:310-341`)

Uses a Leaflet polygon with two rings (`map.js:317-324`):

```js
const worldRect = [[-90,-180],[90,-180],[90,180],[-90,180]];
barangayMask = L.polygon([worldRect, boundaryPolygon], {
    fillColor: '#000', fillOpacity: 0.45, stroke: false, interactive: false
}).addTo(map);
```

A dashed outline polyline is drawn on top in `#9ca3af` (light mode) or `#6b7280` (dark mode). The map calls `fitBounds` only on the first render (`boundaryBounds === null`). Subsequent `network_loaded` messages preserve the user's zoom and pan.

#### OSM Graph Mode (`map.js:355-472`)

When enabled, `toggleOsmGraphMode(true)` fetches the current barangay's preprocessed JSON from `./data/barangays/{slug}.json` into `osmNetworkCache` (fetched once, reused on subsequent toggles). The tile layer is removed and replaced with:

- One grey `L.polyline` per undirected edge (deduplicated with a `drawn` Set). Edges incident on any `removedNodes` node render red.
- One `L.circleMarker` per node (radius 3, blue by default). Removed nodes render solid red.

Node markers are clickable. `toggleNodeRemoval(nodeId, marker)` (`map.js:440-453`) adds or removes the node from `window.removedNodes` and immediately updates that marker and all its connected edges via `graphNodeEdgeMap`. A graph-reset button becomes visible when `removedNodes.size > 0`.

When toggled off, all `osmGraphLayers` are removed and the tile layer is restored. Switching barangays sets `osmNetworkCache = null` so the next toggle fetches the new barangay's data.

#### Crime Node Markers (`map.js:545-632`)

`plotCrimeMarker(point)` (`map.js:545-597`) creates a draggable `L.marker` with a `L.divIcon`:

```html
<div class="crime-marker" id="cm-{crimeId}"></div>
<div class="crime-marker-label">{crimeId}</div>
```

The popup is bound lazily via a factory function calling `_buildCrimePopupHtml(crimeId)` (`map.js:501-542`). The popup shows: status, coordinates, and (after Stage 3) the assigned patrol and zone position. All popup buttons use `window.*` global handlers to survive Leaflet innerHTML replacement.

**Drag validation** (`map.js:576-593`): On `dragstart` the pre-drag position is saved. On `dragend`, `pointInHull` tests the new position against `window.currentHull`. Outside the hull: `marker.setLatLng([savedLat, savedLng])` snaps it back with a warning banner. Inside the hull: `ui.dragCrimeNode(crimeId, oldLat, oldLng, newLat, newLng)` updates `window.P` and pushes an undo action.

`updateCrimeMarkerStyle(crimeId, style)` (`map.js:613-623`) adds CSS class `outlier`, `excluded`, or `unreachable` to the `cm-{crimeId}` div and refreshes the popup content.

#### Hull Rendering (`map.js:635-650`)

`renderHull(hullVertices)` creates or updates a single `hullPolygon` via `setLatLngs` on subsequent runs, avoiding layer churn. Style: blue fill at 12% opacity, dashed blue stroke, `interactive: false`.

#### Patrol Markers (`map.js:652-760`)

**Roaming icon** (`_roamingIcon(color, num, confidence)`, `map.js:730-742`):
Circular `L.divIcon` (24x24px) with the patrol number centered. Optionally includes a small colored confidence badge dot: green for confidence >= 80%, yellow for >= 50%, red otherwise.

**Stationary icon** (`_stationaryIcon(color, num)`, `map.js:744-760`):
A downward-pointing teardrop SVG pin (28x36px, `iconAnchor: [14, 36]`) in the patrol color, with the patrol number plus "S" overlaid as text (`nS`).

`renderPatrolMarkers(patrols)` (`map.js:653-692`) adds markers to `patrolClusterGroup`. It also removes stale patrol markers from previous runs. Clicking a patrol marker fires `_onPatrolClick(patrolId)`, which toggles the `PatrolInfoPanel` and calls `highlightPatrolRoute`.

`updatePatrolPositionsInstant(positions)` (`map.js:694-718`) is called on Stage 2 `stage_progress` messages. It moves existing patrol markers instantly via `setLatLng` with no animation.

#### Zone Lines (`map.js:762-786`)

`renderZoneLines(zones, patrols)` draws dashed colored polylines from each patrol position to each of its assigned crime node positions. Respects the `showZoneLines` display config flag. Zone lines are always cleared before route rendering begins.

#### Coverage Radius (`map.js:789-807`)

`renderCoverageRadius(patrols)` draws one `L.circle` per patrol. Leaflet's `L.circle` accepts `radius` in meters natively. Default radius is 500m (configurable via `activeConfig.display.coverageRadiusMeters`). Fill at 10% opacity. References stored in `patrolMarkerMap[id].coverageCircle` and removed during `clearAllMapResults`.

#### Route Rendering (`map.js:902-948`)

`renderRoutes(routes)` iterates `route.pathSegments` (arrays of `{lat, lng}` coordinates from Dijkstra path reconstruction). Each segment becomes one `L.polyline` (weight 4, opacity 0.9). Direction arrowheads are added via `L.polylineDecorator` if the library is available, repeating at 30% intervals with `pixelSize: 6`.

```js
routePolylines[patrolId] = { lines: [], decorators: [] }
```

Routes are rendered as single flat polylines per segment in the patrol color. Overlap between multiple patrols sharing a road segment is communicated by a separate overlay, not by visual separation of the lines.

#### Route Highlight (`map.js:879-898`)

`highlightPatrolRoute(patrolId)` sets the selected patrol's polylines to weight 7 / opacity 1.0 and brings them to front. All other patrol lines drop to weight 2 / opacity 0.2. Overlap overlay lines drop to 15% opacity. `clearPatrolHighlight()` restores all to weight 4 / opacity 0.9.

#### Overlap Overlay (`map.js:964-1018`)

`renderOverlapOverlay(routes)` uses a two-pass algorithm:

**Pass 1**: Build `edgePatrols: Map<edgeKey, Set<patrolId>>` across all pathSegments. Using a `Set<patrolId>` per edge prevents a single patrol traversing a dead-end and back from self-counting as overlap.

**Pass 2**: For edges where `patrolSet.size >= 2`, draw one overlay polyline (deduplicated via a `drawn` Set). Color: orange (`rgba(255,165,0,0.6)`) for exactly 2 patrols, red (`rgba(255,0,0,0.6)`) for 3+.

`_edgeKey(a, b)` (`map.js:1008-1018`): uses numeric node ID ordering (`n89|n234`) when both points have `nodeId`; falls back to rounded lat/lng strings otherwise.

#### Nearest Intersection Highlights (`map.js:1021-1042`)

Shown when Stage 1 finds no valid candidates inside the hull. Renders amber `L.circleMarker` (radius 8) with a tooltip instructing the user to plot incidents near those intersections.

#### Route Playback (`map.js:1262-1364`)

`startRoutePlayback(patrolId, speed)` (`map.js:1278-1345`):

1. Flattens all `pathSegments` into one ordered `points` array, skipping the duplicate junction point at each segment boundary (via `start = si === 0 ? 0 : 1`).
2. Pre-computes `cumDist[]` -- cumulative Haversine distances at each point.
3. Creates a `L.marker` with a `.pb-dot` CSS element styled with the patrol color via `--pb-color` CSS variable.
4. Runs a `requestAnimationFrame` loop that:
   - Computes progress fraction from elapsed time, looping via `% 1`.
   - Uses binary search on `cumDist` to find the current segment.
   - Linearly interpolates the marker's lat/lng within that segment.
   - Updates `window.uiApp.playbackProgress` for the progress bar.

`PLAYBACK_BASE_DURATION = 20` seconds for one full circuit at 1x speed (`map.js:1274`).

`updatePlaybackSpeed(speed)` (`map.js:1356-1364`) saves the current `progressOffset` before changing speed so the marker does not visually jump.

#### Algorithm Comparison Overlay (`map.js:1086-1155`)

`renderComparisonResults(runA, runB)` calls `_renderComparisonRun` for each:

- **Run A**: solid roaming-icon markers at full opacity; route polylines weight 3, solid.
- **Run B**: hollow "comparison-b" styled markers (border-only in patrol color) at 0.6 opacity; dashed route polylines weight 2.

`showComparisonRunA/B(visible)` adds or removes the respective layer arrays from the map.

#### Session Result Rendering (`map.js:1159-1246`)

`renderSessionResults(session, ui)` reconstructs all pipeline output from a saved session object: hull, patrol markers, zones, and routes. Also rebuilds `_crimeAssignmentMap` from saved zones and wires playback controls for roaming-mode sessions.

#### Global Exports (`map.js:1367-1422`)

All rendering functions are assigned to `window.*` so they are accessible from Alpine.js event handlers and `websocket-client.js` placeholder wiring. Notable special exports:

```js
window.isInsideBarangay = (lat, lng) => pointInHull(lat, lng, window.boundaryPolygon || []);
// Used by ui.js addCrimeNode and importCoordinates for boundary enforcement

window.clearCrimeMarkers
// Alias used by ui.js bulk-import: removes visual markers without touching window.P
```

### 11.4 ui.js

#### Module-Level Utilities

A private `_haversine(lat1, lng1, lat2, lng2)` function at `ui.js:8-16` is used exclusively by `importCoordinates()` for client-side outlier detection. It is not exported and is independent of `dijkstra.js`'s canonical version.

`STAGE_INFO` at `ui.js:19-36` is a plain object keyed by stage number (1-4). Each entry has a `description` (what the stage does for the user) and an `algorithmNote` (complexity and implementation details). These static strings are merged into each `traceStages` entry on `addTraceStage` and displayed in the collapsed trace card header regardless of run data.

#### Alpine.js Component: `patrolPointApp()`

Defined inside `document.addEventListener('alpine:init', ...)` at `ui.js:38`. The component is exposed as `window.uiApp` in `init()` so `map.js`, `websocket-client.js`, and HTML onclick handlers can call its methods.

**Reactive properties** (full list, `ui.js:41-128`):

```
wsConnected, wsStatusText           WebSocket connection state
selectedBarangay                    currently selected barangay name
barangayOptions                     array of available barangay names
barangayQuery                       combobox input text (filtered search)
barangayDropdownOpen                controls combobox dropdown visibility
nMax                                soft cap = floor(sqrt(intersectionCount or nodeCount))
nPatrols, nPatrolsError             patrol count input and validation message
deploymentMode                      'stationary' | 'roaming'
pipelineRunning, pipelineComplete   disable/enable Recalculate button
pipelineStageText                   loading indicator text
P                                   reactive mirror of window.P (for template rendering)
routes                              reactive mirror of window.routes (for playback select)
bannerMessage, bannerType           warning/error banner
bannerList, bannerCollapsed         multi-warning consolidation
showTracePanel, showSettings        panel/modal visibility
showComparison, showImport          panel/modal visibility
showPlayback                        route playback controls bar
traceStages                         array of stage objects (see addTraceStage below)
pipelineSummary, pipelineSummaryData   post-pipeline summary text and structured data
importText, importMessage           bulk import textarea and status message
undoStack, redoStack                arrays of action objects (max 50 each)
darkMode, animationsEnabled         display preferences (persisted to localStorage)
osmGraphMode                        road graph overlay toggle
comparisonModeActive                whether comparison mode is entered
comparisonRunA, comparisonRunB      full run snapshots for comparison
showRunA, showRunB                  visibility toggles for comparison layers
verificationReport                  post-pipeline verifier output object
routePlaybackActive                 whether playback marker is running
playbackPatrolId                    selected patrol for playback
playbackSpeed                       multiplier (passed to startRoutePlayback)
playbackProgress                    0-1 fraction updated by map.js rAF loop
mobileSheetHeight                   bottom sheet height % (40 collapsed, 80 expanded)
isMobile                            true when viewport < 768px
activeConfig                        the config currently applied, sent to backend on compute
settingsDraft                       editable copy shown in settings modal (not yet applied)
```

**`activeConfig` vs `settingsDraft`** (`ui.js:130-187`):

Two separate deep copies of the config object live in the component. `activeConfig` is what gets sent to the backend on `recalculate()`. `settingsDraft` is only modified in the settings modal. `openSettings()` deep-copies `activeConfig` into `settingsDraft`. `applySettings()` deep-copies `settingsDraft` back into `activeConfig`. This prevents half-edited settings from affecting an in-progress pipeline run.

#### Lifecycle: `init()` (`ui.js:190-253`)

Runs on Alpine component mount:

1. Loads `darkMode` and `animationsEnabled` from `localStorage`.
2. Applies `dark` class to `document.documentElement` if `darkMode` is true.
3. Registers three keyboard shortcuts (only when focus is not on a textarea/input):
   - `Ctrl+Z`: undo
   - `Ctrl+Shift+Z`: redo
   - `Ctrl+Enter`: recalculate (if pipeline not running and WebSocket connected)
4. Registers `beforeunload` warning if `P.length > 0` or `pipelineComplete` (unsaved data).
5. Sets `isMobile = window.innerWidth < 768` and listens to `resize`.
6. Watches `showRunA` and `showRunB` with `$watch` to call `showComparisonRunA/B` in map.js.
7. Sets `window.uiApp = this`.
8. Fetches `/data/barangays/manifest.json` into `window.barangayManifest` for OSM graph slug lookups.
9. Calls `initMap(this)` and `initWebSocket(this)`.

#### Crime Node Management (`ui.js:256-291`)

Three public methods called by map.js event handlers:

- `addCrimeNode(lat, lng)`: increments `window.crimeIdCounter`, builds `CRIME-NNN` ID, pushes to `window.P`, syncs reactive `this.P`, pushes `add_crime` undo action, calls `plotCrimeMarker`.
- `removeCrimeNode(crimeId)`: filters from `window.P`, syncs `this.P`, pushes `remove_crime` undo action, calls `removeCrimeMarker`.
- `dragCrimeNode(crimeId, oldLat, oldLng, newLat, newLng)`: updates coordinates in `window.P`, syncs `this.P`, pushes `drag_crime` undo action.

#### Recalculate (`ui.js:306-325`)

Validates `nPatrols`, checks `P.length >= 2`, clears the banner, then calls `sendComputeRequest(this.P, this.nPatrols, this.deploymentMode, this.activeConfig, this.selectedBarangay)`.

#### Undo / Redo (`ui.js:440-568`)

`_pushUndo(action)` appends to `undoStack`, clears `redoStack`, and caps at 50 entries. `undo()` and `redo()` pop from one stack and push to the other before calling `_applyAction(action, inverse)`.

`_applyAction` handles five action types:

| Type | Undo (inverse=true) | Redo (inverse=false) |
|------|---------------------|----------------------|
| `add_crime` | remove the point | re-add the point |
| `remove_crime` | restore the point | remove it again |
| `drag_crime` | move back to `oldLat/oldLng` | move to `newLat/newLng` |
| `bulk_import` | restore `previousP` and `previousCounter` | re-apply `newP` and `newCounter` |
| `reset` | restore `previousP` and `previousCounter` | clear again |

For `bulk_import` and `reset`, undo/redo calls `restoreCrimeMarkers(window.P)` to rebuild all visual markers from scratch.

#### Import Coordinates (`ui.js:572-684`)

`importCoordinates()` parses a newline-separated list of `"lat,lng"` pairs. Processing steps:

1. Parse and validate each line; track `skipped` count.
2. Filter to points inside the barangay boundary via `window.isInsideBarangay`.
3. Confirm with the user if existing points will be replaced.
4. Assign sequential `CRIME-NNN` IDs continuing from `window.crimeIdCounter`.
5. Run client-side outlier detection (same logic as Stage 1): compute centroid, average Haversine distance, flag points where `dist > outlierMultiplier * avg`. Outlier count is reported in a warning banner.
6. Push a `bulk_import` undo action with `previousP`, `previousCounter`, `newP`, and `newCounter`.
7. Call `clearCrimeMarkers()` then `restoreCrimeMarkers(window.P)` to rebuild visual state.

#### Settings (`ui.js:686-745`)

`openSettings()`: deep-copies `activeConfig` into `settingsDraft`, sets `showSettings = true`.

`applySettings()`: deep-copies `settingsDraft` into `activeConfig`, recomputes `nMax` based on `candidateNodes` setting, syncs `animationsEnabled` to `localStorage`, closes modal.

`resetSettingsToDefaults()`: resets `settingsDraft` to hardcoded defaults (does not apply until `applySettings` is called).

#### Route Playback (`ui.js:759-784`)

`playbackToggle()`: calls `stopRoutePlayback()` or `startRoutePlayback(playbackPatrolId, playbackSpeed)` depending on current state.

`onPlaybackPatrolChange()`: restarts playback on the new patrol (if active) and calls `window.showPatrolInfoPanel(patrolId)` to highlight the new patrol on the map.

`onPlaybackSpeedChange()`: calls `updatePlaybackSpeed(speed)` to change speed without resetting position.

#### Mobile Bottom Sheet Drag (`ui.js:786-807`)

Touch event handlers for dragging the control panel up/down on mobile:

- `onDragStart`: saves `_dragStartY` and `_dragStartHeight`.
- `onDragMove`: computes `deltaPct` from touch delta, clamps `mobileSheetHeight` to `[20, 80]`.
- `onDragEnd`: snaps to 80% if height > 55%, else snaps to 40%.

#### Algorithm Comparison Mode (`ui.js:809-875`)

`storeComparisonRunA/B()` captures a snapshot of the current pipeline results (`window.S_star`, `window.zones`, `window.routes`, `window.currentHull`) along with the config used, total circuit distance, stationary count, and runtime. Snapshots are stored in `this.comparisonRunA/B` and `window.comparisonResultA/B`. When both runs are stored, calls `renderComparisonResults(runA, runB)` in map.js.

`exitComparisonMode()` nulls both snapshots, resets visibility toggles, calls `clearComparisonOverlay()`.

#### Trace Panel Helpers (`ui.js:877-939`)

`addTraceStage(id, name)` (`ui.js:886-909`) pushes a full stage object pre-populated with all trace fields:

```js
{
    id, name,
    description, algorithmNote,   // from STAGE_INFO
    status: 'running',
    summary, metrics, fullLog,
    expanded: true,
    runtimeMs, confidence,
    convergenceCurve, convergenceRestart, redundancy, restartsCompleted,
    subparts, narrative,
    zoneChart, circuitChart
}
```

`updateTraceStage(id, update)` (`ui.js:911-931`) merges any subset of those fields (only defined keys are applied -- undefined fields are skipped). This allows `websocket-client.js` to progressively fill in data as it becomes available.

`setPipelineSummary(text)` (`ui.js:933-939`) sets the summary text and auto-scrolls the `#trace-content` div to the bottom via `$nextTick`.

---

## 12. Configuration System

The CONFIG object is the single source of all algorithm parameters. It originates as `DEFAULT_CONFIG` in `pipeline.js`, can be partially overridden by the user via the settings modal, and is validated by `validateConfig` in `sanitize.js` before use.

```
DEFAULT_CONFIG (pipeline.js:38-63)
         |
         v
mergeConfig(userConfig)  -- shallow spread per section
         |
         v
Passed to all 4 algorithm stages as config parameter
```

**Config fields and defaults:**

| Section | Field | Default | Description |
|---------|-------|---------|-------------|
| `hillClimbing` | `restarts` | 100 | Restart multiplier (total = restarts * n) |
| `hillClimbing` | `maxIterations` | 1000 | Per-restart iteration cap |
| `hillClimbing` | `radiusMultiplier` | 2 | R = sqrt(hullArea / candidates) * this |
| `hillClimbing` | `synchronousMode` | false | Sync vs async patrol move application |
| `convexHull` | `outlierMultiplier` | 2.5 | Outlier threshold = this * avgDist from centroid |
| `convexHull` | `collinearityEpsilon` | 1e-10 | Cross product threshold for collinearity test |
| `convexHull` | `includeOutliers` | true | Skip outlier detection entirely |
| `tsp` | `maxCrimeNodesPerZone` | 12 | Zone cap -- also the NN fallback threshold |
| `tsp` | `nearestNeighborFallbackThreshold` | 12 | k above this uses NN heuristic |
| `tsp` | `hullExteriorPenalty` | 1 | Dijkstra edge penalty multiplier outside hull |
| `zoneAssignment` | `strongRebalancing` | false | Light vs strong zone rebalancing |
| `snapping` | `boundingBoxEpsilon` | 1e-7 | Bbox expansion for float boundary safety |
| `snapping` | `initialSearchRadiusMeters` | 500 | Starting snap search radius |
| (root) | `candidateNodes` | `'all'` | `'all'` or `'intersection'` for patrol placement |

---

## 13. Data Flow: Full Pipeline Run

```
User clicks Recalculate
         |
ui.js recalculate()
         |
websocket-client.js sendComputeRequest(incidents, n, mode, config, barangay)
         |
ws.send({ type: 'compute', data: { incidents, n, mode, config, barangay, removedNodes } })
         |
SERVER: pipelineSocket.js handleCompute(ws, data, clientIp)
  1. Check activePipelines < 3
  2. Check WebSocket rate limit
  3. validateBarangay, validateIncidents, validateN, validateMode, validateConfig
  4. getOrFetchNetwork(barangay)          --> cache.js (in-memory or local file)
  5. pushToClient: network_loaded
  6. pushToClient: pipeline_start
  7. runPipeline(networkData, data, pushMessage, isCancelled, ws.previousState)
         |
         |
SERVER: pipeline.js runPipeline
  mergeConfig(data.config)
  deriveHCSeed(incidents)             --> FNV-1a hash of sorted incidents
  Compute barangayAreaM2 from bbox
  Build filteredNodeMap (all or intersection) + allNodesMap
         |
  Stage 1: runConvexHull(incidents, n, config, networkDataForHull, options)
    Incremental check (previousHull) OR full computation
    Outlier detection
    Collinearity check
    Brute force O(n^3) hull edges
    Edge ordering + Shoelace area + winding normalization
    Ray Cast pre-filter (nodeMap -> validCandidates)
    Return hull, validCandidates, hullAreaM2
  push: stage_complete(1, ...)
  yieldToEventLoop()
         |
  buildRoadDistMatrix(validCandidates, adjacencyList) -- O(|candidates| * (V+E)logV)
         |
  Stage 2: runHillClimbing(validCandidates, n, hullAreaM2, config, { seed, roadDistMatrix })
    Compute R
    FOR restartIdx = 0 to maxRestarts:
      Initialize n patrols at random distinct positions (shuffle+slice)
      WHILE anyPatrolMoved AND iteration < maxIterations:
        (async or sync mode)
        FOR each patrol: find neighbors within R, evaluate objective, move
      Record restart minDist
      push: stage_progress (patrolPositions) for animation
      Adaptive convergence check (last 3 restarts within 0.1%)
    Select best restart
    Compute confidence, bestSoFarCurve, redundancy
    Return patrols (S_star)
  push: stage_complete(2, ...)
  yieldToEventLoop()
         |
  Stage 3: runZoneAssignment(incidents, patrols, validCandidates, hull,
                              adjacencyList, dijkstraCache, config, options)
    Normalize crime IDs
    Silent snapping (each incident -> nearest road node, expanding radius)
    Deduplication (same snap target -> merge)
    Dijkstra pre-computation (once per unique snapped node)
    Build distanceMatrix[snappedNodeId][patrolIndex]
    Initial zone assignment (min road distance)
    Zero distance waypoint detection
    Zone rebalancing (light or strong)
    Zone cap enforcement (nearest maxCrimeNodesPerZone kept)
    Zone classification (empty / single / multi)
    Return zones, emptyZones, singleNodeZones, multiNodeZones
  push: stage_complete(3, ...)
  yieldToEventLoop()
         |
  IF mode === 'roaming':
    Stage 4: runTSP(zones, patrols, multiNodeZones, singleNodeZones,
                    nodeMap, adjacencyList, dijkstraCache, config, hull)
      FOR each singleNodeZone: build si -> c1 -> si with Dijkstra paths
      FOR each multiNodeZone:
        Build distance matrix D (k+1 Dijkstra calls, uses cache from Stage 3)
        Remove unreachable crime nodes
        k=2: direct; k > threshold: NN heuristic; else: backtracking TSP
        Path-aware sequence adjustment
        Build pathSegments (road coordinates per leg)
      Compute overlap edges (Set<patrolId> per edge key)
      Return routes
    push: stage_complete(4, ...)
    yieldToEventLoop()
         |
  verifyAll(pipelineResult)   -- non-fatal
  push: pipeline_complete(hull, patrols, zones, routes, verificationReport)
         |
  Return { previousState: { hull, validCandidates, incidents, hullAreaM2 } }

         |
CLIENT: websocket-client.js handlePipelineComplete(data)
  Store hull, patrols, zones, routes in window globals
  Update Alpine ui.pipelineComplete, ui.routes
  Show route playback controls if roaming mode
  Build pipeline summary lines
  Store verificationReport on Alpine component
  Call onPipelineComplete(data)  --> map.js rendering functions
```

---

## 14. Error Handling and Edge Cases

### Pipeline Stops

| Condition | Behavior |
|-----------|----------|
| Linear handler triggered (2 pts, collinear, few edges) | Pipeline sends `pipeline_complete` with `linearHandler: true`, no hull polygon, patrols placed along line. Stages 2-4 skipped. |
| Stage 1 error (no valid candidates) | Error sent with `nearestHighlights` (5 nearest nodes to hull centroid). Frontend highlights them on map. |
| Stage 2 error | Fatal error message pushed. Pipeline aborts. |
| Stage 3 error | Fatal error. Pipeline aborts. |
| Stage 4 error | Fatal error. Pipeline aborts. Routes remain null. |

### Graceful Degradations

| Condition | Behavior |
|-----------|----------|
| Crime node disconnected from all patrols (Infinity road dist) | Haversine fallback for zone assignment. `haversineFallback: true` flag on node. Warning emitted. |
| Crime node unreachable from patrol in TSP | Crime node excluded from route. Zone treated as stationary if all nodes unreachable. |
| Backtracking TSP finds no feasible circuit | Nearest neighbor heuristic fallback. |
| n > validCandidates.length | n capped to validCandidates.length. Warning emitted. |
| Crime node snap fails (no intersection within hull diameter) | Node added to `excludedCrimeNodes` with `reason: 'no_reachable_intersection'`. |
| Zone exceeds maxCrimeNodesPerZone | Furthest nodes moved to `excludedCrimeNodes` with `reason: 'zone_cap'`. |
| WebSocket closes mid-pipeline | `ws.cancelled = true`. Checked before each stage. Pipeline aborts cleanly. |

### Verifier Failures

The verifier runs post-pipeline and its results are informational only (not fatal). A `pass: false` result on `verifyTSPRoute` for k > 6 non-approximate routes is expected (exhaustive check skipped).

---

## 15. Local Development Setup

**Prerequisites:** Node.js LTS 22.x

```bash
git clone https://github.com/GavinnMR/patrolpoint
cd patrolpoint
git checkout main
npm install
```

Create `.env` (copy from `.env.example`):
```
NODE_ENV=development
PORT=3000
```

Start the server:
```bash
npm start
```

Open `http://localhost:3000` in a browser.

The server loads the barangay manifest at startup. Commonwealth and all other Quezon City barangays load from `data/barangays/*.json`. No database or external API calls are needed.

**Health check:**
```
GET http://localhost:3000/health
Response: { "status": "ok", "version": "2.0" }
```

**Network summary (example):**
```
GET http://localhost:3000/api/network/Commonwealth
Response: { "barangay": "Commonwealth", "nodeCount": 3593, "edgeCount": 4091,
            "intersectionCount": 914, "fromCache": false, "bbox": {...}, "boundary": [...] }
```

**Running tests (Playwright):**
```bash
npx playwright test
```

Test files are served from `/tests` in development only (`server/index.js:28-30`).

---

*Documentation generated from source code on 2026-06-15. All line references point to the committed main branch.*
