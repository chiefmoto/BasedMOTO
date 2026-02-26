/**
 * set-farm-start-testnet.mjs
 *
 * Sets the farmStart block on Pool1 and Pool2 to open staking on testnet.
 *
 * Usage:
 *   node set-farm-start-testnet.mjs --block <blockNumber>
 *
 * Options:
 *   --block <n>      Block number at which farming opens (use a future block
 *                    to give users time to stake before rewards start).
 *                    Pass 0 to use the current block (immediate start).
 *   --pool1-only     Only set Pool1 farmStart
 *   --pool2-only     Only set Pool2 farmStart
 *
 * Prerequisites:
 *   - deployment.testnet.json must exist (run deploy-testnet.mjs first)
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
    const get = (flag) => {
        const i = args.indexOf(flag);
        return i !== -1 ? args[i + 1] : null;
    };
    return {
        block:     get('--block'),
        pool1Only: args.includes('--pool1-only'),
        pool2Only: args.includes('--pool2-only'),
    };
}

const { block: blockArg, pool1Only, pool2Only } = parseArgs();

if (blockArg === null) {
    console.error('Usage: node set-farm-start-testnet.mjs --block <blockNumber>');
    console.error('       node set-farm-start-testnet.mjs --block 0   (current block = immediate start)');
    console.error('       node set-farm-start-testnet.mjs --block <n> --pool1-only');
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
const mnemonic = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);

console.log('Deployer P2TR:', wallet.p2tr);

// Resolve block number
const currentBlock = BigInt(await provider.getBlockNumber());
const startBlock = blockArg === '0' ? currentBlock : BigInt(blockArg);

console.log(`Current block : ${currentBlock}`);
console.log(`Farm start    : ${startBlock}`);
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
// ABIs
// ---------------------------------------------------------------------------
const SetFarmStartAbi = [
    ...OP_NET_ABI,
    {
        name: 'setFarmStart',
        inputs: [{ name: 'startBlock', type: ABIDataTypes.UINT256 }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
];

// ---------------------------------------------------------------------------
// Set farm start helper
// ---------------------------------------------------------------------------
async function setFarmStart(label, contractAddress) {
    console.log(`=== ${label}.setFarmStart(${startBlock}) ===`);

    const utxos    = await getSpendableUtxos();
    const contract = getContract(contractAddress, SetFarmStartAbi, provider, NETWORK, wallet.address);
    const sim      = await contract.setFarmStart(startBlock);

    if ('error' in sim) {
        throw new Error(`Simulation failed for ${label}.setFarmStart: ${JSON.stringify(sim.error)}`);
    }

    const signedTx = await sim.signTransaction({
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
    console.log(`✓ ${label}.setFarmStart — tx: ${txid}`);
    await sleep(15_000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
if (!pool2Only) {
    await setFarmStart('Pool1', deployment.pool1Addr);
}

if (!pool1Only) {
    await setFarmStart('Pool2', deployment.pool2Addr);
}

// Update deployment.testnet.json
if (!pool2Only) deployment.pool1FarmStart = startBlock.toString();
if (!pool1Only) deployment.pool2FarmStart = startBlock.toString();
writeFileSync('./deployment.testnet.json', JSON.stringify(deployment, null, 2));
console.log('\nUpdated deployment.testnet.json');

console.log('');
console.log('Farming is now open! Update contracts.ts with the farm start block:');
if (!pool2Only) console.log(`  pool1FarmStart: ${startBlock}n,`);
if (!pool1Only) console.log(`  pool2FarmStart: ${startBlock}n,`);

await provider.close();
