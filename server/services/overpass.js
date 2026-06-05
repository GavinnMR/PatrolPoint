import fetch from 'node-fetch';

const OVERPASS_SERVERS = [
    process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter'
];

function buildRoadQuery(barangay, south, west, north, east) {
    return `[out:json][bbox:${south},${west},${north},${east}];
relation["name"="${barangay}"]["admin_level"="10"];
map_to_area->.boundary;
way["highway"]["highway"!="steps"](area.boundary);
(._;>;);
out body;`;
}

function buildBoundaryQuery(barangay, south, west, north, east) {
    return `[out:json][bbox:${south},${west},${north},${east}];
relation["name"="${barangay}"]["admin_level"="10"];
(._;>;);
out body;`;
}

async function queryOverpass(query) {
    let lastError;
    for (const serverUrl of OVERPASS_SERVERS) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=' + encodeURIComponent(query),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                console.warn(`Overpass ${serverUrl} returned HTTP ${response.status}`);
                lastError = new Error(`HTTP ${response.status}`);
                continue;
            }

            return await response.json();
        } catch (err) {
            lastError = err;
            if (err.name === 'AbortError') {
                console.warn(`Overpass ${serverUrl} timed out after 30s`);
            } else {
                console.warn(`Overpass ${serverUrl} failed: ${err.message}`);
            }
        }
    }
    throw new Error(`All Overpass API servers failed. Last error: ${lastError?.message}`);
}

export async function fetchBarangayData(barangayName, bbox) {
    const { south, west, north, east } = bbox;
    console.log(`Fetching Overpass data for ${barangayName} [${south},${west},${north},${east}]...`);

    const roadQuery = buildRoadQuery(barangayName, south, west, north, east);
    const boundaryQuery = buildBoundaryQuery(barangayName, south, west, north, east);

    // Run both queries in parallel — separate independent requests
    const [roadData, boundaryData] = await Promise.all([
        queryOverpass(roadQuery),
        queryOverpass(boundaryQuery)
    ]);

    console.log(`Overpass fetch complete: ${roadData.elements?.length} road elements, ${boundaryData.elements?.length} boundary elements`);
    return { roadData, boundaryData };
}
