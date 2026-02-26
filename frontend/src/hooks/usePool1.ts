import { useCallback, useEffect, useState } from 'react';
import { getContract, CallResult, OPNetEvent, IOP_NETContract } from 'opnet';
import { Address } from '@btc-vision/transaction';
import { useOPNet } from '../contexts/OPNetProvider';
import { Pool1Abi } from '../abi/abis';
import { opnetSign } from '../utils/opnetSign';
import { computeBlockRate, computeBlocksUntilHalving, computeTotalEmitted } from '../utils/emission';
import { POOL1_INITIAL_RATE, POOL1_EPOCH_DURATION, POOL1_MAX_EPOCHS } from '../config/contracts';

interface IPool1Contract extends IOP_NETContract {
    deposit(poolId: number, amount: bigint): Promise<CallResult>;
    withdraw(poolId: number, amount: bigint): Promise<CallResult>;
    harvest(poolId: number): Promise<CallResult>;
    /** Committed rewards — exact lower bound on what harvest() will transfer. */
    pendingStored(poolId: number, user: Address): Promise<CallResult<{ committed: bigint }, OPNetEvent<never>[]>>;
    /** Estimated rewards — includes real-time accrual, may differ from actual harvest. */
    pending(poolId: number, user: Address): Promise<CallResult<{ pending: bigint }, OPNetEvent<never>[]>>;
    getUserStake(poolId: number, user: Address): Promise<CallResult<{ stake: bigint }, OPNetEvent<never>[]>>;
    getTotalDistributed(): Promise<CallResult<{ totalDistributed: bigint }, OPNetEvent<never>[]>>;
}

interface Pool1State {
    /**
     * Committed rewards per sub-pool — exactly matches what harvest() will transfer
     * (or less if medianTimestamp advances). Updated by deposit/withdraw/harvest.
     * Monotonically non-decreasing between harvests → safe to display without HWM.
     */
    committed: readonly [bigint, bigint, bigint];
    /**
     * Estimated real-time rewards per sub-pool — includes accruing rewards based
     * on the simulation timestamp. May be higher than actual harvest amount.
     * Use a localStorage HWM so it never visually decreases on refresh.
     */
    pendingEstimate: readonly [bigint, bigint, bigint];
    stakes: readonly [bigint, bigint, bigint];
    /** Current emission rate per block for each sub-pool (base units, 8 decimals). */
    ratesPerBlock: readonly [bigint, bigint, bigint];
    /** Blocks remaining until next halving, or null if in final epoch. */
    blocksUntilHalving: bigint | null;
    totalDistributed: bigint;
    /** Total BMOTO emitted globally (harvested + pending across all users). */
    totalEmitted: bigint;
    loading: boolean;
}

interface TxState {
    loading: boolean;
    error: string | null;
    txId: string | null;
}

// ---------------------------------------------------------------------------
// localStorage HWM helpers — keyed by wallet address so multiple wallets
// don't share stale values.
// ---------------------------------------------------------------------------

function hwmKey(walletAddress: string): string {
    return `pool1_pending_hwm_${walletAddress}`;
}

function loadHWM(walletAddress: string | null): readonly [bigint, bigint, bigint] {
    if (!walletAddress) return [0n, 0n, 0n];
    try {
        const raw = localStorage.getItem(hwmKey(walletAddress));
        if (!raw) return [0n, 0n, 0n];
        const parsed = JSON.parse(raw) as string[];
        return [BigInt(parsed[0] ?? '0'), BigInt(parsed[1] ?? '0'), BigInt(parsed[2] ?? '0')];
    } catch {
        return [0n, 0n, 0n];
    }
}

function saveHWM(walletAddress: string | null, values: readonly [bigint, bigint, bigint]): void {
    if (!walletAddress) return;
    try {
        localStorage.setItem(hwmKey(walletAddress), JSON.stringify(values.map(String)));
    } catch { /* non-fatal */ }
}

function clearHWMPool(walletAddress: string | null, poolId: 0 | 1 | 2, current: readonly [bigint, bigint, bigint]): readonly [bigint, bigint, bigint] {
    const next: [bigint, bigint, bigint] = [current[0], current[1], current[2]];
    next[poolId] = 0n;
    saveHWM(walletAddress, next);
    return next;
}

function maxPending(
    next: readonly [bigint, bigint, bigint],
    prev: readonly [bigint, bigint, bigint],
): readonly [bigint, bigint, bigint] {
    return [
        next[0] > prev[0] ? next[0] : prev[0],
        next[1] > prev[1] ? next[1] : prev[1],
        next[2] > prev[2] ? next[2] : prev[2],
    ];
}

// ---------------------------------------------------------------------------

