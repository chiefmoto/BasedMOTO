/**
 * BMOTO Wire Script — OPNet Testnet
 *
 * Wires already-deployed contracts together. Run this after deploy-testnet.mjs
 * if wiring failed (e.g. because contracts weren't indexed yet).
 *
 * Usage:
 *   node wire-testnet.mjs
 *
 * Deployed addresses are hardcoded below.
 */

import { writeFileSync } from 'fs';
import { JSONRpcProvider, getContract, OP_20_ABI, ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';
import {
    Mnemonic,
    AddressTypes,
    MLDSASecurityLevel,
} from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL      = 'https://testnet.opnet.org/api/v1/json-rpc';
const NETWORK      = networks.opnetTestnet;
const FEE_RATE     = 10;
const PRIORITY_FEE = 330_000n;
const GAS_SAT_FEE  = 330_000n;

process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }

// ---------------------------------------------------------------------------
// Deployed contract addresses (from deploy-testnet.mjs run)
// ---------------------------------------------------------------------------
const BMOTO_ADDR   = 'opt1sqrf773f6n3nxm3clsem3z5zt6pqddq60scvhysud';
const POOL1_ADDR   = 'opt1sqzt4fugeweu3tvmqxz4gqtl0z9wt9xll0uvdnah7';
const POOL2_ADDR   = 'opt1sqpfgp4gr0mep6pzd5tn0tmn7xkukjtw8e5kcguev';
const REBASER_ADDR = 'opt1sqqne48k598kyhp6j3u25re6jxhj90vtcdv8k0y2n';
const LP0_ADDR     = 'opt1sqq47sszp4zrj9xhss2ep54dc456za9aweqvqzr3g'; // PILL/MOTO LP

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

/**
 * Resolve an OPNet address string to an Address object via RPC.
 * Retries for up to MAX_WAIT_MS — freshly deployed contracts may take
 * several minutes to appear in the indexer.
 */
