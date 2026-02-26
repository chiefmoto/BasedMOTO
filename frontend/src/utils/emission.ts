/**
 * Computes total BMOTO emitted from the pool since farm start up to
 * `currentBlock`, summing completed epochs plus the partial current epoch.
 * This represents global farmed (harvested + still pending across all users).
 */
export function computeTotalEmitted(
    initialRate: bigint,
    epochDuration: bigint,
    maxEpochs: bigint,
    farmStart: bigint,
    currentBlock: bigint,
): bigint {
    if (farmStart === 0n || currentBlock <= farmStart) return 0n;
    const elapsed = currentBlock - farmStart;
    const currentEpoch = elapsed / epochDuration;
    const cappedEpoch = currentEpoch < maxEpochs ? currentEpoch : maxEpochs;
    let total = 0n;
    // Sum completed epochs
    for (let e = 0n; e < cappedEpoch; e++) {
        total += (initialRate >> e) * epochDuration;
    }
    // Add partial current epoch (if still within emission schedule)
    if (currentEpoch < maxEpochs) {
        const blocksInCurrentEpoch = elapsed - currentEpoch * epochDuration;
        total += (initialRate >> currentEpoch) * blocksInCurrentEpoch;
    }
    return total;
}

/**
 * Returns blocks remaining until the next halving, or null if the farm
 * hasn't started or is in its final epoch.
 */
export function computeBlocksUntilHalving(
    epochDuration: bigint,
    maxEpochs: bigint,
    farmStart: bigint,
    currentBlock: bigint,
): bigint | null {
    if (farmStart === 0n || currentBlock < farmStart) return null;
    const epoch = (currentBlock - farmStart) / epochDuration;
    if (epoch >= maxEpochs - 1n) return null;
    const nextHalvingBlock = farmStart + (epoch + 1n) * epochDuration;
    return nextHalvingBlock - currentBlock;
}

/**
 * Computes the current per-block reward rate for a geometric halving
 * emission schedule: rate halves every `epochDuration` blocks starting
 * from `farmStart`, capped at `maxEpochs` epochs.
 */
export function computeBlockRate(
    initialRate: bigint,
    epochDuration: bigint,
    maxEpochs: bigint,
    farmStart: bigint,
    currentBlock: bigint,
): bigint {
    if (farmStart === 0n || currentBlock < farmStart) return 0n;
    const epoch = (currentBlock - farmStart) / epochDuration;
    if (epoch >= maxEpochs) return 0n;
    return initialRate >> epoch;
}
