/**
 * set-pool2-lp-testnet.mjs
 *
 * Calls Pool2.initialize(bmoto, lp) to wire up the BMOTO/MOTO LP token
 * after the pair has been created on MotoSwap testnet.
 *
 * This must be run ONCE after deploy-testnet.mjs, before staking opens.
 * Pool2.initialize() is one-time — it reverts if called again.
 *
 * Usage:
 *   node set-pool2-lp-testnet.mjs --lp <BMOTO/MOTO pair address>
 *
 * Prerequisites:
 *   - deployment.testnet.json must exist (run deploy-testnet.mjs first)
 *   - The BMOTO/MOTO LP pair must already exist on MotoSwap testnet
 */

import { readFileSync, writeFileSync } from 'fs';
import { JSONRpcProvider, getContract, ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';
import {
    Mnemonic,
    AddressTypes,
    MLDSASecurityLevel,
} from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL  = 'https://testnet.opnet.org/api/v1/json-rpc';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NETWORK  = networks.opnetTestnet;
const FEE_RATE = 10;
const PRIORITY_FEE = 330_000n;
const GAS_SAT_FEE  = 330_000n;

process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
function parseArgs() {
    const args = process.argv.slice(2);
    const i = args.indexOf('--lp');
    return i !== -1 ? args[i + 1] : null;
}

const LP_ADDR = parseArgs();
if (!LP_ADDR) {
    console.error('Usage: node set-pool2-lp-testnet.mjs --lp <BMOTO/MOTO pair address>');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Load deployment.testnet.json
// ---------------------------------------------------------------------------
let deployment;
try {
    deployment = JSON.parse(readFileSync('./deployment.testnet.json', 'utf8'));
} catch {
    console.error('deployment.testnet.json not found — run deploy-testnet.mjs first');
    process.exit(1);
}

const BMOTO_ADDR = deployment.bmotoAddr;
const POOL2_ADDR = deployment.pool2Addr;

console.log(`BMOTOToken : ${BMOTO_ADDR}`);
console.log(`Pool2      : ${POOL2_ADDR}`);
console.log(`LP (BMOTO/MOTO) : ${LP_ADDR}`);
console.log('');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
const mnemonic = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);

console.log('Deployer P2TR:', wallet.p2tr);
console.log('');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSpendableUtxos() {
    const allUtxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    if (!allUtxos || allUtxos.length === 0) {
        throw new Error(`No UTXOs found for ${wallet.p2tr}. Fund via https://faucet.opnet.org`);
    }
    const spendable = allUtxos.filter((u) => u.value !== 2_500_000_000n);
    if (spendable.length === 0) {
        throw new Error('Only coinbase UTXOs found — wait for maturity or send BTC from faucet');
    }
    return spendable;
}

async function broadcast(rawTx) {
    const { JSONRpcMethods } = await import('opnet');
    return provider._send(JSONRpcMethods.BROADCAST_TRANSACTION, [rawTx]);
}

// ---------------------------------------------------------------------------
// Pool2 ABI — initialize(bmoto, lp)
// ---------------------------------------------------------------------------
const Pool2Abi = [
    ...OP_NET_ABI,
    {
        name: 'initialize',
        inputs: [
            { name: 'bmoto', type: ABIDataTypes.ADDRESS },
            { name: 'lp',    type: ABIDataTypes.ADDRESS },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('=== Calling Pool2.initialize(bmoto, lp) ===');

const utxos   = await getSpendableUtxos();
const bmotoObj = await provider.getPublicKeyInfo(BMOTO_ADDR, true);
const lpObj    = await provider.getPublicKeyInfo(LP_ADDR, true);

const contract   = getContract(POOL2_ADDR, Pool2Abi, provider, NETWORK, wallet.address);
const simulation = await contract.initialize(bmotoObj, lpObj);

if ('error' in simulation) {
    console.error(`Simulation failed: ${JSON.stringify(simulation.error)}`);
    console.error('');
    console.error('Pool2.initialize() can only be called once.');
    console.error('If Pool2 was already initialized with the wrong LP, redeploy Pool2.');
    process.exit(1);
}

const signedTx = await simulation.signTransaction({
    signer:      wallet.keypair,
    mldsaSigner: wallet.mldsaKeypair,
    network:     NETWORK,
    utxos,
    refundTo:    wallet.p2tr,
    maximumAllowedSatToSpend: 100_000n,
    linkMLDSAPublicKeyToAddress: false,
});

if (signedTx.fundingTransactionRaw) {
    const ftxid = await broadcast(signedTx.fundingTransactionRaw);
    console.log(`Funding tx: ${ftxid}`);
    await sleep(5_000);
}

const txid = await broadcast(signedTx.interactionTransactionRaw);
console.log(`✓ Pool2.initialize — tx: ${txid}`);

// Update deployment.testnet.json
deployment.pool2Lp = LP_ADDR;
writeFileSync('./deployment.testnet.json', JSON.stringify(deployment, null, 2));
console.log('');
console.log('Updated deployment.testnet.json');
console.log('');
console.log('Pool2 is now initialized. Next steps:');
console.log('  1. Update frontend/src/config/contracts.ts:');
console.log(`       pool2Lp: '${LP_ADDR}',`);
console.log('  2. Transfer BMOTO to Pool2 if not done yet (750,000 BMOTO):');
console.log(`       node transfer-bmoto-testnet.mjs --to ${POOL2_ADDR} --amount 75000000000000`);
console.log('  3. Run: node set-farm-start-testnet.mjs --block <start block>');

await provider.close();
