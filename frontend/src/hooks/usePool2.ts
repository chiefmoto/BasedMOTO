import { useCallback, useEffect, useState } from 'react';
import { getContract, CallResult, OPNetEvent, IOP_NETContract } from 'opnet';
import { Address } from '@btc-vision/transaction';
import { useOPNet } from '../contexts/OPNetProvider';
import { Pool2Abi } from '../abi/abis';
import { opnetSign } from '../utils/opnetSign';
import { computeBlockRate, computeBlocksUntilHalving, computeTotalEmitted } from '../utils/emission';
import { POOL2_INITIAL_RATE, POOL2_EPOCH_DURATION, POOL2_MAX_EPOCHS } from '../config/contracts';

interface IPool2Contract extends IOP_NETContract {
    deposit(amount: bigint): Promise<CallResult>;
    withdraw(amount: bigint): Promise<CallResult>;
    harvest(): Promise<CallResult>;
    /** Committed rewards — exact lower bound on what harvest() will transfer. */
    pendingStored(user: Address): Promise<CallResult<{ committed: bigint }, OPNetEvent<never>[]>>;
    /** Estimated rewards — includes real-time accrual, may differ from actual harvest. */
    pending(user: Address): Promise<CallResult<{ pending: bigint }, OPNetEvent<never>[]>>;
    getTotalDistributed(): Promise<CallResult<{ totalDistributed: bigint }, OPNetEvent<never>[]>>;
    getUserStake(user: Address): Promise<CallResult<{ stake: bigint }, OPNetEvent<never>[]>>;
}

