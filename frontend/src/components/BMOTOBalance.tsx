import { useBMOTO } from '../hooks/useBMOTO';
import { formatBMOTO } from '../utils/format';

interface BMOTOBalanceProps {
    bmotoAddress: string;
    harvestAll?: () => Promise<void>;
    hasHarvestable?: boolean;
    totalCommitted?: bigint;
    totalPending?: bigint;
    harvestLoading?: boolean;
}

export function BMOTOBalance({ bmotoAddress, harvestAll, hasHarvestable, totalCommitted = 0n, totalPending = 0n, harvestLoading }: BMOTOBalanceProps) {
    const { balance, loading, refresh } = useBMOTO(bmotoAddress);

    const handleHarvestAll = async () => {
        await harvestAll?.();
        void refresh();
    };

    const displayAmount = totalCommitted > 0n
        ? <span className="pending-amount">{formatBMOTO(totalCommitted)} basedMOTO</span>
        : totalPending > 0n
            ? <span className="pending-amount" style={{ opacity: 0.7 }}>~{formatBMOTO(totalPending)} basedMOTO</span>
            : null;

    return (
        <div className="card">
            <div className="card-title">basedMOTO Balance</div>
            <div className="balance-big">{formatBMOTO(balance)}</div>
            <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                {hasHarvestable && harvestAll ? (
                    <>
                        <button
                            className="btn btn-success btn-sm"
                            onClick={() => void handleHarvestAll()}
                            disabled={harvestLoading || loading}
                        >
                            {harvestLoading ? 'Claiming...' : 'Claim All'}
                        </button>
                        {displayAmount}
                    </>
                ) : (
                    <button className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={loading}>
                        {loading ? 'Loading…' : 'Refresh'}
                    </button>
                )}
            </div>
        </div>
    );
}
