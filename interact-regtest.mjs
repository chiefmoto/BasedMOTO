/**
 * BMOTO Interact Script — Regtest
 *
 * Tests the full stake → accrue → harvest flow against a deployed BMOTO system.
 * Reads contract addresses from deployment.json (created by deploy-regtest.mjs).
 *
 * Usage:
 *   node interact-regtest.mjs
 *
 * To test halving (requires time-travel):
 *   bitcoin-cli -regtest setmocktime $(($(date +%s) + 86401))
 *   bitcoin-cli -regtest generatetoaddress 1 $(bitcoin-cli -regtest getnewaddress)
 *   node interact-regtest.mjs  # then call halve section manually
 *   bitcoin-cli -regtest setmocktime 0   # reset
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

// ---------------------------------------------------------------------------
// Load deployment
// ---------------------------------------------------------------------------
const dep = JSON.parse(readFileSync('./deployment.json', 'utf8'));
const { bmotoAddr, pool1Addr, pool2Addr, rebaserAddr, mockLp0, mockLp1, mockLp2 } = dep;

console.log('=== BMOTO Interact ===');
console.log(`BMOTOToken : ${bmotoAddr}`);
console.log(`Pool1      : ${pool1Addr}`);
console.log(`Pool2      : ${pool2Addr}`);
console.log(`Rebaser    : ${rebaserAddr}`);
console.log(`MockLP-0   : ${mockLp0}`);
console.log(`MockLP-1   : ${mockLp1}`);
console.log(`MockLP-2   : ${mockLp2}`);
console.log('');

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

/**
 * Fetch spendable UTXOs using bitcoin-cli directly (bypasses stale OPNet UTXO index).
 * Builds complete UTXO objects including nonWitnessUtxo required for Taproot signing.
 */