interface Pool2State {
    /**
     * Committed rewards — exactly matches what harvest() will transfer
     * (or less if medianTimestamp advances). Monotonically non-decreasing
     * between harvests.
     */
    committed: bigint;
    /**
     * Estimated real-time rewards — includes accruing rewards based on
     * simulation timestamp. May be higher than actual harvest amount.
     * Uses localStorage HWM so it never visually decreases on refresh.
     */
    pendingEstimate: bigint;
    stake: bigint;
    /** Current emission rate per block (base units, 8 decimals). */
    ratePerBlock: bigint;
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
// localStorage HWM helpers
// ---------------------------------------------------------------------------

function hwmKey(walletAddress: string): string {
    return `pool2_pending_hwm_${walletAddress}`;
}

function loadHWM(walletAddress: string | null): bigint {
    if (!walletAddress) return 0n;
    try {
        const raw = localStorage.getItem(hwmKey(walletAddress));
        if (!raw) return 0n;
        return BigInt(raw);
    } catch {
        return 0n;
    }
}

function saveHWM(walletAddress: string | null, value: bigint): void {
    if (!walletAddress) return;
    try {
        localStorage.setItem(hwmKey(walletAddress), value.toString());
    } catch { /* non-fatal */ }
}

function clearHWM(walletAddress: string | null): bigint {
    if (!walletAddress) return 0n;
    try {
        localStorage.removeItem(hwmKey(walletAddress));
    } catch { /* non-fatal */ }
    return 0n;
}

// ---------------------------------------------------------------------------

export function usePool2(pool2Address: string, farmStart: bigint) {
    const { provider, network, networkId, walletAddress, walletAddressObj } = useOPNet();
    const [state, setState] = useState<Pool2State>({
        committed: 0n,
        pendingEstimate: 0n,
        stake: 0n,
        ratePerBlock: 0n,
        blocksUntilHalving: null,
        totalDistributed: 0n,
        totalEmitted: 0n,
        loading: false,
    });
    const [tx, setTx] = useState<TxState>({ loading: false, error: null, txId: null });

    // Fetch current block and compute rate — independent of wallet connection
    useEffect(() => {
        if (!provider) return;
        let cancelled = false;
        provider.getBlockNumber().then((bn) => {
            if (cancelled) return;
            const block = BigInt(bn);
            const ratePerBlock = computeBlockRate(
                POOL2_INITIAL_RATE, POOL2_EPOCH_DURATION, POOL2_MAX_EPOCHS,
                farmStart, block,
            );
            const blocksUntilHalving = computeBlocksUntilHalving(
                POOL2_EPOCH_DURATION, POOL2_MAX_EPOCHS, farmStart, block,
            );
            const totalEmitted = computeTotalEmitted(
                POOL2_INITIAL_RATE, POOL2_EPOCH_DURATION, POOL2_MAX_EPOCHS, farmStart, block,
            );
            setState((s) => ({ ...s, ratePerBlock, blocksUntilHalving, totalEmitted }));
        }).catch(() => { /* non-fatal */ });
        return () => { cancelled = true; };
    }, [provider, farmStart]);

    // Load HWM from localStorage when wallet connects
    useEffect(() => {
        if (!walletAddress) return;
        const hwm = loadHWM(walletAddress);
        setState((s) => ({ ...s, pendingEstimate: hwm > s.pendingEstimate ? hwm : s.pendingEstimate }));
    }, [walletAddress]);

    // Persist pendingEstimate HWM to localStorage whenever it changes
    useEffect(() => {
        saveHWM(walletAddress, state.pendingEstimate);
    }, [walletAddress, state.pendingEstimate]);

    const getPool = useCallback((): IPool2Contract => {
        if (!provider || !walletAddressObj) throw new Error('Wallet not connected');
        return getContract<IPool2Contract>(
            pool2Address,
            Pool2Abi,
            provider,
            network,
            walletAddressObj,
        );
    }, [provider, network, walletAddressObj, pool2Address]);

    const refresh = useCallback(async () => {
        if (!provider || !walletAddressObj) return;
        setState((s) => ({ ...s, loading: true }));
        try {
            const pool = getPool();
            const [committedRes, estimateRes, distRes, stakeRes, blockNum] = await Promise.all([
                pool.pendingStored(walletAddressObj),
                pool.pending(walletAddressObj),
                pool.getTotalDistributed(),
                pool.getUserStake(walletAddressObj),
                provider.getBlockNumber(),
            ]);
            const block = BigInt(blockNum);
            const ratePerBlock = computeBlockRate(
                POOL2_INITIAL_RATE, POOL2_EPOCH_DURATION, POOL2_MAX_EPOCHS,
                farmStart, block,
            );
            const blocksUntilHalving = computeBlocksUntilHalving(
                POOL2_EPOCH_DURATION, POOL2_MAX_EPOCHS, farmStart, block,
            );
            const totalEmitted = computeTotalEmitted(
                POOL2_INITIAL_RATE, POOL2_EPOCH_DURATION, POOL2_MAX_EPOCHS, farmStart, block,
            );
            setState((prev) => {
                const nextStake = stakeRes.properties.stake;
                const nextEstimate = estimateRes.properties.pending;
                // Apply HWM only when stake is active; reset to 0 if fully unstaked.
                const pendingEstimate = nextStake === 0n
                    ? 0n
                    : nextEstimate > prev.pendingEstimate ? nextEstimate : prev.pendingEstimate;
                return {
                    committed: committedRes.properties.committed,
                    pendingEstimate,
                    stake: nextStake,
                    ratePerBlock,
                    blocksUntilHalving,
                    totalDistributed: distRes.properties.totalDistributed,
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
        async (amount: bigint) => {
            setTx({ loading: true, error: null, txId: null });
            try {
                const id = await sendPoolTx(() => getPool().deposit(amount));
                setTx({ loading: false, error: null, txId: id });
                // Reset HWM — deposit calls _updateReward, committing rewards to storage
                setState((s) => ({ ...s, pendingEstimate: clearHWM(walletAddress) }));
                await wait();
                void refresh();
            } catch (err: unknown) {
                setTx({ loading: false, error: err instanceof Error ? err.message : String(err), txId: null });
            }
        },
        [sendPoolTx, getPool, refresh, walletAddress],
    );

    const withdraw = useCallback(
        async (amount: bigint) => {
            setTx({ loading: true, error: null, txId: null });
            try {
                const id = await sendPoolTx(() => getPool().withdraw(amount));
                setTx({ loading: false, error: null, txId: id });
                setState((s) => ({ ...s, pendingEstimate: clearHWM(walletAddress) }));
                await wait();
                void refresh();
            } catch (err: unknown) {
                setTx({ loading: false, error: err instanceof Error ? err.message : String(err), txId: null });
            }
        },
        [sendPoolTx, getPool, refresh, walletAddress],
    );

    const harvest = useCallback(async () => {
        setTx({ loading: true, error: null, txId: null });
        try {
            const id = await sendPoolTx(() => getPool().harvest());
            setTx({ loading: false, error: null, txId: id });
            // Clear both committed and HWM immediately after harvest
            setState((s) => ({ ...s, committed: 0n, pendingEstimate: clearHWM(walletAddress) }));
            await wait();
            void refresh();
        } catch (err: unknown) {
            setTx({ loading: false, error: err instanceof Error ? err.message : String(err), txId: null });
        }
    }, [sendPoolTx, getPool, refresh, walletAddress]);

    return { ...state, tx, deposit, withdraw, harvest, refresh };
}
