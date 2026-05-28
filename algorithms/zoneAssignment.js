// Stage 3: Zone Assignment

// Snap p to the nearest validCandidate within hullDiameter, expanding radius by 50% on miss
function _za_snapToNearest(p, validCandidates, hullDiameter, config) {
    const eps = config.snapping.boundingBoxEpsilon;
    let radius = Math.min(500, hullDiameter);

    while (radius <= hullDiameter) {
        const dLat = radius / 111000;
        const dLng = radius / (111000 * Math.cos(p.lat * Math.PI / 180));
        const minLat = p.lat - dLat - eps, maxLat = p.lat + dLat + eps;
        const minLng = p.lng - dLng - eps, maxLng = p.lng + dLng + eps;

        let bestNode = null;
        let bestDist = Infinity;

        for (const c of validCandidates) {
            if (c.lat < minLat || c.lat > maxLat || c.lng < minLng || c.lng > maxLng) continue;
            const d = haversineDistance(p.lat, p.lng, c.lat, c.lng);
            if (d <= radius && d < bestDist) { bestDist = d; bestNode = c; }
        }

        if (bestNode) return { node: bestNode, dist: bestDist };
        radius *= 1.5;
    }

    return null;
}

function computeZoneAssignment(P, S_star, validCandidates, hullVertices, config) {
    const log = [];
    const warnings = [];

    // Defensive check
    if (!validCandidates || validCandidates.length === 0) {
        return {
            status: 'error',
            message: 'No valid patrol positions available. Please recalculate.',
            warnings,
            data: { traceLog: log }
        };
    }

    // Hull diameter — max Haversine between any two hull vertices
    let hullDiameter = 0;
    for (let i = 0; i < hullVertices.length; i++) {
        for (let j = i + 1; j < hullVertices.length; j++) {
            const d = haversineDistance(
                hullVertices[i].lat, hullVertices[i].lng,
                hullVertices[j].lat, hullVertices[j].lng
            );
            if (d > hullDiameter) hullDiameter = d;
        }
    }
    log.push(`Hull diameter: ${Math.round(hullDiameter)}m`);

    // Step 1: Silent snapping — each P snapped to nearest validCandidate only
    const snappedNodes = [];
    const excludedPIndices = [];

    for (let pIdx = 0; pIdx < P.length; pIdx++) {
        const p = P[pIdx];
        const result = _za_snapToNearest(p, validCandidates, hullDiameter, config);
        if (result) {
            snappedNodes.push({
                id: result.node.id,
                lat: result.node.lat,
                lng: result.node.lng,
                pIdx,
                snappingDist: result.dist
            });
            log.push(`P[${pIdx}] (${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}) → ${result.node.id} dist=${Math.round(result.dist)}m`);
        } else {
            excludedPIndices.push(pIdx);
            warnings.push(`Crime node at (${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}) has no reachable road intersection inside the danger zone. Point excluded.`);
            log.push(`P[${pIdx}] excluded — no candidate within hull diameter (${Math.round(hullDiameter)}m)`);
        }
    }

    // Step 2: Dedup snapped positions — two P points → same node → keep first, merge rest
    const seenIds = new Map();
    const deduped = [];
    let mergedCount = 0;

    for (const sn of snappedNodes) {
        if (seenIds.has(sn.id)) {
            mergedCount++;
            warnings.push(`Crime node merged with nearby incident at node ${sn.id}.`);
            log.push(`P[${sn.pIdx}] merged into existing node ${sn.id}`);
        } else {
            seenIds.set(sn.id, sn);
            deduped.push(sn);
        }
    }

    // Step 3: Zero distance waypoint detection
    let waypointCount = 0;
    for (const sn of deduped) {
        for (let i = 0; i < S_star.length; i++) {
            if (sn.id === S_star[i].id) {
                waypointCount++;
                log.push(`P[${sn.pIdx}] at node ${sn.id} matches patrol ${i + 1} position — zero distance waypoint`);
            }
        }
    }

    // Step 4: Zone assignment — nearest patrol by Haversine, tiebreaker = lower index (loop order)
    const zones = Array.from({ length: S_star.length }, () => []);
    for (const sn of deduped) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < S_star.length; i++) {
            const d = haversineDistance(sn.lat, sn.lng, S_star[i].lat, S_star[i].lng);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        zones[bestIdx].push(sn);
    }

    // Step 5: Zone cap enforcement
    const max = config.tsp.maxCrimeNodesPerZone;
    let cappedZonesCount = 0;
    const cappedExcludedPIndices = [];

    for (let i = 0; i < zones.length; i++) {
        if (zones[i].length > max) {
            zones[i].sort((a, b) =>
                haversineDistance(a.lat, a.lng, S_star[i].lat, S_star[i].lng) -
                haversineDistance(b.lat, b.lng, S_star[i].lat, S_star[i].lng)
            );
            const excluded = zones[i].splice(max);
            excluded.forEach(sn => cappedExcludedPIndices.push(sn.pIdx));
            cappedZonesCount++;
            warnings.push(`Zone for patrol ${i + 1} capped at ${max} nodes. ${excluded.length} node${excluded.length !== 1 ? 's' : ''} excluded. Consider adding more patrols.`);
            log.push(`Zone ${i + 1}: capped at ${max}, excluded ${excluded.length} nodes`);
        }
    }

    // Step 6: Zone classification
    const zoneTypes = [];
    for (let i = 0; i < zones.length; i++) {
        if (zones[i].length === 0) {
            zoneTypes.push('empty');
            log.push(`Zone ${i + 1}: empty — patrol stationary`);
        } else if (zones[i].length === 1) {
            const dist2x = 2 * haversineDistance(zones[i][0].lat, zones[i][0].lng, S_star[i].lat, S_star[i].lng);
            zoneTypes.push('single');
            log.push(`Zone ${i + 1}: single node ${zones[i][0].id} — direct visit, round trip ${Math.round(dist2x)}m`);
        } else {
            zoneTypes.push('multiple');
            log.push(`Zone ${i + 1}: ${zones[i].length} nodes — proceeding to TSP`);
        }
    }

    // Step 7: Aggregate snapping statistics
    let totalDist = 0;
    let maxDist = 0;
    for (const sn of deduped) {
        totalDist += sn.snappingDist;
        if (sn.snappingDist > maxDist) maxDist = sn.snappingDist;
    }
    const avgDist = deduped.length > 0 ? totalDist / deduped.length : 0;
    if (maxDist > 200) {
        warnings.push(`Maximum snapping distance (${Math.round(maxDist)}m) exceeds 200m. Some crime nodes may be far from road intersections.`);
        log.push(`Warning: max snapping distance ${Math.round(maxDist)}m exceeds 200m threshold`);
    }

    const emptyCount    = zoneTypes.filter(t => t === 'empty').length;
    const singleCount   = zoneTypes.filter(t => t === 'single').length;
    const multipleCount = zoneTypes.filter(t => t === 'multiple').length;

    if (emptyCount > 0) {
        warnings.push(`${emptyCount} patrol${emptyCount !== 1 ? 's' : ''} have no assigned crime nodes and will remain stationary.`);
    }

    log.push(`\nSnapping: avg ${Math.round(avgDist)}m, max ${Math.round(maxDist)}m`);
    log.push(`Zones: ${emptyCount} empty, ${singleCount} single, ${multipleCount} multiple`);

    return {
        status: warnings.length > 0 ? 'warning' : 'success',
        message: `Zone assignment complete. ${deduped.length} crime node${deduped.length !== 1 ? 's' : ''} assigned across ${S_star.length} patrol${S_star.length !== 1 ? 's' : ''}.`,
        warnings,
        data: {
            zones,
            zoneTypes,
            excludedPIndices,
            cappedExcludedPIndices,
            snappingStats: {
                avgDist,
                maxDist,
                excludedCount: excludedPIndices.length,
                mergedCount,
                waypointCount
            },
            cappedZonesCount,
            traceLog: log
        }
    };
}
