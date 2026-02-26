import { useCallback, useEffect, useState } from 'react';
import { getContract, IOP20Contract, OP_20_ABI } from 'opnet';
import { useOPNet } from '../contexts/OPNetProvider';

interface BMOTOState {
    balance: bigint;
    totalSupply: bigint;
    loading: boolean;
}

export function useBMOTO(bmotoAddress: string) {
    const { provider, network, walletAddressObj } = useOPNet();
    const [state, setState] = useState<BMOTOState>({ balance: 0n, totalSupply: 0n, loading: false });

    const refresh = useCallback(async () => {
        if (!provider || !walletAddressObj) return;
        setState((s) => ({ ...s, loading: true }));
        try {
            const contract = getContract<IOP20Contract>(
                bmotoAddress,
                OP_20_ABI,
                provider,
                network,
                walletAddressObj,
            );
            const [balRes, supplyRes] = await Promise.all([
                contract.balanceOf(walletAddressObj),
                contract.totalSupply(),
            ]);
            setState({
                balance: balRes.properties.balance,
                totalSupply: supplyRes.properties.totalSupply,
                loading: false,
            });
        } catch {
            setState((s) => ({ ...s, loading: false }));
        }
    }, [provider, network, walletAddressObj, bmotoAddress]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return { ...state, refresh };
}
