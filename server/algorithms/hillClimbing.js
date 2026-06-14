// server/algorithms/hillClimbing.js
// Stage 2: Hill Climbing Patrol Placement — V2 backend implementation.
// Pure ESM module — no browser dependencies, no side effects.
//
// V2 additions over V1:
//   • Adaptive restart count: stops early if last 3 restarts converge within 0.1%.
//   • Synchronous mode: all patrols compute moves on old positions, apply simultaneously.
//   • Confidence indicator: (1 - stdDev/mean) × 100 across all restart results.
//   • pushProgress callback: real-time patrol positions for frontend animation.
//
// haversineDistance is imported from dijkstra.js — never reimplemented inline.

import { haversineDistance } from './dijkstra.js';

// mulberry32 — seedable PRNG (Vigna 2017). Returns a callable that produces [0,1) floats.
// Same seed → same sequence. Used to make Hill Climbing deterministic per incident set.
function mulberry32(seed) {
    return function () {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const PATROL_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6',
    '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4'
];

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fisher-Yates shuffle — returns a shuffled copy, never mutates input.
// rng defaults to Math.random so callers without a seed still work.
function shuffle(arr, rng = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// Minimum pairwise road distance across all patrol positions — O(n²) matrix lookups.
// Falls back to Haversine if roadDistMatrix is not provided.
function globalMinPairwiseDist(positions, roadDistMatrix) {
    let minDist = Infinity;
    for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
            const d = roadDistMatrix
                ? (roadDistMatrix[positions[i].nodeId]?.[positions[j].nodeId] ?? Infinity)
                : haversineDistance(positions[i].lat, positions[i].lng, positions[j].lat, positions[j].lng);
            if (d < minDist) minDist = d;
        }
    }
    return minDist;
}

// Minimum pairwise road distance over all pairs that do NOT involve patrol at excludeIdx.
// Precomputed once per patrol per iteration — O(n²) — so per-neighbor evaluation is O(n).
// Falls back to Haversine if roadDistMatrix is not provided.
function minPairwiseExcluding(positions, excludeIdx, roadDistMatrix) {
    let minDist = Infinity;
    const n = positions.length;
    for (let j = 0; j < n; j++) {
        if (j === excludeIdx) continue;
        for (let k = j + 1; k < n; k++) {
            if (k === excludeIdx) continue;
            const d = roadDistMatrix
                ? (roadDistMatrix[positions[j].nodeId]?.[positions[k].nodeId] ?? Infinity)
                : haversineDistance(positions[j].lat, positions[j].lng, positions[k].lat, positions[k].lng);
            if (d < minDist) minDist = d;
        }
    }
    return minDist;
}

// Find all valid candidate nodes within road distance R of patrol at positions[idx].
// Uses roadDistMatrix for O(1) lookup per candidate — no bbox pre-filter needed.
// Falls back to Haversine bbox+confirmation if roadDistMatrix is not provided.
// Excludes si's own node and any node currently occupied by another patrol.
function findNeighbors(positions, idx, R, validCandidates, roadDistMatrix, eps) {
    const si = positions[idx];

    const occupiedIds = new Set();
    for (let j = 0; j < positions.length; j++) {
        if (j !== idx) occupiedIds.add(positions[j].nodeId);
    }

    const neighbors = [];

    if (roadDistMatrix) {
        const row = roadDistMatrix[si.nodeId];
        if (!row) return neighbors;
        for (const v of validCandidates) {
            if (v.id === si.nodeId) continue;
            if (occupiedIds.has(v.id)) continue;
            if ((row[v.id] ?? Infinity) <= R) neighbors.push(v);
        }
    } else {
        // Haversine fallback — bbox pre-filter then confirmation
        const dLat = R / 111000;
        const dLng = R / (111000 * Math.cos(si.lat * Math.PI / 180));
        for (const v of validCandidates) {
            if (v.id === si.nodeId) continue;
            if (occupiedIds.has(v.id)) continue;
            if (v.lat < si.lat - dLat - eps || v.lat > si.lat + dLat + eps) continue;
            if (v.lng < si.lng - dLng - eps || v.lng > si.lng + dLng + eps) continue;
            if (haversineDistance(si.lat, si.lng, v.lat, v.lng) <= R) neighbors.push(v);
        }
    }
    return neighbors;
}

