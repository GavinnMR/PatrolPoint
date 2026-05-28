// Stage 2: Hill Climbing Patrol Placement

function _hc_shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Min pairwise Haversine distance among all positions
function _hc_globalMinPairwise(positions) {
    if (positions.length < 2) return Infinity;
    let min = Infinity;
    for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
            const d = haversineDistance(
                positions[i].lat, positions[i].lng,
                positions[j].lat, positions[j].lng
            );
            if (d < min) min = d;
        }
    }
    return min;
}

// Min pairwise distance among all positions EXCEPT index idx
function _hc_minPairwiseExcluding(positions, idx) {
    let min = Infinity;
    for (let i = 0; i < positions.length; i++) {
        if (i === idx) continue;
        for (let j = i + 1; j < positions.length; j++) {
            if (j === idx) continue;
            const d = haversineDistance(
                positions[i].lat, positions[i].lng,
                positions[j].lat, positions[j].lng
            );
            if (d < min) min = d;
        }
    }
    return min;
}

// Min Haversine distance from (vLat, vLng) to all positions except excludeIdx
function _hc_minDistToOthers(vLat, vLng, positions, excludeIdx) {
    let min = Infinity;
    for (let i = 0; i < positions.length; i++) {
        if (i === excludeIdx) continue;
        const d = haversineDistance(vLat, vLng, positions[i].lat, positions[i].lng);
        if (d < min) min = d;
    }
    return min;
}

// Bounding box pre-filter then Haversine check; excludes si's own position and occupied nodes
function _hc_findNeighbors(si, positions, siIdx, validCandidates, R, config) {
    const eps = config.snapping.boundingBoxEpsilon;
    const dLat = R / 111000;
    const dLng = R / (111000 * Math.cos(si.lat * Math.PI / 180));

    const minLat = si.lat - dLat - eps, maxLat = si.lat + dLat + eps;
    const minLng = si.lng - dLng - eps, maxLng = si.lng + dLng + eps;

    const occupied = new Set();
    for (let i = 0; i < positions.length; i++) {
        if (i !== siIdx) occupied.add(positions[i].id);
    }

    const neighbors = [];
    for (const c of validCandidates) {
        if (c.id === si.id) continue;
        if (occupied.has(c.id)) continue;
        if (c.lat < minLat || c.lat > maxLat || c.lng < minLng || c.lng > maxLng) continue;
        if (haversineDistance(si.lat, si.lng, c.lat, c.lng) <= R) neighbors.push(c);
    }
    return neighbors;
}