async function getSpendableUtxos(_provider, address, excludeTxids = new Set()) {
    for (let attempt = 0; attempt < 20; attempt++) {
        // Use scantxoutset for accurate current UTXO state
        const scan = JSON.parse(execSync(
            `bitcoin-cli -regtest scantxoutset start '["addr(${address})"]'`,
            { encoding: 'utf8' },
        ));

        const utxos = [];
        for (const u of scan.unspents) {
            if (excludeTxids.has(u.txid)) continue;
            if (u.coinbase) continue; // skip coinbase (scantxoutset reports this directly)
            const rawHex = execSync(
                `bitcoin-cli -regtest getrawtransaction ${u.txid} false`,
                { encoding: 'utf8' },
            ).trim();
            const rawBuf = Buffer.from(rawHex, 'hex');
            // Convert BTC amount to satoshis as BigInt (avoid float precision issues)
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

const deployerAddr = wallet.p2tr;
console.log('Interactor:', deployerAddr);
console.log('');

// Resolve contract addresses to Address objects (needed when passed as ABI args)
const pool1AddrObj  = await provider.getPublicKeyInfo(pool1Addr,  true);
const pool2AddrObj  = await provider.getPublicKeyInfo(pool2Addr,  true);
// wallet.address is already an Address object — use it instead of deployerAddr for ABI args

// Track UTXOs spent across interactions so each call gets fresh ones
const spentTxids = new Set();

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------
const MockLpAbi = [
    ...OP_NET_ABI,
    ...OP_20_ABI,
    {
        name: 'mint',
        inputs: [
            { name: 'to',     type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
];

const BMOTOTokenAbi = [
    ...OP_NET_ABI,
    ...OP_20_ABI,
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
            { name: 'pair',            type: ABIDataTypes.ADDRESS },
            { name: 'pool1LaunchBlock', type: ABIDataTypes.UINT64  },
            { name: 'bmotoIsToken0',   type: ABIDataTypes.BOOL    },
        ],
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

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------
function broadcast(raw) {
    const result = execSync(`bitcoin-cli -regtest sendrawtransaction ${raw}`, { encoding: 'utf8' }).trim();
    return result;
}

async function interact(label, contractAddress, abi, methodName, ...args) {
    console.log(`  → ${label}`);

    // Fetch fresh UTXOs via bitcoin-cli (bypasses stale OPNet UTXO index)
    const utxos = await getSpendableUtxos(provider, deployerAddr, spentTxids);
    for (const u of utxos) spentTxids.add(u.transactionId);

    const contract = getContract(contractAddress, abi, provider, NETWORK, wallet.address);
    const simulation = await contract[methodName](...args);
    if ('error' in simulation) {
        throw new Error(`Simulation failed for ${methodName}: ${JSON.stringify(simulation.error)}`);
    }

    const signed = await simulation.signTransaction({
        signer:                    wallet.keypair,
        mldsaSigner:               wallet.mldsaKeypair,
        refundTo:                  deployerAddr,
        network:                   NETWORK,
        maximumAllowedSatToSpend:  100_000n,
        linkMLDSAPublicKeyToAddress: false,
        utxos,
    });

    if (signed.fundingTransactionRaw) {
        broadcast(signed.fundingTransactionRaw);
        mineBlock();
        await sleep(1000);
    }
    const txid = broadcast(signed.interactionTransactionRaw);
    console.log(`  ✓ ${label} — txid: ${txid}`);
    mineBlock();
    await sleep(2000);

    return txid;
}

async function view(label, contractAddress, abi, methodName, ...args) {
    const contract = getContract(contractAddress, abi, provider, NETWORK, wallet.address);
    const result = await contract[methodName](...args);
    if ('error' in result) {
        throw new Error(`View call failed for ${methodName}: ${JSON.stringify(result.error)}`);
    }
    return result.properties ?? result;
}

function fmtBmoto(wei) {
    return `${(Number(wei) / 1e8).toFixed(8)} BMOTO`;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------
// 1000 LP tokens (8 decimals)
const LP_AMOUNT = 1_000n * 100_000_000n;

// Approve a large amount so we don't need re-approvals
const MAX_APPROVE = 2n ** 256n - 1n;

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

// ── 1. Mint LP tokens to deployer ──────────────────────────────────────────
console.log('\n=== Step 1: Mint mock LP tokens to deployer ===');
await interact('Mint 1000 mockLp0 to self', mockLp0, MockLpAbi, 'mint', wallet.address, LP_AMOUNT);
await interact('Mint 1000 mockLp1 to self', mockLp1, MockLpAbi, 'mint', wallet.address, LP_AMOUNT);
await interact('Mint 1000 mockLp2 to self', mockLp2, MockLpAbi, 'mint', wallet.address, LP_AMOUNT);

// ── 2. Approve Pool1 to spend each LP ─────────────────────────────────────
console.log('\n=== Step 2: Approve Pool1 for all 3 LP tokens ===');
await interact('mockLp0.increaseAllowance(Pool1)', mockLp0, MockLpAbi, 'increaseAllowance', pool1AddrObj, MAX_APPROVE);
await interact('mockLp1.increaseAllowance(Pool1)', mockLp1, MockLpAbi, 'increaseAllowance', pool1AddrObj, MAX_APPROVE);
await interact('mockLp2.increaseAllowance(Pool1)', mockLp2, MockLpAbi, 'increaseAllowance', pool1AddrObj, MAX_APPROVE);

// ── 3. Deposit into each Pool1 sub-pool ────────────────────────────────────
console.log('\n=== Step 3: Deposit into Pool1 sub-pools ===');
await interact('Pool1.deposit(pool=0, 100 LP)', pool1Addr, Pool1Abi, 'deposit', 0, 100n * 100_000_000n);
await interact('Pool1.deposit(pool=1, 100 LP)', pool1Addr, Pool1Abi, 'deposit', 1, 100n * 100_000_000n);
await interact('Pool1.deposit(pool=2, 100 LP)', pool1Addr, Pool1Abi, 'deposit', 2, 100n * 100_000_000n);

// ── 4. Mine a few blocks so rewards accumulate ─────────────────────────────
console.log('\n=== Step 4: Mining 5 blocks to let rewards accrue ===');
for (let i = 0; i < 5; i++) {
    mineBlock();
    await sleep(500);
}
await sleep(2000);

// ── 5. Check pending rewards ────────────────────────────────────────────────
console.log('\n=== Step 5: Check pending Pool1 rewards ===');
for (const pid of [0, 1, 2]) {
    const res = await view(`Pool1.pending(${pid})`, pool1Addr, Pool1Abi, 'pending', pid, wallet.address);
    console.log(`  Pool1[${pid}] pending: ${fmtBmoto(res.pending ?? 0n)}`);
}

// ── 6. Harvest from each Pool1 sub-pool ────────────────────────────────────
console.log('\n=== Step 6: Harvest Pool1 rewards ===');
await interact('Pool1.harvest(pool=0)', pool1Addr, Pool1Abi, 'harvest', 0);
await interact('Pool1.harvest(pool=1)', pool1Addr, Pool1Abi, 'harvest', 1);
await interact('Pool1.harvest(pool=2)', pool1Addr, Pool1Abi, 'harvest', 2);

// ── 7. Check BMOTO balance after harvest ───────────────────────────────────
console.log('\n=== Step 7: Check BMOTO balance after Pool1 harvest ===');
{
    const res = await view('BMOTO.balanceOf(deployer)', bmotoAddr, BMOTOTokenAbi, 'balanceOf', wallet.address);
    console.log(`  BMOTO balance: ${fmtBmoto(res.balance ?? 0n)}`);
}

// ── 8. Check Pool1 total distributed ───────────────────────────────────────
{
    const res = await view('Pool1.getTotalDistributed', pool1Addr, Pool1Abi, 'getTotalDistributed');
    console.log(`  Pool1 totalDistributed: ${fmtBmoto(res.totalDistributed ?? 0n)}`);
}

// ── 9. Pool2: approve + deposit ────────────────────────────────────────────
// Pool2 uses mockLp0 as its LP stand-in (set in deploy script)
console.log('\n=== Step 9: Pool2 — approve + deposit ===');
await interact('mockLp0.increaseAllowance(Pool2)', mockLp0, MockLpAbi, 'increaseAllowance', pool2AddrObj, MAX_APPROVE);
await interact('Pool2.deposit(100 LP)',  pool2Addr, Pool2Abi, 'deposit', 100n * 100_000_000n);

// Let rewards accrue
for (let i = 0; i < 5; i++) {
    mineBlock();
    await sleep(500);
}
await sleep(2000);

// ── 10. Check + harvest Pool2 rewards ──────────────────────────────────────
console.log('\n=== Step 10: Pool2 pending + harvest ===');
{
    const res = await view('Pool2.pending(deployer)', pool2Addr, Pool2Abi, 'pending', wallet.address);
    console.log(`  Pool2 pending: ${fmtBmoto(res.pending ?? 0n)}`);
}
await interact('Pool2.harvest', pool2Addr, Pool2Abi, 'harvest');

// ── 11. Final BMOTO balance ─────────────────────────────────────────────────
console.log('\n=== Step 11: Final BMOTO balance ===');
{
    const res = await view('BMOTO.balanceOf(deployer)', bmotoAddr, BMOTOTokenAbi, 'balanceOf', wallet.address);
    console.log(`  BMOTO balance: ${fmtBmoto(res.balance ?? 0n)}`);
}

// ── 12. Check Rebaser state ─────────────────────────────────────────────────
console.log('\n=== Step 12: Rebaser state ===');
{
    const res = await view('Rebaser.isRebaseEnabled', rebaserAddr, RebaserAbi, 'isRebaseEnabled');
    console.log(`  isRebaseEnabled: ${res.enabled}`);
    console.log('  (expect false — rebase unlocks after 4 weeks or 97% distributed)');
}

// ── 13. Withdraw test ───────────────────────────────────────────────────────
console.log('\n=== Step 13: Partial withdraw from Pool1[0] ===');
await interact('Pool1.withdraw(pool=0, 50 LP)', pool1Addr, Pool1Abi, 'withdraw', 0, 50n * 100_000_000n);
{
    const lp0 = await view('mockLp0.balanceOf(deployer)', mockLp0, MockLpAbi, 'balanceOf', wallet.address);
    console.log(`  mockLp0 balance after withdraw: ${Number(lp0.balance ?? 0n) / 1e8}`);
}

// ── 14. Pool1 halve — mine 288+ blocks past farmStart to trigger epoch end ──
console.log('\n=== Step 14: halve() test (requires 288 blocks past epoch start) ===');
console.log('  Pool1 epoch duration: 288 blocks. Pool2 epoch duration: 432 blocks.');
console.log('  To test halving, mine enough blocks past the farm start block, then call:');
console.log('    for i in $(seq 1 288); do bitcoin-cli -regtest generatetoaddress 1 $(bitcoin-cli -regtest getnewaddress); done');
console.log('  Then uncomment the halve() call below and re-run this script.');
// await interact('Pool1.halve()', pool1Addr, Pool1Abi, 'halve');
// await interact('Pool2.halve()', pool2Addr, Pool2Abi, 'halve');

console.log('\n=== DONE ===');
await provider.close();
