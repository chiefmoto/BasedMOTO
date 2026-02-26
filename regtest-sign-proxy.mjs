/**
 * Regtest signing proxy — bypasses OPWallet for local development.
 *
 * OPWallet produces corrupted calldata on regtest (wrong selector bytes).
 * This proxy accepts simulation output from the frontend, signs the correct
 * calldata using the deployer mnemonic + fresh UTXOs from bitcoin-cli, and
 * broadcasts both transactions via bitcoin-cli.
 *
 * Port: 9003
 * Start: node regtest-sign-proxy.mjs (or via pm2)
 *
 * POST /sign
 *   Body: { calldata: hex, to: string, contractHex: string,
 *           estimatedSatGas: string, linkMLDSA: boolean }
 *   Response: { txid: string } | { error: string }
 */

import { createServer } from 'http';
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { JSONRpcProvider, CallResult, getContract, OP_20_ABI } from 'opnet';
import {
    Mnemonic,
    AddressTypes,
    MLDSASecurityLevel,
    Address,
} from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

const dep = JSON.parse(readFileSync('./deployment.json', 'utf8'));
const MAX_U256 = 2n ** 256n - 1n;

const PORT = 9003;
const RPC_URL = 'http://localhost:9001/api/v1/json-rpc';
const NETWORK = networks.regtest;
process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }

// One shared provider for challenge fetching
const rpcProvider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });

const mnemonic = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
// Derive deployer wallet (index 0) as default
const defaultWallet = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);

// Cache of derived wallets by P2TR address
const walletCache = new Map();
walletCache.set(defaultWallet.p2tr, defaultWallet);

// Load external wallets from wallets.json (P2TR → mnemonic)
function loadExternalWallets() {
    const path = './wallets.json';
    if (!existsSync(path)) return;
    try {
        const entries = JSON.parse(readFileSync(path, 'utf8'));
        for (const [p2tr, mnemonicPhrase] of Object.entries(entries)) {
            if (walletCache.has(p2tr)) continue;
            const m = new Mnemonic(mnemonicPhrase, '', NETWORK, MLDSASecurityLevel.LEVEL2);
            const w = m.deriveOPWallet(AddressTypes.P2TR, 0);
            walletCache.set(w.p2tr, w);
            console.log(`[wallets] Loaded external wallet: ${w.p2tr}`);
        }
    } catch (e) {
        console.warn(`[wallets] Failed to load wallets.json: ${e.message}`);
    }
}

loadExternalWallets();

function walletForAddress(p2tr) {
    if (!p2tr) return defaultWallet;
    // Reload external wallets on each call so newly-added wallets are picked up
    loadExternalWallets();
    if (walletCache.has(p2tr)) return walletCache.get(p2tr);
    // Search up to index 20 of deployer mnemonic
    for (let i = 1; i <= 20; i++) {
        const w = mnemonic.deriveOPWallet(AddressTypes.P2TR, i);
        walletCache.set(w.p2tr, w);
        if (w.p2tr === p2tr) return w;
    }
    console.warn(`[sign] Unknown senderP2TR ${p2tr} — falling back to deployer`);
    return defaultWallet;
}

// Keep a reference to the default wallet for mineBlock / UTXOs funding
const wallet = defaultWallet;

console.log('Regtest sign proxy starting...');
console.log('Deployer P2TR:', wallet.p2tr);

function getSpendableUtxos(address) {
    const scan = JSON.parse(
        execSync(`bitcoin-cli -regtest scantxoutset start '["addr(${address})"]'`, {
            encoding: 'utf8',
        }),
    );
    const utxos = [];
    for (const u of scan.unspents) {
        // Skip coinbase UTXOs (scantxoutset reports coinbase directly)
        if (u.coinbase) continue;
        const rawHex = execSync(
            `bitcoin-cli -regtest getrawtransaction ${u.txid} false`,
            { encoding: 'utf8' },
        ).trim();
        const rawBuf = Buffer.from(rawHex, 'hex');
        const [whole, frac = ''] = u.amount.toFixed(8).split('.');
        const sats = BigInt(whole) * 100_000_000n + BigInt(frac.padEnd(8, '0'));
        utxos.push({
            transactionId: u.txid,
            outputIndex: u.vout,
            value: sats,
            scriptPubKey: { hex: u.scriptPubKey, address },
            nonWitnessUtxo: Object.fromEntries([...rawBuf].entries()),
            nonWitnessUtxoBase64: rawBuf.toString('base64'),
            witnessScript: undefined,
            redeemScript: undefined,
            isCSV: false,
        });
    }
    return utxos;
}

function mineBlock() {
    execSync(`bitcoin-cli -regtest generatetoaddress 1 ${wallet.p2tr}`, { encoding: 'utf8' });
}

