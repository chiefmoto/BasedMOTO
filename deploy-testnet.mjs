/**
 * BMOTO Full Deploy Script — OPNet Testnet (Signet fork)
 *
 * Deploys all 4 contracts and wires them together using real MotoSwap LP pairs.
 *
 * Usage:
 *   node deploy-testnet.mjs --lp0 <PILL/MOTO pair address>
 *
 * Prerequisites:
 *   - OPNet testnet BTC in deployer wallet (fund via https://faucet.opnet.org)
 *   - MotoSwap testnet PILL/MOTO LP pair address
 *
 * Notes on Pool1 testnet config:
 *   - Only 1 sub-pool active (PILL/MOTO, poolId=0, 100% weight).
 *   - PEPE/MOTO and UNGA/MOTO are not yet live on testnet.
 *   - lp0 address is passed for all 3 initialize slots; pools 1 & 2 are
 *     inaccessible via the contract (poolId > 0 reverts).
 *
 * Notes:
 *   - Pool2 LP (BMOTO/MOTO) is NOT set at deploy time — it's set later via
 *     Pool2.setLpToken() after the pair is created on MotoSwap.
 *   - farmStart blocks are set after deploy — call setFarmStart separately
 *     once you're ready to open staking.
 *   - Outputs deployment.testnet.json with all addresses.
 */

