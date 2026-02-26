import { useCallback, useEffect, useState } from 'react';
import { getContract, IOP20Contract, OP_20_ABI } from 'opnet';
import { useOPNet } from '../contexts/OPNetProvider';

/** Returns the LP token balance held by `targetAddress` (e.g. a pool contract). */
export function useLPBalance(lpAddress: string, targetAddress: string) {
    const { provider, network, walletAddressObj } = useOPNet();
    const [balance, setBalance] = useState<bigint>(0n);

    const refresh = useCallback(async () => {
        if (!provider || !walletAddressObj) return;
        try {
            const lp = getContract<IOP20Contract>(lpAddress, OP_20_ABI, provider, network, walletAddressObj);
            const targetObj = await provider.getPublicKeyInfo(targetAddress, true);
            const res = await lp.balanceOf(targetObj);
            setBalance(res.properties.balance);
        } catch {
            // ignore view errors silently
        }
    }, [provider, network, walletAddressObj, lpAddress, targetAddress]);

    useEffect(() => { void refresh(); }, [refresh]);

    return { balance, refresh };
}