async function signAndBroadcast({ calldata, to, contractHex, estimatedSatGas, linkMLDSA, senderP2TR }) {
    const signerWallet = walletForAddress(senderP2TR);
    const utxos = getSpendableUtxos(signerWallet.p2tr);
    if (utxos.length === 0) {
        throw new Error(`No spendable UTXOs for ${signerWallet.p2tr} — send BTC to this address first`);
    }

    const calldataBytes = new Uint8Array(Buffer.from(calldata, 'hex'));

    // Build a custom provider: UTXOs from bitcoin-cli, challenge from OPNet RPC node
    const customProvider = {
        network: NETWORK,
        utxoManager: {
            getUTXOsForAmount: async () => utxos,
            spentUTXO: () => {},
            clean: () => {},
        },
        getChallenge: () => rpcProvider.getChallenge(),
        sendRawTransaction: async () => {
            throw new Error('Use signTransaction only — do not call sendTransaction via this provider');
        },
        getCSV1ForAddress: () => undefined,
    };

    // Reconstruct a minimal CallResult with the calldata from the frontend simulation
    const cr = new CallResult(
        { result: new Uint8Array(0), accessList: {}, events: {} },
        customProvider,
    );
    cr.setCalldata(calldataBytes);
    cr.to = to;
    cr.address = Address.fromString(contractHex);
    cr.estimatedSatGas = BigInt(estimatedSatGas);

    const signed = await cr.signTransaction({
        signer: signerWallet.keypair,
        mldsaSigner: signerWallet.mldsaKeypair,
        refundTo: signerWallet.p2tr,
        network: NETWORK,
        maximumAllowedSatToSpend: 100_000n,
        linkMLDSAPublicKeyToAddress: Boolean(linkMLDSA),
        utxos,
    });

    // Broadcast funding transaction
    if (signed.fundingTransactionRaw) {
        execSync(
            `bitcoin-cli -regtest sendrawtransaction ${signed.fundingTransactionRaw}`,
            { encoding: 'utf8' },
        );
        mineBlock();
        await new Promise((r) => setTimeout(r, 500));
    }

    // Broadcast interaction transaction
    const txid = execSync(
        `bitcoin-cli -regtest sendrawtransaction ${signed.interactionTransactionRaw}`,
        { encoding: 'utf8' },
    ).trim();

    mineBlock();

    // Send fresh UTXO back to wallet so the next tx has funds
    try {
        execSync(`bitcoin-cli -regtest sendtoaddress ${wallet.p2tr} 0.01`, { encoding: 'utf8' });
        mineBlock();
    } catch {
        // Non-fatal — wallet may already have other UTXOs
    }

    return txid;
}

/**
 * Auto-approve all LP → Pool allowances for a given P2TR address.
 * Funds the wallet with BTC if it has no spendable UTXOs, then sequentially
 * signs increaseAllowance txs for: LP0/1/2 → Pool1, LP0 → Pool2.
 * Skips pairs that are already approved. Registers ML-DSA key on first tx.
 */
async function autoApproveAll(p2tr) {
    const userWallet = walletForAddress(p2tr);

    // Fund wallet if it has no spendable UTXOs
    const existingUtxos = getSpendableUtxos(userWallet.p2tr);
    if (existingUtxos.length === 0) {
        console.log(`[auto-approve] Funding ${userWallet.p2tr} with 1 BTC...`);
        execSync(`bitcoin-cli -regtest sendtoaddress ${userWallet.p2tr} 1.0`, { encoding: 'utf8' });
        mineBlock();
        await new Promise((r) => setTimeout(r, 1500));
    }

    const [pool1Obj, pool2Obj] = await Promise.all([
        rpcProvider.getPublicKeyInfo(dep.pool1Addr, true),
        rpcProvider.getPublicKeyInfo(dep.pool2Addr, true),
    ]);

    const approvals = [
        { lpAddr: dep.mockLp0, spenderObj: pool1Obj, label: 'LP0→Pool1' },
        { lpAddr: dep.mockLp1, spenderObj: pool1Obj, label: 'LP1→Pool1' },
        { lpAddr: dep.mockLp2, spenderObj: pool1Obj, label: 'LP2→Pool1' },
        { lpAddr: dep.mockLp0, spenderObj: pool2Obj, label: 'LP0→Pool2' },
    ];

    let isFirst = true;
    for (const { lpAddr, spenderObj, label } of approvals) {
        try {
            const lp = getContract(lpAddr, OP_20_ABI, rpcProvider, NETWORK, userWallet.address);

            // Check existing allowance — skip if already approved
            try {
                const allowRes = await lp.allowance(userWallet.address, spenderObj);
                const existing = allowRes.properties?.remaining ?? 0n;
                if (existing > 0n) {
                    console.log(`[auto-approve] ${label} already approved — skipping`);
                    isFirst = false;
                    continue;
                }
            } catch { /* treat as 0 */ }

            const sim = await lp.increaseAllowance(spenderObj, MAX_U256);
            if ('error' in sim) {
                console.warn(`[auto-approve] Simulation failed for ${label}: ${JSON.stringify(sim.error)}`);
                continue;
            }

            console.log(`[auto-approve] Approving ${label}...`);
            await signAndBroadcast({
                calldata: Buffer.from(sim.calldata).toString('hex'),
                to: sim.to,
                contractHex: sim.address.toHex(),
                estimatedSatGas: sim.estimatedSatGas.toString(),
                linkMLDSA: isFirst,  // register ML-DSA key on the first tx only
                senderP2TR: p2tr,
            });
            isFirst = false;

            // Brief pause so the fresh change UTXO is indexed before next tx
            await new Promise((r) => setTimeout(r, 1500));
        } catch (e) {
            console.warn(`[auto-approve] Error for ${label}: ${e.message}`);
        }
    }

    return { success: true };
}

const server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'POST' || (req.url !== '/sign' && req.url !== '/auto-approve-all')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found — POST /sign or /auto-approve-all' }));
        return;
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });
    req.on('end', async () => {
        try {
            const data = JSON.parse(body);
            if (req.url === '/auto-approve-all') {
                console.log(`[auto-approve] Starting for p2tr=${data.p2tr}`);
                const result = await autoApproveAll(data.p2tr);
                console.log(`[auto-approve] Done for p2tr=${data.p2tr}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } else {
                console.log(
                    `[sign] contract=${data.contractHex?.slice(0, 16)}... method calldata[0..8]=${data.calldata?.slice(0, 8)} linkMLDSA=${data.linkMLDSA}`,
                );
                const txid = await signAndBroadcast(data);
                console.log(`[sign] ✓ txid: ${txid}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ txid }));
            }
        } catch (e) {
            console.error('[sign] Error:', e.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Regtest sign proxy listening on port ${PORT}`);
});