import { readFileSync, writeFileSync } from 'fs';
import { JSONRpcProvider, getContract, OP_20_ABI, ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';
import {
    TransactionFactory,
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
// Parse CLI args:  --lp0 <addr> --lp1 <addr> --lp2 <addr>
// ---------------------------------------------------------------------------
function parseArgs() {
    const args = process.argv.slice(2);
    const get = (flag) => {
        const i = args.indexOf(flag);
        return i !== -1 ? args[i + 1] : null;
    };
    return { lp0: get('--lp0') };
}

const { lp0: LP0_ADDR } = parseArgs();

if (!LP0_ADDR) {
    console.error('Usage: node deploy-testnet.mjs --lp0 <PILL/MOTO pair address>');
    console.error('');
    console.error('Get the LP pair address from MotoSwap testnet.');
    process.exit(1);
}

console.log('LP0 (PILL/MOTO):', LP0_ADDR);
console.log('(Pool1 testnet: single sub-pool, 100% weight — pools 1 & 2 inactive)');
console.log('');

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
const mnemonic = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);
const factory  = new TransactionFactory();

console.log('Deployer P2TR:', wallet.p2tr);
console.log('');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSpendableUtxos() {
    const allUtxos = await provider.utxoManager.getUTXOs({ address: wallet.p2tr });
    if (!allUtxos || allUtxos.length === 0) {
        throw new Error(
            `No UTXOs found for ${wallet.p2tr}. Fund via https://faucet.opnet.org`,
        );
    }
    // Filter out likely coinbase UTXOs (25 BTC = 2_500_000_000 sats on signet)
    const spendable = allUtxos.filter((u) => u.value !== 2_500_000_000n);
    if (spendable.length === 0) {
        throw new Error('Only coinbase UTXOs found — wait for them to mature or send BTC from faucet');
    }
    return spendable;
}

async function broadcast(rawTx) {
    const resp = await fetch(`${RPC_URL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'btc_sendRawTransaction',
            params: [rawTx],
            id: 1,
        }),
    });
    const json = await resp.json();
    if (json.error) throw new Error(`Broadcast error: ${JSON.stringify(json.error)}`);
    if (!json.result?.success) throw new Error(`Broadcast failed: ${JSON.stringify(json.result)}`);
    return json.result.result; // txid
}

// ---------------------------------------------------------------------------
// Deploy helper
// ---------------------------------------------------------------------------
async function deployContract(label, wasmPath) {
    console.log(`\n=== Deploying ${label} ===`);
    const bytecode = new Uint8Array(readFileSync(wasmPath));
    console.log(`WASM size: ${bytecode.length} bytes`);

    const utxos = await getSpendableUtxos();
    console.log(`UTXOs: ${utxos.length} spendable`);

    const challenge = await provider.getChallenge();

    const result = await factory.signDeployment({
        linkMLDSAPublicKeyToAddress: true,
        revealMLDSAPublicKey:        true,
        signer:      wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        network:     NETWORK,
        feeRate:     FEE_RATE,
        priorityFee: PRIORITY_FEE,
        gasSatFee:   GAS_SAT_FEE,
        utxos,
        bytecode,
        calldata:    new Uint8Array(0),
        challenge,
        refundTo:    wallet.p2tr,
    });

    for (const [i, rawTx] of result.transaction.entries()) {
        const txid = await broadcast(rawTx);
        console.log(`TX ${i + 1}: ${txid}`);
    }

    console.log(`${label} address: ${result.contractAddress}`);

    // Wait for the transaction to be indexed before proceeding
    console.log('Waiting for indexer...');
    await sleep(15_000);

    return result.contractAddress;
}

// ---------------------------------------------------------------------------
// Interaction helper
// ---------------------------------------------------------------------------
async function interact(label, contractAddress, abi, methodName, ...args) {
    console.log(`\n  → ${label}`);

    const utxos = await getSpendableUtxos();
    const contract = getContract(contractAddress, abi, provider, NETWORK, wallet.address);
    const simulation = await contract[methodName](...args);

    if ('error' in simulation) {
        throw new Error(`Simulation failed for ${methodName}: ${JSON.stringify(simulation.error)}`);
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
        const txid1 = await broadcast(signedTx.fundingTransactionRaw);
        console.log(`    funding tx: ${txid1}`);
        await sleep(5_000);
    }

    const txid2 = await broadcast(signedTx.interactionTransactionRaw);
    console.log(`  ✓ ${label} — tx: ${txid2}`);

    await sleep(15_000);
}

// Helper: resolve an OPNet contract address string to an Address object via RPC
async function caddr(s) {
    return provider.getPublicKeyInfo(s, true);
}

// ---------------------------------------------------------------------------
// ABIs (same as deploy-regtest.mjs)
// ---------------------------------------------------------------------------
const BMOTOTokenAbi = [
    ...OP_NET_ABI,
    {
        name: 'setRebaseContract',
        inputs: [{ name: 'addr', type: ABIDataTypes.ADDRESS }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
];

const Pool1Abi = [
    ...OP_NET_ABI,
    {
        name: 'initialize',
        inputs: [
            { name: 'bmoto', type: ABIDataTypes.ADDRESS },
            { name: 'lp0',   type: ABIDataTypes.ADDRESS },
            { name: 'lp1',   type: ABIDataTypes.ADDRESS },
            { name: 'lp2',   type: ABIDataTypes.ADDRESS },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setFarmStart',
        inputs: [{ name: 'startBlock', type: ABIDataTypes.UINT256 }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
];

const RebaserAbi = [
    ...OP_NET_ABI,
    {
        name: 'setContracts',
        inputs: [
            { name: 'bmoto',            type: ABIDataTypes.ADDRESS },
            { name: 'pool1',            type: ABIDataTypes.ADDRESS },
            { name: 'pool2',            type: ABIDataTypes.ADDRESS },
            { name: 'bmotoMotoPair',    type: ABIDataTypes.ADDRESS },
            { name: 'pool1LaunchBlock', type: ABIDataTypes.UINT64  },
            { name: 'bmotoIsToken0',    type: ABIDataTypes.BOOL    },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
];

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

// 1. Deploy core contracts
const bmotoAddr   = await deployContract('BMOTOToken', './token/build/BMOTOToken.wasm');
const pool1Addr   = await deployContract('Pool1',      './pool1/build/Pool1.wasm');
const pool2Addr   = await deployContract('Pool2',      './pool2/build/Pool2.wasm');
const rebaserAddr = await deployContract('Rebaser',    './rebaser/build/Rebaser.wasm');

console.log('\n=== All contracts deployed ===');
console.log(`BMOTOToken : ${bmotoAddr}`);
console.log(`Pool1      : ${pool1Addr}`);
console.log(`Pool2      : ${pool2Addr}`);
console.log(`Rebaser    : ${rebaserAddr}`);

// 2. Wire up addresses
console.log('\n=== Wiring addresses ===');

// Pool1.initialize(bmoto, lp0, lp1, lp2)
// Testnet: only pool 0 (PILL/MOTO) is active — pass LP0 for all 3 slots.
// Pools 1 & 2 are inaccessible (contract rejects poolId > 0).
const lp0Addr = await caddr(LP0_ADDR);
await interact(
    'Pool1.initialize',
    pool1Addr, Pool1Abi, 'initialize',
    await caddr(bmotoAddr),
    lp0Addr,
    lp0Addr,
    lp0Addr,
);

// Pool2.initialize is deferred — BMOTO/MOTO LP doesn't exist yet.
// initialize() is one-time only, so we must pass the real LP address.
// After creating the BMOTO/MOTO pair on MotoSwap, run:
//   node set-pool2-lp-testnet.mjs --lp <BMOTO/MOTO pair address>
console.log('\n  ⚠ Skipping Pool2.initialize — BMOTO/MOTO LP pair not yet created.');
console.log('  Pool2 is deployed but NOT initialized. Staking will be disabled until:');
console.log('  node set-pool2-lp-testnet.mjs --lp <BMOTO/MOTO pair address>');

// Rebaser.setContracts
// bmotoIsToken0: true assumes BMOTO is token0 in the BMOTO/MOTO pair.
// Verify this after creating the pair on MotoSwap.
// pool1LaunchBlock: use actual current block so the 4032-block activation
// check passes once ~28 days have elapsed from pool1 launch.
const currentBlock = BigInt(await provider.getBlockNumber());
console.log(`\nCurrent block: ${currentBlock}`);

await interact(
    'Rebaser.setContracts',
    rebaserAddr, RebaserAbi, 'setContracts',
    await caddr(bmotoAddr),
    await caddr(pool1Addr),
    await caddr(pool2Addr),
    await caddr(LP0_ADDR),  // placeholder — update after pair created
    currentBlock,            // pool1LaunchBlock = current block
    true,                    // bmotoIsToken0 — verify after pair creation
);

// BMOTOToken.setRebaseContract(rebaser)
await interact(
    'BMOTOToken.setRebaseContract',
    bmotoAddr, BMOTOTokenAbi, 'setRebaseContract',
    await caddr(rebaserAddr),
);

// 3. Fund pools: 250k → Pool1, 750k → Pool2
await interact(
    'BMOTOToken.transfer → Pool1 (250,000 BMOTO)',
    bmotoAddr, OP_20_ABI, 'transfer',
    await caddr(pool1Addr), 25_000_000_000_000n,
);
await interact(
    'BMOTOToken.transfer → Pool2 (750,000 BMOTO)',
    bmotoAddr, OP_20_ABI, 'transfer',
    await caddr(pool2Addr), 75_000_000_000_000n,
);

// 4. Save deployment output
const deployment = {
    network: 'testnet',
    bmotoAddr,
    pool1Addr,
    pool2Addr,
    rebaserAddr,
    lp0: LP0_ADDR,
    lp1: 'INACTIVE — only PILL/MOTO (lp0) is live on testnet',
    lp2: 'INACTIVE — only PILL/MOTO (lp0) is live on testnet',
    pool2Lp: 'PENDING — create BMOTO/MOTO pair on MotoSwap then run set-pool2-lp-testnet.mjs',
    pool1FarmStart: 'NOT SET — run set-farm-start-testnet.mjs when ready to open staking',
    pool2FarmStart: 'NOT SET — run set-farm-start-testnet.mjs when ready to open staking',
    deployerP2TR: wallet.p2tr,
    currentBlockAtDeploy: currentBlock.toString(),
    timestamp: new Date().toISOString(),
};

writeFileSync('./deployment.testnet.json', JSON.stringify(deployment, null, 2));

console.log('\n=== DONE ===');
console.log('Saved to ./deployment.testnet.json');
console.log('');
console.log('Next steps:');
console.log('  1. Update frontend/src/config/contracts.ts with the addresses above');
console.log('  2. Create the BMOTO/MOTO LP pair on MotoSwap testnet');
console.log('  3. Run: node set-pool2-lp-testnet.mjs --lp <pair address>');
console.log('  4. Run: node set-farm-start-testnet.mjs --block <start block>');

await provider.close();
