/**
 * fund-user.mjs — Mint mock LP tokens to a user address and check their state.
 *
 * Usage:
 *   node fund-user.mjs <p2tr-address>
 *
 * Example:
 *   node fund-user.mjs bcrt1pxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import {
    TransactionFactory,
    Mnemonic,
    AddressTypes,
    MLDSASecurityLevel,
    Address,
} from '@btc-vision/transaction';
import { networks, address as btcAddress } from '@btc-vision/bitcoin';
import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RPC_URL  = 'http://localhost:9001/api/v1/json-rpc';
const NETWORK  = networks.regtest;
const FEE_RATE = 10;

process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }

// ---------------------------------------------------------------------------
// Parse target address from argv
// ---------------------------------------------------------------------------
const targetAddr = process.argv[2];
if (!targetAddr) {
    console.error('Usage: node fund-user.mjs <p2tr-address>');
    console.error('Example: node fund-user.mjs bcrt1p...');
    process.exit(1);
}
console.log(`Target address: ${targetAddr}`);

// ---------------------------------------------------------------------------
// Load deployment
// ---------------------------------------------------------------------------
const dep = JSON.parse(readFileSync('./deployment.json', 'utf8'));
const { pool1Addr, pool2Addr, mockLp0, mockLp1, mockLp2 } = dep;

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

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const spentTxids = new Set();

async function getSpendableUtxos(address) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const scan = JSON.parse(execSync(
            `bitcoin-cli -regtest scantxoutset start '["addr(${address})"]'`,
            { encoding: 'utf8' },
        ));
        const utxos = [];
        for (const u of scan.unspents) {
            if (spentTxids.has(u.txid)) continue;
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
const mnemonic = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet   = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);

const deployerAddr = wallet.p2tr;
console.log(`Deployer: ${deployerAddr}`);
console.log('');

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

// ---------------------------------------------------------------------------
// Interaction helper
// ---------------------------------------------------------------------------
async function interact(label, contractAddress, abi, methodName, ...args) {
    console.log(`  → ${label}`);

    const utxos = await getSpendableUtxos(deployerAddr);
    for (const u of utxos) spentTxids.add(u.transactionId);
    if (utxos.length === 0) throw new Error('No spendable UTXOs — fund the deployer first');

    const contract = getContract(contractAddress, abi, provider, NETWORK, wallet.address);
    const simulation = await contract[methodName](...args);
    if ('error' in simulation) {
        throw new Error(`Simulation failed for ${methodName}: ${JSON.stringify(simulation.error)}`);
    }

    const signed = await simulation.signTransaction({
        signer:                     wallet.keypair,
        mldsaSigner:                wallet.mldsaKeypair,
        refundTo:                   wallet.p2tr,
        network:                    NETWORK,
        maximumAllowedSatToSpend:   100_000n,
        linkMLDSAPublicKeyToAddress: false,
        utxos,
    });

    if (signed.fundingTransactionRaw) {
        execSync(`bitcoin-cli -regtest sendrawtransaction ${signed.fundingTransactionRaw}`, { stdio: 'inherit' });
        mineBlock();
        await sleep(1000);
    }
    const txid = execSync(
        `bitcoin-cli -regtest sendrawtransaction ${signed.interactionTransactionRaw}`,
        { encoding: 'utf8' },
    ).trim();
    console.log(`  ✓ ${label} — txid: ${txid}`);
    mineBlock();
    await sleep(2000);
}

async function view(contractAddress, abi, methodName, ...args) {
    const contract = getContract(contractAddress, abi, provider, NETWORK, wallet.address);
    const result = await contract[methodName](...args);
    if ('error' in result) throw new Error(`View failed: ${result.error}`);
    return result.properties ?? result;
}

// ---------------------------------------------------------------------------
// Resolve target address to OPNet Address object
// ---------------------------------------------------------------------------
console.log('=== Resolving target address ===');
let targetAddressObj;
try {
    targetAddressObj = await provider.getPublicKeyInfo(targetAddr, false);
    console.log(`  Resolved via RPC: ${targetAddressObj.toHex()}`);
} catch (e) {
    console.warn(`  getPublicKeyInfo failed: ${e.message}`);
    // Decode the P2TR bech32m address directly:
    // For segwit v1 (Taproot), the witness program IS the 32-byte x-only tweaked pubkey.
    try {
        const decoded = btcAddress.fromBech32(targetAddr);
        if (decoded.version !== 1 || decoded.data.length !== 32) {
            throw new Error(`Not a P2TR address (version=${decoded.version}, dataLen=${decoded.data.length})`);
        }
        const tweakedXOnly = Buffer.from(decoded.data); // 32 bytes
        const tweakedCompressed = Buffer.concat([Buffer.from([0x02]), tweakedXOnly]); // 33 bytes
        targetAddressObj = new Address(tweakedXOnly, tweakedCompressed);
        console.log(`  Decoded from bech32m: ${targetAddressObj.toHex()}`);
    } catch (e2) {
        console.error(`  Failed to decode address: ${e2.message}`);
        targetAddressObj = null;
    }
}

// ---------------------------------------------------------------------------
// Check existing balances
// ---------------------------------------------------------------------------
console.log('\n=== Existing state ===');
if (targetAddressObj) {
    for (const [name, addr] of [['mockLp0', mockLp0], ['mockLp1', mockLp1], ['mockLp2', mockLp2]]) {
        try {
            const res = await view(addr, MockLpAbi, 'balanceOf', targetAddressObj);
            console.log(`  ${name} balance: ${Number(res.balance ?? 0n) / 1e8}`);
        } catch (e) {
            console.log(`  ${name} balance: (error: ${e.message})`);
        }
    }

    // Check allowance towards pool1
    try {
        const pool1Info = await provider.getPublicKeyInfo(pool1Addr, true);
        for (const [name, addr] of [['mockLp0', mockLp0], ['mockLp1', mockLp1], ['mockLp2', mockLp2]]) {
            const res = await view(addr, MockLpAbi, 'allowance', targetAddressObj, pool1Info);
            console.log(`  ${name} allowance(user→pool1): ${res.remaining ?? res.allowance ?? 0n}`);
        }
    } catch (e) {
        console.log(`  allowance check error: ${e.message}`);
    }
} else {
    console.log('  (cannot check — address not resolved)');
}

// ---------------------------------------------------------------------------
// Mint LP tokens to target
// ---------------------------------------------------------------------------
const LP_AMOUNT = 1_000n * 100_000_000n; // 1000 tokens (8 decimals)

if (!targetAddressObj) {
    console.error('Could not resolve target address — aborting.');
    process.exit(1);
}

console.log(`\n=== Minting 1000 LP tokens to ${targetAddr} ===`);
await interact('Mint 1000 mockLp0', mockLp0, MockLpAbi, 'mint', targetAddressObj, LP_AMOUNT);
await interact('Mint 1000 mockLp1', mockLp1, MockLpAbi, 'mint', targetAddressObj, LP_AMOUNT);
await interact('Mint 1000 mockLp2', mockLp2, MockLpAbi, 'mint', targetAddressObj, LP_AMOUNT);

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------
console.log('\n=== Verifying new balances ===');
try {
    const refreshed = await provider.getPublicKeyInfo(targetAddr, false);
    for (const [name, addr] of [['mockLp0', mockLp0], ['mockLp1', mockLp1], ['mockLp2', mockLp2]]) {
        const res = await view(addr, MockLpAbi, 'balanceOf', refreshed);
        console.log(`  ${name} balance: ${Number(res.balance ?? 0n) / 1e8}`);
    }
} catch (e) {
    console.log(`  Verification error: ${e.message}`);
}

console.log('\n=== Done ===');
console.log('Now go back to the frontend, Approve LP → Pool1, then Deposit.');
await provider.close();