export function usePool1(pool1Address: string, farmStart: bigint) {
    const { provider, network, networkId, walletAddress, walletAddressObj } = useOPNet();
    const [state, setState] = useState<Pool1State>({
        committed: [0n, 0n, 0n],
        pendingEstimate: [0n, 0n, 0n],
        stakes: [0n, 0n, 0n],
        ratesPerBlock: [0n, 0n, 0n],
        blocksUntilHalving: null,
        totalDistributed: 0n,
        totalEmitted: 0n,
        loading: false,
    });
    const [txStates, setTxStates] = useState<[TxState, TxState, TxState]>([
        { loading: false, error: null, txId: null },
        { loading: false, error: null, txId: null },
        { loading: false, error: null, txId: null },
    ]);

    // Fetch current block and compute rates — independent of wallet connection
    useEffect(() => {
        if (!provider) return;
        let cancelled = false;
        provider.getBlockNumber().then((bn) => {
            if (cancelled) return;
            const block = BigInt(bn);
            const poolRate = computeBlockRate(
                POOL1_INITIAL_RATE, POOL1_EPOCH_DURATION, POOL1_MAX_EPOCHS,
                farmStart, block,
            );
            const ratesPerBlock: readonly [bigint, bigint, bigint] = [
                poolRate * 70n / 100n,
                poolRate * 15n / 100n,
                poolRate * 15n / 100n,
            ];
            const blocksUntilHalving = computeBlocksUntilHalving(
                POOL1_EPOCH_DURATION, POOL1_MAX_EPOCHS, farmStart, block,
            );
            const totalEmitted = computeTotalEmitted(
                POOL1_INITIAL_RATE, POOL1_EPOCH_DURATION, POOL1_MAX_EPOCHS, farmStart, block,
            );
            setState((s) => ({ ...s, ratesPerBlock, blocksUntilHalving, totalEmitted }));
        }).catch(() => { /* non-fatal */ });
        return () => { cancelled = true; };
    }, [provider, farmStart]);

    // Load HWM from localStorage when wallet connects
    useEffect(() => {
        if (!walletAddress) return;
        const hwm = loadHWM(walletAddress);
        setState((s) => ({ ...s, pendingEstimate: maxPending(hwm, s.pendingEstimate) }));
    }, [walletAddress]);

    // Persist pendingEstimate HWM to localStorage whenever it changes
    useEffect(() => {
        saveHWM(walletAddress, state.pendingEstimate);
    }, [walletAddress, state.pendingEstimate]);

    const setPoolTx = useCallback((poolId: 0 | 1 | 2, update: TxState) => {
        setTxStates((prev) => {
            const next: [TxState, TxState, TxState] = [prev[0], prev[1], prev[2]];
            next[poolId] = update;
            return next;
        });
    }, []);

    const getPool = useCallback((): IPool1Contract => {
        if (!provider || !walletAddressObj) throw new Error('Wallet not connected');
        return getContract<IPool1Contract>(
            pool1Address,
            Pool1Abi,
            provider,
            network,
            walletAddressObj,
        );
    }, [provider, network, walletAddressObj, pool1Address]);

    const refresh = useCallback(async () => {
        if (!provider || !walletAddressObj) return;
        setState((s) => ({ ...s, loading: true }));
        try {
            const pool = getPool();
            const [c0, c1, c2, e0, e1, e2, s0, s1, s2, dist, blockNum] = await Promise.all([
                pool.pendingStored(0, walletAddressObj),
                pool.pendingStored(1, walletAddressObj),
                pool.pendingStored(2, walletAddressObj),
                pool.pending(0, walletAddressObj),
                pool.pending(1, walletAddressObj),
                pool.pending(2, walletAddressObj),
                pool.getUserStake(0, walletAddressObj),
                pool.getUserStake(1, walletAddressObj),
                pool.getUserStake(2, walletAddressObj),
                pool.getTotalDistributed(),
                provider.getBlockNumber(),
            ]);
            const block = BigInt(blockNum);
            const poolRate = computeBlockRate(
                POOL1_INITIAL_RATE, POOL1_EPOCH_DURATION, POOL1_MAX_EPOCHS,
                farmStart, block,
            );
            const ratesPerBlock: readonly [bigint, bigint, bigint] = [
                poolRate * 70n / 100n,
                poolRate * 15n / 100n,
                poolRate * 15n / 100n,
            ];
            const blocksUntilHalving = computeBlocksUntilHalving(
                POOL1_EPOCH_DURATION, POOL1_MAX_EPOCHS, farmStart, block,
            );
            const totalEmitted = computeTotalEmitted(
                POOL1_INITIAL_RATE, POOL1_EPOCH_DURATION, POOL1_MAX_EPOCHS, farmStart, block,
            );
            const nextCommitted: readonly [bigint, bigint, bigint] = [
                c0.properties.committed,
                c1.properties.committed,
                c2.properties.committed,
            ];
            const nextEstimate: readonly [bigint, bigint, bigint] = [
                e0.properties.pending,
                e1.properties.pending,
                e2.properties.pending,
            ];
            const nextStakes: readonly [bigint, bigint, bigint] = [
                s0.properties.stake,
                s1.properties.stake,
                s2.properties.stake,
            ];
            setState((prev) => {
                // Apply HWM only for sub-pools with active stake; reset to 0 if unstaked.
                const pendingEstimate: [bigint, bigint, bigint] = [0n, 0n, 0n];
                for (let i = 0; i < 3; i++) {
                    if (nextStakes[i] === 0n) {
                        pendingEstimate[i] = 0n;
                    } else {
                        pendingEstimate[i] = nextEstimate[i] > prev.pendingEstimate[i]
                            ? nextEstimate[i]
                            : prev.pendingEstimate[i];
                    }
                }
                return {
                    committed: nextCommitted,
                    pendingEstimate,
                    stakes: nextStakes,
                    ratesPerBlock,
                    blocksUntilHalving,
                    totalDistributed: dist.properties.totalDistributed,
                    totalEmitted,
                    loading: false,
                };
            });
        } catch {
            setState((s) => ({ ...s, loading: false }));
        }
    }, [getPool, provider, walletAddressObj]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const sendPoolTx = useCallback(
        async (action: () => Promise<CallResult>): Promise<string | null> => {
            if (!walletAddress) throw new Error('Wallet not connected');
            const sim = await action();
            if ('error' in sim) throw new Error(`Simulation: ${String((sim as { error: unknown }).error)}`);
            return opnetSign(sim, networkId, network, walletAddress, false);
        },
        [walletAddress, networkId, network],
    );

    const wait = () => new Promise<void>((r) => setTimeout(r, 8000));

    const deposit = useCallback(
        async (poolId: number, amount: bigint) => {
            const id = poolId as 0 | 1 | 2;
            setPoolTx(id, { loading: true, error: null, txId: null });
            try {
                const txid = await sendPoolTx(() => getPool().deposit(poolId, amount));
                setPoolTx(id, { loading: false, error: null, txId: txid });
                // Reset HWM for this sub-pool — deposit calls _updateReward so
                // the next pendingStored will show the newly committed amount.
                setState((s) => ({
                    ...s,
                    pendingEstimate: clearHWMPool(walletAddress, id, s.pendingEstimate),
                }));
                await wait();
                void refresh();
            } catch (err: unknown) {
                setPoolTx(id, { loading: false, error: err instanceof Error ? err.message : String(err), txId: null });
            }
        },
        [sendPoolTx, getPool, refresh, setPoolTx, walletAddress],
    );

    const withdraw = useCallback(
        async (poolId: number, amount: bigint) => {
            const id = poolId as 0 | 1 | 2;
            setPoolTx(id, { loading: true, error: null, txId: null });
            try {
                const txid = await sendPoolTx(() => getPool().withdraw(poolId, amount));
                setPoolTx(id, { loading: false, error: null, txId: txid });
                setState((s) => ({
                    ...s,
                    pendingEstimate: clearHWMPool(walletAddress, id, s.pendingEstimate),
                }));
                await wait();
                void refresh();
            } catch (err: unknown) {
                setPoolTx(id, { loading: false, error: err instanceof Error ? err.message : String(err), txId: null });
            }
        },
        [sendPoolTx, getPool, refresh, setPoolTx, walletAddress],
    );

    const harvest = useCallback(
        async (poolId: number) => {
            const id = poolId as 0 | 1 | 2;
            setPoolTx(id, { loading: true, error: null, txId: null });
            try {
                const txid = await sendPoolTx(() => getPool().harvest(poolId));
                setPoolTx(id, { loading: false, error: null, txId: txid });
                // Clear committed display immediately after harvest confirms.
                // Also reset HWM — rewards are now 0, the estimate should start fresh.
                setState((s) => {
                    const nextCommitted: [bigint, bigint, bigint] = [s.committed[0], s.committed[1], s.committed[2]];
                    nextCommitted[id] = 0n;
                    return {
                        ...s,
                        committed: nextCommitted,
                        pendingEstimate: clearHWMPool(walletAddress, id, s.pendingEstimate),
                    };
                });
                await wait();
                void refresh();
            } catch (err: unknown) {
                setPoolTx(id, { loading: false, error: err instanceof Error ? err.message : String(err), txId: null });
            }
        },
        [sendPoolTx, getPool, refresh, setPoolTx, walletAddress],
    );

    const harvestAll = useCallback(async () => {
        for (const id of [0, 1, 2] as const) {
            if (state.committed[id] === 0n && state.stakes[id] === 0n) continue;
            await harvest(id);
        }
    }, [harvest, state.committed, state.stakes]);

    return { ...state, txStates, deposit, withdraw, harvest, harvestAll, refresh };
}
