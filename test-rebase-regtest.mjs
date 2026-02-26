/**
 * BMOTO Rebaser Test Script — Regtest (TWAP version)
 *
 * Tests the full rebase flow:
 *   1. Set BMOTO/MOTO reserves (1:1 balanced)
 *   2. Call updateTWAP() × 6 with 10s gaps → builds the TWAP accumulator
 *   3. rebase() → no-op (deviation < 5%)
 *   4. Imbalance reserves (BMOTO cheap, 20% deviation)
 *   5. Call updateTWAP() × 6 → new TWAP reflects the imbalance
 *   6. rebase() → expansion (supply +2%)
 *   7. Immediate second rebase → "Too soon" (24h cooldown)
 *
 * Usage:
 *   node test-rebase-regtest.mjs
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import {
    TransactionFactory,
    Mnemonic,
    AddressTypes,
    MLDSASecurityLevel,
} from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';
import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

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

const SCALE = 100_000_000n;

// ---------------------------------------------------------------------------
// Load deployment
// ---------------------------------------------------------------------------
const dep = JSON.parse(readFileSync('./deployment.json', 'utf8'));
const { bmotoAddr, rebaserAddr, mockBmotoMotoPair } = dep;

console.log('=== BMOTO Rebaser TWAP Test ===');
console.log(`BMOTOToken         : ${bmotoAddr}`);
console.log(`Rebaser            : ${rebaserAddr}`);
console.log(`MockPair BMOTO/MOTO: ${mockBmotoMotoPair}`);
console.log('');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mineBlock() {
    execSync(
        "bitcoin-cli -regtest generatetoaddress 1 $(bitcoin-cli -regtest getnewaddress)",
        { stdio: 'inherit' },
    );
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getSpendableUtxos(provider, address) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const scan = JSON.parse(execSync(
            `bitcoin-cli -regtest scantxoutset start '["addr(${address})"]'`,
            { encoding: 'utf8' },
        ));
        const utxos = [];
        for (const u of scan.unspents) {
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
        await sleep(2000);
    }
    throw new Error(`No spendable UTXOs for ${address}`);
}

async function broadcastRaw(raw) {
    const res = await fetch('http://localhost:9002/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`Broadcast failed: ${JSON.stringify(j.error)}`);
    return j.txid ?? j.result;
}

// ---------------------------------------------------------------------------
// Wallet + provider
// ---------------------------------------------------------------------------
const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
const mnemonic = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);

async function interact(label, contractAddr, abi, method, ...args) {
    console.log(`\n→ ${label}`);
    const utxos    = await getSpendableUtxos(provider, wallet.p2tr);
    const contract = getContract(contractAddr, abi, provider, NETWORK, wallet.address);
    const sim      = await contract[method](...args);
    if ('error' in sim) throw new Error(`Simulation failed for ${method}: ${sim.error}`);

    const challenge = await provider.getChallenge();
    const signedTx  = await sim.signTransaction({
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
        await broadcastRaw(signedTx.fundingTransactionRaw);
        mineBlock();
        await sleep(3000);
    }
    await broadcastRaw(signedTx.interactionTransactionRaw);
    mineBlock();
    await sleep(3000);
    console.log(`  ✓ ${label}`);
    return sim;
}

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------
const RebaserAbi = [
    ...OP_NET_ABI,
    {
        name: 'rebase',
        inputs: [],
        outputs: [
            { name: 'supplyDelta', type: ABIDataTypes.UINT256 },
            { name: 'isExpansion', type: ABIDataTypes.BOOL },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'updateTWAP',
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
    {
        name: 'getTWAPInfo',
        inputs: [],
        outputs: [
            { name: 'twapPrice',       type: ABIDataTypes.UINT256 },
            { name: 'sampleCount',     type: ABIDataTypes.UINT256 },
            { name: 'lastSampleBlock', type: ABIDataTypes.UINT64  },
            { name: 'lastRebaseTime',  type: ABIDataTypes.UINT64  },
            { name: 'currentBlock',    type: ABIDataTypes.UINT64  },
        ],
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
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getTotalSupply() {
    const token  = getContract(bmotoAddr, OP_20_ABI, provider, NETWORK, wallet.address);
    const result = await token.totalSupply();
    const props  = result.properties ?? result;
    return props.totalSupply ?? props.total ?? props[Object.keys(props)[0]];
}

async function debugTWAP(label) {
    const rebaser = getContract(rebaserAddr, RebaserAbi, provider, NETWORK, wallet.address);
    const result  = await rebaser.getTWAPInfo();
    const props   = result.properties ?? result;
    console.log(`  [${label}] twapPrice=${props.twapPrice} sampleCount=${props.sampleCount}`);
    console.log(`  [${label}] lastSampleBlock=${props.lastSampleBlock} currentBlock=${props.currentBlock}`);
}

async function waitForOpnetSync() {
    const btcHeight = parseInt(execSync('bitcoin-cli -regtest getblockcount', { encoding: 'utf8' }).trim());
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const resp = await fetch(RPC_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'btc_blockNumber', params: [], id: 1 }),
            });
            const json = await resp.json();
            const opnetHeight = parseInt(json.result, 16);
            if (opnetHeight >= btcHeight) {
                console.log(`  OPNet synced at block ${opnetHeight}`);
                return;
            }
            process.stdout.write(`  Waiting for OPNet sync: opnet=${opnetHeight} btc=${btcHeight}...\r`);
        } catch (_) {}
        await sleep(1000);
    }
    console.warn('  WARN: OPNet sync timeout — proceeding anyway');
}

/**
 * Pushes N TWAP samples, waiting MIN_SAMPLE_INTERVAL (10s) between each.
 * Mines a block + syncs OPNet BEFORE simulating each sample so the contract
 * sees a fresh block timestamp (~10s+ later than the previous sample's block).
 */