function computeHillClimbing(validCandidates, hullAreaM2, n, config) {
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

    // ── Special case: n = 1 ───────────────────────────────────────────────────
    if (n === 1) {
        log.push('Single patrol mode — finding most central intersection node');
        let bestNode = validCandidates[0];
        let bestAvg = Infinity;
        for (const c of validCandidates) {
            let total = 0;
            for (const other of validCandidates) {
                if (other.id !== c.id)
                    total += haversineDistance(c.lat, c.lng, other.lat, other.lng);
            }
            const avg = validCandidates.length > 1 ? total / (validCandidates.length - 1) : 0;
            if (avg < bestAvg) { bestAvg = avg; bestNode = c; }
        }
        log.push(`Placed at ${bestNode.id} (${bestNode.lat.toFixed(6)}, ${bestNode.lng.toFixed(6)}), avg dist to others: ${Math.round(bestAvg)}m`);
        return {
            status: 'success',
            message: 'Single patrol mode — placed at most central intersection node.',
            warnings,
            data: {
                positions: [{ id: bestNode.id, lat: bestNode.lat, lng: bestNode.lng }],
                bestMinPairwiseDist: 0,
                bestRestartIdx: null,
                R: 0,
                actualN: 1,
                cappedN: null,
                restartsCompleted: 0,
                radiusExpansions: 0,
                maxIterWarnings: 0,
                duplicateConfigWarnings: 0,
                traceLog: log
            }
        };
    }

    // ── Special case: n > validCandidates.length ──────────────────────────────
    let actualN = n;
    let cappedN = null;
    if (n > validCandidates.length) {
        cappedN = n;
        actualN = validCandidates.length;
        warnings.push(`Only ${actualN} valid patrol positions exist inside the danger zone. Number of patrols reduced from ${n} to ${actualN}.`);
        log.push(`n capped from ${n} to ${actualN}`);
        if (actualN === 0) {
            return {
                status: 'error',
                message: 'No valid patrol positions available. Please recalculate.',
                warnings,
                data: { actualN: 0, cappedN, traceLog: log }
            };
        }
    }

    // ── Compute R ─────────────────────────────────────────────────────────────
    const R = Math.sqrt(hullAreaM2 / validCandidates.length) * config.hillClimbing.radiusMultiplier;
    log.push(`R = sqrt(${Math.round(hullAreaM2)} / ${validCandidates.length}) × ${config.hillClimbing.radiusMultiplier} = ${Math.round(R)}m`);

    let bestPositions = null;
    let bestMinDist = -Infinity;
    let bestRestartIdx = 1;
    let totalRadiusExpansions = 0;
    let totalMaxIterWarnings = 0;
    let totalDuplicateWarnings = 0;
    const previousConfigs = [];

    // ── Restart loop ──────────────────────────────────────────────────────────
    for (let restart = 0; restart < config.hillClimbing.restarts; restart++) {
        log.push(`\n--- Restart ${restart + 1} of ${config.hillClimbing.restarts} ---`);

        // Shuffle-and-slice initialization — unique starting positions per restart
        const shuffled = _hc_shuffle(validCandidates);
        let positions = shuffled.slice(0, actualN)
            .map(p => ({ id: p.id, lat: p.lat, lng: p.lng }));
        log.push(`Init: ${positions.map(p => p.id).join(', ')}`);

        let localR = R;
        let iteration = 0;
        let anyPatrolMoved = true;
        let restartExpansions = 0;

        // ── Iteration loop ────────────────────────────────────────────────────
        while (anyPatrolMoved && iteration < config.hillClimbing.maxIterations) {
            anyPatrolMoved = false;
            let anyHadNeighbor = false;

            // Shuffle patrol processing order each iteration
            const order = _hc_shuffle(positions.map((_, i) => i));

            for (const siIdx of order) {
                const si = positions[siIdx];
                const neighbors = _hc_findNeighbors(si, positions, siIdx, validCandidates, localR, config);

                if (neighbors.length === 0) {
                    log.push(`  i${iteration} P${siIdx + 1}(${si.id}): no neighbors within R=${Math.round(localR)}m`);
                    continue;
                }
                anyHadNeighbor = true;

                // Precompute min pairwise excluding si — O(n²) once per patrol
                const minExclSi = _hc_minPairwiseExcluding(positions, siIdx);
                const curGlobalMin = _hc_globalMinPairwise(positions);
                let bestMinForSi = curGlobalMin;
                let bestNeighbor = null;

                // Evaluate each neighbor — O(n) per neighbor
                for (const v of neighbors) {
                    const minFromV = _hc_minDistToOthers(v.lat, v.lng, positions, siIdx);
                    const newMin = Math.min(minExclSi, minFromV);
                    if (newMin > bestMinForSi) {
                        bestMinForSi = newMin;
                        bestNeighbor = v;
                    }
                }

                if (bestNeighbor) {
                    log.push(`  i${iteration} P${siIdx + 1}: ${si.id} → ${bestNeighbor.id} (min: ${Math.round(curGlobalMin)}m → ${Math.round(bestMinForSi)}m)`);
                    positions[siIdx] = { id: bestNeighbor.id, lat: bestNeighbor.lat, lng: bestNeighbor.lng };
                    anyPatrolMoved = true;
                }
            }

            // If no patrol had any unoccupied neighbor, expand R globally by 50%
            if (!anyHadNeighbor) {
                localR *= 1.5;
                restartExpansions++;
                totalRadiusExpansions++;
                log.push(`  i${iteration}: All patrols surrounded — expanding R to ${Math.round(localR)}m`);
                anyPatrolMoved = true; // keep iterating
            }

            iteration++;
        }

        if (iteration >= config.hillClimbing.maxIterations) {
            totalMaxIterWarnings++;
            log.push(`Restart ${restart + 1}: hit max iterations (${config.hillClimbing.maxIterations})`);
        }

        const finalMin = actualN < 2 ? 0 : _hc_globalMinPairwise(positions);
        log.push(`Restart ${restart + 1}: min dist = ${Math.round(finalMin)}m (${iteration} iters${restartExpansions > 0 ? `, R expanded ${restartExpansions}×` : ''})`);

        // Duplicate config detection
        const key = positions.map(p => p.id).sort().join(',');
        if (previousConfigs.includes(key)) {
            totalDuplicateWarnings++;
            log.push(`Restart ${restart + 1}: converged to previously found configuration`);
        }
        previousConfigs.push(key);

        if (finalMin > bestMinDist) {
            bestMinDist = finalMin;
            bestPositions = positions.map(p => ({ ...p }));
            bestRestartIdx = restart + 1;
            log.push(`Restart ${restart + 1} is new best`);
        }
    }

    log.push(`\nBest: restart ${bestRestartIdx}, min pairwise dist = ${Math.round(bestMinDist)}m`);

    // Build warning messages for status
    if (totalRadiusExpansions > 0)
        warnings.push(`Radius R expanded ${totalRadiusExpansions} time(s) due to patrols with no unoccupied neighbors.`);
    if (totalMaxIterWarnings > 0)
        warnings.push(`${totalMaxIterWarnings} restart(s) reached maximum iterations without converging. Result may be suboptimal.`);
    if (totalDuplicateWarnings > 0)
        warnings.push(`${totalDuplicateWarnings} restart(s) converged to previously found configuration. Solution diversity low — consider increasing radius R in Settings.`);

    return {
        status: warnings.length > 0 ? 'warning' : 'success',
        message: `Patrol positions found. Best min pairwise distance: ${Math.round(bestMinDist)}m.`,
        warnings,
        data: {
            positions: bestPositions,
            bestMinPairwiseDist: bestMinDist,
            bestRestartIdx,
            R,
            actualN,
            cappedN,
            restartsCompleted: config.hillClimbing.restarts,
            radiusExpansions: totalRadiusExpansions,
            maxIterWarnings: totalMaxIterWarnings,
            duplicateConfigWarnings: totalDuplicateWarnings,
            traceLog: log
        }
    };
}