// ── Main export ───────────────────────────────────────────────────────────────
// validCandidates: Array<{id, lat, lng}> — intersection nodes inside the hull
// n:              number of patrols requested
// hullAreaM2:     hull area in square metres (used to compute radius R)
// config:         CONFIG object — reads hillClimbing and snapping sections
// options:        { pushProgress?: function }
//
// Return shape:
// {
//   status: 'success' | 'warning' | 'error',
//   message: string,
//   warnings: string[],
//   data: {
//     patrols: [{id, nodeId, lat, lng, color}],
//     bestMinPairwiseDist: number,
//     bestRestart: number,          // 1-indexed
//     restartsCompleted: number,
//     confidence: number,           // 0–100
//     cappedFrom: number | null,    // original n if n was capped
//     traceLog: string[]
//   }
// }
export function runHillClimbing(validCandidates, n, hullAreaM2, config, options = {}) {
    const { pushProgress = null, seed = null, roadDistMatrix = null } = options;

    const eps  = config.snapping.boundingBoxEpsilon;   // 1e-7
    const log      = [];
    const warnings = [];

    log.push(roadDistMatrix
        ? `Distance metric: road network (precomputed matrix, ${Object.keys(roadDistMatrix).length} nodes)`
        : 'Distance metric: Haversine straight-line (no road matrix provided)');

    // ── Defensive check ───────────────────────────────────────────────────────
    if (!validCandidates || validCandidates.length === 0) {
        return {
            status: 'error',
            message: 'No valid patrol positions available. Please recalculate.',
            warnings,
            data: {
                patrols: null, bestMinPairwiseDist: null, bestRestart: null,
                restartsCompleted: 0, confidence: null, cappedFrom: null, traceLog: log
            }
        };
    }

    // ── n = 1 special case ────────────────────────────────────────────────────
    // Skip Hill Climbing — place sole patrol at most central valid candidate.
    // Most central = minimum average Haversine distance to all other valid candidates.
    if (n === 1) {
        log.push('Single patrol mode - finding most central intersection node.');
        let bestNode   = null;
        let bestAvgDist = Infinity;
        for (const candidate of validCandidates) {
            let total = 0;
            for (const other of validCandidates) {
                total += roadDistMatrix
                    ? (roadDistMatrix[candidate.id]?.[other.id] ?? Infinity)
                    : haversineDistance(candidate.lat, candidate.lng, other.lat, other.lng);
            }
            const avg = total / validCandidates.length;
            if (avg < bestAvgDist) {
                bestAvgDist = avg;
                bestNode    = candidate;
            }
        }
        log.push(`Single patrol placed at most central node: ${bestNode.id} (${bestNode.lat.toFixed(6)}, ${bestNode.lng.toFixed(6)}), avg dist to others: ${Math.round(bestAvgDist)}m`);
        return {
            status:   'success',
            message:  'Single patrol mode - placed at most central intersection node.',
            warnings,
            data: {
                patrols: [{ id: 's1', nodeId: bestNode.id, lat: bestNode.lat, lng: bestNode.lng, color: PATROL_COLORS[0] }],
                bestMinPairwiseDist: 0,
                bestRestart:        0,
                restartsCompleted:  0,
                confidence:         100,
                cappedFrom:         null,
                traceLog:           log,
                restartScores:      [],
                bestSoFarCurve:     [],
                convergenceRestart: null,
                efficiency:         null
            }
        };
    }

    // ── n > validCandidates cap ───────────────────────────────────────────────
    let effectiveN = n;
    let cappedFrom = null;
    if (n > validCandidates.length) {
        cappedFrom  = n;
        effectiveN  = validCandidates.length;
        const msg   = `Only ${effectiveN} valid patrol positions exist inside the danger zone. Number of patrols reduced from ${n} to ${effectiveN}.`;
        warnings.push(msg);
        log.push(msg);
        if (effectiveN === 0) {
            return {
                status: 'error',
                message: 'No valid patrol positions available for the requested configuration.',
                warnings,
                data: {
                    patrols: null, bestMinPairwiseDist: null, bestRestart: null,
                    restartsCompleted: 0, confidence: null, cappedFrom, traceLog: log
                }
            };
        }
    }

    // ── Radius R ──────────────────────────────────────────────────────────────
    // R = sqrt(A_m2 / |validCandidates|) × radiusMultiplier
    const baseR = Math.sqrt(hullAreaM2 / validCandidates.length) * config.hillClimbing.radiusMultiplier;
    log.push(`R = sqrt(${Math.round(hullAreaM2)} / ${validCandidates.length}) × ${config.hillClimbing.radiusMultiplier} = ${Math.round(baseR)}m`);

    // ── Restart budget ────────────────────────────────────────────────────────
    // Total restarts = restarts-per-patrol × n. Scales with n because the
    // min-max-pairwise-distance landscape has more local optima as n grows.
    const maxRestarts   = config.hillClimbing.restarts * effectiveN;
    const minRestarts   = Math.max(5, effectiveN);
    const maxIterations = config.hillClimbing.maxIterations;       // default 500
    const syncMode      = config.hillClimbing.synchronousMode === true;

    const allRestartResults   = [];   // { positions, minDist, iterations, maxIterReached, nodeIdSet }
    let bestResult            = null; // { positions, minDist, restartIndex }
    let anyMaxIterWarning     = false;
    let totalRadiusExpansions = 0;
    let duplicateConfigCount  = 0;

    // ── Parameters block ──────────────────────────────────────────────────────
    log.push(`Patrols: ${effectiveN}${cappedFrom != null ? ` (capped from ${cappedFrom})` : ''} | Candidates: ${validCandidates.length} | R: ${Math.round(baseR)}m`);
    log.push(`Restarts: max ${maxRestarts} (${config.hillClimbing.restarts}×n), min ${minRestarts} | Max iterations: ${maxIterations} | Mode: ${syncMode ? 'synchronous' : 'asynchronous'} | Seed: ${seed !== null ? seed : 'none (random)'}`);

    // ── Restart loop ──────────────────────────────────────────────────────────
    for (let restartIdx = 0; restartIdx < maxRestarts; restartIdx++) {
        log.push(`─── Restart ${restartIdx + 1} ───`);

        // Per-restart RNG — seeded from incident hash XOR restart index so each restart
        // explores a different region while remaining fully deterministic per input set.
        // Falls back to Math.random when no seed is provided.
        const rng = seed !== null
            ? mulberry32((seed ^ Math.imul(restartIdx, 2654435761)) >>> 0)
            : Math.random;

        // Shuffle-and-slice initialization — guarantees unique starting positions.
        const shuffledCandidates = shuffle(validCandidates, rng);
        let positions = shuffledCandidates.slice(0, effectiveN).map((node, i) => ({
            id:     `s${i + 1}`,
            nodeId:  node.id,
            lat:     node.lat,
            lng:     node.lng,
            color:   PATROL_COLORS[i % PATROL_COLORS.length]
        }));
        const initMinDist = effectiveN > 1 ? globalMinPairwiseDist(positions, roadDistMatrix) : 0;
        log.push(`  Init: ${positions.map(p => p.nodeId).join(', ')} | start dist: ${Math.round(initMinDist)}m`);

        let R                        = baseR;
        let anyPatrolMoved           = true;
        let iteration                = 0;
        let maxIterReached           = false;
        let restartRadiusExpansions  = 0;
        let moveCount                = 0;

        // ── Iteration loop ────────────────────────────────────────────────────
        while (anyPatrolMoved && iteration < maxIterations) {
            anyPatrolMoved          = false;
            let anyPatrolHadNeighbors = false;

            // Shuffle patrol processing order each iteration to prevent systematic bias.
            const shuffledOrder = shuffle(Array.from({ length: effectiveN }, (_, i) => i), rng);

            if (syncMode) {
                // ── Synchronous mode ──────────────────────────────────────────
                // Phase 1: compute proposed moves for ALL patrols using OLD positions.
                // No patrol sees another's movement during this phase.
                const globalMinCurrent = globalMinPairwiseDist(positions, roadDistMatrix);
                const proposedMoves    = new Array(effectiveN).fill(null);

                for (const idx of shuffledOrder) {
                    const neighbors = findNeighbors(positions, idx, R, validCandidates, roadDistMatrix, eps);
                    if (neighbors.length === 0) continue;
                    anyPatrolHadNeighbors = true;

                    const minExclSi  = minPairwiseExcluding(positions, idx, roadDistMatrix);
                    let bestMinDist  = globalMinCurrent;
                    let bestNeighbor = null;

                    for (const v of neighbors) {
                        let minFromV = Infinity;
                        for (let j = 0; j < effectiveN; j++) {
                            if (j === idx) continue;
                            const d = roadDistMatrix
                                ? (roadDistMatrix[v.id]?.[positions[j].nodeId] ?? Infinity)
                                : haversineDistance(v.lat, v.lng, positions[j].lat, positions[j].lng);
                            if (d < minFromV) minFromV = d;
                        }
                        const newGlobalMin = Math.min(minExclSi, minFromV);
                        if (newGlobalMin > bestMinDist) {
                            bestMinDist  = newGlobalMin;
                            bestNeighbor = v;
                        }
                    }
                    proposedMoves[idx] = bestNeighbor; // null if no improvement found
                }

                // Phase 2: apply all non-conflicting moves simultaneously.
                // occupiedTargets starts with nodes of non-moving patrols — these are
                // immovable targets that moving patrols cannot claim.
                // Moving patrols' current nodes are NOT in the set, allowing chain moves.
                const occupiedTargets = new Set(
                    positions.filter((_, i) => !proposedMoves[i]).map(p => p.nodeId)
                );
                const newPositions = positions.map(p => ({ ...p }));

                for (const idx of shuffledOrder) {
                    const target = proposedMoves[idx];
                    if (!target) continue;
                    if (occupiedTargets.has(target.id)) continue; // conflict — higher-priority patrol already claimed this node
                    occupiedTargets.add(target.id);
                    newPositions[idx] = { ...newPositions[idx], nodeId: target.id, lat: target.lat, lng: target.lng };
                    anyPatrolMoved = true;
                    moveCount++;
                    log.push(`  Iter ${iteration}, ${newPositions[idx].id} (sync) ${positions[idx].nodeId} → ${target.id}`);
                }
                positions = newPositions;

                // pushProgress once per iteration in sync mode (after batch apply)
                if (anyPatrolMoved && typeof pushProgress === 'function') {
                    const currentMin = globalMinPairwiseDist(positions);
                    pushProgress({
                        stage:           2,
                        restart:         restartIdx + 1,
                        iteration,
                        patrolPositions: positions.map(p => ({ id: p.id, lat: p.lat, lng: p.lng, color: p.color })),
                        bestMinDist:     bestResult ? Math.max(bestResult.minDist, currentMin) : currentMin
                    });
                }

            } else {
                // ── Asynchronous mode (default, V1 behavior) ──────────────────
                // Process patrols sequentially — each patrol sees the moves already
                // applied by earlier patrols in this iteration's shuffled order.
                for (const idx of shuffledOrder) {
                    const neighbors = findNeighbors(positions, idx, R, validCandidates, roadDistMatrix, eps);

                    if (neighbors.length === 0) {
                        log.push(`  Iter ${iteration}, ${positions[idx].id}: no unoccupied neighbors within R=${Math.round(R)}m`);
                        continue;
                    }
                    anyPatrolHadNeighbors = true;

                    // Precompute min pairwise excluding si — O(n²) once per patrol.
                    // Used to avoid recomputing this term for every neighbor candidate.
                    const minExclSi     = minPairwiseExcluding(positions, idx, roadDistMatrix);
                    const prevGlobalMin = globalMinPairwiseDist(positions, roadDistMatrix);
                    let bestMinDist     = prevGlobalMin;
                    let bestNeighbor    = null;

                    for (const v of neighbors) {
                        // Compute distance from v to all other patrols — O(n)
                        let minFromV = Infinity;
                        for (let j = 0; j < effectiveN; j++) {
                            if (j === idx) continue;
                            const d = roadDistMatrix
                                ? (roadDistMatrix[v.id]?.[positions[j].nodeId] ?? Infinity)
                                : haversineDistance(v.lat, v.lng, positions[j].lat, positions[j].lng);
                            if (d < minFromV) minFromV = d;
                        }
                        // New global min if si were at v
                        const newGlobalMin = Math.min(minExclSi, minFromV);
                        if (newGlobalMin > bestMinDist) {
                            bestMinDist  = newGlobalMin;
                            bestNeighbor = v;
                        }
                    }

                    if (bestNeighbor) {
                        const oldNodeId  = positions[idx].nodeId;
                        positions[idx]   = { ...positions[idx], nodeId: bestNeighbor.id, lat: bestNeighbor.lat, lng: bestNeighbor.lng };
                        anyPatrolMoved   = true;
                        moveCount++;
                        log.push(`  Iter ${iteration}, ${positions[idx].id} moved ${oldNodeId} → ${bestNeighbor.id} (min dist: ${Math.round(prevGlobalMin)}m → ${Math.round(bestMinDist)}m)`);

                        // pushProgress after each individual patrol move in async mode
                        if (typeof pushProgress === 'function') {
                            pushProgress({
                                stage:           2,
                                restart:         restartIdx + 1,
                                iteration,
                                patrolPositions: positions.map(p => ({ id: p.id, lat: p.lat, lng: p.lng, color: p.color })),
                                bestMinDist:     bestMinDist
                            });
                        }
                    }
                }
            }

            // If no patrol had any neighbor at all, R is too small — expand by 50%
            if (!anyPatrolHadNeighbors) {
                R                       *= 1.5;
                restartRadiusExpansions++;
                totalRadiusExpansions++;
                anyPatrolMoved           = true; // continue iterating after expansion
                log.push(`  All patrols surrounded. Expanding radius R to ${Math.round(R)}m`);
            }

            iteration++;
        }

        // Max iteration cap check
        if (iteration >= maxIterations) {
            maxIterReached    = true;
            anyMaxIterWarning = true;
            const msg = `Restart ${restartIdx + 1} reached maximum ${maxIterations} iterations without converging. Result may be suboptimal.`;
            log.push(`  ${msg}`);
            warnings.push(msg);
        }

        const finalMinDist = effectiveN > 1 ? globalMinPairwiseDist(positions, roadDistMatrix) : 0;

        // Duplicate configuration detection — compare node ID sets
        const nodeIdSet   = new Set(positions.map(p => p.nodeId));
        let isDuplicate   = false;
        for (const prev of allRestartResults) {
            if (prev.nodeIdSet.size === nodeIdSet.size &&
                [...nodeIdSet].every(id => prev.nodeIdSet.has(id))) {
                isDuplicate = true;
                duplicateConfigCount++;
                log.push(`  Restart ${restartIdx + 1} converged to previously found configuration. Solution diversity low - consider increasing radius R in Settings.`);
                break;
            }
        }

        allRestartResults.push({
            positions:     positions.map(p => ({ ...p })),
            minDist:       finalMinDist,
            iterations:    iteration,
            maxIterReached,
            nodeIdSet
        });

        // Keep the restart with highest minimum pairwise distance as current best
        const prevBestDist = bestResult?.minDist ?? null;
        const isNewBest    = !bestResult || finalMinDist > bestResult.minDist;
        if (isNewBest) {
            bestResult = {
                positions:    positions.map(p => ({ ...p })),
                minDist:      finalMinDist,
                restartIndex: restartIdx
            };
        }

        const expansionNote = restartRadiusExpansions > 0 ? ` | R expanded ${restartRadiusExpansions}×` : '';
        log.push(`  Restart ${restartIdx + 1} summary: ${iteration} iter | ${moveCount} moves | ${Math.round(initMinDist)}m → ${Math.round(finalMinDist)}m${expansionNote}${isNewBest ? ' [NEW BEST]' : ''}${isDuplicate ? ' [DUPLICATE]' : ''}`);
        log.push(`  Final: ${positions.map(p => `${p.id}@${p.nodeId}`).join(' | ')}`);
        if (isNewBest && prevBestDist !== null) {
            const imp = finalMinDist - prevBestDist;
            log.push(`  ** Best improved: +${Math.round(imp)}m (+${((imp / prevBestDist) * 100).toFixed(1)}%) → new best ${Math.round(finalMinDist)}m`);
        } else if (isNewBest) {
            log.push(`  ** First result: ${Math.round(finalMinDist)}m`);
        }

        // ── Adaptive convergence check ─────────────────────────────────────────
        // After minimum 5 restarts, stop if last 3 consecutive results are within 0.1%.
        if (allRestartResults.length >= minRestarts) {
            const last3 = allRestartResults.slice(-3).map(r => r.minDist);
            if (last3.length === 3) {
                const maxD   = Math.max(...last3);
                const minD   = Math.min(...last3);
                const spread = maxD > 0 ? ((maxD - minD) / maxD * 100).toFixed(3) : '0.000';
                // Guard against maxD=0 edge case (n=2 with identical starting positions)
                if (maxD > 0 && (maxD - minD) / maxD < 0.001) {
                    log.push(`Converged after ${allRestartResults.length} restarts: [${last3.map(d => Math.round(d)).join(', ')}]m, spread ${spread}% < 0.1%.`);
                    break;
                }
                log.push(`  Convergence check: [${last3.map(d => Math.round(d)).join(', ')}]m, spread ${spread}% (need < 0.1%)`);
            }
        }
    }

    // ── Final summary ─────────────────────────────────────────────────────────
    const restartsCompleted = allRestartResults.length;
    if (restartsCompleted >= maxRestarts) {
        log.push(`Reached maximum ${maxRestarts} restarts.`);
    }
    log.push(`Best result found at restart ${bestResult.restartIndex + 1}. Min pairwise distance: ${Math.round(bestResult.minDist)}m.`);
    log.push(`All restart scores: [${allRestartResults.map((r, i) => `R${i + 1}:${Math.round(r.minDist)}m${r.maxIterReached ? '!' : ''}`).join('  ')}]`);
    log.push(`Best patrol positions: ${bestResult.positions.map(p => `${p.id}@${p.nodeId}(${p.lat.toFixed(6)},${p.lng.toFixed(6)})`).join(' | ')}`);
    if (duplicateConfigCount > 0) {
        log.push(`Duplicate configurations found: ${duplicateConfigCount} restarts.`);
    }
    if (totalRadiusExpansions > 0) {
        log.push(`Total radius expansions across all restarts: ${totalRadiusExpansions}.`);
    }

    // ── Convergence curve ─────────────────────────────────────────────────────
    // restartScores: raw per-restart minDist values.
    // bestSoFarCurve: monotonically non-decreasing best-so-far at each restart.
    // convergenceRestart: last restart (1-indexed) that improved the best result.
    const restartScores   = allRestartResults.map(r => r.minDist);
    const bestSoFarCurve  = [];
    let runningBest        = -Infinity;
    let convergenceRestart = 1;
    let improvingCount     = 0;
    for (let i = 0; i < restartScores.length; i++) {
        if (restartScores[i] > runningBest) {
            runningBest        = restartScores[i];
            convergenceRestart = i + 1;
            improvingCount++;
        }
        bestSoFarCurve.push(runningBest);
    }
    // redundancy: % of restarts that confirmed the best without improving it.
    // High redundancy = the algorithm kept verifying the same answer = stable solution.
    const redundancy = restartsCompleted > 0
        ? Math.round((1 - improvingCount / restartsCompleted) * 1000) / 10
        : null;

    // ── Confidence indicator ──────────────────────────────────────────────────
    // Weighted composite of two independent signals:
    //   60% consistency  — how tightly clustered are restart results?
    //                      Low coefficient of variation (stdDev/mean) → high consistency.
    //   40% confirmation — what fraction of restarts confirmed the best without improving?
    //                      High redundancy → the solution is stable and well-verified.
    // This addresses a weakness of consistency alone: if all restarts consistently find a
    // poor local optimum, stdDev/mean is low but the result is untrustworthy. Adding
    // confirmation penalises solutions that kept improving until the last restart.
    const allMinDists = allRestartResults.map(r => r.minDist);
    const mean        = allMinDists.reduce((s, d) => s + d, 0) / allMinDists.length;
    let confidence    = 100;
    let consistency   = 100;
    if (allMinDists.length > 1 && mean > 0) {
        const variance  = allMinDists.reduce((s, d) => s + (d - mean) ** 2, 0) / allMinDists.length;
        const stdDev    = Math.sqrt(variance);
        consistency     = Math.max(0, Math.min(100, (1 - stdDev / mean) * 100));
        const confirmation = redundancy ?? 0;
        confidence = Math.max(0, Math.min(100, 0.5 * consistency + 0.5 * confirmation));
    }

    log.push(`Convergence restart: ${convergenceRestart} of ${restartsCompleted}. Redundancy: ${redundancy}%.`);
    log.push(`Confidence: ${confidence.toFixed(1)}% = consistency(${consistency.toFixed(1)}%) × 0.5 + confirmation(${(redundancy ?? 0).toFixed(1)}%) × 0.5`);

    const hasWarnings = anyMaxIterWarning || duplicateConfigCount > 0 || totalRadiusExpansions > 0;

    return {
        status:  hasWarnings ? 'warning' : 'success',
        message: hasWarnings
            ? `Hill Climbing complete with warnings. Best minimum pairwise distance: ${Math.round(bestResult.minDist)}m.`
            : `Hill Climbing complete. Best minimum pairwise distance: ${Math.round(bestResult.minDist)}m.`,
        warnings,
        data: {
            patrols:             bestResult.positions,
            bestMinPairwiseDist: bestResult.minDist,
            bestRestart:         bestResult.restartIndex + 1,
            restartsCompleted,
            confidence:          Math.round(confidence * 10) / 10,
            cappedFrom,
            traceLog:            log,
            bestSoFarCurve,
            convergenceRestart,
            redundancy
        }
    };
}
