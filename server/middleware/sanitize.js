// server/middleware/sanitize.js
// Input validation helpers — called inside route handlers and handleCompute.
// All functions throw descriptive Error on invalid input.

export function validateIncidents(incidents) {
    if (!Array.isArray(incidents)) throw new Error('incidents must be an array.');
    if (incidents.length < 1) throw new Error('At least 1 incident coordinate is required.');
    if (incidents.length > 300) throw new Error('Maximum 300 incident coordinates allowed.');
    for (let i = 0; i < incidents.length; i++) {
        const inc = incidents[i];
        if (!inc || typeof inc !== 'object') {
            throw new Error(`Incident ${i + 1}: each element must be an object with lat and lng.`);
        }
        if (typeof inc.lat !== 'number' || typeof inc.lng !== 'number' ||
            !Number.isFinite(inc.lat) || !Number.isFinite(inc.lng)) {
            throw new Error(`Incident ${i + 1}: lat and lng must be finite numbers.`);
        }
        if (inc.lat < -90 || inc.lat > 90) {
            throw new Error(`Incident ${i + 1}: lat must be between -90 and 90.`);
        }
        if (inc.lng < -180 || inc.lng > 180) {
            throw new Error(`Incident ${i + 1}: lng must be between -180 and 180.`);
        }
    }
}

export function validateN(n) {
    if (typeof n !== 'number' || !Number.isInteger(n)) {
        throw new Error('Number of patrols must be a whole number.');
    }
    if (n < 1 || n > 100) {
        throw new Error('Number of patrols must be between 1 and 100.');
    }
}

export function validateMode(mode) {
    if (mode !== 'stationary' && mode !== 'roaming') {
        throw new Error('Deployment mode must be "stationary" or "roaming".');
    }
}

export function validateConfig(config) {
    if (!config || typeof config !== 'object') return;

    const hc = config.hillClimbing;
    if (hc) {
        if (hc.restarts !== undefined && (typeof hc.restarts !== 'number' || hc.restarts < 1 || hc.restarts > 100)) {
            throw new Error('hillClimbing.restarts must be between 1 and 100.');
        }
        if (hc.maxIterations !== undefined && (typeof hc.maxIterations !== 'number' || hc.maxIterations < 1 || hc.maxIterations > 10000)) {
            throw new Error('hillClimbing.maxIterations must be between 1 and 10000.');
        }
        if (hc.radiusMultiplier !== undefined && (typeof hc.radiusMultiplier !== 'number' || hc.radiusMultiplier < 0.1 || hc.radiusMultiplier > 20)) {
            throw new Error('hillClimbing.radiusMultiplier must be between 0.1 and 20.');
        }
        if (hc.adaptiveMaxRestarts !== undefined && (typeof hc.adaptiveMaxRestarts !== 'number' || hc.adaptiveMaxRestarts < 1 || hc.adaptiveMaxRestarts > 100)) {
            throw new Error('hillClimbing.adaptiveMaxRestarts must be between 1 and 100.');
        }
        if (hc.synchronousMode !== undefined && typeof hc.synchronousMode !== 'boolean') {
            throw new Error('hillClimbing.synchronousMode must be a boolean.');
        }
    }

    const ch = config.convexHull;
    if (ch) {
        if (ch.outlierMultiplier !== undefined && (typeof ch.outlierMultiplier !== 'number' || ch.outlierMultiplier < 0.5 || ch.outlierMultiplier > 10)) {
            throw new Error('convexHull.outlierMultiplier must be between 0.5 and 10.');
        }
        if (ch.areaThresholdDivisor !== undefined && (typeof ch.areaThresholdDivisor !== 'number' || ch.areaThresholdDivisor < 1 || ch.areaThresholdDivisor > 1000)) {
            throw new Error('convexHull.areaThresholdDivisor must be between 1 and 1000.');
        }
        if (ch.collinearityEpsilon !== undefined && (typeof ch.collinearityEpsilon !== 'number' || ch.collinearityEpsilon <= 0)) {
            throw new Error('convexHull.collinearityEpsilon must be a positive number.');
        }
    }

    const tsp = config.tsp;
    if (tsp) {
        if (tsp.maxCrimeNodesPerZone !== undefined && (typeof tsp.maxCrimeNodesPerZone !== 'number' || tsp.maxCrimeNodesPerZone < 1 || tsp.maxCrimeNodesPerZone > 50)) {
            throw new Error('tsp.maxCrimeNodesPerZone must be between 1 and 50.');
        }
        if (tsp.nearestNeighborFallbackThreshold !== undefined && (typeof tsp.nearestNeighborFallbackThreshold !== 'number' || tsp.nearestNeighborFallbackThreshold < 1 || tsp.nearestNeighborFallbackThreshold > 50)) {
            throw new Error('tsp.nearestNeighborFallbackThreshold must be between 1 and 50.');
        }
    }

    const snap = config.snapping;
    if (snap) {
        if (snap.boundingBoxEpsilon !== undefined && (typeof snap.boundingBoxEpsilon !== 'number' || snap.boundingBoxEpsilon <= 0)) {
            throw new Error('snapping.boundingBoxEpsilon must be a positive number.');
        }
        if (snap.initialSearchRadiusMeters !== undefined && (typeof snap.initialSearchRadiusMeters !== 'number' || snap.initialSearchRadiusMeters <= 0)) {
            throw new Error('snapping.initialSearchRadiusMeters must be a positive number.');
        }
    }
}

export function validateBarangay(barangay) {
    if (typeof barangay !== 'string' || barangay.trim().length === 0) {
        throw new Error('Barangay name must be a non-empty string.');
    }
    if (barangay.length > 255) {
        throw new Error('Barangay name must not exceed 255 characters.');
    }
    if (!/^[a-zA-Z0-9 ]+$/.test(barangay)) {
        throw new Error('Barangay name must contain only alphanumeric characters and spaces.');
    }
}