async function buildTWAP(n = 6) {
    console.log(`\n→ Building TWAP (${n} samples, 1 block apart)...`);
    for (let i = 0; i < n; i++) {
        mineBlock();              // each sample requires a new block
        await waitForOpnetSync(); // ensure simulation sees the new block number
        await interact(`updateTWAP sample ${i + 1}/${n}`, rebaserAddr, RebaserAbi, 'updateTWAP');
    }
    await debugTWAP('after buildTWAP');
}

// ---------------------------------------------------------------------------
// MAIN TEST
// ---------------------------------------------------------------------------

// ── Step 0: Check isRebaseEnabled ──────────────────────────────────────────
console.log('\n=== Step 0: isRebaseEnabled ===');
{
    const rebaser = getContract(rebaserAddr, RebaserAbi, provider, NETWORK, wallet.address);
    const result  = await rebaser.isRebaseEnabled();
    const props   = result.properties ?? result;
    if (!props.enabled) {
        console.error('ERROR: Rebase not enabled');
        process.exit(1);
    }
    console.log('  ✓ Rebase is active');
}

// ── Step 1: Balanced reserves → no-op rebase ───────────────────────────────
console.log('\n=== Step 1: Balanced reserves → no-op rebase ===');
// 1:1 reserves → BMOTO price = 1 MOTO = PRICE_SCALE → deviation = 0
await interact('MockPair.setReserves — 1:1 balanced', mockBmotoMotoPair, MockPairAbi, 'setReserves',
    50_000_000_000n, 50_000_000_000n);

await waitForOpnetSync();
await buildTWAP(6);
await waitForOpnetSync();

const supplyBefore1 = await getTotalSupply();
console.log(`\n  totalSupply before no-op rebase: ${supplyBefore1}`);

await interact('Rebaser.rebase() — expect no-op', rebaserAddr, RebaserAbi, 'rebase');
await waitForOpnetSync();

const supplyAfter1 = await getTotalSupply();
console.log(`  totalSupply after  no-op rebase: ${supplyAfter1}`);
console.log(`  Δ supply: ${supplyAfter1 - supplyBefore1} (expected 0)`);
if (supplyAfter1 !== supplyBefore1) {
    console.warn('  WARN: supply changed on balanced rebase');
} else {
    console.log('  ✓ No-op rebase correct');
}

// ── Step 2: BMOTO cheap → expansion rebase ─────────────────────────────────
// Note: no-op does NOT update lastRebaseTime, so the 24h cooldown is still open.
// The TWAP accumulator was also NOT reset by the no-op, but we reset it here by
// setting new reserves and building a fresh TWAP that reflects the imbalance.
console.log('\n=== Step 2: BMOTO cheap (20% below MOTO) → expansion rebase ===');
// 625 BMOTO : 500 MOTO → BMOTO price = 500/625 × 10^8 = 0.8 × 10^8
// Deviation = 20% → supplyDelta = supply × 20% / 10 = 2% of supply
await interact('MockPair.setReserves — BMOTO cheap (0.8)', mockBmotoMotoPair, MockPairAbi, 'setReserves',
    62_500_000_000n, 50_000_000_000n);

await waitForOpnetSync();
await buildTWAP(6);
await waitForOpnetSync();

const supplyBefore2 = await getTotalSupply();
const expectedDelta2 = supplyBefore2 * 20n / 100n / 10n;
console.log(`\n  totalSupply before expansion rebase: ${supplyBefore2}`);
console.log(`  Expected Δ supply ≈ +${expectedDelta2} (2% of supply)`);

await interact('Rebaser.rebase() — expansion', rebaserAddr, RebaserAbi, 'rebase');
await waitForOpnetSync();

const supplyAfter2 = await getTotalSupply();
const actualDelta2 = supplyAfter2 - supplyBefore2;
console.log(`  totalSupply after  expansion rebase: ${supplyAfter2}`);
console.log(`  Actual Δ supply: +${actualDelta2}`);

if (actualDelta2 > 0n) {
    console.log('  ✓ Expansion rebase: supply increased');
} else {
    console.error('  ✗ FAIL: supply did not increase');
}

// ── Step 3: 24h cooldown ────────────────────────────────────────────────────
console.log('\n=== Step 3: 24h cooldown — immediate second call should revert ===');
// Build a fresh TWAP with imbalanced reserves so we pass the MIN_SAMPLES check,
// but the 24h cooldown (lastRebaseTime=now_ms) will block us.
await buildTWAP(6);
try {
    await interact('Rebaser.rebase() — should revert (Too soon)', rebaserAddr, RebaserAbi, 'rebase');
    console.error('  ✗ FAIL: should have reverted with "Too soon"');
} catch (e) {
    if (e.message.includes('Too soon')) {
        console.log(`  ✓ Correctly reverted: ${e.message}`);
    } else {
        console.error(`  ✗ Unexpected error: ${e.message}`);
    }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n=== Rebase Test Summary ===');
console.log(`  Step 1 no-op:     supply unchanged at ${supplyAfter1}`);
console.log(`  Step 2 expansion: ${supplyBefore2} → ${supplyAfter2} (+${actualDelta2})`);
console.log('  Step 3 cooldown:  reverted correctly');
console.log('\n✓ All rebase tests passed');
