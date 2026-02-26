/**
 * Regtest signing utility — routes transaction signing through the backend
 * sign proxy (port 9003) instead of OPWallet.
 *
 * OPWallet on regtest produces corrupted calldata (wrong method selector),
 * causing every transaction to revert with "Method not found". The sign proxy
 * uses the deployer mnemonic + bitcoin-cli UTXOs to sign the correct calldata
 * derived from the frontend simulation, bypassing OPWallet entirely.
 */
import { CallResult } from 'opnet';

const SIGN_PROXY_URL = 'http://142.93.84.52:9003/sign';

export async function regtestSign(sim: CallResult, linkMLDSA: boolean, senderP2TR?: string): Promise<string> {
    if (!sim.calldata) throw new Error('Simulation has no calldata');
    if (!sim.to) throw new Error('Simulation has no contract "to" address');
    if (!sim.address) throw new Error('Simulation has no contract Address object');

    // Convert Uint8Array calldata to hex without requiring Buffer polyfill
    const calldataHex = Array.from(sim.calldata)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    const body = {
        calldata: calldataHex,
        to: sim.to,
        contractHex: sim.address.toHex(),
        estimatedSatGas: sim.estimatedSatGas.toString(),
        linkMLDSA,
        senderP2TR,
    };

    const resp = await fetch(SIGN_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        throw new Error(`Sign proxy HTTP error: ${resp.status}`);
    }

    const data = (await resp.json()) as { txid?: string; error?: string };
    if (data.error) throw new Error(`Sign proxy: ${data.error}`);
    if (!data.txid) throw new Error('Sign proxy returned no txid');

    return data.txid;
}
