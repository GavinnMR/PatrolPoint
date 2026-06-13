import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOCAL_NETWORK_FILES = {};

try {
    const manifestPath = join(__dirname, '../../data/barangays/manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const [name, entry] of Object.entries(manifest)) {
        LOCAL_NETWORK_FILES[name] = join(__dirname, `../../data/barangays/${entry.slug}.json`);
    }
    console.log(`Barangay manifest loaded: ${Object.keys(manifest).length} barangays registered`);
} catch {
    console.log('No barangay manifest found — run scripts/preprocess_barangays.py to generate local network files');
}

// In-memory cache — persists across requests for the lifetime of the process
const networkCache = {};

async function buildNetworkFromLocalFile(barangayName) {
    const filePath = LOCAL_NETWORK_FILES[barangayName];
    if (!filePath) return null;

    let raw;
    try {
        raw = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (err) {
        console.warn(`Local network file not readable for "${barangayName}": ${err.message}`);
        return null;
    }

    const nodes = {};
    for (const n of raw.nodes) nodes[n.id] = n;

    const adjacencyList = {};
    const degree = {};
    for (const id in nodes) { adjacencyList[id] = []; degree[id] = 0; }

    for (const edge of raw.edges) {
        adjacencyList[edge.from].push({ neighborId: edge.to, weight: edge.weight });
        adjacencyList[edge.to].push({ neighborId: edge.from, weight: edge.weight });
        degree[edge.from] = (degree[edge.from] || 0) + 1;
        degree[edge.to]   = (degree[edge.to]   || 0) + 1;
    }

    const intersectionNodeIds = Object.keys(degree).filter(id => degree[id] >= 3);

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;
    for (const id in nodes) {
        const { lat, lng } = nodes[id];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
    }

    const nodeCount         = Object.keys(nodes).length;
    const edgeCount         = raw.edges.length;
    const intersectionCount = intersectionNodeIds.length;

    console.log(`Local file processed: ${nodeCount} nodes, ${edgeCount} edges, ${intersectionCount} intersection nodes`);

    return {
        nodes,
        edges: raw.edges,
        adjacencyList,
        intersectionNodeIds,
        boundary: raw.boundary || [],
        nodeCount,
        edgeCount,
        intersectionCount,
        bbox: { south: minLat, west: minLng, north: maxLat, east: maxLng }
    };
}

export async function getOrFetchNetwork(barangayName) {
    if (networkCache[barangayName]) {
        console.log(`Network cache hit: ${barangayName}`);
        return { ...networkCache[barangayName], fromCache: true };
    }

    console.log(`Loading network for "${barangayName}" from local file...`);
    const localData = await buildNetworkFromLocalFile(barangayName);
    if (localData) {
        networkCache[barangayName] = localData;
        return { ...localData, fromCache: false };
    }

    throw new Error(`No local network file found for barangay: "${barangayName}". Run scripts/preprocess_barangays.py to generate it.`);
}
