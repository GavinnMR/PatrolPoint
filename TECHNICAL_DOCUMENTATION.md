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

**PatrolPoint V2** is a full-stack patrol deployment optimization system built for barangay-level law enforcement in Quezon City, Philippines. A **barangay** is the smallest administrative unit in the Philippines, roughly equivalent to a neighborhood or village. **Tanod** units are the community-level security volunteers who patrol these areas on foot.

The system solves a practical problem: given a set of locations where crimes or incidents have been reported, where should you position patrol units to cover the danger zone as effectively as possible, and what routes should those units walk?

A user opens the application in a web browser, clicks on a map to mark where incidents happened, sets how many patrol units are available, and clicks Recalculate. The server then runs a four-stage mathematical process called a **pipeline** (a series of steps where each step's output feeds into the next) and sends the results back to the browser in real time. The browser displays patrol positions, zone boundaries, and patrol routes directly on the map.

### Deployment Modes

The system supports two modes of operation:

- **Stationary:** Runs Stages 1, 2, and 3. Places patrol units at mathematically optimal positions and divides the incident area into zones of responsibility. No walking routes are computed. Use this when you want to position guards at fixed posts.
- **Roaming:** Runs all four stages. In addition to placement and zones, Stage 4 computes a closed-loop walking circuit for each patrol unit, following actual roads, that covers every incident location in that patrol's zone. Use this when units will actively patrol on foot.

### Key Properties of the System

- All mathematical computation runs on the **server** (the remote computer that hosts the application). The browser only displays the results it receives.
- Road network data (the map of walkable streets and paths) is loaded from pre-processed local files at startup. The system does not call any external map service during a pipeline run.
- 358 Quezon City barangays are supported, each with its own road network file.
- The same set of incident locations will always produce exactly the same result, no matter how many times you run it. This property is called **determinism** and is achieved by using a seeded random number generator (a random number generator that produces the same sequence of numbers every time when given the same starting value).

---

## 2. Architecture

The system is divided into two main parts that communicate with each other: the **frontend** (what runs in the user's browser) and the **backend** (what runs on the server).

Think of it like a restaurant: the frontend is the dining room where customers (users) interact, and the backend is the kitchen where all the actual cooking (computation) happens. The customer never needs to know how the food is prepared; they just receive the finished dish.

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
         |-- data/barangays/manifest.json          (name to slug + bbox index)
         |
         |-- client/                               (served as static files by Express)
```

The browser communicates with the server using two different protocols:

- **HTTP (HyperText Transfer Protocol):** The same protocol used when you visit any website. It works like sending a letter: you make one request, you get one response, and the conversation ends. PatrolPoint uses this for loading the initial page and fetching road network summaries.
- **WebSocket:** A newer protocol that keeps a persistent, two-way connection open between the browser and server. Think of it like a phone call that stays open: either side can speak at any moment. PatrolPoint uses WebSocket to stream pipeline results to the browser stage by stage, so the user sees the map updating in real time rather than waiting for everything to finish.

The HTTP server and WebSocket server share the same port (door number) on the machine. This is accomplished in `server/index.js` at lines 16-18:

```js
const httpServer = http.createServer(app);
const wss        = new WebSocketServer({ server: httpServer });
```

`http.createServer(app)` wraps the Express application (the HTTP request handler) in a raw HTTP server object. `new WebSocketServer({ server: httpServer })` attaches a WebSocket server to that same HTTP server, so both types of connections arrive on the same port (3000).

---

## 3. Project Structure

Every file in this project has a specific responsibility. Understanding the folder layout helps you know where to look when something needs to be changed.

```
patrolpoint/
├── client/
│   ├── index.html
│   ├── css/custom.css
│   └── js/
│       ├── main.js                 global state, page load initialization
│       ├── map.js                  Leaflet map setup, all visual rendering
│       ├── ui.js                   Alpine.js reactive component, all UI controls
│       └── websocket-client.js     WebSocket connection, message handling, trace panel
├── server/
│   ├── index.js                    Express + WebSocket entry point
│   ├── routes/
│   │   └── network.js              GET /api/network/:barangay endpoint
│   ├── algorithms/
│   │   ├── dijkstra.js             Distance calculations, shortest path finder
│   │   ├── convexHull.js           Stage 1: danger zone boundary
│   │   ├── hillClimbing.js         Stage 2: patrol position optimizer
│   │   ├── zoneAssignment.js       Stage 3: zone divider
│   │   ├── tsp.js                  Stage 4: route planner
│   │   └── verifier.js             Post-pipeline correctness checker
│   ├── services/
│   │   ├── cache.js                In-memory network cache, local file loader
│   │   └── pipeline.js             Stage sequencer, config handler, seed deriver
│   ├── middleware/
│   │   ├── rateLimit.js            Request frequency limiter
│   │   └── sanitize.js             Input validation functions
│   └── websocket/
│       └── pipelineSocket.js       WebSocket handler, concurrency cap, per-connection state
├── data/
│   └── barangays/
│       ├── manifest.json           358-entry index mapping barangay names to files
│       ├── commonwealth.json       Road network data for Commonwealth barangay
│       └── *.json                  One file per barangay
├── .env.example
├── package.json
└── render.yaml
```

The `client/` folder contains everything the browser downloads and runs. The `server/` folder contains everything that runs on the server machine. The `data/` folder contains the pre-processed road network files that the server reads at startup. The `algorithms/` folder contains pure mathematical functions that take data in and return results out, with no connection to the network, database, or browser.

---

## 4. Dependencies and Stack

### What "Dependencies" Means

A **dependency** is a pre-written library of code that your project uses rather than writing from scratch. Instead of writing your own web server code, for example, you use the `express` library which already handles that. Dependencies are listed in `package.json` and downloaded via `npm install`.

### Server-Side Dependencies

From `package.json` (lines 11-21):

```json
{
  "type": "module",
  "dependencies": {
    "express":            "^4.18.2",
    "ws":                 "^8.14.2",
    "cors":               "^2.8.5",
    "express-rate-limit": "^7.1.5",
    "dotenv":             "^16.3.1"
  },
  "devDependencies": {
    "playwright": "^1.60.0"
  }
}
```

Each dependency does one specific job:

- **express:** A framework for building web servers in Node.js. It handles incoming HTTP requests and routes them to the right handler function. Without it, you would need to write raw socket-level HTTP parsing code yourself.
- **ws:** A library that adds WebSocket server capability to Node.js. It handles the WebSocket handshake protocol and provides a clean API for sending and receiving messages.
- **cors:** Cross-Origin Resource Sharing (CORS) is a browser security rule that prevents a webpage from making requests to a different server than the one it came from. This library adds the correct HTTP headers to tell the browser that such requests are permitted.
- **express-rate-limit:** Limits how many requests a single IP address (network identifier for a computer) can make in a given time window. This prevents abuse and protects server resources.
- **dotenv:** Loads environment variables (configuration values stored outside the code, like server addresses and secret keys) from a `.env` file into the running process. This keeps sensitive configuration out of the source code.
- **playwright (devDependency):** A browser automation library used for running automated tests. It is only needed during development, not in production.

The `"type": "module"` setting means the project uses **ES modules** (the modern JavaScript `import`/`export` syntax) rather than the older **CommonJS** (`require`/`module.exports`) system. All `import` statements in server files are native JavaScript module syntax.

### Frontend Libraries (Loaded in index.html)

These libraries are loaded from the internet (a Content Delivery Network, or CDN) when the page opens, rather than being installed on the server:

- **Leaflet.js:** An open-source library for displaying interactive maps in the browser. It handles tile loading (downloading map image squares from OpenStreetMap), zoom and pan controls, and placing markers and shapes on the map.
- **Leaflet.markercluster:** A Leaflet plugin that groups nearby markers into a single cluster bubble when the map is zoomed out. This keeps the map readable when many markers are close together.
- **Leaflet.polylineDecorator:** A Leaflet plugin that adds decorations (such as direction arrows) along polylines (lines drawn on the map).
- **Alpine.js:** A lightweight JavaScript library for making HTML interactive without writing a lot of code. It uses special HTML attributes (like `x-data`, `x-show`, `x-on:click`) to bind data and behavior directly to HTML elements. Think of it as a simpler alternative to frameworks like React or Vue.
- **Tailwind CSS:** A CSS (Cascading Style Sheets, the language that controls how web pages look) framework that provides thousands of small, single-purpose utility classes. Instead of writing custom CSS rules, you apply classes like `text-red-500`, `flex`, or `rounded-lg` directly in your HTML.

### Environment Variables

Environment variables are configuration values that live outside the source code, typically in a file called `.env`. The `.env.example` file shows which variables are required:

```
NODE_ENV=development
PORT=3000
```

- `NODE_ENV`: Tells the application whether it is running in development (on a developer's local computer) or production (on the live server). Certain behaviors differ between the two, such as CORS restrictions and test file serving.
- `PORT`: The port number the server listens on. Port 3000 is a common convention for local development.

No `DATABASE_URL` or `JWT_SECRET` (a secret key for generating authentication tokens) are required in the current baseline. The database and authentication layers are deferred to a future version.

---

## 5. Server Entry Point

**File: `server/index.js`**

This file is the starting point for the entire server. When you run `npm start`, Node.js executes this file first. It sets everything up in a specific order, because some steps depend on earlier steps being completed.

### Initialization Order

The server starts up by doing these steps in sequence (lines 1-53):

1. **Load dotenv:** Reads the `.env` file and makes those variables available to the rest of the code.
2. **Create Express app:** Creates the main web application object that will handle all HTTP requests.
3. **Create HTTP server:** Wraps the Express app in a raw HTTP server, which is necessary so that both Express and WebSocket can share the same port.
4. **Create WebSocket server:** Attaches a WebSocket server to the HTTP server, sharing its port.
5. **Apply CORS middleware:** Configures which browser origins are allowed to make requests.
6. **Apply JSON body parsing:** Tells Express to automatically parse incoming request bodies that contain JSON data (a text format for structured data). The `1mb` limit prevents excessively large requests.
7. **Serve the client folder as static files:** Any file in the `client/` directory becomes directly accessible via the browser, so `client/index.html` is served at `http://localhost:3000/`.
8. **Serve the data directory:** Makes barangay JSON files accessible at `http://localhost:3000/data/`.
9. **Serve the tests directory:** Only in non-production mode, makes Playwright test files accessible.
10. **Apply the rate limiter to all `/api` routes:** Limits the frequency of API requests.
11. **Mount the health check endpoint:** Registers a `GET /health` route that simply returns `{ status: 'ok', version: '2.0' }`. This is used to verify the server is running and by monitoring services to detect outages.
12. **Mount the network router:** Registers the barangay network summary endpoint.
13. **Register the catch-all route:** Any request that does not match an API route serves `client/index.html`. This is necessary for the frontend to handle page navigation without full page reloads.
14. **Bind WebSocket connections:** Tells the WebSocket server to call `handlePipelineConnection` every time a new browser connects.
15. **Start listening on PORT:** Opens the server to incoming connections on the configured port.

### CORS Policy

**CORS (Cross-Origin Resource Sharing)** is a browser security feature. When a webpage at one web address tries to make requests to a different web address, the browser checks whether the server at that different address explicitly allows it. The CORS middleware adds a response header that tells the browser this is permitted.

The policy in `server/index.js` lines 20-24:

```js
app.use(cors({
    origin: process.env.NODE_ENV === 'production'
        ? /\.onrender\.com$/
        : '*'
}));
```

In production, only requests from addresses ending in `.onrender.com` (the hosting platform) are permitted. In development, any origin is permitted (the `'*'` wildcard). This prevents other websites from making requests to the live server on behalf of their users.

In plain terms: in production, only the official PatrolPoint website can talk to the PatrolPoint server. In development, any website can, which makes testing easier.

---

## 6. Road Network Data Layer

To plan patrol routes that follow real streets, the system needs a mathematical model of the road network. This section explains what that model looks like, where it comes from, and how the server loads it.

### What a Road Network Graph Is

A **graph** is a mathematical structure made of two things: **nodes** (also called vertices) and **edges**. You can think of a graph like a city map: the intersections are nodes, and the road segments connecting them are edges.

In PatrolPoint's road network:

- Each **node** represents a point on the road network, whether an intersection, a dead end, or any intermediate point along a road. Each node has a unique ID (like `n0`, `n1`, `n2`) and a geographic position (latitude and longitude).
- Each **edge** represents a direct road connection between two nodes. Each edge has a `weight`, which is the real-world walking distance between those two nodes in meters.
- The graph is **undirected**, meaning you can travel along any edge in either direction (from node A to node B, or from node B to node A).

For the Commonwealth barangay specifically, the road network contains 3,593 nodes and 4,091 edges.

### 6.1 Local File Format

Each barangay has its own pre-processed file, for example `data/barangays/commonwealth.json`. The file contains three arrays:

```json
{
  "nodes": [{ "id": "n0", "lat": 14.7028, "lng": 121.0944 }, ...],
  "edges": [{ "from": "n0", "to": "n1", "weight": 45.3 }, ...],
  "boundary": [{ "lat": 14.695, "lng": 121.080 }, ...]
}
```

- `nodes`: Every road graph node. Commonwealth has **3,593 nodes**. Each node has an ID, a latitude, and a longitude.
- `edges`: Every undirected connection between two nodes. Commonwealth has **4,091 edges**. The `weight` field holds the Haversine distance (explained in Section 9.1) between the two nodes in meters.
- `boundary`: An ordered list of geographic coordinates tracing the polygon outline of the barangay boundary. Commonwealth's boundary has 161 points. The frontend uses this to draw the darkening mask over areas outside the barangay.

In plain terms: the road network file is essentially a digital street map stored as a list of points and connections rather than as an image. The algorithms use this list to find shortest paths between any two locations.

### 6.2 The Manifest File

`data/barangays/manifest.json` is an index file that maps every supported barangay name to its file information:

```json
{
  "Commonwealth": { "slug": "commonwealth", "bbox": { "south": ..., "west": ..., "north": ..., "east": ... } },
  ...
}
```

A **slug** is a URL-safe version of a name (lowercase, no spaces). A **bounding box** (bbox) is the smallest rectangle that completely contains the barangay, defined by its southernmost latitude, westernmost longitude, northernmost latitude, and easternmost longitude. The manifest covers 358 Quezon City barangays.

### 6.3 The Cache Service (server/services/cache.js)

`getOrFetchNetwork(barangayName)` is the single function that all other server code calls when it needs a barangay's road network. The function implements a two-layer lookup strategy, checking the fastest source first.

**Layer 1: In-memory cache** (`cache.js` lines 81-83):

```js
if (networkCache[barangayName]) {
    return { ...networkCache[barangayName], fromCache: true };
}
```

**In-memory** means stored directly in the running program's working memory (RAM), as opposed to on disk. A plain JavaScript object called `networkCache` holds every barangay network that has been loaded this session. Looking something up in this object is instantaneous. Once loaded, a network stays in memory for as long as the server is running, so repeated requests cost nothing.

In plain terms: the first time you select Commonwealth, the server reads the file from disk. Every time after that, it uses the copy already in memory, which is instant.

**Layer 2: Local file** (`cache.js` lines 86-93):

If the network is not in memory, the server reads the JSON file from disk. After reading it, the code reconstructs the **adjacency list** (a data structure that maps each node ID to the list of its direct neighbors) from the raw edges array:

```js
for (const edge of raw.edges) {
    adjacencyList[edge.from].push({ neighborId: edge.to,   weight: edge.weight });
    adjacencyList[edge.to  ].push({ neighborId: edge.from, weight: edge.weight });
}
```

Each edge appears twice in the adjacency list because the graph is undirected: if node A connects to node B, then B also connects to A. An adjacency list is the standard data structure for representing graphs because it makes "find all neighbors of node X" very fast.

**Intersection node detection** (`cache.js` line 49):

```js
const intersectionNodeIds = Object.keys(degree).filter(id => degree[id] >= 3);
```

The code counts how many edges connect to each node (the node's **degree**). Any node with three or more connections is classified as an intersection. Commonwealth has 914 intersection nodes out of its 3,593 total. This distinction matters because one configuration option restricts patrol placement to intersection nodes only, which are more strategically meaningful as patrol positions.

**Layer 3: Error:**

If no manifest entry exists for the requested barangay, the function throws an error directing the developer to run the preprocessing script that generates the JSON files.

### 6.4 The Network Route (server/routes/network.js)

`GET /api/network/:barangay` is an HTTP endpoint the browser calls when it first loads or when the user switches barangays. It returns a summary object:

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

The full `nodes` and `edges` arrays are not included here. Those arrays contain thousands of entries and would make the response too large for a regular HTTP request. The full road network data is kept on the server and used internally during pipeline execution.

---

## 7. WebSocket Protocol

### What a Protocol Is

A **protocol** is an agreed-upon set of rules for how two parties communicate. PatrolPoint defines its own message protocol on top of WebSocket. Every message is a JSON object with at least a `type` field that identifies what kind of message it is, and usually a `data` field that contains the payload.

### 7.1 Message Definitions

**Messages sent from the browser to the server:**

| Type | What it carries | When it is sent |
|------|-----------------|-----------------|
| `init` | `{ barangay }` | When the user selects a barangay, to load its road network |
| `compute` | `{ incidents, n, mode, config, barangay, removedNodes }` | When the user clicks Recalculate |
| `ping` | nothing | Every 30 seconds, to keep the connection alive |
| `cancel` | nothing | When the user wants to stop a running pipeline |

**Messages sent from the server to the browser:**

| Type | What it carries | When it is sent |
|------|-----------------|-----------------|
| `connected` | nothing | Immediately when the WebSocket connection is established |
| `network_loaded` | barangay name, counts, boundary polygon | After `init` or `compute` loads the road network |
| `pipeline_start` | total stage count, mode | Just before Stage 1 begins |
| `stage_start` | stage number, stage name | Just before each individual stage begins |
| `stage_progress` | current patrol positions, best distance so far | Repeatedly during Stage 2 to animate patrol movement |
| `stage_complete` | stage number, full result object, trace data, runtime | After each stage finishes |
| `warning` | stage number, message text | When something unexpected but non-fatal happens |
| `error` | stage number, message text, fatal flag | When validation fails or an algorithm error occurs |
| `pipeline_complete` | hull, patrols, zones, routes, trace, runtime, verification report | After all stages are done |
| `pong` | nothing | Response to a `ping` message |

### 7.2 The Connection Handler (server/websocket/pipelineSocket.js)

Every time a browser opens a new WebSocket connection, the server calls `handlePipelineConnection`. This function sets up per-connection state directly on the `ws` object (the object representing one WebSocket connection), at lines 87-89:

```js
ws.cancelled        = false;
ws.pipelineRunning  = false;
ws.previousState    = {};
```

- `ws.cancelled`: A flag set to `true` if the user closes their browser or sends a `cancel` message. The pipeline checks this before each stage and aborts if it is true.
- `ws.pipelineRunning`: Tracks whether a computation is currently in progress for this connection.
- `ws.previousState`: Stores the hull and valid candidates from the last pipeline run. If the user adds more incidents and runs again, Stage 1 can skip recalculating the hull if all new incidents are already inside the existing boundary.

**Concurrency cap** (`pipelineSocket.js` lines 34-36):

```js
let activePipelines = 0;
const MAX_CONCURRENT_PIPELINES = 3;
```

A **concurrency cap** limits how many pipeline runs can happen at the same time. If three pipelines are already running and a fourth request comes in, it is immediately rejected. This protects the server from being overloaded on the free-tier hosting plan.

**WebSocket rate limiter** (`pipelineSocket.js` lines 40-59):

Each IP address is allowed 20 compute requests per 5-minute window. Requests from `localhost` (the local development machine) are exempt so automated test suites are not blocked during development.

**The `pushToClient` helper function** (`pipelineSocket.js` lines 63-74):

```js
function pushToClient(ws, message) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(message));
    } else {
        ws.cancelled = true;
    }
}
```

Before sending any message, this function checks that the WebSocket connection is still open. If the user has closed their browser tab, `ws.readyState` will not equal `ws.OPEN`, and instead of crashing, the function sets `ws.cancelled = true`. This triggers a clean abort at the next cancellation check in the pipeline.

In plain terms: this is the safety check that prevents the server from trying to send results to a browser that has already gone away.

### 7.3 The Compute Flow (handleCompute)

When a `compute` message arrives, `handleCompute` at lines 174-288 runs through this sequence:

1. Check that fewer than 3 pipelines are currently running. Reject if at the cap.
2. Increment `activePipelines` and mark the connection as running.
3. Check the WebSocket-specific rate limit for this IP address.
4. Validate all inputs using the functions in `sanitize.js`. Throw an error immediately if anything is invalid.
5. Load the road network for the requested barangay using `getOrFetchNetwork`.
6. Send a `network_loaded` message to the browser.
7. Send a `pipeline_start` message to the browser.
8. Call `runPipeline` with all the data, passing a `pushMessage` callback so the pipeline can send messages back to the browser.
9. Store the returned `previousState` on the connection object for the next run.
10. Decrement `activePipelines` in the `finally` block. This runs even if an error was thrown, ensuring the count always stays accurate.

---

## 8. Pipeline Orchestrator

**File: `server/services/pipeline.js`**

The pipeline orchestrator is the conductor of the entire computation. It sequences the four algorithm stages in order, passes each stage's output to the next stage, handles configuration, and manages shared resources that span multiple stages.

### 8.1 CONFIG Merge

Every algorithm stage accepts a configuration object that controls its behavior. The system has sensible default values for every parameter, defined as `DEFAULT_CONFIG` at `pipeline.js` lines 38-63:

```js
export const DEFAULT_CONFIG = {
    hillClimbing:   { restarts: 100, maxIterations: 1000, radiusMultiplier: 2, synchronousMode: false },
    convexHull:     { areaThresholdDivisor: 100, outlierMultiplier: 2.5, collinearityEpsilon: 1e-10, includeOutliers: true },
    tsp:            { maxCrimeNodesPerZone: 12, nearestNeighborFallbackThreshold: 12, hullExteriorPenalty: 1 },
    zoneAssignment: { strongRebalancing: false },
    snapping:       { boundingBoxEpsilon: 1e-7, initialSearchRadiusMeters: 500 }
};
```

`mergeConfig(userConfig)` at lines 66-75 performs a **shallow spread** per section: it takes the user's configuration (whatever they changed in the settings panel) and overrides only the fields they provided, keeping defaults for everything else. You can change one Hill Climbing parameter without having to specify all the others.

In plain terms: the default configuration is a starting point. The settings panel lets you override individual values. Any value you do not change stays at its default.

### 8.2 Deterministic Seed

**Determinism** means the same input always produces the same output. Stage 2 (Hill Climbing) uses random numbers to explore different starting positions. Without a fixed starting point for the random number generator, two runs with the same incident locations would produce different results.

`deriveHCSeed(incidents)` at `pipeline.js` lines 18-28 solves this by computing a **hash** of all the incident coordinates. The hash algorithm used is **FNV-1a** (Fowler-Noll-Vo 1a, a well-known fast hash function that converts arbitrary data into a fixed-size integer). Before hashing, the incidents are sorted by latitude and then longitude, so the result does not depend on the order in which the user clicked them. The 32-bit integer produced is used as the **seed** (the starting value) for the random number generator in Stage 2.

In plain terms: the incident locations act as a fingerprint that determines how the random exploration starts. Same locations, same fingerprint, same exploration, same result.

### 8.3 Candidate Node Selection

Not every road node is a valid position for a patrol unit. The pipeline narrows down the candidates (eligible nodes) in two ways, controlled by `config.candidateNodes` at `pipeline.js` lines 143-166:

- `'all'` (the default): every road node inside the danger zone boundary is eligible for patrol placement.
- `'intersection'`: only road nodes with three or more connections (intersections) are eligible. Intersections are arguably better patrol positions because they control access to multiple streets.

Snapping candidates (used in Stage 3 to find the nearest road node to each incident location) always use all nodes regardless of this setting. This ensures that the system can find the nearest road point to an incident even when intersection-only mode is selected for patrol placement.

### 8.4 Road Distance Matrix

Stage 2 (Hill Climbing) needs to know the actual road distance between every pair of candidate nodes inside the danger zone. Computing these distances one at a time during Stage 2 would be very slow. Instead, `buildRoadDistMatrix` at `pipeline.js` lines 287-289 precomputes them all at once before Stage 2 begins:

```js
const roadDistMatrix = buildRoadDistMatrix(validCandidates, networkData.adjacencyList);
```

This function runs the shortest-path algorithm once per valid candidate node. Because a single run finds distances from one source to all other nodes simultaneously, running it once per candidate gives the complete set of all pairwise distances. Every distance lookup during Stage 2 then becomes a simple array index lookup rather than a fresh computation.

For 914 intersection candidates, this matrix is approximately 914 x 914 x 8 bytes, roughly 6.7 megabytes, which fits comfortably in server memory.

### 8.5 Event Loop Yield

Node.js is **single-threaded**, meaning it can only do one thing at a time. When the server is running a heavy computation like Stage 2, it is not processing any other events, including outgoing WebSocket messages. Without a deliberate pause, Stage 2 might start before the Stage 1 result message actually reaches the browser.

`yieldToEventLoop()` at `pipeline.js` lines 87-89 solves this:

```js
function yieldToEventLoop() {
    return new Promise(resolve => setTimeout(resolve, 0));
}
```

`setTimeout(resolve, 0)` schedules the continuation of the pipeline to run after the current batch of pending events (including outgoing WebSocket messages) is processed. This is called after every `stage_complete` push.

In plain terms: this is a polite pause that lets the server send its messages before diving into the next computation. Without it, all four stage results might arrive at the browser simultaneously after the whole pipeline finishes.

### 8.6 Cancellation Checks

`isCancelled()` is a function passed into `runPipeline` that returns `true` if `ws.cancelled` is set. It is checked at the start of each stage. If the user closes their browser or sends a `cancel` message mid-pipeline, the next cancellation check catches it and returns early, producing no further output.

---

## 9. Algorithm Deep Dive

All algorithm files live in `server/algorithms/`. They are pure JavaScript modules, meaning they have no side effects: they take input data, compute, and return structured result objects. They never touch the network, database, or WebSocket directly. Think of them as mathematical functions you can examine, test, and reason about in isolation.

---

### 9.1 Dijkstra and Haversine (dijkstra.js)

**File: `server/algorithms/dijkstra.js`** — the file responsible for all distance calculations and for finding the shortest road path between any two points in the road network.

This file is the canonical (official, single authoritative) source for all distance computation in the project. Every other algorithm file imports from it and never reimplements distance calculations on its own.

#### The Haversine Distance Formula

**What problem it solves:** Geographic coordinates (latitude and longitude) are angles on a sphere, not positions on a flat plane. You cannot compute the real-world distance between two coordinates by simply applying the Pythagorean theorem (the flat-plane distance formula), because the Earth is curved. You need a formula that accounts for that curvature.

**How it solves it:** `haversineDistance(lat1, lng1, lat2, lng2)` at `dijkstra.js` lines 8-16 computes the straight-line distance along the Earth's surface between two geographic points:

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

Every variable explained:
- `R = 6371000`: The mean radius of the Earth in meters.
- `dLat`: The difference in latitudes, converted from degrees to radians (the unit that trigonometric functions like `sin` and `cos` expect). The conversion is: multiply degrees by π (pi, approximately 3.14159) divided by 180.
- `dLng`: The difference in longitudes, similarly converted to radians.
- `a`: An intermediate value from the Haversine formula. It combines the latitude difference and the longitude difference scaled by the cosines of both latitudes (the cosine scaling accounts for the fact that lines of longitude get closer together near the poles).
- The return value: `2 * R * Math.asin(Math.sqrt(a))` completes the formula and gives the great-circle distance (the shortest path along the Earth's surface) in meters.

The function always takes parameters in the order `lat1, lng1, lat2, lng2`. This order is consistent everywhere in the codebase.

In plain terms: given two map coordinates, this formula tells you how far apart they are in real-world meters, correctly accounting for the Earth's curvature.

**Why this formula was chosen:** The Haversine formula is the standard formula for computing distances between geographic coordinates. It is accurate to well within 1% for distances at the scale of a barangay (under a few kilometers), and it is fast to compute.

**What the output looks like:** A single number representing the straight-line (as-the-crow-flies) distance between the two points in meters.

#### The Binary Min-Heap

**What problem it solves:** Dijkstra's algorithm needs to repeatedly find the unvisited node with the smallest current distance estimate. If you stored all nodes in a plain list, finding the minimum would require scanning the entire list every time, which is very slow for large graphs.

A **min-heap** is a tree-shaped data structure that keeps the smallest value at its root (top), so retrieving the minimum always takes the same amount of time regardless of how many items are in the structure.

**How it works:** `MinHeap` at `dijkstra.js` lines 21-97 is a **binary min-heap** (a heap where each node has at most two children) with an additional `position` map that records where each node ID is stored in the heap array. This `position` map enables O(1) (constant-time, independent of heap size) index lookup, which makes the `decreaseKey` operation (updating a node's distance estimate when a shorter path is found) run in O(log n) time instead of O(n) time.

Without the `position` map, finding a specific node to update its priority would require scanning the entire heap from the beginning. With it, you can jump directly to that node's position.

Key methods and their time complexities (where n is the number of items in the heap):

- `insert(nodeId, priority)`: Adds a new node at the end of the heap, then moves it upward until the heap property is restored. Time: O(log n).
- `extractMin()`: Removes and returns the root (minimum), replaces it with the last item, then moves that item downward until the heap property is restored. Time: O(log n).
- `decreaseKey(nodeId, newPriority)`: Uses `position[nodeId]` for instant index lookup, updates the priority, then moves the node upward. Time: O(log n).

In plain terms: the min-heap is like a priority queue at a hospital emergency room. New patients are added (insert), the most urgent patient is always called next (extractMin), and if a patient's condition worsens their priority can be updated (decreaseKey). All of these operations happen quickly no matter how many patients are waiting.

#### Core Dijkstra's Algorithm

**What problem it solves:** Given a starting node in the road network graph, find the shortest road path from that starting node to every other node in the graph.

**How it works:** `dijkstra(sourceId, adjacencyList, nodeMap, hull, exteriorPenalty, removedNodes)` at `dijkstra.js` lines 129-184:

1. Set every node's distance to infinity (meaning "not yet reached").
2. Set the source node's distance to 0.
3. Insert the source node into the min-heap with priority 0.
4. Loop until the heap is empty:
   - Extract the node with the smallest current distance estimate.
   - If its distance is infinity, the rest of the graph is disconnected from the source; stop.
   - For each neighboring node connected by an edge:
     - Skip if the neighbor is in `removedNodes` (a set of nodes the user has blocked).
     - Compute the edge's effective weight, applying the exterior penalty multiplier if active and the edge's midpoint falls outside the hull.
     - If traveling through the current node gives a shorter path to the neighbor than previously known, update the neighbor's distance and record the current node as its parent.
     - Update the neighbor's position in the min-heap.
5. Return `{ distances, parents }` where `distances[nodeId]` is the shortest road distance from the source to that node, and `parents[nodeId]` is the previous node on that shortest path.

**Time complexity:** O((V + E) log V), where V is the number of nodes (vertices) and E is the number of edges. For Commonwealth's graph (3,593 nodes, 4,091 edges), this means each single Dijkstra run completes in microseconds.

In plain terms: Dijkstra's algorithm is like sending ripples outward from a stone dropped in water, always expanding to the next-nearest point. It guarantees that when the ripple first reaches any location, it has found the shortest possible path to that location.

**Why this algorithm was chosen:** Dijkstra's algorithm with a binary min-heap is the standard efficient algorithm for finding shortest paths in a graph with non-negative edge weights. All road distances are non-negative (you cannot walk a negative distance), so Dijkstra is both correct and optimal here.

**Hull exterior penalty:** When `hullExteriorPenalty > 1` and a hull (danger zone boundary) is provided, each edge's midpoint is tested with Ray Casting (described in Section 9.2). If the midpoint is outside the hull, the edge weight is multiplied by the penalty factor. This makes routes that leave the danger zone artificially more expensive, encouraging the algorithm to find paths that stay within the incident area.

**removedNodes:** A set of node IDs that the user has manually blocked (by clicking nodes in OSM Graph mode). When a `removedNodes` set is active, Dijkstra always recomputes from scratch rather than reading from the cache, because the effective graph topology differs from the base graph.

#### Path Reconstruction

`reconstructPath(sourceId, destId, parents)` at `dijkstra.js` lines 190-207 traces the chain of parent pointers from the destination back to the source, then reverses the result. If the destination was never reached (distance remained infinity), it returns `null`. This is how the system produces the actual sequence of road coordinates for drawing a route on the map.

#### All-Pairs Road Distance Matrix

`buildRoadDistMatrix(candidates, adjacencyList)` at `dijkstra.js` lines 224-236 runs Dijkstra once per candidate node. A single Dijkstra run from a source node gives distances to all other nodes in one pass, so this function needs only one Dijkstra call per candidate (not one call per pair). The result is a square matrix where `matrix[srcId][dstId]` is the shortest road distance between any two candidate nodes.

This matrix is used exclusively by Stage 2 (Hill Climbing). The matrix for 914 intersection candidates contains 914 x 914 = 835,396 entries at 8 bytes each, totaling approximately 6.7 megabytes.

#### Cached Dijkstra Runner

`runDijkstra(sourceId, adjacencyList, dijkstraCache, nodeMap, hull, exteriorPenalty, removedNodes)` at `dijkstra.js` lines 254-265 is the public entry point used by Stages 3 and 4. Before running Dijkstra, it checks `dijkstraCache[sourceId]`. On a cache hit, it returns the stored result instantly. On a miss, it runs the core Dijkstra function and stores the result in the cache.

The cache persists for the entire pipeline run. Stage 4 automatically benefits from every Dijkstra call that Stage 3 already made, typically achieving near-100% cache hit rates for the patrol-to-crime-node pairs that Stage 4 needs.

#### Normalized Cache Key

`normalizedCacheKey(idA, idB)` at `dijkstra.js` lines 212-216 produces a consistent string key for any pair of node IDs regardless of the order they are provided. It extracts the numeric part of each node ID (format `nNNN`), sorts them numerically, and joins them with `|`. This ensures that looking up the path from node 89 to node 234 and looking up the path from 234 to 89 produce the same cache key (`n89|n234`), enabling overlap detection in Stage 4.

---

### 9.2 Stage 1: Brute Force Convex Hull (convexHull.js)

**File: `server/algorithms/convexHull.js`** — the file that computes the danger zone boundary enclosing all incident locations.

**What problem it solves:** Given a scattered set of incident locations, the system needs a single polygon (a closed shape with straight sides) that represents the "danger zone": the region the patrol commander cares about. This polygon is used as the boundary for all subsequent calculations: patrol positions must be inside it, road nodes are only eligible if they are inside it, and TSP routes are discouraged from leaving it.

**What a convex hull is:** A **convex hull** is the smallest convex polygon that contains all the input points. Think of it as the shape you would get if you stretched a rubber band around all the incident markers on the map and let it snap tight. Every input point is either on the boundary of the shape or inside it.

A shape is **convex** if, for any two points inside it, the straight line between them is also entirely inside it. Convex hulls cannot have dents or concave sections.

**Input:**
- `incidents`: array of `{lat, lng}` objects, one per incident location
- `n`: the number of patrol units
- `config`: algorithm parameters
- `networkData`: contains `nodeMap` (the road graph nodes) and `barangayAreaM2` (the total barangay area in square meters)
- `options`: optional previous hull, previous candidates, and a progress callback

**Output:** A structured result object containing the hull polygon vertices, the hull area in square meters, the list of valid candidate road nodes inside the hull, indices of any outlier incidents, and a detailed trace log.

#### Step 0: Incremental Hull Update

Before doing any computation, Stage 1 checks whether the previous hull can be reused (`convexHull.js` lines 176-277). This is an optimization for when the user adds incidents and runs again without clearing the map.

The logic works as follows:

1. If a previous hull exists and previous candidates exist, compare the current incidents to the previous ones.
2. Find any new incidents (points in the current set that were not in the previous set).
3. If there are no new incidents and no incidents were removed, return the previous hull unchanged (the incident set is identical).
4. If all new incidents fall inside the previous hull (tested using Ray Casting, described below), return the previous hull unchanged (the new incidents are already within the danger zone, so the boundary does not need to expand).
5. If any new incident falls outside the previous hull, fall through to full recomputation.

In plain terms: if you add a new incident to the middle of the map where incidents already exist, the danger zone does not change. Only if you plot an incident outside the existing boundary does the system recalculate the hull.

This saves the cost of the O(n³) hull computation (explained below) in many common use cases.

#### Step 1: Outlier Detection

When `config.convexHull.includeOutliers` is set to `false` and there are three or more incidents, the system identifies and removes outliers (incidents unusually far from the cluster center) before computing the hull. The goal is to prevent one far-away incident from stretching the danger zone excessively (`convexHull.js` lines 284-329).

The detection works by:
1. Computing the centroid (average position) of all incidents.
2. Computing the average distance from the centroid to all incidents.
3. Flagging any incident whose distance from the centroid exceeds `outlierMultiplier * averageDistance`. The default `outlierMultiplier` is 2.5, meaning any incident more than 2.5 times the average distance away is flagged as an outlier.

Flagged incidents are not deleted from the map. Their indices are returned in `outlierIndices` so the frontend can render them with a distinct visual style (a different color or icon) to indicate they were excluded from the hull computation.

#### Step 2: Validity Check

After outlier removal, if fewer than 3 non-outlier points remain (or exactly 2 remain), the system cannot compute a proper polygon. It triggers the **linear handler** instead, described at the end of this section.

#### Step 3: Collinearity Check

If all remaining points happen to fall on a single straight line (for example, all incidents occurred along one road), a polygon still cannot be formed. The system detects this in O(n) time (`convexHull.js` lines 349-365).

The detection fixes two anchor points A and B (the first two incidents). For each remaining point C, it computes the **cross product** of vectors AB and AC:

`k = (B.lng - A.lng) × (C.lat - A.lat) - (B.lat - A.lat) × (C.lng - A.lng)`

If all points are on the same line, k will equal 0 for every C (within `collinearityEpsilon`, a tiny threshold of 1×10⁻¹⁰ to handle floating-point rounding). If k is 0 for every point, all incidents are collinear and the linear handler is triggered.

Throughout this file, `x = lng` and `y = lat`. This convention is consistent across all cross product and area calculations.

#### Step 4: Brute Force Convex Hull Computation

**Time complexity:** O(n³), where n is the number of incident points. This means that if you double the number of incidents, the computation takes roughly 8 times as long. At the typical scale of 5 to 30 incident points, this is completely imperceptible (the computation finishes in microseconds regardless).

The algorithm works by testing every possible directed edge between pairs of points (`convexHull.js` lines 374-389):

```js
const d = (pj.lng - pi.lng) * (pk.lat - pi.lat) -
           (pj.lat - pi.lat) * (pk.lng - pi.lng);
if (d < 0) { valid = false; break; }
```

For each ordered pair of points (pi, pj), the algorithm checks every other point pk:
- `d > 0` means pk is to the left of the directed edge from pi to pj (counter-clockwise orientation).
- `d = 0` means pk is exactly on the line through pi and pj (allowed).
- `d < 0` means pk is to the right of the edge (clockwise orientation), which means this edge cannot be part of the convex hull boundary.

An edge belongs to the convex hull if and only if all other points have `d >= 0` (they are all on the left side or on the line). Collecting all valid edges gives the complete set of hull boundary edges.

In plain terms: the brute force approach tries every possible boundary line and keeps only the ones where all other incidents are on the same side. A rubber band stretched around all the points naturally satisfies this: every point is on the inside.

**Why brute force was chosen over faster algorithms:** The well-known Graham Scan algorithm runs in O(n log n), which is faster. However, O(n³) is entirely acceptable for n under 30 (the typical incident count). The brute force approach is simpler to understand, easier to verify for correctness, and matches the academic context of this project.

#### Step 5: Edge Ordering

The valid edges collected from Step 4 are in no particular order. The system chains them into a proper polygon by matching the endpoint of one edge to the start of the next (`convexHull.js` lines 406-437). If no connecting edge is found (meaning the hull has a topological break), the algorithm returns an error.

#### Step 6: Area Computation and Winding Order Normalization

The system computes the hull's area using the **Shoelace formula** (also called the surveyor's formula), a standard algorithm for computing the area of a polygon given its vertex coordinates (`convexHull.js` lines 444-463):

```js
signedArea += curr.lng * next.lat - next.lng * curr.lat;
signedArea /= 2;
```

Here `curr` and `next` are consecutive vertices of the polygon. The Shoelace formula produces a **signed area**: positive if the vertices are listed in counter-clockwise order (**CCW winding**), negative if they are in clockwise order. All Ray Casting logic in this codebase assumes CCW winding, so if the signed area is negative, the vertex list is reversed.

The area is then converted from square degrees to square meters using a scaling factor calculated at the centroid latitude:

```js
const lngScale   = 111000 * Math.cos(centroidLat * Math.PI / 180);
const hullAreaM2 = hullAreaDeg * 111000 * lngScale;
```

Here, `111000` is approximately how many meters correspond to one degree of latitude. `Math.cos(centroidLat * Math.PI / 180)` is the scaling factor that accounts for longitude lines being closer together at higher latitudes. The result `hullAreaM2` is the hull area in square meters, accurate to within about 1% at barangay scale.

#### Step 7: Ray Casting Pre-Filter

After computing the hull, Stage 1 identifies which road nodes from the full road network fall inside the hull. These become `validCandidates`, the eligible positions for patrol placement in Stage 2.

**Ray Casting** is the algorithm used to test whether a point is inside a polygon. `runRayCastPreFilter(hull, nodeMap, eps)` at `convexHull.js` lines 61-90 applies it to every node in the road network:

1. First applies a bounding box pre-filter: only nodes that fall within the rectangle bounding the hull (expanded by `eps = 1e-7` degrees to avoid floating-point boundary issues) are tested further. This eliminates most nodes quickly without the full polygon test.
2. Nodes passing the bounding box check are tested with full Ray Casting.

`rayCast(point, hull)` at `convexHull.js` lines 17-29 works by casting an imaginary ray from the test point outward to the right (in the positive longitude direction) and counting how many times that ray crosses the hull boundary. An odd number of crossings means the point is inside. An even number (including zero) means it is outside.

In plain terms: imagine standing at a point on the map and looking east. Count how many times the boundary of the danger zone crosses your line of sight. If you cross it an odd number of times, you must be inside it.

A hull-candidate cache (`hullCache`) is checked first. If the hull vertices have not changed since the last run, the previously computed candidates are returned immediately without re-running Ray Casting (`convexHull.js` lines 505-529).

#### The Linear Handler

When the linear handler triggers (fewer than 3 valid hull edges, only 2 input points, or all points are collinear), patrols are placed along the incident line using evenly-spaced positions (`convexHull.js` lines 96-143):

`position_k = k / (n + 1)  for k = 1 through n`

Dividing by `n+1` instead of `n` ensures equal buffer on both endpoints: with two endpoints and three patrols, the patrols land at positions 1/4, 2/4, and 3/4 along the line rather than at 0, 1/2, and 1. The pipeline terminates after Stage 1 when the linear handler fires: Stages 2, 3, and 4 are all skipped.

---

### 9.3 Stage 2: Hill Climbing (hillClimbing.js)

**File: `server/algorithms/hillClimbing.js`** — the file that finds the optimal positions for patrol units within the danger zone.

**What problem it solves:** Given the valid candidate nodes (road nodes inside the hull from Stage 1), find the positions for n patrol units such that the minimum distance between any two patrols is as large as possible. Maximizing this minimum separation ensures patrols are spread out as widely as possible across the danger zone, maximizing coverage.

**Why this objective:** If two patrols are very close together, they overlap in coverage and leave other areas unguarded. Maximizing the smallest pairwise distance forces all patrols to be as far apart from each other as they can be, spreading them evenly across the area.

**Input:**
- `validCandidates`: road nodes inside the hull (from Stage 1)
- `n`: number of patrol units
- `hullAreaM2`: hull area in square meters (used to compute search radius)
- `config`: algorithm parameters
- `options`: contains `seed` (the deterministic random seed), `pushProgress` (callback for real-time animation), and `roadDistMatrix` (the precomputed pairwise road distance matrix)

**Output:** A structured result containing the final patrol positions (`patrols`), the best minimum pairwise distance achieved, which restart produced the best result, a confidence score, a convergence curve, and a detailed trace log.

#### What Hill Climbing Is

**Hill Climbing** is a family of optimization techniques that work like physically climbing a hill in fog: you look at all the steps you could take from your current position, pick the one that goes uphill, and take it. You keep doing this until no uphill step exists, at which point you are at a local peak.

The "hill" in this case is the minimum pairwise distance between patrols: you want to maximize it. Each "step" is moving one patrol unit to a neighboring road node. After each move, you check whether the minimum pairwise distance improved.

The problem with basic hill climbing is that it can get stuck on a **local maximum**: a position that is better than all its immediate neighbors, but not the globally best position. This is like reaching a small hill when there is a much taller mountain nearby. The solution is to **restart** from a new random position many times and keep the best result found across all restarts.

#### Pseudorandom Number Generator (mulberry32)

`mulberry32(seed)` at `hillClimbing.js` lines 17-24 is a **seedable PRNG** (pseudorandom number generator): a function that produces a sequence of numbers that appear random but are entirely determined by the starting seed value. It uses the Vigna 2017 mulberry32 algorithm, which is fast and has good statistical properties.

Each restart gets a unique sub-seed derived from the master seed: `(masterSeed XOR (restartIdx * 2654435761)) >>> 0`. Here `XOR` is the exclusive-OR bitwise operation (a standard way to combine numbers to produce a new number), and `2654435761` is the **Knuth multiplicative constant** (a number chosen for its statistical properties in hashing). The `>>> 0` converts the result to an unsigned 32-bit integer. This ensures each restart starts from a different position in the search space while remaining fully deterministic.

#### Special Cases

**n = 1** (`hillClimbing.js` lines 164-200): When only one patrol unit is needed, Hill Climbing is skipped entirely. The single best position is found by computing the average road distance from each candidate node to all other candidate nodes and selecting the candidate with the smallest average. This is the most central accessible node, which is an intuitively good position for a single patrol. Confidence is set to 100 since there is no uncertainty in the result.

**n greater than the number of valid candidates** (`hillClimbing.js` lines 203-222): If the hull is very small and contains fewer road nodes than the requested number of patrols, n is reduced to the number of available candidates and a warning is emitted. You cannot place more patrols than there are eligible positions.

#### Search Radius R

The search radius R controls how far a patrol can move in one iteration:

`baseR = Math.sqrt(hullAreaM2 / validCandidates.length) * config.hillClimbing.radiusMultiplier`

Breaking down every component:
- `hullAreaM2`: the area of the danger zone in square meters.
- `validCandidates.length`: the number of eligible road nodes inside the hull.
- `hullAreaM2 / validCandidates.length`: the average area per candidate node, which represents how densely the road network covers the danger zone.
- `Math.sqrt(...)`: the square root of that average area approximates the average spacing between candidate nodes (since area = side², side = sqrt(area)).
- `* radiusMultiplier` (default 2): scales the base radius up to allow patrols to jump farther than just to their nearest neighbor.

If all patrols have no candidate neighbors within R, R is expanded by 50% (`hillClimbing.js` lines 412-417). This prevents the algorithm from getting stuck when the patrol is in a sparse area.

#### Restart Budget

`maxRestarts = config.hillClimbing.restarts * effectiveN` (`hillClimbing.js` line 230).

With the default `restarts = 100` and n = 3, this gives 300 maximum restarts. The minimum is `max(5, n)` restarts (you always run at least as many restarts as there are patrols). Each restart begins from a fresh random configuration, generated by a Fisher-Yates shuffle (a standard unbiased shuffling algorithm) of the candidate nodes, taking the first n as starting positions.

#### Asynchronous Mode (the Default)

In **asynchronous mode**, each iteration processes patrols in a randomly shuffled order. Each patrol sees the positions that earlier patrols in the same iteration have already moved to. For each patrol `si` at index `idx` in the shuffled order (`hillClimbing.js` lines 356-408):

1. Find all unoccupied valid candidates within road distance R of `si`'s current position (`findNeighbors`).
2. Precompute `minPairwiseExcluding(si)`: the minimum pairwise distance among all patrols not including `si`. This is computed once per patrol per iteration and used as a baseline for evaluating each potential move.
3. For each neighboring candidate v:
   - Compute the minimum road distance from v to all other patrols (O(n) loop).
   - `newGlobalMin = min(minExcludingSi, minFromV)`.
   - If `newGlobalMin` is greater than the current best minimum, save v as the best neighbor.
4. If a best neighbor was found, move `si` to that neighbor.

`minPairwiseExcluding` at `hillClimbing.js` lines 62-76 is precomputed once per patrol per iteration. Because it excludes the current patrol from the calculation, the per-neighbor evaluation only needs to compute one patrol's distances (O(n)) instead of all pairs (O(n²)).

`findNeighbors` at `hillClimbing.js` lines 82-113 uses `roadDistMatrix` for O(1) distance lookup per candidate. It simply iterates all candidates and keeps those whose pre-computed road distance to the current patrol is within R.

#### Synchronous Mode

When `config.hillClimbing.synchronousMode === true` (`hillClimbing.js` lines 285-338), the iteration works differently:

- **Phase 1:** Compute the proposed best move for every patrol using only the current (pre-iteration) positions. No patrol sees what any other patrol is planning to do.
- **Phase 2:** Apply all non-conflicting moves simultaneously. If two patrols propose the same target node, the first in the shuffled order claims it and the other skips its move.

This is mathematically different from asynchronous mode. In asynchronous mode, each patrol benefits from information about where earlier patrols in the same iteration have moved. In synchronous mode, all patrols make decisions simultaneously with the same information, more closely resembling how real deployed units would coordinate.

#### Adaptive Convergence

After each restart, the algorithm checks whether it has found a stable solution and can stop early (`hillClimbing.js` lines 478-491):

```
last3 = the minimum pairwise distances from the last 3 restarts
if max(last3) > 0 AND (max(last3) - min(last3)) / max(last3) < 0.001:
    break (converged: the spread across the last 3 restarts is under 0.1%)
```

The algorithm always runs at least `minRestarts = max(5, n)` restarts before checking convergence. It never exceeds `maxRestarts`. If the last three restarts all produced essentially the same best minimum distance (within 0.1% of each other), continuing would be unlikely to find anything better, so the algorithm stops.

In plain terms: if three runs in a row give you nearly identical results, you have probably found the best answer, and running more restarts would just waste time.

#### Confidence Indicator

After all restarts complete, the system computes a confidence score representing how reliable the result is (`hillClimbing.js` lines 541-554):

```
mean       = average of all restart minDist scores
stdDev     = square root of the variance across all restart scores
consistency   = max(0, min(100, (1 - stdDev / mean) * 100))
redundancy    = percentage of restarts that confirmed the best without beating it
confidence    = 0.5 * consistency + 0.5 * redundancy
```

The composite score combines two independent signals:
- **Consistency (50% weight):** How tightly clustered are the results across all restarts? A low coefficient of variation (stdDev / mean) means every restart found a similar answer, indicating the algorithm reliably converges to the same region. High consistency gives high confidence.
- **Confirmation (50% weight):** What fraction of restarts found the same best answer without improving it? If most restarts confirm the best result, the solution is stable. High redundancy (many confirming restarts) gives high confidence.

In plain terms: if every random starting position leads to approximately the same patrol placement, you can be confident that placement is genuinely optimal. If each restart produces very different results, the answer is less certain.

#### Convergence Curve

`bestSoFarCurve` is a monotonically non-decreasing array (each value is always greater than or equal to the previous) where `bestSoFarCurve[i]` is the best minimum pairwise distance seen through restart i. The frontend renders this as a bar chart in the trace panel, showing how quickly the algorithm improved.

`convergenceRestart` is the last restart index (1-based) at which the best result improved. All subsequent restarts confirmed but did not beat it. `redundancy` is computed from this: if the best was found on restart 7 out of 20 total restarts, then 13 restarts confirmed it, giving a redundancy of 65%.

---

### 9.4 Stage 3: Zone Assignment (zoneAssignment.js)

**File: `server/algorithms/zoneAssignment.js`** — the file that divides all incident locations among the patrol units, giving each patrol a defined zone of responsibility.

**What problem it solves:** After Stage 2 places patrol units at their optimal positions, each incident location needs to be assigned to exactly one patrol. The patrol "closest" to an incident (by real road distance, not straight-line distance) is responsible for that incident's area. The result is a set of zones: one zone per patrol, where each zone contains the list of incidents assigned to that patrol.

**Input:**
- `incidents`: the original incident coordinates
- `patrols`: Stage 2's output, the optimal patrol positions
- `validCandidates`: road nodes inside the hull
- `hull`: the danger zone polygon from Stage 1
- `adjacencyList`: the road network graph
- `dijkstraCache`: shared cache for Dijkstra results (also used by Stage 4)
- `config`: algorithm parameters
- `options`: includes `bestRestartIndex`, `removedNodes`, and `snapCandidates`

**Output:** A structured result containing the zone arrays, counts of empty/single-node/multi-node zones, excluded crime nodes with their reasons, snapping distance statistics, the road distance matrix, and a detailed trace log.

#### Step 1: Silent Snapping

Each incident location as the user clicked it on the map is unlikely to fall exactly on a road node. Before zone assignment can happen, each incident needs to be **snapped** to the nearest road node. "Silent" means the user's plotted marker stays at the clicked position; the snap target is invisible and only used for routing calculations (`zoneAssignment.js` lines 35-60).

`snapToNearestCandidate` uses the following process:
1. Apply a bounding box pre-filter to find candidate nodes near the incident.
2. Among those nearby candidates, find the one with the smallest Haversine distance.
3. If no candidate is found within the initial search radius (default 500m), expand the radius by 50% and try again.
4. Keep expanding until a candidate is found or the search radius exceeds the hull's diameter. If no candidate is found within the hull diameter, the incident is excluded.

`snapCandidates` (passed from `pipeline.js`) always uses all road nodes, not just intersection nodes. This ensures snap accuracy is not degraded when the patrol placement toggle is set to `'intersection'`.

In plain terms: snapping finds the nearest actual street point to each incident. This is necessary because patrol routes follow roads, and a route must start and end on road nodes.

#### Step 2: Deduplication

If two incidents snap to the exact same road node, keeping both would cause the routing algorithm to visit the same location twice for no reason. Only the first incident is kept for routing purposes. Both visual markers remain on the map. A warning is emitted for each merge so the user can see it in the trace panel (`zoneAssignment.js` lines 299-315).

#### Step 3: Dijkstra Pre-computation

For each unique snapped node, the system runs `runDijkstra` once, which gives road distances from that node to every other node in the graph simultaneously (`zoneAssignment.js` lines 320-339).

With m unique snapped incident positions, this requires only m Dijkstra calls. The result is stored as `distanceMatrix[snappedNodeId][patrolIndex]`: the road distance from each snapped incident to each patrol's position.

The `dijkstraCache` object is mutated in-place during this step. Stage 4 reuses every result Stage 3 computed, achieving near-100% cache hit rates for the patrol-to-incident pairs that Stage 4 will also need.

#### Step 4: Zone Assignment

Each incident is assigned to the patrol with the minimum road network distance (`zoneAssignment.js` lines 348-384). When two patrols have equal road distances to an incident, the patrol with the lower index number wins.

**Euclidean fallback:** If all road distances from an incident to all patrols are infinity (meaning that incident's snapped node is on a disconnected portion of the road network with no path to any patrol), the system falls back to using straight-line Haversine distance instead and emits a warning. A `haversineFallback: true` flag is stored on that incident node.

In plain terms: each incident is assigned to whichever patrol can reach it by the shortest walking route. In the rare case where no road connection exists, straight-line distance is used as a fallback.

#### Zero Distance Waypoints

After zone assignment, the system checks whether any incident's snapped position is the same node as its assigned patrol's position (meaning the patrol is already at that location). The road distance is 0 in this case, which is valid. The system notes it in the trace log for transparency.

#### Step 5: Zone Rebalancing

The initial zone assignment gives each incident to its nearest patrol, but this can produce unequal zone sizes. One patrol might end up with many more incidents than another. Rebalancing corrects this.

Two modes are available, selected by `config.zoneAssignment.strongRebalancing`:

**Light rebalancing** (the default, `zoneAssignment.js` lines 67-122):

The system runs up to 10 rebalancing iterations. Each iteration:
1. Finds the largest and smallest non-empty zones.
2. Checks whether the largest zone has more than twice the average size AND the smallest zone has less than half the average size.
3. If so, finds **boundary incidents** in the largest zone: incidents where the road distance to the largest zone's patrol and the road distance to the smallest zone's patrol differ by less than 10%.
4. Moves the boundary incident closest to the smaller zone's patrol from the large zone to the small zone.
5. If the largest zone is now at most 1.5 times the average size, stops early.

**Strong rebalancing** (opt-in, `zoneAssignment.js` lines 130-186):

Forces all non-empty zones to within the range `[floor(target), ceil(target)]` incidents, where `target = totalIncidents / nonEmptyZones`. At each step, it picks the incident in any overloaded zone with the minimum road distance to any underloaded patrol and moves it there. This continues until all zones are within the target range.

In plain terms: light rebalancing nudges the zones toward balance when they are very unequal. Strong rebalancing enforces near-equal zone sizes regardless of geography, which may assign some incidents to patrols that are not the nearest.

#### Step 6: Zone Cap

Hard limit: no zone can contain more than `config.tsp.maxCrimeNodesPerZone` incidents (default 12). If a zone exceeds this limit, the incidents with the greatest road distance to their patrol are moved to `excludedCrimeNodes` with the reason `'zone_cap'` (`zoneAssignment.js` lines 419-438).

The cap exists because Stage 4's backtracking TSP algorithm has O(k!) time complexity (explained in Section 9.5), which becomes prohibitively slow for large k. Capping at 12 ensures TSP never needs to solve a problem with more than 12 incidents, keeping it fast.

#### Step 7: Zone Classification

Each patrol's zone is classified into one of three types (`zoneAssignment.js` lines 444-464):

- **Empty:** 0 incidents assigned. The patrol remains stationary (Deploy Only mode) or is marked as stationary in Deploy and Route mode.
- **Single-node:** 1 incident assigned. In Stage 4, the patrol makes a direct out-and-back visit to that one location.
- **Multi-node:** 2 or more incidents assigned. Stage 4 computes an optimal visiting sequence using TSP.

---

### 9.5 Stage 4: Backtracking TSP (tsp.js)

**File: `server/algorithms/tsp.js`** — the file that determines the optimal walking route for each patrol unit to visit all its assigned incidents and return to its starting position.

**What problem it solves:** The **Travelling Salesman Problem** (TSP) asks: given a set of locations to visit, what is the shortest possible route that visits every location exactly once and returns to the starting point? In PatrolPoint's context, each patrol unit needs a walking circuit that visits every incident in its zone and comes back to its patrol post.

**Why TSP is hard:** TSP is one of the most famous problems in computer science. The number of possible routes grows factorially with the number of locations: with k locations, there are k! (k factorial) possible orderings to check. With k = 5, that is 120 routes. With k = 10, that is 3,628,800 routes. This is why the system caps zones at 12 incidents and uses heuristics for larger zones.

**Input:**
- `zones`: Stage 3's output, the incident assignments per patrol
- `patrols`: Stage 2's patrol positions
- `multiNodeZones` and `singleNodeZones`: classified zone lists from Stage 3
- `nodeMap`: road network node coordinates
- `adjacencyList`: road network graph
- `dijkstraCache`: shared Dijkstra cache
- `config`, `hull`, and `options`

**Output:** A structured result containing one route per patrol, each with the visit sequence, total circuit distance in meters, and the actual road-following coordinates for every leg of the route.

#### Hull Exterior Penalty

When `config.tsp.hullExteriorPenalty > 1`, Dijkstra calls in Stage 4 use a separate local cache rather than the shared `dijkstraCache` (`tsp.js` lines 129-133):

```js
const penaltyActive  = exteriorPenalty > 1 && hull && hull.length >= 3;
const effectiveCache = penaltyActive ? {} : dijkstraCache;
```

This separation is critical: penalized distances (inflated edge weights for roads outside the hull) must not overwrite the unpenalized distances stored in the shared cache from Stage 3. Mixing them would corrupt the zone assignment data.

In plain terms: when the exterior penalty is active, Stage 4 uses its own separate distance table so it does not contaminate Stage 3's table with inflated values.

#### Distance Matrix Construction

For each patrol zone, the system builds a local distance matrix covering the patrol's starting position and all its assigned incident nodes. `buildDistanceMatrix([sId, ...crimeNodeIds])` runs Dijkstra from each unique source node (`tsp.js` lines 159-169).

Because single-source Dijkstra gives distances to all nodes in one pass, computing the matrix for k crime nodes plus 1 patrol start requires only k+1 Dijkstra calls total (not k² calls for all pairs). Cache hits from Stage 3 are automatically reused, so in practice many of these Dijkstra calls return instantly from the cache.

#### Algorithm Selection

For each multi-node zone with k reachable incident nodes, the system selects an algorithm based on k (`tsp.js` lines 360-399):

| Condition | Algorithm used | Time complexity |
|-----------|----------------|-----------------|
| k = 2 | Direct shortcut | O(1): both orderings have the same total distance on an undirected graph |
| k > 12 (default threshold) | Nearest neighbor heuristic | O(k²): greedy, approximate |
| Otherwise | Backtracking TSP | O(k!): exact, with pruning |

O(1) means the result is computed in constant time regardless of input size. O(k²) means the time grows with the square of k. O(k!) means the time grows factorially (extremely fast). At k = 12, 12! = 479,001,600 possible routes, but pruning (described below) eliminates most branches before they are fully explored.

In plain terms: for zones with 2 incidents, the answer is trivial. For zones with up to 12 incidents, the system finds the guaranteed optimal route. For larger zones, it uses a fast approximation.

#### Backtracking TSP Algorithm

`backtrack(current, accumulated, visited, route)` at `tsp.js` lines 46-78:

```
IF accumulated >= bestCircuit: prune (current partial route already costs too much to improve)
IF all k incidents visited:
    total = accumulated + D[current][start]
    IF total < bestCircuit: update bestCircuit and optimalSequence
    return
FOR each unvisited incident:
    IF D[current][incident] == Infinity: skip (unreachable)
    backtrack(incident, accumulated + D[current][incident], visited+incident, route+incident)
```

The key optimization is the **pruning condition**: if the cost so far (`accumulated`) already equals or exceeds the best complete circuit found so far (`bestCircuit`), there is no point continuing down this branch, because adding more legs can only make the total larger. The algorithm immediately backtracks.

This pruning dramatically reduces the effective search space in practice. In most real cases with 6-8 incidents, the algorithm explores far fewer than k! branches because most branches are cut off early.

In plain terms: backtracking TSP is like trying every possible order of stops on a journey, but crossing off any partial journey the moment it becomes longer than the best complete journey found so far. You never waste time finishing a route you already know cannot win.

#### Nearest Neighbor Heuristic

For zones with more than 12 incidents, `nearestNeighbor` at `tsp.js` lines 19-41 is used instead:

1. Start at the patrol's position.
2. Visit the nearest unvisited incident (by road distance).
3. From there, visit the nearest unvisited incident.
4. Repeat until all incidents are visited, then return to the patrol's position.

This is O(k²): for each of the k stops, you scan all remaining unvisited incidents to find the nearest. It is not guaranteed to produce the optimal route, but it reliably produces a reasonable one very quickly. The trace log notes when this heuristic is used.

#### Path-Aware Sequence Adjustment

After TSP or nearest-neighbor produces a visit order, `adjustSequence` at `tsp.js` lines 217-257 applies a post-processing step that can eliminate unnecessary detours.

The insight: if the shortest road path from incident A to incident B naturally passes through incident C (which is scheduled to be visited later), it is more efficient to visit C at that point rather than traveling past it and coming back later.

The algorithm works in passes:

```
WHILE any adjustment was made this pass:
    FOR each consecutive pair (from, to) in the current circuit:
        path = the Dijkstra road path from "from" to "to"
        IF any intermediate node on that path is an incident scheduled for later:
            Move that incident to immediately after "from" in the sequence
```

In plain terms: if your route from Point A to Point B naturally walks past Point C, visit C on the way rather than doubling back to it later.

#### Path Segments

Every route includes `pathSegments`: an array where each entry is the sequence of actual road coordinates for one leg of the circuit. These are produced by `processLeg(fromId, toId)` at `tsp.js` lines 194-211 using Dijkstra's path reconstruction. These coordinates are what the frontend draws on the map as colored polylines following the actual roads.

Each patrol's route object looks like: `{ sequence, circuitDistanceM, pathSegments: [[{lat,lng}]] }`.

#### Single-Node Zones

For zones with exactly one incident, the route is always `patrol -> incident -> patrol`. Two Dijkstra calls are made (outbound path and return path). Both legs are included explicitly in `pathSegments` so the frontend can show both the outbound and return paths on the map.

#### Overlap Detection

`edgeUsage` is a map from edge keys to sets of patrol IDs, accumulated across all `processLeg` calls (`tsp.js` lines 204-208). After all routes are built, any edge (road segment) used by two or more distinct patrols is reported as an `overlapEdge`. Using a `Set<patrolId>` per edge (rather than a simple count) prevents a single patrol traversing a dead-end road and back from being incorrectly counted as overlap between two patrols.

The overlap data is used by the frontend to draw colored overlay lines on road segments shared by multiple patrols.

---

### 9.6 Post-Pipeline Verifier (verifier.js)

**File: `server/algorithms/verifier.js`** — the file that checks the correctness of the entire pipeline's output after all four stages complete.

**What problem it solves:** Even well-tested code can produce subtly incorrect results for edge cases. The verifier independently re-examines the pipeline's output to confirm that the mathematical guarantees hold: every incident is inside the hull, every patrol is inside the hull, every incident is assigned to exactly one zone, and every TSP route is genuinely optimal (for small zones where this can be checked exhaustively).

The verifier is **non-fatal**: if it throws an error internally, the pipeline still returns its results to the browser. A failed verification is informational, not a crash. The verification report appears in the trace panel.

`verifyAll(pipelineResult)` at `verifier.js` lines 312-386 orchestrates four independent checks.

#### verifyConvexHull

For each non-outlier incident, runs `isPointInHull` (Ray Casting from Section 9.2). Returns `pass: false` if any incident is outside the hull (`verifier.js` lines 47-66).

In plain terms: confirms that the rubber band is actually around all the pins.

#### verifyPatrolPositions

Three checks (`verifier.js` lines 70-115):
1. All patrol positions are inside the hull (Ray Casting).
2. All patrol node IDs are distinct (no two patrols placed at the same road node).
3. All patrol node IDs are members of `validCandidates` (patrols are on eligible nodes).

#### verifyZoneAssignment

Three checks (`verifier.js` lines 124-200):
1. No incident appears in more than one zone (no duplicates).
2. Every non-outlier incident is either in a zone or listed in `excludedCrimeNodes` with a reason. No incidents silently disappear.
3. Each assigned incident is within 10% of road distance of the nearest patrol. The 10% tolerance allows for intentional zone rebalancing deviations (an incident may be assigned to a slightly farther patrol if rebalancing moved it).

#### verifyTSPRoute

Per-route checks (`verifier.js` lines 213-287):
1. The route sequence contains exactly k incident nodes.
2. All k node IDs in the sequence are unique (each incident visited exactly once).
3. The recomputed circuit distance matches the reported `circuitDistanceM` within 1 meter (confirming arithmetic was done correctly).
4. **Exhaustive optimality check** for k <= 6 and non-approximate routes only: enumerates all k! permutations and confirms the returned sequence has the minimum total distance. For k = 6, this is 720 permutations, which is very fast.

For k > 6, or for zones that used the nearest-neighbor heuristic, the exhaustive check is skipped and noted in the report. The nearest-neighbor heuristic is approximate by design, so it would be incorrect to test it for optimality.

---

## 10. Middleware

**Middleware** is software that runs in between an incoming request and the final handler that processes it. Think of it like security checkpoints at an airport: every passenger must pass through identification, then the boarding pass check, then the security scanner, before reaching the gate. Middleware works the same way: every incoming request passes through configured middleware functions before reaching the route that handles it.

### Rate Limiter (server/middleware/rateLimit.js)

The rate limiter prevents any single user or automated script from sending too many requests in a short period. This protects the server from being overwhelmed.

```js
export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15-minute window
    max: 100,                    // 100 requests per window per IP address
    standardHeaders: true,
    legacyHeaders:   false
});
```

- `windowMs: 15 * 60 * 1000`: The time window in milliseconds. 15 minutes × 60 seconds × 1000 milliseconds = 900,000 milliseconds.
- `max: 100`: The maximum number of requests allowed from one IP address within the window.
- `standardHeaders: true`: Includes `RateLimit-*` headers in responses so the client knows how many requests it has remaining.
- `legacyHeaders: false`: Disables the older `X-RateLimit-*` header format.

This limiter is applied to all `/api` HTTP routes. The WebSocket compute requests have a separate in-memory rate limiter in `pipelineSocket.js` that allows 20 compute requests per 5-minute window per IP.

### Input Validation (server/middleware/sanitize.js)

**File: `server/middleware/sanitize.js`** — a collection of validation functions that check whether incoming data is safe and sensible before it is passed to the algorithms.

These are not traditional Express middleware functions (they are not applied to all routes automatically). Instead, they are helper functions called explicitly inside the WebSocket compute handler before starting the pipeline. All functions throw an `Error` with a descriptive message if validation fails.

| Function | What it checks |
|----------|----------------|
| `validateIncidents` | Must be an array, minimum 1 element, maximum 300 elements. Each element must have `lat` (a finite number between -90 and 90) and `lng` (a finite number between -180 and 180). |
| `validateN` | Must be a whole number (integer) between 1 and 100. |
| `validateMode` | Must be exactly the string `'stationary'` or the string `'roaming'`. |
| `validateBarangay` | Must be a non-empty string, at most 255 characters, containing only letters, numbers, and spaces. |
| `validateConfig` | Checks every CONFIG field for being within an acceptable numeric range. Prevents users from setting, for example, a negative restart count or a radius multiplier of one million. |

The limits are set to practical maximums: 300 incidents is far more than any real use case would produce, and 100 patrols covers any conceivable barangay deployment.

---

## 11. Frontend Architecture

The frontend is the portion of PatrolPoint that runs in the user's web browser. It is built with plain (vanilla) JavaScript rather than a framework like React, with Alpine.js added for reactive UI behavior and Leaflet for map rendering.

The frontend is split into four JavaScript files, each with a distinct responsibility:

- `client/js/main.js`: sets up all global state and triggers initialization.
- `client/js/websocket-client.js`: manages the WebSocket connection and handles all incoming messages.
- `client/js/map.js`: manages the Leaflet map and all visual rendering.
- `client/js/ui.js`: defines the Alpine.js component that powers all interactive controls.

### 11.1 main.js

**File: `client/js/main.js`** — the first file to run when the page loads, responsible for declaring all shared state and triggering initialization.

#### Global State

`main.js` declares all shared application state on the `window` object (JavaScript's global namespace, accessible from any script). This is the single source of truth for non-reactive state:

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

Each variable explained:
- `window.P`: The array of all incident locations the user has plotted. Each object has a unique `crimeId` (like `CRIME-001`), a latitude, and a longitude.
- `window.crimeIdCounter`: A counter that increments every time a new incident is added, used to generate sequential IDs. It never decrements; removed incidents leave gaps in the sequence.
- `window.currentHull`: The danger zone polygon from Stage 1. Null until the first pipeline run completes Stage 1.
- `window.S_star`: The array of optimal patrol positions from Stage 2.
- `window.zones`: The zone assignment arrays from Stage 3.
- `window.routes`: The TSP route objects from Stage 4 (empty in stationary mode).
- `window.pipelineRunning`: A flag used to disable the Recalculate button while a pipeline is in progress.
- `window.removedNodes`: A `Set` of node IDs the user has manually blocked in OSM Graph mode.

#### Initialization Sequence

On `DOMContentLoaded` (an event that fires when the browser has finished parsing the HTML page but before images and other resources have loaded), `main.js` at lines 60-79 runs:

1. Load `darkMode` and `animationsEnabled` from `localStorage` (persistent browser storage that survives page reloads).
2. Apply the `dark` CSS class to `document.documentElement` immediately, before any rendering happens, to prevent a brief white flash on dark-mode page loads.
3. Restore a saved authentication token if one exists.
4. Call `initMap()` and `initWebSocket()` to start the map and connect to the server.

---

### 11.2 websocket-client.js

**File: `client/js/websocket-client.js`** — the file responsible for the WebSocket connection, all incoming message handling, and building the trace panel content.

#### Connection Management

The client connects to the WebSocket server at lines 114-158:

1. Determines whether to use `ws://` (unencrypted, for development) or `wss://` (encrypted, for production) based on `window.location.protocol`. If the page was served over HTTPS, WebSocket connections must also use WSS.
2. Connects and sends an `init` message with the selected barangay.
3. On close or error, waits 3 seconds and reconnects, up to `MAX_RECONNECT = 5` attempts.
4. Sends a `ping` message every 30 seconds via `setInterval` to keep the connection alive. Without keepalive pings, some network infrastructure (proxies, load balancers) may close idle connections.
5. After 5 failed reconnection attempts, displays an error banner instructing the user to refresh the page.

#### Message Dispatch

`websocket-client.js` at lines 162-187 routes each incoming message type to its handler. All 10 server-to-client message types defined in the WebSocket protocol are handled here.

#### Placeholder System

`websocket-client.js` at lines 36-56 defines placeholder functions for all the map rendering callbacks:

```js
export let onHullComplete    = (result) => console.log('placeholder');
export function replacePlaceholder(name, fn) { ... }
```

`map.js` calls `replacePlaceholder('onHullComplete', renderHull)` during map initialization to wire the actual rendering function in place of the placeholder. This decoupling means `websocket-client.js` can be loaded and work without depending on `map.js` being loaded first. The placeholder simply logs to the console until the real function is installed.

In plain terms: this is like installing a temporary light switch that does nothing until an electrician comes and connects it to the actual circuit.

#### Trace Panel Construction

`websocket-client.js` at lines 569-1351 contains all the logic for building the trace panel content. When a `stage_complete` message arrives, four builder functions are called for each stage:

- `buildTraceSummary(stage, result)`: produces the one-line status displayed in the collapsed trace card header.
- `buildTraceMetrics(stage, result)`: produces the array of labeled metrics shown in the expanded metrics grid (values like "Best Distance: 234m", "Restarts: 47").
- `buildStage_Subparts(stage, result)`: produces the step-by-step breakdown describing what the algorithm computed in this specific run.
- `buildNarrative(stage, result)`: produces a one-sentence human-readable summary of this run's result, filled with actual numbers from the data.

These builders are what transform raw algorithm output numbers into the human-readable descriptions you read in the trace panel.

#### sendComputeRequest

`sendComputeRequest` at `websocket-client.js` lines 1356-1382 validates inputs on the client side before sending the `compute` message:

```js
ws.send(JSON.stringify({
    type: 'compute',
    data: { incidents, n, mode, config, barangay,
            removedNodes: Array.from(window.removedNodes || []) }
}));
```

`Array.from(window.removedNodes)` converts the `Set` object to a plain array, because JSON serialization cannot handle `Set` objects directly.

---

### 11.3 map.js

**File: `client/js/map.js`** — the file that creates and manages the Leaflet map, including all visual elements drawn on it.

#### Map Constants

```js
const MAP_CENTER   = [14.7028, 121.0944];  // Commonwealth barangay center
const MAP_ZOOM     = 15;
const MAP_MIN_ZOOM = 10;
const MAP_MAX_ZOOM = 18;  // BUG FIX: V1 used 19, OSM tiles unavailable there
```

`MAP_MAX_ZOOM = 18` is a deliberate bug fix from V1. OpenStreetMap tiles (the map images) are only available up to zoom level 18. At zoom 19, the map would show blank grey tiles. CartoDB tiles (used in dark mode) technically support level 19, but the system caps at 18 for consistency.

#### Module-Level State

`map.js` at lines 19-53 declares module-level variables that track every active Leaflet layer. Key variables:

- `hullPolygon`: the blue polygon showing the danger zone boundary.
- `barangayMask`: the translucent overlay that darkens the area outside the barangay.
- `patrolClusterGroup`: the Leaflet.markercluster group that automatically clusters patrol markers at low zoom.
- `patrolMarkerMap`: maps each patrol ID to its marker, color, number, style (roaming or stationary), and optional coverage circle.
- `zoneLinesList`: array of dashed colored lines from patrols to their assigned incidents.
- `routePolylines`: maps each patrol ID to its route polylines and direction decorators.
- `overlapOverlayLines`: the orange and red overlay lines on shared road segments.
- `crimeMarkerMap`: maps each crime ID to its Leaflet marker.
- `osmGraphLayers`: all the lines and circles drawn when OSM Graph mode is active.
- `_lastRoutes`, `_lastPatrols`, `_lastZones`: stored copies of the most recent pipeline results, used to populate the patrol info panel and other dynamic content.
- `_crimeAssignmentMap`: maps each crime ID to its assigned patrol, used to update crime popup content after Stage 3 completes.

#### Patrol Info Panel

`PatrolInfoPanel` at `map.js` lines 70-92 is a custom Leaflet control (a UI element anchored to the map) positioned in the top-right corner. It replaces the default Leaflet popup for patrol detail display. When you click a patrol marker, this panel shows the patrol's position, circuit distance, crime node count, and a clickable list of assigned crime IDs. Clicking a crime ID in the panel pans the map to that crime marker.

#### Map Initialization

`initMap(ui)` at `map.js` lines 95-307 sets up everything:

1. Creates the Leaflet map with the constants above.
2. Adds both tile layers (light and dark) and activates the correct one based on `window.darkMode`.
3. Binds `mousemove` to update the coordinate display at the bottom of the map.
4. Binds map `click` to add crime nodes, with validation that the click is inside the barangay boundary and not on a duplicate coordinate.
5. Binds `zoomend` to re-render the overlap overlay when the zoom level changes.
6. Creates the `patrolClusterGroup` with clustering disabled below zoom level 10.
7. Instantiates and adds the `PatrolInfoPanel` control.
8. Exposes global handlers for popup buttons (since Leaflet replaces popup HTML, the button handlers must be on `window` to survive that replacement).
9. Fetches the initial barangay boundary JSON for the darkening mask.
10. Wires all WebSocket placeholder callbacks to the actual rendering functions using `replacePlaceholder`.

#### Barangay Boundary Darkening

The area outside the barangay is visually darkened using a technique called an **inverted polygon** (`map.js` lines 310-341):

```js
const worldRect = [[-90,-180],[90,-180],[90,180],[-90,180]];
barangayMask = L.polygon([worldRect, boundaryPolygon], {
    fillColor: '#000', fillOpacity: 0.45, stroke: false, interactive: false
}).addTo(map);
```

Leaflet's `L.polygon` supports **holes**: if you provide multiple rings, the first is the outer boundary and subsequent rings are holes punched through it. By making the outer boundary a rectangle covering the entire world and punching a hole in the shape of the barangay, the fill (dark overlay) covers everything except the barangay. The barangay itself shows through as the "hole" in the dark overlay.

#### OSM Graph Mode

When enabled, `toggleOsmGraphMode(true)` at `map.js` lines 355-472 removes the tile layer and replaces the map background with the raw road network graph:

1. Fetches the barangay's preprocessed JSON from `./data/barangays/{slug}.json` (loaded once, cached in `osmNetworkCache` for subsequent toggles).
2. Draws one thin grey polyline per road edge, deduplicated so each road segment is drawn once even though each edge appears in both node directions. Edges touching removed nodes are drawn in red.
3. Draws one small circle marker per road node. Removed nodes are shown as solid red circles.

Clicking a node marker calls `toggleNodeRemoval(nodeId, marker)` at `map.js` lines 440-453, which adds or removes the node from `window.removedNodes` and immediately updates the visual style of that node and all its connected edges.

#### Crime Node Markers

`plotCrimeMarker(point)` at `map.js` lines 545-597 creates a draggable marker using a custom HTML icon:

```html
<div class="crime-marker" id="cm-{crimeId}"></div>
<div class="crime-marker-label">{crimeId}</div>
```

The CSS class `cm-{crimeId}` allows the style to be updated later when the assignment status is known. The label shows the crime ID below the marker.

Markers are draggable. When the user releases a dragged marker, `dragend` fires:
- If the new position is inside the hull (tested with `pointInHull`), the position is updated in `window.P` and an undo action is pushed.
- If the new position is outside the hull, `marker.setLatLng([savedLat, savedLng])` snaps it back to its original position and a warning banner is shown.

#### Hull Rendering

`renderHull(hullVertices)` at `map.js` lines 635-650 creates or updates the hull polygon. On subsequent calls, it uses `setLatLngs` on the existing polygon object rather than creating a new one, which avoids unnecessary layer creation and removal (called "layer churn"). The hull polygon is blue, 12% fill opacity, dashed stroke, and set to `interactive: false` so clicks pass through to the map below.

#### Patrol Markers

Two visual styles exist for patrol markers:

**Roaming icon** (`_roamingIcon(color, num, confidence)` at `map.js` lines 730-742): A circular `L.divIcon` (24x24px) with the patrol number centered in the patrol color. Optionally includes a small colored badge showing the Hill Climbing confidence score: green for 80%+, yellow for 50%+, red below 50%.

**Stationary icon** (`_stationaryIcon(color, num)` at `map.js` lines 744-760): A downward-pointing teardrop SVG pin shape (28x36px) in the patrol color, with the patrol number plus "S" (for Stationary) overlaid inside.

`renderPatrolMarkers(patrols)` at `map.js` lines 653-692 adds markers to `patrolClusterGroup` and removes any stale markers from previous runs.

#### Zone Lines

`renderZoneLines(zones, patrols)` at `map.js` lines 762-786 draws thin dashed colored polylines from each patrol position to each of its assigned incident positions. These are removed when Stage 4 route rendering begins (in roaming mode, the routes replace the zone lines as the primary visual).

#### Coverage Radius

`renderCoverageRadius(patrols)` at `map.js` lines 789-807 draws one transparent circle per patrol. Leaflet's `L.circle` accepts `radius` in meters natively, so no coordinate conversion is needed. The default radius is 500 meters, configurable via the settings panel. Fill opacity is 10%.

#### Route Rendering

`renderRoutes(routes)` at `map.js` lines 902-948 draws the actual walking routes. It iterates `route.pathSegments` (the road-following coordinate arrays from Dijkstra path reconstruction) and draws each segment as a `L.polyline`. Direction arrowheads are added via `L.polylineDecorator` (if available) repeating every 30% of the line length with a pixel size of 6.

#### Route Highlight

`highlightPatrolRoute(patrolId)` at `map.js` lines 879-898 brings one patrol's route to visual prominence. The selected patrol's polylines are set to weight 7 and full opacity. All other patrols' lines drop to weight 2 and 20% opacity. `clearPatrolHighlight()` restores all lines to weight 4 and 90% opacity.

#### Overlap Overlay

`renderOverlapOverlay(routes)` at `map.js` lines 964-1018 uses a two-pass algorithm:

**Pass 1:** For every path segment in every route, accumulate a map of `edgeKey -> Set<patrolId>`. Using a Set prevents a single patrol traversing the same dead-end road twice from counting as overlap with itself.

**Pass 2:** For every edge with two or more distinct patrols, draw one overlay polyline. Color is orange at 60% opacity for exactly 2 patrols sharing a road, red at 60% opacity for 3 or more.

`_edgeKey(a, b)` at `map.js` lines 1008-1018 produces a consistent key for any edge regardless of travel direction: it uses numerically sorted node IDs when available, falling back to rounded coordinates.

#### Route Playback

`startRoutePlayback(patrolId, speed)` at `map.js` lines 1278-1345 animates a dot moving along a patrol's route:

1. Flattens all `pathSegments` into a single ordered array of coordinates.
2. Precomputes cumulative distances at each point.
3. Creates an animated marker with a CSS-styled dot using the patrol's color.
4. Runs a `requestAnimationFrame` loop that:
   - Computes the current progress fraction from elapsed time, looping via modulo 1.
   - Uses binary search on the cumulative distances to find the current segment.
   - Linearly interpolates the marker's position within that segment.
   - Updates the progress bar in the UI.

One full circuit takes `PLAYBACK_BASE_DURATION = 20` seconds at 1x speed.

#### Algorithm Comparison Overlay

`renderComparisonResults(runA, runB)` at `map.js` lines 1086-1155 renders two pipeline runs simultaneously:

- **Run A:** Solid filled patrol markers at full opacity, solid route polylines at weight 3.
- **Run B:** Hollow patrol markers (border-only in patrol color) at 60% opacity, dashed route polylines at weight 2.

Toggle buttons in the UI show or hide each run's layers independently.

#### Session Result Rendering

`renderSessionResults(session, ui)` at `map.js` lines 1159-1246 reconstructs all pipeline output from a saved session object, re-rendering the hull, patrol markers, zones, routes, and crime markers exactly as they appeared when the session was saved.

---

### 11.4 ui.js

**File: `client/js/ui.js`** — the file that defines the Alpine.js reactive component powering all interactive user interface controls.

#### Module-Level Utilities

A private `_haversine` function at `ui.js` lines 8-16 is used exclusively by `importCoordinates()` for client-side outlier detection. It is separate from the canonical version in `dijkstra.js` and is not exported.

`STAGE_INFO` at `ui.js` lines 19-36 is a plain object containing static descriptions for each stage number (1-4). Each entry has a `description` (what the stage does for the user) and an `algorithmNote` (complexity and implementation details). These strings are merged into trace panel entries and displayed regardless of the run data.

#### The Alpine.js Component: patrolPointApp()

The component is defined inside `document.addEventListener('alpine:init', ...)` at `ui.js` line 38 and exposed as `window.uiApp` in `init()` so `map.js`, `websocket-client.js`, and HTML onclick handlers can all call its methods.

**Key reactive properties:**

- `wsConnected`, `wsStatusText`: WebSocket connection state (used to show the connection indicator).
- `selectedBarangay`, `barangayOptions`, `barangayQuery`, `barangayDropdownOpen`: the barangay selector combobox.
- `nMax`: a soft cap on the patrol count input, computed as the floor of the square root of the intersection count. For Commonwealth with 914 intersections, nMax = 30.
- `nPatrols`, `nPatrolsError`: the patrol count value and its validation message.
- `deploymentMode`: `'stationary'` or `'roaming'`.
- `pipelineRunning`, `pipelineComplete`: used to disable the Recalculate button during runs.
- `traceStages`: array of stage objects, each containing the trace panel content for one stage.
- `activeConfig`, `settingsDraft`: two separate config copies (explained below).
- `undoStack`, `redoStack`: arrays of action objects (max 50 each).
- `darkMode`, `animationsEnabled`: display preferences, both persisted to `localStorage`.

**`activeConfig` versus `settingsDraft`** (`ui.js` lines 130-187):

Two separate deep copies of the configuration object live in the component. `activeConfig` is the configuration sent to the backend when the user clicks Recalculate. `settingsDraft` is only modified inside the settings modal.

When the user opens the settings modal, `openSettings()` deep-copies `activeConfig` into `settingsDraft`. While the modal is open, the user can change values freely. If they click Apply, `applySettings()` deep-copies `settingsDraft` back into `activeConfig`. If they click Cancel, `settingsDraft` is discarded with no effect.

In plain terms: the settings modal works on a copy, not the original. Changes only take effect when you explicitly click Apply. This prevents a half-edited settings panel from affecting a pipeline that is already running.

#### Lifecycle: init()

`init()` at `ui.js` lines 190-253 runs when the Alpine component mounts:

1. Loads `darkMode` and `animationsEnabled` from `localStorage`.
2. Applies the `dark` class to `document.documentElement` if dark mode is enabled.
3. Registers three keyboard shortcuts (only when focus is not in a text field):
   - `Ctrl+Z`: undo
   - `Ctrl+Shift+Z`: redo
   - `Ctrl+Enter`: trigger Recalculate if the pipeline is not running
4. Registers a `beforeunload` warning if there is unsaved data (incidents plotted or a pipeline complete).
5. Sets `isMobile = window.innerWidth < 768` and listens to window resize events.
6. Sets `window.uiApp = this` for external access.
7. Fetches `manifest.json` into `window.barangayManifest` for OSM graph mode slug lookups.
8. Calls `initMap(this)` and `initWebSocket(this)`.

#### Crime Node Management

Three public methods handle incident lifecycle:

- `addCrimeNode(lat, lng)`: increments `window.crimeIdCounter`, builds a zero-padded ID like `CRIME-007`, pushes the new object to `window.P`, syncs the reactive `this.P` mirror, pushes an `add_crime` undo action, and calls `plotCrimeMarker`.
- `removeCrimeNode(crimeId)`: removes from `window.P`, syncs `this.P`, pushes a `remove_crime` undo action, calls `removeCrimeMarker`.
- `dragCrimeNode(crimeId, oldLat, oldLng, newLat, newLng)`: updates coordinates in `window.P`, syncs `this.P`, pushes a `drag_crime` undo action.

#### Recalculate

`recalculate()` at `ui.js` lines 306-325 validates that `nPatrols` is a valid number, checks that `P.length >= 2` (you need at least 2 incidents to compute a hull), clears any active warning banner, and calls `sendComputeRequest`.

#### Undo and Redo Stack

`_pushUndo(action)` at `ui.js` lines 440-568 appends an action to `undoStack`, clears `redoStack` (because a new action invalidates any previously undone actions), and caps the stack at 50 entries (dropping the oldest if exceeded). `undo()` and `redo()` pop from one stack and push to the other before calling `_applyAction`.

`_applyAction` handles five action types:

| Type | What undo does | What redo does |
|------|----------------|----------------|
| `add_crime` | Removes the added point | Re-adds the point |
| `remove_crime` | Restores the removed point | Removes it again |
| `drag_crime` | Moves marker back to `oldLat/oldLng` | Moves marker to `newLat/newLng` |
| `bulk_import` | Restores `previousP` and `previousCounter` | Re-applies `newP` and `newCounter` |
| `reset` | Restores `previousP` and `previousCounter` | Clears the map again |

For `bulk_import` and `reset`, undo and redo call `restoreCrimeMarkers(window.P)` to rebuild all visual markers from scratch.

#### Import Coordinates

`importCoordinates()` at `ui.js` lines 572-684 parses a user-pasted list of `"lat,lng"` pairs:

1. Parses and validates each line; tracks how many were skipped due to invalid format.
2. Filters to only points inside the barangay boundary using `window.isInsideBarangay`.
3. If existing incidents are already plotted, asks the user to confirm replacement.
4. Assigns sequential `CRIME-NNN` IDs continuing from the current `window.crimeIdCounter`.
5. Runs client-side outlier detection (same logic as Stage 1) and reports the outlier count in a warning banner.
6. Pushes a `bulk_import` undo action with the full before and after state.
7. Clears all existing crime markers, then draws the new ones from scratch.

#### Settings

`openSettings()` deep-copies `activeConfig` into `settingsDraft` and shows the modal. `applySettings()` deep-copies `settingsDraft` back into `activeConfig`, recomputes `nMax` based on the `candidateNodes` setting (switching from `'all'` to `'intersection'` changes the candidate count, which changes the suggested maximum patrol count), syncs `animationsEnabled` to `localStorage`, and closes the modal. `resetSettingsToDefaults()` resets `settingsDraft` to the hardcoded defaults without applying until the user clicks Apply.

#### Route Playback

`playbackToggle()` at `ui.js` lines 759-784 starts or stops the playback animation. `onPlaybackPatrolChange()` restarts playback on the newly selected patrol and calls `window.showPatrolInfoPanel(patrolId)` to highlight that patrol on the map. `onPlaybackSpeedChange()` calls `updatePlaybackSpeed(speed)` which saves the current progress offset before changing speed so the animated marker does not visually jump.

#### Mobile Bottom Sheet

On mobile devices (viewport narrower than 768px), the control panel becomes a bottom sheet that slides up and down. Three touch event handlers manage this:

- `onDragStart`: saves the initial Y coordinate and initial height.
- `onDragMove`: computes the percentage height change from the drag delta, clamps `mobileSheetHeight` between 20% and 80%.
- `onDragEnd`: snaps to 80% if the sheet is above 55% height, otherwise snaps to 40%.

#### Algorithm Comparison Mode

`storeComparisonRunA()` and `storeComparisonRunB()` at `ui.js` lines 809-875 capture snapshots of the current pipeline results including patrol positions, zones, routes, hull, configuration used, total circuit distance, stationary patrol count, and runtime. When both runs are stored, `renderComparisonResults(runA, runB)` is called in `map.js` to render both simultaneously. `exitComparisonMode()` clears both snapshots and removes the overlay layers.

#### Trace Panel Helpers

`addTraceStage(id, name)` at `ui.js` lines 886-909 pushes a new stage object to `traceStages` with all fields pre-initialized (status set to `'running'`, all content fields empty). `updateTraceStage(id, update)` at lines 911-931 merges any subset of those fields: only defined keys in the update object are applied, so you can update one field without overwriting others. This allows `websocket-client.js` to fill in the trace panel incrementally as data arrives.

`setPipelineSummary(text)` at lines 933-939 sets the post-pipeline summary text and auto-scrolls the trace content div to the bottom using `$nextTick` (an Alpine.js utility that runs a callback after the DOM has updated to reflect the latest reactive state).

---

## 12. Configuration System

The configuration system is the single point of control for all algorithm behavior. Every parameter that affects how the algorithms work is defined here, can be changed by the user in the settings modal, and is validated before use.

### How Configuration Flows

```
DEFAULT_CONFIG (pipeline.js lines 38-63)
         |
         | user may override individual fields via the settings modal
         v
mergeConfig(userConfig)  (shallow spread per section)
         |
         v
Passed to all 4 algorithm stages as the config parameter
```

`DEFAULT_CONFIG` in `pipeline.js` defines sensible starting values for every parameter. When the user opens the settings modal and changes a value, only that specific value is overridden; all others remain at their defaults. This merged config is then sent to the backend with the compute request and validated by `sanitize.js` before any algorithm code runs.

### Full Configuration Reference

| Section | Field | Default value | What changing it does in practice |
|---------|-------|---------------|------------------------------------|
| `hillClimbing` | `restarts` | 100 | The restart multiplier. Total restarts = restarts × n. Increasing this makes the algorithm explore more starting positions, improving result quality at the cost of longer runtime. |
| `hillClimbing` | `maxIterations` | 1000 | The maximum number of iteration steps per restart before giving up and starting over. Increasing this gives each restart more time to converge, but rarely improves results once the algorithm has stalled. |
| `hillClimbing` | `radiusMultiplier` | 2 | Controls how far a patrol can move in one iteration. Increasing this makes patrols jump farther per step, potentially escaping local optima but also potentially skipping good positions. |
| `hillClimbing` | `synchronousMode` | false | Switches between asynchronous mode (each patrol sees others' moves within the same iteration) and synchronous mode (all patrols decide simultaneously). Synchronous mode is slower to converge but may find different solutions. |
| `convexHull` | `outlierMultiplier` | 2.5 | The threshold for outlier detection. A value of 2.5 means any incident more than 2.5 times the average distance from the centroid is flagged as an outlier. Reducing this flags more incidents as outliers, shrinking the danger zone. Increasing this keeps more incidents inside the hull. |
| `convexHull` | `collinearityEpsilon` | 1e-10 | The floating-point tolerance for the collinearity check. At 1×10⁻¹⁰ this is effectively zero; do not change this unless you understand floating-point arithmetic. |
| `convexHull` | `includeOutliers` | true | When true, outlier detection is skipped entirely and every incident contributes to the hull. When false, incidents beyond `outlierMultiplier × avgDist` are excluded from hull computation. |
| `tsp` | `maxCrimeNodesPerZone` | 12 | Hard limit on incidents per zone. Zones exceeding this cap have their furthest incidents excluded. Increasing this allows larger zones but risks slow TSP computation (each additional incident multiplies computation time factorially). |
| `tsp` | `nearestNeighborFallbackThreshold` | 12 | When a zone has more incidents than this value, the nearest-neighbor heuristic is used instead of exact backtracking TSP. Since this equals `maxCrimeNodesPerZone` by default, the heuristic is never triggered in standard operation. Reducing this threshold activates the heuristic for smaller zones, trading route quality for speed. |
| `tsp` | `hullExteriorPenalty` | 1 | A multiplier applied to road edges that pass outside the danger zone. Setting this to 1 (the default) disables the penalty. Setting it to, say, 3 makes the routing algorithm strongly prefer roads that stay within the hull, at the cost of sometimes finding longer routes. |
| `zoneAssignment` | `strongRebalancing` | false | When false, light rebalancing only adjusts zones that are more than twice the average size. When true, strong rebalancing enforces near-equal zone sizes, which may assign incidents to non-nearest patrols. |
| `snapping` | `boundingBoxEpsilon` | 1e-7 | A tiny expansion applied to bounding boxes during node search to avoid floating-point edge cases. Do not change this. |
| `snapping` | `initialSearchRadiusMeters` | 500 | The starting search radius (in meters) when snapping an incident to the nearest road node. If no node is found within this radius, the radius expands by 50% and the search retries. |
| (root) | `candidateNodes` | `'all'` | Controls which road nodes are eligible for patrol placement. `'all'` uses all 3,593 Commonwealth nodes. `'intersection'` uses only the 914 intersection nodes. Does not affect snapping accuracy. |

---

## 13. Data Flow: Full Pipeline Run

This section traces the complete path of a single Recalculate request from the user's click to the final map update, naming every function involved in the correct sequence.

```
User clicks Recalculate
         |
ui.js: recalculate()
         |
websocket-client.js: sendComputeRequest(incidents, n, mode, config, barangay)
         |
ws.send({ type: 'compute', data: { incidents, n, mode, config, barangay, removedNodes } })
         |
SERVER: pipelineSocket.js handleCompute(ws, data, clientIp)
  1. Check activePipelines < 3
  2. Check WebSocket rate limit
  3. validateBarangay, validateIncidents, validateN, validateMode, validateConfig
  4. getOrFetchNetwork(barangay)        (cache.js: in-memory or local file)
  5. pushToClient: network_loaded
  6. pushToClient: pipeline_start
  7. runPipeline(networkData, data, pushMessage, isCancelled, ws.previousState)
         |
SERVER: pipeline.js runPipeline
  mergeConfig(data.config)
  deriveHCSeed(incidents)              (FNV-1a hash of sorted incidents)
  Compute barangayAreaM2 from bbox
  Build filteredNodeMap (all or intersection nodes) + allNodesMap
         |
  Stage 1: runConvexHull(incidents, n, config, networkDataForHull, options)
    Incremental check (previousHull) OR full computation
    Outlier detection
    Collinearity check
    Brute force O(n^3) hull edges
    Edge ordering + Shoelace area + winding normalization
    Ray Cast pre-filter (nodeMap to validCandidates)
    Return hull, validCandidates, hullAreaM2
  push: stage_complete(1, ...)
  yieldToEventLoop()
         |
  buildRoadDistMatrix(validCandidates, adjacencyList)
         |
  Stage 2: runHillClimbing(validCandidates, n, hullAreaM2, config, { seed, roadDistMatrix })
    Compute search radius R
    FOR restartIdx = 0 to maxRestarts:
      Initialize n patrols at random distinct positions (Fisher-Yates shuffle)
      WHILE anyPatrolMoved AND iteration < maxIterations:
        (async or sync mode: evaluate all patrols, move to best neighbor)
      Record restart minDist, push stage_progress for animation
      Adaptive convergence check (last 3 restarts within 0.1%)
    Select best restart
    Compute confidence, bestSoFarCurve, redundancy
    Return patrols (S_star)
  push: stage_complete(2, ...)
  yieldToEventLoop()
         |
  Stage 3: runZoneAssignment(incidents, patrols, validCandidates, hull,
                              adjacencyList, dijkstraCache, config, options)
    Silent snapping (each incident to nearest road node, expanding radius)
    Deduplication (same snap target: merge)
    Dijkstra pre-computation (once per unique snapped node)
    Build distanceMatrix[snappedNodeId][patrolIndex]
    Initial zone assignment (min road distance)
    Zero distance waypoint detection
    Zone rebalancing (light or strong)
    Zone cap enforcement (nearest maxCrimeNodesPerZone kept)
    Zone classification (empty, single, multi)
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
  verifyAll(pipelineResult)   (non-fatal correctness checks)
  push: pipeline_complete(hull, patrols, zones, routes, verificationReport)
         |
  Return { previousState: { hull, validCandidates, incidents, hullAreaM2 } }

         |
CLIENT: websocket-client.js handlePipelineComplete(data)
  Store hull, patrols, zones, routes in window globals
  Update Alpine reactive state: ui.pipelineComplete, ui.routes
  Show route playback controls if roaming mode
  Build pipeline summary lines
  Store verificationReport on Alpine component
  Call onPipelineComplete(data)  (map.js rendering functions)
```

---

## 14. Error Handling and Edge Cases

No algorithm can handle every possible input perfectly. This section documents the specific situations the system handles gracefully and what happens in each case.

### When the Pipeline Stops Early

| Situation | What the system does |
|-----------|---------------------|
| Linear handler triggered (only 2 incidents, all collinear incidents, or too few valid hull edges) | The pipeline sends `pipeline_complete` with `linearHandler: true`. Patrols are placed along the incident line. Stages 2, 3, and 4 are all skipped. |
| Stage 1 error: no valid road candidates inside the hull | An error message is sent to the browser with `nearestHighlights` (the 5 nearest road nodes to the hull centroid). The frontend displays these as amber markers on the map with a tooltip instructing the user to plot incidents closer to those intersections. |
| Stage 2 error | A fatal error message is pushed to the browser. The pipeline aborts. The Recalculate button is re-enabled. |
| Stage 3 error | A fatal error message is pushed. The pipeline aborts. |
| Stage 4 error | A fatal error message is pushed. The pipeline aborts. Any routes from before the error remain null. |

### Graceful Degradations (Warnings, Not Errors)

These situations are handled automatically with no pipeline abort. A warning message appears in the trace panel:

| Situation | What the system does |
|-----------|---------------------|
| An incident's snapped node has no road path to any patrol (disconnected graph segment) | Haversine straight-line distance is used instead of road distance for zone assignment. A `haversineFallback: true` flag is stored on the incident node. A warning is emitted. |
| A crime node is unreachable from a patrol in Stage 4 TSP | That crime node is excluded from the route. If all crime nodes in a zone are unreachable, the zone is treated as stationary. |
| Backtracking TSP finds no feasible complete circuit | Nearest neighbor heuristic is used as a fallback. |
| n is greater than the number of valid candidates inside the hull | n is reduced to the number of available candidates. A warning is emitted. |
| A crime node has no road intersection within the hull's diameter | The node is added to `excludedCrimeNodes` with `reason: 'no_reachable_intersection'`. |
| A zone exceeds `maxCrimeNodesPerZone` | The furthest incident nodes are moved to `excludedCrimeNodes` with `reason: 'zone_cap'`. |
| The WebSocket closes while the pipeline is running | `ws.cancelled = true` is set. The next cancellation check at the start of the following stage catches this and the pipeline aborts cleanly without sending any further messages. |

### Verifier Failures

The verifier runs after all stages complete and its results are informational only. A failed verification does not cause the pipeline to re-run or the results to be withheld from the browser. The verification report appears in the trace panel so the user can see whether the mathematical guarantees held.

A `pass: false` result on `verifyTSPRoute` for zones with k > 6 is expected behavior, not a bug: the exhaustive optimality check is deliberately skipped for larger zones because enumerating millions of permutations would take too long.

---

## 15. Local Development Setup

This section explains how to get PatrolPoint running on your own computer for development or testing.

### Prerequisites

- **Node.js LTS 22.x:** Node.js is the JavaScript runtime that runs the server. LTS (Long-Term Support) means this version receives security updates for several years. Download from nodejs.org.

### Installation Steps

1. Clone the repository (download a copy of the code from GitHub):
```bash
git clone https://github.com/GavinnMR/patrolpoint
cd patrolpoint
git checkout main
```

2. Install all dependencies (this downloads all the libraries listed in `package.json`):
```bash
npm install
```

3. Create a `.env` file by copying the example:
```
NODE_ENV=development
PORT=3000
```

4. Start the server:
```bash
npm start
```

5. Open `http://localhost:3000` in a web browser. The map should load with the Commonwealth barangay boundary visible.

No database connection or external API key is needed. The server loads all barangay road network data from the local `data/barangays/` folder at startup.

### Verifying the Server is Running

The health check endpoint returns a simple status message:

```
GET http://localhost:3000/health
Response: { "status": "ok", "version": "2.0" }
```

### Checking a Barangay Network Summary

```
GET http://localhost:3000/api/network/Commonwealth
Response: { "barangay": "Commonwealth", "nodeCount": 3593, "edgeCount": 4091,
            "intersectionCount": 914, "fromCache": false, "bbox": {...}, "boundary": [...] }
```

On the first request, `fromCache` will be `false` (data loaded from disk). On subsequent requests for the same barangay in the same server session, `fromCache` will be `true` (data returned from memory instantly).

### Running the Automated Tests

PatrolPoint uses **Playwright** (a browser automation framework that controls a real browser programmatically) for end-to-end testing. End-to-end tests simulate actual user interactions and verify the full system from browser click to rendered map result.

```bash
npx playwright test
```

Test files are served from the `/tests` route in development mode only. This route is not available in production (`server/index.js` lines 28-30).
