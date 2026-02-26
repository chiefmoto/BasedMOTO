/**
 * BMOTO Full Deploy Script — Regtest
 *
 * Deploys all 4 contracts in the correct order and wires them together.
 * Uses mock OP20 tokens (MyToken.wasm) as LP token stand-ins for regtest testing.
 *
 * Usage:
 *   node deploy-regtest.mjs
 *
 * Prerequisite: bitcoin-cli reachable, regtest node running on localhost:9001
 *
 * After each deployment a block is automatically mined.
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import {
    TransactionFactory,
    Mnemonic,
    AddressTypes,
    MLDSASecurityLevel,
    Address,
} from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL      = 'http://localhost:9001/api/v1/json-rpc';
const NETWORK      = networks.regtest;
const FEE_RATE     = 10;
const PRIORITY_FEE = 330_000n;
const GAS_SAT_FEE  = 330_000n;

process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }

// Path to a compiled OP20 WASM to use as mock LP tokens
const MOCK_LP_WASM_PATH = '/root/myproject/my-token/contract/build/MyToken.wasm';

// Path to MockPair WASM (implements getReserves() for Rebaser testing)
const MOCK_PAIR_WASM_PATH = './mock-pair/build/MockPair.wasm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isCoinbase(utxo) {
    const raw = utxo.nonWitnessUtxo;
    if (!raw) return false;
    for (const offset of [7, 5]) {
        if (offset + 32 > Object.keys(raw).length) continue;
        let allZero = true;
        for (let i = offset; i < offset + 32; i++) {
            if (raw[i] !== 0) { allZero = false; break; }
        }
        if (allZero) return true;
    }
    return false;
}

function mineBlock() {
    execSync(
        "bitcoin-cli -regtest generatetoaddress 1 $(bitcoin-cli -regtest getnewaddress)",
        { stdio: 'inherit' },
    );
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getSpendableUtxos(_provider, address, excludeTxids = new Set()) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const scan = JSON.parse(execSync(
            `bitcoin-cli -regtest scantxoutset start '["addr(${address})"]'`,
            { encoding: 'utf8' },
        ));
        const utxos = [];
        for (const u of scan.unspents) {
            if (excludeTxids.has(u.txid)) continue;
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
        if (utxos.length > 0) return utxos;
        if (attempt < 19) {
            process.stdout.write(attempt === 0 ? '  Waiting for UTXO...' : '.');
            await sleep(2000);
        }
    }
    process.stdout.write('\n');
    throw new Error('Timed out waiting for fresh UTXOs');
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
const mnemonic  = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet    = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);
const factory   = new TransactionFactory();

console.log('Deployer P2TR:', wallet.p2tr);
console.log('');

// ---------------------------------------------------------------------------
// Deploy helper
// ---------------------------------------------------------------------------
// Track UTXOs spent across deployments so each call waits for fresh ones
const spentTxids = new Set();

async function deployContract(label, wasmPath) {
    console.log(`\n=== Deploying ${label} ===`);
    const bytecode = new Uint8Array(readFileSync(wasmPath));
    console.log(`WASM size: ${bytecode.length} bytes`);

    const utxos = await getSpendableUtxos(provider, wallet.p2tr, spentTxids);
    console.log(`UTXOs: ${utxos.length} spendable`);

    // Mark all inputs as spent so the next deployment won't reuse them
    for (const u of utxos) spentTxids.add(u.transactionId);

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
        const txid = execSync(
            `bitcoin-cli -regtest sendrawtransaction ${rawTx}`,
            { encoding: 'utf8' },
        ).trim();
        console.log(`TX ${i + 1}: ${txid}`);
    }

    mineBlock();
    // spentTxids already has the consumed input txids — change outputs will
    // have NEW txids from the broadcast transactions, so they're not filtered
    await sleep(3000);

    console.log(`${label} address: ${result.contractAddress}`);
    return result.contractAddress;
}

// ---------------------------------------------------------------------------
// Interaction helper — simulate + broadcast
// ---------------------------------------------------------------------------
async function interact(label, contractAddress, abi, methodName, ...args) {
    console.log(`\n  → ${label}`);

    const utxos = await getSpendableUtxos(provider, wallet.p2tr, spentTxids);
    for (const u of utxos) spentTxids.add(u.transactionId);

    const contract = getContract(contractAddress, abi, provider, NETWORK, wallet.address);

    const simulation = await contract[methodName](...args);
    if ('error' in simulation) {
        throw new Error(`Simulation failed for ${methodName}: ${simulation.error}`);
    }

    const challenge = await provider.getChallenge();

    // Sign the transaction but broadcast manually via bitcoin-cli (OPNet node relay broken on regtest)
    const signedTx = await simulation.signTransaction({
        signer:      wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        network:     NETWORK,
        feeRate:     FEE_RATE,
        priorityFee: PRIORITY_FEE,
        gasSatFee:   GAS_SAT_FEE,
        utxos,
        challenge,
        refundTo:    wallet.p2tr,
        maximumAllowedSatToSpend: 100_000n,
    });

    if (signedTx.fundingTransactionRaw) {
        const txid1 = execSync(
            `bitcoin-cli -regtest sendrawtransaction ${signedTx.fundingTransactionRaw}`,
            { encoding: 'utf8' },
        ).trim();
        console.log(`    funding tx: ${txid1}`);
    }
    const txid2 = execSync(
        `bitcoin-cli -regtest sendrawtransaction ${signedTx.interactionTransactionRaw}`,
        { encoding: 'utf8' },
    ).trim();
    console.log(`  ✓ ${label} — interact tx: ${txid2}`);

    mineBlock();
    await sleep(2000);
}

// ---------------------------------------------------------------------------
// BMOTO-specific ABIs (from generated files, inline here for portability)
// ---------------------------------------------------------------------------
import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

const BMOTOTokenAbi = [
    ...OP_NET_ABI,
    {
        name: 'rebase',
        inputs: [
            { name: 'supplyDelta', type: ABIDataTypes.UINT256 },
            { name: 'isExpansion', type: ABIDataTypes.BOOL },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setRebaseContract',
        inputs: [{ name: 'addr', type: ABIDataTypes.ADDRESS }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getGonsPerFragment',
        inputs: [],
        outputs: [{ name: 'gonsPerFragment', type: ABIDataTypes.UINT256 }],
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
    {
        name: 'deposit',
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'withdraw',
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'harvest',
        inputs: [{ name: 'poolId', type: ABIDataTypes.UINT8 }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'halve',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'pending',
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'user',   type: ABIDataTypes.ADDRESS },
        ],
        outputs: [{ name: 'pending', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTotalDistributed',
        inputs: [],
        outputs: [{ name: 'totalDistributed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
];

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
    {
        name: 'setFarmStart',
        inputs: [{ name: 'startBlock', type: ABIDataTypes.UINT256 }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'deposit',
        inputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'withdraw',
        inputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'harvest',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'halve',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'pending',
        inputs: [{ name: 'user', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'pending', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTotalDistributed',
        inputs: [],
        outputs: [{ name: 'totalDistributed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
];

const RebaserAbi = [
    ...OP_NET_ABI,
    {
        name: 'setContracts',
        inputs: [
            { name: 'bmoto',           type: ABIDataTypes.ADDRESS },
            { name: 'pool1',           type: ABIDataTypes.ADDRESS },
            { name: 'pool2',           type: ABIDataTypes.ADDRESS },
            { name: 'bmotoMotoPair',   type: ABIDataTypes.ADDRESS },
            { name: 'pool1LaunchBlock', type: ABIDataTypes.UINT64  },
            { name: 'bmotoIsToken0',   type: ABIDataTypes.BOOL    },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'updateTWAP',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'rebase',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'isRebaseEnabled',
        inputs: [],
        outputs: [{ name: 'enabled', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
];

const MockPairAbi = [
    ...OP_NET_ABI,
    {
        name: 'setReserves',
        inputs: [
            { name: 'reserve0', type: ABIDataTypes.UINT256 },
            { name: 'reserve1', type: ABIDataTypes.UINT256 },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getReserves',
        inputs: [],
        outputs: [
            { name: 'reserve0',          type: ABIDataTypes.UINT256 },
            { name: 'reserve1',          type: ABIDataTypes.UINT256 },
            { name: 'blockTimestampLast', type: ABIDataTypes.UINT64 },
        ],
        type: BitcoinAbiTypes.Function,
    },
];

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

// 1. Deploy 3 mock LP tokens (reuse MyToken.wasm — any OP20 works for testing)
const mockLp0 = await deployContract('MockLP-0 (PILL/MOTO)', MOCK_LP_WASM_PATH);
const mockLp1 = await deployContract('MockLP-1 (PEPE/MOTO)', MOCK_LP_WASM_PATH);
const mockLp2 = await deployContract('MockLP-2 (UNGA/MOTO)', MOCK_LP_WASM_PATH);

// 1b. Deploy MockPair contracts for Rebaser oracle testing
//   - mockBmotoMotoPair: simulates the BMOTO/MOTO Motoswap pair (BMOTO=token0, MOTO=token1)
//   - mockMotoRefPair:   simulates a MOTO/BTC reference pair (MOTO=token0, BTC=token1)
const mockBmotoMotoPair = await deployContract('MockPair (BMOTO/MOTO)', MOCK_PAIR_WASM_PATH);
const mockMotoRefPair   = await deployContract('MockPair (MOTO/BTC)',   MOCK_PAIR_WASM_PATH);

// 2. Deploy BMOTOToken
const bmotoAddr = await deployContract('BMOTOToken', './token/build/BMOTOToken.wasm');

// 3. Deploy Pool1
const pool1Addr = await deployContract('Pool1', './pool1/build/Pool1.wasm');

// 4. Deploy Pool2
const pool2Addr = await deployContract('Pool2', './pool2/build/Pool2.wasm');

// 5. Deploy Rebaser
const rebaserAddr = await deployContract('Rebaser', './rebaser/build/Rebaser.wasm');

console.log('\n=== All contracts deployed ===');
console.log(`BMOTOToken : ${bmotoAddr}`);
console.log(`Pool1      : ${pool1Addr}`);
console.log(`Pool2      : ${pool2Addr}`);
console.log(`Rebaser             : ${rebaserAddr}`);
console.log(`MockLP-0            : ${mockLp0}`);
console.log(`MockLP-1            : ${mockLp1}`);
console.log(`MockLP-2            : ${mockLp2}`);
console.log(`MockPair BMOTO/MOTO : ${mockBmotoMotoPair}`);
console.log(`MockPair MOTO/BTC   : ${mockMotoRefPair}`);

// 6. Wire up addresses
console.log('\n=== Wiring addresses ===');

// Helper: resolve an OPNet contract address string to an Address object via RPC
async function caddr(s) {
    return provider.getPublicKeyInfo(s, true);
}

// Pool1.initialize(bmoto, lp0, lp1, lp2)
await interact(
    'Pool1.initialize',
    pool1Addr, Pool1Abi, 'initialize',
    await caddr(bmotoAddr), await caddr(mockLp0), await caddr(mockLp1), await caddr(mockLp2),
);

// Pool2.initialize(bmoto, mockLp0) — use mockLp0 as BMOTO/MOTO LP stand-in
await interact(
    'Pool2.initialize',
    pool2Addr, Pool2Abi, 'initialize',
    await caddr(bmotoAddr), await caddr(mockLp0),
);

// Set farm start blocks (regtest: start immediately on next interaction)
const currentBlock = BigInt(await provider.getBlockNumber());
console.log(`\nCurrent block: ${currentBlock}`);

// Pool1 farm starts at currentBlock + 1
const pool1FarmStart = currentBlock + 1n;
await interact(
    `Pool1.setFarmStart(${pool1FarmStart})`,
    pool1Addr, Pool1Abi, 'setFarmStart',
    pool1FarmStart,
);

// Pool2 farm starts at Pool1 farmStart + 288 (mainnet intent)
// For regtest testing we use pool1FarmStart + 1 so both pools are active immediately
const pool2FarmStart = pool1FarmStart + 1n;
await interact(
    `Pool2.setFarmStart(${pool2FarmStart})`,
    pool2Addr, Pool2Abi, 'setFarmStart',
    pool2FarmStart,
);

// Rebaser.setContracts(bmoto, pool1, pool2, bmotoMotoPair, launchBlock, bmotoIsToken0)
// launchBlock = 1 → 4032-block activation check passes immediately on regtest
// bmotoIsToken0 = true → BMOTO is reserve0 in the BMOTO/MOTO pair
await interact(
    'Rebaser.setContracts',
    rebaserAddr, RebaserAbi, 'setContracts',
    await caddr(bmotoAddr),
    await caddr(pool1Addr),
    await caddr(pool2Addr),
    await caddr(mockBmotoMotoPair),
    1n,    // launchBlock = 1 → 4032-block check passes immediately on regtest
    true,  // bmotoIsToken0
);

// BMOTOToken.setRebaseContract(rebaser)
await interact(
    'BMOTOToken.setRebaseContract',
    bmotoAddr, BMOTOTokenAbi, 'setRebaseContract',
    await caddr(rebaserAddr),
);

// 7. Transfer BMOTO to pools:  250k → Pool1, 750k → Pool2
//    250_000 × 10^8 = 25_000_000_000_000
//    750_000 × 10^8 = 75_000_000_000_000
await interact(
    'BMOTOToken.transfer → Pool1 (250k)',
    bmotoAddr, OP_20_ABI, 'transfer',
    await caddr(pool1Addr), 25_000_000_000_000n,
);
await interact(
    'BMOTOToken.transfer → Pool2 (750k)',
    bmotoAddr, OP_20_ABI, 'transfer',
    await caddr(pool2Addr), 75_000_000_000_000n,
);

// 8. Save deployment JSON for interact script
const deployment = {
    bmotoAddr, pool1Addr, pool2Addr, rebaserAddr,
    mockLp0, mockLp1, mockLp2,
    mockBmotoMotoPair, mockMotoRefPair,
    pool1FarmStart: pool1FarmStart.toString(),
    pool2FarmStart: pool2FarmStart.toString(),
    deployerP2TR: wallet.p2tr,
    timestamp: new Date().toISOString(),
};
writeFileSync('./deployment.json', JSON.stringify(deployment, null, 2));

console.log('\n=== DONE ===');
console.log('Saved to ./deployment.json');
console.log('\nRun interact-regtest.mjs to test staking.');

await provider.close();
