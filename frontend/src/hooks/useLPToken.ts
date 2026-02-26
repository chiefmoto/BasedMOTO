/**
 * Hook for querying an LP token balance and approving a spender.
 * LP tokens are standard OP20s (MyToken.wasm on regtest, real LP on mainnet).
 */
import { useCallback, useEffect, useState } from 'react';
import { getContract, IOP20Contract, OP_20_ABI } from 'opnet';
import { useOPNet } from '../contexts/OPNetProvider';
import { MAX_U256 } from '../utils/format';
import { opnetSign } from '../utils/opnetSign';

export function useLPToken(lpAddress: string, spenderAddress: string) {
    const { provider, network, networkId, walletAddress, walletAddressObj, autoApprovedAt, refreshWalletAddressObj } = useOPNet();
    const [balance, setBalance] = useState<bigint>(0n);
    const [allowance, setAllowance] = useState<bigint>(0n);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [txId, setTxId] = useState<string | null>(null);

    const getLP = useCallback((): IOP20Contract => {
        if (!provider || !walletAddressObj) throw new Error('Wallet not connected');
        return getContract<IOP20Contract>(lpAddress, OP_20_ABI, provider, network, walletAddressObj);
    }, [provider, network, walletAddressObj, lpAddress]);

    const refreshBalance = useCallback(async () => {
        if (!provider || !walletAddressObj) return;
        try {
            const lp = getLP();
            const [balRes, spenderObj] = await Promise.all([
                lp.balanceOf(walletAddressObj),
                provider.getPublicKeyInfo(spenderAddress, true),
            ]);
            setBalance(balRes.properties.balance);
            try {
                const allowRes = await lp.allowance(walletAddressObj, spenderObj);
                setAllowance((allowRes.properties as { remaining?: bigint }).remaining ?? 0n);
            } catch {
                setAllowance(0n);
            }
        } catch {
            // ignore view errors silently
        }
    }, [getLP, walletAddressObj, provider, spenderAddress]);

    useEffect(() => {
        void refreshBalance();
    }, [refreshBalance]);

    // Re-fetch allowance after auto-approve-all completes (triggered by OPNetProvider)
    useEffect(() => {
        if (autoApprovedAt > 0) void refreshBalance();
    }, [autoApprovedAt]); // eslint-disable-line react-hooks/exhaustive-deps

    const approve = useCallback(async () => {
        setLoading(true);
        setError(null);
        setTxId(null);
        try {
            if (!provider) throw new Error('RPC not connected');
            if (!walletAddress) throw new Error('Wallet not connected');
            if (!walletAddressObj) throw new Error('Resolving wallet address, please try again');
            const spenderObj = await provider.getPublicKeyInfo(spenderAddress, true);
            const lp = getLP();
            const sim = await lp.increaseAllowance(spenderObj, MAX_U256);
            if ('error' in sim) throw new Error(`Simulation failed: ${String(sim.error)}`);
            const txid = await opnetSign(sim, networkId, network, walletAddress, networkId === 'regtest');
            setTxId(txid);
            // Wait for OPNet node to index the approve block before re-fetching
            // the wallet address object (ML-DSA key must be visible on-chain).
            await new Promise<void>((r) => setTimeout(r, 4000));
            await refreshWalletAddressObj();
            // Explicitly refresh balance/allowance — walletAddressObj may not have
            // changed reference even after refreshWalletAddressObj, so the useEffect
            // won't fire automatically.
            await refreshBalance();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [getLP, provider, walletAddress, walletAddressObj, spenderAddress, refreshWalletAddressObj, refreshBalance]);

    return { balance, allowance, loading, error, txId, refreshBalance, approve };
}