async function caddr(addr, label = addr) {
    const MAX_WAIT_MS  = 20 * 60 * 1000; // 20 minutes
    const INTERVAL_MS  = 10_000;          // poll every 10 seconds
    const start = Date.now();

    while (true) {
        // Preferred: getPublicKeyInfo (works for contracts with registered ML-DSA key)
        const result = await provider.getPublicKeyInfo(addr, true).catch(() => undefined);
        if (result !== undefined && result !== null) {
            console.log(`  [indexed] ${label}`);
            return result;
        }

        // Fallback: getCode returns contractPublicKey even without ML-DSA registration
        const codeInfo = await provider.getCode(addr).catch(() => undefined);
        if (codeInfo?.contractPublicKey) {
            console.log(`  [indexed via getCode] ${label}`);
            return codeInfo.contractPublicKey;
        }

        const elapsed = Date.now() - start;
        if (elapsed >= MAX_WAIT_MS) {
            throw new Error(
                `Timed out waiting for ${label} (${addr}) to be indexed after ${MAX_WAIT_MS / 60_000} min`,
            );
        }

        const secs = Math.round(elapsed / 1000);
        console.log(`  [waiting] ${label} — not indexed yet (${secs}s elapsed, retrying in 10s)...`);
        await sleep(INTERVAL_MS);
    }
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

// ---------------------------------------------------------------------------
// ABIs
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
console.log('=== Step 1: Wait for all contracts to be indexed ===');
console.log('(Freshly deployed contracts can take several minutes to appear in the indexer.)');
console.log('');

// LP0 is a pre-existing contract so it resolves immediately.
// The four new contracts may need a long wait.
const [bmotoAddrObj, pool1AddrObj, pool2AddrObj, rebaserAddrObj, lp0AddrObj] = await Promise.all([
    caddr(BMOTO_ADDR,   'BMOTOToken'),
    caddr(POOL1_ADDR,   'Pool1'),
    caddr(POOL2_ADDR,   'Pool2'),
    caddr(REBASER_ADDR, 'Rebaser'),
    caddr(LP0_ADDR,     'LP0 (PILL/MOTO)'),
]);

console.log('\n=== Step 2: Wire contracts ===');

// Pool1.initialize(bmoto, lp0, lp1, lp2)
// Testnet: only pool 0 (PILL/MOTO) active — pass lp0 for all 3 slots.
await interact(
    'Pool1.initialize',
    POOL1_ADDR, Pool1Abi, 'initialize',
    bmotoAddrObj,
    lp0AddrObj,
    lp0AddrObj,
    lp0AddrObj,
);

// Pool2 — deferred until BMOTO/MOTO LP pair exists on MotoSwap
console.log('\n  ⚠ Skipping Pool2.initialize — BMOTO/MOTO LP pair not yet created.');
console.log('    Run set-pool2-lp-testnet.mjs after creating the pair.');

// Rebaser.setContracts
const currentBlock = BigInt(await provider.getBlockNumber());
console.log(`\nCurrent block: ${currentBlock}`);

await interact(
    'Rebaser.setContracts',
    REBASER_ADDR, RebaserAbi, 'setContracts',
    bmotoAddrObj,
    pool1AddrObj,
    pool2AddrObj,
    lp0AddrObj,   // bmotoMotoPair placeholder — update via Rebaser.setContracts again after pair created
    currentBlock, // pool1LaunchBlock
    true,         // bmotoIsToken0 — verify after pair creation
);

// BMOTOToken.setRebaseContract
await interact(
    'BMOTOToken.setRebaseContract',
    BMOTO_ADDR, BMOTOTokenAbi, 'setRebaseContract',
    rebaserAddrObj,
);

// Fund pools: 250k → Pool1, 750k → Pool2
await interact(
    'BMOTOToken.transfer → Pool1 (250,000 basedMOTO)',
    BMOTO_ADDR, OP_20_ABI, 'transfer',
    pool1AddrObj, 25_000_000_000_000n,
);
await interact(
    'BMOTOToken.transfer → Pool2 (750,000 basedMOTO)',
    BMOTO_ADDR, OP_20_ABI, 'transfer',
    pool2AddrObj, 75_000_000_000_000n,
);

// ---------------------------------------------------------------------------
// Save deployment output
// ---------------------------------------------------------------------------
const deployment = {
    network: 'testnet',
    bmotoAddr:   BMOTO_ADDR,
    pool1Addr:   POOL1_ADDR,
    pool2Addr:   POOL2_ADDR,
    rebaserAddr: REBASER_ADDR,
    lp0: LP0_ADDR,
    lp1: 'INACTIVE — only PILL/MOTO (lp0) is live on testnet',
    lp2: 'INACTIVE — only PILL/MOTO (lp0) is live on testnet',
    pool2Lp:        'PENDING — create BMOTO/MOTO pair on MotoSwap then run set-pool2-lp-testnet.mjs',
    pool1FarmStart: 'NOT SET — run set-farm-start-testnet.mjs when ready to open staking',
    pool2FarmStart: 'NOT SET — run set-farm-start-testnet.mjs when ready to open staking',
    deployerP2TR:        wallet.p2tr,
    pool1LaunchBlock:    currentBlock.toString(),
    timestamp:           new Date().toISOString(),
};

writeFileSync('./deployment.testnet.json', JSON.stringify(deployment, null, 2));

console.log('\n=== DONE ===');
console.log('Saved to ./deployment.testnet.json');
console.log('');
console.log('Next steps:');
console.log('  1. Update frontend/src/config/contracts.ts TESTNET_ADDRESSES with addresses above');
console.log('  2. Create the BMOTO/MOTO LP pair on MotoSwap testnet');
console.log('  3. node set-pool2-lp-testnet.mjs --lp <pair address>');
console.log('  4. node set-farm-start-testnet.mjs --block <start block>');

await provider.close();
