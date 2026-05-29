/* ============================================================
   Stage 4.1 — Dijkstra Road Path Computation
   ============================================================ */

class MinHeap {
    constructor() {
        this._heap = [];          // [{ nodeId, priority }]
        this._indexMap = new Map(); // nodeId → index in heap
    }

    _swap(i, j) {
        const tmp = this._heap[i];
        this._heap[i] = this._heap[j];
        this._heap[j] = tmp;
        this._indexMap.set(this._heap[i].nodeId, i);
        this._indexMap.set(this._heap[j].nodeId, j);
    }

    _bubbleUp(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this._heap[parent].priority > this._heap[i].priority) {
                this._swap(parent, i);
                i = parent;
            } else break;
        }
    }

    _bubbleDown(i) {
        const n = this._heap.length;
        while (true) {
            let min = i;
            const l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && this._heap[l].priority < this._heap[min].priority) min = l;
            if (r < n && this._heap[r].priority < this._heap[min].priority) min = r;
            if (min !== i) { this._swap(min, i); i = min; }
            else break;
        }
    }

    insert(nodeId, priority) {
        this._heap.push({ nodeId, priority });
        const i = this._heap.length - 1;
        this._indexMap.set(nodeId, i);
        this._bubbleUp(i);
    }

    extractMin() {
        if (this._heap.length === 0) return null;
        const min = this._heap[0];
        const last = this._heap.pop();
        this._indexMap.delete(min.nodeId);
        if (this._heap.length > 0) {
            this._heap[0] = last;
            this._indexMap.set(last.nodeId, 0);
            this._bubbleDown(0);
        }
        return min;
    }

    decreaseKey(nodeId, newPriority) {
        const i = this._indexMap.get(nodeId);
        if (i === undefined) return;
        this._heap[i].priority = newPriority;
        this._bubbleUp(i);
    }

    has(nodeId) { return this._indexMap.has(nodeId); }
    isEmpty() { return this._heap.length === 0; }
}

// Normalized edge key: smaller numeric ID first, pipe-separated ("n89|n234")
function normalizeEdgeKey(idA, idB) {
    const numA = parseInt(idA.slice(1), 10);
    const numB = parseInt(idB.slice(1), 10);
    return numA < numB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// Dijkstra from sourceId — traverses the full graph including non-intersection nodes
// Returns { distances: Map<nodeId → dist>, parents: Map<nodeId → parentId|null> }
function runDijkstra(sourceId, adjacencyList, nodeMap) {
    const dist = new Map();
    const parent = new Map();

    for (const id of nodeMap.keys()) {
        dist.set(id, Infinity);
        parent.set(id, null);
    }
    dist.set(sourceId, 0);

    const heap = new MinHeap();
    heap.insert(sourceId, 0);

    while (!heap.isEmpty()) {
        const { nodeId: curr, priority: currDist } = heap.extractMin();
        if (currDist > dist.get(curr)) continue; // stale entry

        for (const { neighborId, weight } of (adjacencyList.get(curr) || [])) {
            const newDist = currDist + weight;
            if (newDist < dist.get(neighborId)) {
                dist.set(neighborId, newDist);
                parent.set(neighborId, curr);
                if (heap.has(neighborId)) {
                    heap.decreaseKey(neighborId, newDist);
                } else {
                    heap.insert(neighborId, newDist);
                }
            }
        }
    }

    return { distances: dist, parents: parent };
}

// Reconstruct path from sourceId to destId via parent map
// Returns ordered array of node IDs [source, ..., dest], or null if unreachable
function reconstructPath(sourceId, destId, parents) {
    if (sourceId === destId) return [sourceId];
    const path = [destId];
    let curr = destId;
    while (curr !== sourceId) {
        curr = parents.get(curr);
        if (curr === null || curr === undefined) return null;
        path.unshift(curr);
    }
    return path;
}
