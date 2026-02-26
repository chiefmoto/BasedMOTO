import { useState, useEffect, FormEvent } from 'react';
import { usePool1 } from '../hooks/usePool1';
import { useLPToken } from '../hooks/useLPToken';
import { useLPBalance } from '../hooks/useLPBalance';
import { useOPNet } from '../contexts/OPNetProvider';
import { useToast } from '../contexts/ToastContext';
import { formatBMOTO, parseBMOTO } from '../utils/format';
import { POOL1_NAMES, POOL1_EPOCH_DURATION, POOL1_INITIAL_RATE, POOL1_MAX_EPOCHS } from '../config/contracts';
import { BMOTOBalance } from './BMOTOBalance';

const BLOCKS_PER_YEAR = 52_560n;

function formatAPY(ratePerBlock: bigint, totalStaked: bigint): string {
    if (totalStaked === 0n) return '∞';
    const annualPerLP = Number(ratePerBlock * BLOCKS_PER_YEAR) / Number(totalStaked);
    const apy = annualPerLP * 100;
    if (apy >= 1_000_000) return `>${Math.floor(apy / 1_000_000).toLocaleString()}M%`;
    if (apy >= 1_000) return `${apy.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    return `${apy.toFixed(1)}%`;
}

interface Pool1PanelProps {
    pool1Address: string;
    lpTokens: readonly [string, string, string];
    farmStart: bigint;
    bmotoAddress: string;
    numPools: 1 | 2 | 3;
}

interface LPHook {
    balance: bigint;
    allowance: bigint;
    loading: boolean;
    error: string | null;
    txId: string | null;
    approve: () => Promise<void>;
    refreshBalance: () => Promise<void>;
}

interface SubPoolPanelProps {
    poolId: 0 | 1 | 2;
    pool1Address: string;
    lpAddress: string;
    committed: bigint;
    pendingEstimate: bigint;
    stake: bigint;
    ratePerBlock: bigint;
    txLoading: boolean;
    txError: string | null;
    txId: string | null;
    onDeposit: (poolId: number, amount: bigint) => void;
    onWithdraw: (poolId: number, amount: bigint) => void;
    onHarvest: (poolId: number) => void;
    lpHook: LPHook;
}

function SubPoolPanel({
    poolId,
    pool1Address,
    lpAddress,
    committed,
    pendingEstimate,
    stake,
    ratePerBlock,
    txLoading,
    txError,
    txId,
    onDeposit,
    onWithdraw,
    onHarvest,
    lpHook,
}: SubPoolPanelProps) {
    const { walletAddress } = useOPNet();
    const { showToast } = useToast();
    const { balance: lpBalance, allowance: lpAllowance, loading: lpLoading, error: approveError, txId: approveTxId, approve, refreshBalance } = lpHook;
    const { balance: totalStaked } = useLPBalance(lpAddress, pool1Address);
    const [depositAmt, setDepositAmt] = useState('');
    const [withdrawAmt, setWithdrawAmt] = useState('');

    // Toast on pool tx
    useEffect(() => {
        if (txId) showToast('success', 'Transaction confirmed', txId);
    }, [txId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (txError) showToast('error', txError);
    }, [txError]); // eslint-disable-line react-hooks/exhaustive-deps

    // Toast on approve tx
    useEffect(() => {
        if (approveTxId) showToast('success', 'Approval confirmed', approveTxId);
    }, [approveTxId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (approveError) showToast('error', approveError);
    }, [approveError]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleDeposit = (e: FormEvent) => {
        e.preventDefault();
        if (!depositAmt) return;
        onDeposit(poolId, parseBMOTO(depositAmt));
        void refreshBalance();
        setDepositAmt('');
    };

    const handleWithdraw = (e: FormEvent) => {
        e.preventDefault();
        if (!withdrawAmt) return;
        onWithdraw(poolId, parseBMOTO(withdrawAmt));
        void refreshBalance();
        setWithdrawAmt('');
    };

    const busy = txLoading || lpLoading;
    const canStakeOrUnstake = lpAllowance > 0n || stake > 0n;

    return (
        <div>
            {/* Always rendered — hides when nothing staked so card height is constant */}
            <div className="pool-stats" style={{ visibility: stake > 0n ? 'visible' : 'hidden' }}>
                <div className="stat-item">
                    <span className="stat-label">Staked LP</span>
                    <span className="stat-value">{formatBMOTO(stake)}</span>
                </div>
            </div>

            <div className="lp-balance">
                <div>LP Available</div>
                <span>{formatBMOTO(lpBalance)}</span>
            </div>

            <div style={{ position: 'relative' }}>
            {lpAllowance === 0n && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', zIndex: 1 }}>
                    <button
                        className="btn btn-secondary btn-block"
                        onClick={() => void approve()}
                        disabled={busy || !walletAddress}
                    >
                        {lpLoading ? 'Approving...' : 'Approve'}
                    </button>
                </div>
            )}
            <div style={{ display: 'flex', gap: 4, visibility: canStakeOrUnstake ? 'visible' : 'hidden', pointerEvents: canStakeOrUnstake ? 'auto' : 'none' }}>
                <form
                    onSubmit={handleDeposit}
                    className="stack-form"
                    style={{ flex: 1, opacity: lpAllowance === 0n ? 0.3 : 1, pointerEvents: lpAllowance === 0n ? 'none' : 'auto' }}
                >
                    <div className="input-with-max">
                        <input
                            type="number"
                            placeholder="Amount"
                            min="0"
                            step="any"
                            value={depositAmt}
                            onChange={(e) => setDepositAmt(e.target.value)}
                            disabled={busy}
                        />
                        <button
                            type="button"
                            className="btn-max"
                            onClick={() => setDepositAmt(String(lpBalance / 10n ** 8n))}
                            disabled={busy || lpBalance === 0n}
                        >
                            MAX
                        </button>
                    </div>
                    <button type="submit" className="btn btn-primary btn-block" disabled={busy || !depositAmt || !walletAddress}>
                        {txLoading ? 'Wait...' : 'Stake'}
                    </button>
                </form>
                <form
                    onSubmit={handleWithdraw}
                    className="stack-form"
                    style={{ flex: 1, opacity: stake === 0n ? 0.3 : 1, pointerEvents: stake === 0n ? 'none' : 'auto' }}
                >
                    <div className="input-with-max">
                        <input
                            type="number"
                            placeholder="Amount"
                            min="0"
                            step="any"
                            value={withdrawAmt}
                            onChange={(e) => setWithdrawAmt(e.target.value)}
                            disabled={busy}
                        />
                        <button
                            type="button"
                            className="btn-max"
                            onClick={() => setWithdrawAmt(String(stake / 10n ** 8n))}
                            disabled={busy}
                        >
                            MAX
                        </button>
                    </div>
                    <button type="submit" className="btn btn-secondary btn-block" disabled={busy || !withdrawAmt || !walletAddress}>
                        {txLoading ? 'Wait...' : 'Unstake'}
                    </button>
                </form>
            </div>
            </div>


            <div className="stat-item" style={{ marginTop: 8, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
                <span className="stat-label">APY</span>
                <span className="stat-value" style={{ color: 'var(--color-accent)' }}>
                    {formatAPY(ratePerBlock, totalStaked)}
                </span>
            </div>
        </div>
    );
}

export function Pool1Panel({ pool1Address, lpTokens, farmStart, bmotoAddress, numPools }: Pool1PanelProps) {
    const { walletAddress } = useOPNet();
    const { committed, pendingEstimate, stakes, ratesPerBlock, blocksUntilHalving, totalEmitted, txStates, deposit, withdraw, harvest, harvestAll, refresh } = usePool1(pool1Address, farmStart);

    const lpHook0 = useLPToken(lpTokens[0], pool1Address);
    const lpHook1 = useLPToken(lpTokens[1], pool1Address);
    const lpHook2 = useLPToken(lpTokens[2], pool1Address);
    const lpHooksAll = [lpHook0, lpHook1, lpHook2] as const;

    const activeIndices = Array.from({ length: numPools }, (_, i) => i) as (0 | 1 | 2)[];
    const anyLoading = txStates.some((t) => t.loading);

    let epochNum = 0;
    if (ratesPerBlock[0] > 0n) {
        let r = POOL1_INITIAL_RATE;
        while (r > ratesPerBlock[0] && epochNum < Number(POOL1_MAX_EPOCHS) - 1) { r >>= 1n; epochNum++; }
    }
    const totalCommitted = activeIndices.reduce((s, i) => s + committed[i], 0n);
    const epochTotal = activeIndices.reduce((s, i) => s + ratesPerBlock[i], 0n) * POOL1_EPOCH_DURATION;
    const totalPending = activeIndices.reduce((s, i) => s + pendingEstimate[i], 0n);
    const hasHarvestable = activeIndices.some((i) => committed[i] > 0n) || activeIndices.some((i) => pendingEstimate[i] > 0n && stakes[i] > 0n);

    return (
        <div>
            <div className="section-header">
                <span className="section-title">Pool 1 — 250,000 basedMOTO</span>
                <span className="section-sub">
                    {blocksUntilHalving !== null
                        ? <>Next halving: <strong>{blocksUntilHalving.toLocaleString()} blocks</strong></>
                        : 'Final epoch'
                    }
                    {' '}· Epoch {epochNum + 1}: {formatBMOTO(epochTotal)} basedMOTO · Farmed: {formatBMOTO(totalEmitted)} basedMOTO
                </span>
                <button className="btn btn-secondary btn-sm" onClick={() => void refresh()}>↺</button>
            </div>

            <div className="pool1-grid" style={numPools === 1 ? { display: 'block', maxWidth: '50%', margin: '0 auto' } : undefined}>
                {activeIndices.map((i) => (
                    <div key={i}>
                        <div className="card">
                            <div className="card-title">{POOL1_NAMES[i]}</div>
                            <div className="card-subtitle" style={{ marginBottom: 8 }}>
                                {formatBMOTO(ratesPerBlock[i])} basedMOTO/block
                            </div>
                            <SubPoolPanel
                                poolId={i}
                                pool1Address={pool1Address}
                                lpAddress={lpTokens[i]}
                                lpHook={lpHooksAll[i]}
                                committed={committed[i]}
                                pendingEstimate={pendingEstimate[i]}
                                stake={stakes[i]}
                                ratePerBlock={ratesPerBlock[i]}
                                txLoading={txStates[i].loading}
                                txError={txStates[i].error}
                                txId={txStates[i].txId}
                                onDeposit={deposit}
                                onWithdraw={withdraw}
                                onHarvest={harvest}
                            />
                        </div>
                        {(() => {
                            const hasRew = committed[i] > 0n || (pendingEstimate[i] > 0n && stakes[i] > 0n);
                            const isBusy = txStates[i].loading || lpHooksAll[i].loading;
                            return (
                                <button
                                    className="btn btn-success btn-block"
                                    onClick={() => harvest(i)}
                                    disabled={isBusy || !walletAddress}
                                    style={{ marginTop: 8, visibility: hasRew ? 'visible' : 'hidden', pointerEvents: hasRew ? 'auto' : 'none' }}
                                >
                                    {txStates[i].loading
                                        ? 'Wait...'
                                        : committed[i] > 0n
                                            ? `Claim ${formatBMOTO(committed[i])} basedMOTO`
                                            : `Claim ~${formatBMOTO(pendingEstimate[i])} basedMOTO`}
                                </button>
                            );
                        })()}
                    </div>
                ))}
            </div>

            <div className="balance-widget-row" style={{ marginTop: 24 }}>
                <BMOTOBalance
                    bmotoAddress={bmotoAddress}
                    harvestAll={harvestAll}
                    hasHarvestable={hasHarvestable}
                    totalCommitted={totalCommitted}
                    totalPending={totalPending}
                    harvestLoading={anyLoading}
                />
            </div>
        </div>
    );
}
