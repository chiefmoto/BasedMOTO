import { useState, useEffect, FormEvent } from 'react';
import { usePool2 } from '../hooks/usePool2';
import { useLPToken } from '../hooks/useLPToken';
import { useLPBalance } from '../hooks/useLPBalance';
import { useOPNet } from '../contexts/OPNetProvider';
import { useToast } from '../contexts/ToastContext';
import { formatBMOTO, parseBMOTO } from '../utils/format';
import { POOL2_EPOCH_DURATION, POOL2_INITIAL_RATE, POOL2_MAX_EPOCHS } from '../config/contracts';

const BLOCKS_PER_YEAR = 52_560n;

function formatAPY(ratePerBlock: bigint, totalStaked: bigint): string {
    if (totalStaked === 0n) return '∞';
    const annualPerLP = Number(ratePerBlock * BLOCKS_PER_YEAR) / Number(totalStaked);
    const apy = annualPerLP * 100;
    if (apy >= 1_000_000) return `>${Math.floor(apy / 1_000_000).toLocaleString()}M%`;
    if (apy >= 1_000) return `${apy.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    return `${apy.toFixed(1)}%`;
}

interface Pool2PanelProps {
    pool2Address: string;
    pool2LpAddress: string;
    farmStart: bigint;
}

export function Pool2Panel({ pool2Address, pool2LpAddress, farmStart }: Pool2PanelProps) {
    const { walletAddress } = useOPNet();
    const { showToast } = useToast();
    const { committed, pendingEstimate, stake, ratePerBlock, blocksUntilHalving, totalEmitted, tx, deposit, withdraw, harvest, refresh } = usePool2(pool2Address, farmStart);
    const { balance: lpBalance, allowance: lpAllowance, loading: lpLoading, error: approveError, txId: approveTxId, approve, refreshBalance } =
        useLPToken(pool2LpAddress, pool2Address);
    const { balance: totalStaked } = useLPBalance(pool2LpAddress, pool2Address);
    const [depositAmt, setDepositAmt] = useState('');
    const [withdrawAmt, setWithdrawAmt] = useState('');

    useEffect(() => {
        if (tx.txId) showToast('success', 'Transaction confirmed', tx.txId);
    }, [tx.txId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (tx.error) showToast('error', tx.error);
    }, [tx.error]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (approveTxId) showToast('success', 'Approval confirmed', approveTxId);
    }, [approveTxId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (approveError) showToast('error', approveError);
    }, [approveError]); // eslint-disable-line react-hooks/exhaustive-deps

    const busy = tx.loading || lpLoading;
    const hasRewards = committed > 0n || (pendingEstimate > 0n && stake > 0n);

    let epochNum = 0;
    if (ratePerBlock > 0n) {
        let r = POOL2_INITIAL_RATE;
        while (r > ratePerBlock && epochNum < Number(POOL2_MAX_EPOCHS) - 1) { r >>= 1n; epochNum++; }
    }

    const handleDeposit = (e: FormEvent) => {
        e.preventDefault();
        if (!depositAmt) return;
        void deposit(parseBMOTO(depositAmt));
        void refreshBalance();
        setDepositAmt('');
    };

    const handleWithdraw = (e: FormEvent) => {
        e.preventDefault();
        if (!withdrawAmt) return;
        void withdraw(parseBMOTO(withdrawAmt));
        void refreshBalance();
        setWithdrawAmt('');
    };

    return (
        <div>
            <div className="section-header">
                <span className="section-title">Pool 2 — 750,000 basedMOTO</span>
                <span className="section-sub">
                    {blocksUntilHalving !== null
                        ? <>Next halving: <strong>{blocksUntilHalving.toLocaleString()} blocks</strong></>
                        : 'Final epoch'
                    }
                    {' '}· Epoch {epochNum + 1}: {formatBMOTO(ratePerBlock * POOL2_EPOCH_DURATION)} basedMOTO · Farmed: {formatBMOTO(totalEmitted)} basedMOTO
                </span>
            </div>

        <div style={{ maxWidth: '50%', margin: '0 auto' }}>
        <div className="card" style={{ padding: '14px' }}>
            <div className="card-title">BASEDMOTO/MOTO LP</div>
            <div className="card-subtitle" style={{ marginBottom: 8 }}>
                {formatBMOTO(ratePerBlock)} basedMOTO/block
            </div>

            {/* Always rendered — hides when nothing staked so card height is constant */}
            <div className="pool-stats" style={{ marginBottom: 8, visibility: stake > 0n ? 'visible' : 'hidden' }}>
                <div className="stat-item">
                    <span className="stat-label">Staked LP</span>
                    <span className="stat-value">{formatBMOTO(stake)}</span>
                </div>
            </div>

            <div className="lp-balance">
                <div>LP Available</div>
                <span>{formatBMOTO(lpBalance)}</span>
            </div>

            {/* Stake + Unstake — always takes space; approve button overlays when needed */}
            <div style={{ position: 'relative' }}>
            {lpAllowance === 0n && stake === 0n && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}>
                    <button
                        className="btn btn-secondary"
                        onClick={() => void approve()}
                        disabled={busy || !walletAddress}
                    >
                        {lpLoading ? 'Approving…' : 'Approve LP → Pool2'}
                    </button>
                </div>
            )}
            <div style={{ display: 'flex', gap: 4, visibility: lpAllowance > 0n || stake > 0n ? 'visible' : 'hidden', pointerEvents: lpAllowance > 0n || stake > 0n ? 'auto' : 'none' }}>
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
                        {tx.loading ? 'Staking…' : 'Stake'}
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
                        {tx.loading ? 'Unstaking…' : 'Unstake'}
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
        <button
            className="btn btn-success btn-block"
            onClick={() => void harvest()}
            disabled={busy || !walletAddress}
            style={{ marginTop: 8, visibility: hasRewards ? 'visible' : 'hidden', pointerEvents: hasRewards ? 'auto' : 'none' }}
        >
            {tx.loading
                ? 'Claiming…'
                : committed > 0n
                    ? `Claim ${formatBMOTO(committed)} basedMOTO`
                    : `Claim ~${formatBMOTO(pendingEstimate)} basedMOTO`}
        </button>
        </div>
        </div>
    );
}
