/**
 * Network-aware transaction signing.
 *
 * - regtest:          routes through the local sign proxy (regtestSign)
 * - testnet/mainnet:  calls sim.sendTransaction with signer=null so OPWallet
 *                     handles signing via window.opnet.web3.signInteraction()
 */
import { CallResult } from 'opnet';
import { Network } from '@btc-vision/bitcoin';
import { regtestSign } from './regtestSign';

export async function opnetSign(
    sim: CallResult,
    networkId: string,
    network: Network,
    walletAddress: string,
    linkMLDSA: boolean,
): Promise<string | null> {
    if (networkId === 'regtest') {
        return regtestSign(sim, linkMLDSA, walletAddress);
    }

    // Testnet / mainnet: OPWallet signs — signer=null lets detectInteractionOPWallet
    // intercept and call window.opnet.web3.signInteraction() automatically.
    // linkMLDSAPublicKeyToAddress=false because OPWallet manages ML-DSA registration.
    const result = await sim.sendTransaction({
        signer: null,
        mldsaSigner: null,
        refundTo: walletAddress,
        network,
        maximumAllowedSatToSpend: 100_000n,
        linkMLDSAPublicKeyToAddress: false,
    });

    if (!result) return null;
    const r = result as unknown as Record<string, unknown>;
    return (r['txid'] ?? r['hash'] ?? r['transactionId'] ?? null) as string | null;
}
