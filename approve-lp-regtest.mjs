/**
 * Approve Pool1 to transfer LP tokens on behalf of the deployer wallet.
 * Run this once per deployment so the frontend deposit works.
 *
 * OPWallet's signInteraction uses the broken OPNet relay on regtest and the
 * approve tx never lands on-chain. Since the deployer mnemonic/LEVEL2 =
 * the same address as OPWallet, we can approve from the backend so Pool1
 * can call transferFrom when the user deposits via the frontend.
 *
 * Usage:
 *   node approve-lp-regtest.mjs
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import {
    Mnemonic,
    AddressTypes,
    MLDSASecurityLevel,
} from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

const RPC_URL = 'http://localhost:9001/api/v1/json-rpc';
const NETWORK  = networks.regtest;

process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }

const dep = JSON.parse(readFileSync('./deployment.json', 'utf8'));

const MAX_U256 = (1n << 256n) - 1n;

function mineBlock() {
    execSync(
        "bitcoin-cli -regtest generatetoaddress 1 $(bitcoin-cli -regtest getnewaddress)",
        { stdio: 'inherit' },
    );
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getSpendableUtxos(address, excludeTxids = new Set()) {
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

const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
const mnemonic  = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet    = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);

console.log('Wallet P2TR:', wallet.p2tr);
console.log('');

const pool1Obj = await provider.getPublicKeyInfo(dep.pool1Addr, true);
const pool2Obj = await provider.getPublicKeyInfo(dep.pool2Addr, true);
console.log('Pool1 address obj:', pool1Obj.toHex?.() ?? pool1Obj.toString());
console.log('Pool2 address obj:', pool2Obj.toHex?.() ?? pool2Obj.toString());
console.log('');

const spentTxids = new Set();

async function approveLP(label, lpAddress, spenderObj) {
    console.log(`  → Approving ${label} → spender`);

    // Check current allowance first
    const lp = getContract(lpAddress, OP_20_ABI, provider, NETWORK, wallet.address);
    const currentAllowance = await lp.allowance(wallet.address, spenderObj).catch(() => null);
    const remaining = currentAllowance?.properties?.remaining ?? 0n;
    if (remaining === MAX_U256 || remaining >= 100_000_000_000n) {
        console.log(`  ✓ Already approved (remaining: ${remaining})`);
        return;
    }

    const utxos = await getSpendableUtxos(wallet.p2tr, spentTxids);
    for (const u of utxos) spentTxids.add(u.transactionId);

    const sim = await lp.increaseAllowance(spenderObj, MAX_U256);
    if ('error' in sim) throw new Error(`Simulation failed: ${JSON.stringify(sim.error)}`);

    const signed = await sim.signTransaction({
        signer:                      wallet.keypair,
        mldsaSigner:                 wallet.mldsaKeypair,
        refundTo:                    wallet.p2tr,
        network:                     NETWORK,
        maximumAllowedSatToSpend:    100_000n,
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
    console.log(`  ✓ ${label} approved — txid: ${txid}`);
    mineBlock();
    await sleep(2000);
}

console.log('=== Approving LP tokens for Pool1 ===\n');
await approveLP('mockLp0 (PILL/MOTO) → Pool1', dep.mockLp0, pool1Obj);
await approveLP('mockLp1 (PEPE/MOTO) → Pool1', dep.mockLp1, pool1Obj);
await approveLP('mockLp2 (UNGA/MOTO) → Pool1', dep.mockLp2, pool1Obj);

console.log('\n=== Approving LP tokens for Pool2 ===\n');
await approveLP('mockLp0 (BMOTO/MOTO) → Pool2', dep.mockLp0, pool2Obj);

// Verify
console.log('\n=== Verifying allowances ===\n');
for (const [label, lpAddr, spenderObj] of [
    ['LP0→Pool1', dep.mockLp0, pool1Obj],
    ['LP1→Pool1', dep.mockLp1, pool1Obj],
    ['LP2→Pool1', dep.mockLp2, pool1Obj],
    ['LP0→Pool2', dep.mockLp0, pool2Obj],
]) {
    const lp = getContract(lpAddr, OP_20_ABI, provider, NETWORK, wallet.address);
    const r = await lp.allowance(wallet.address, spenderObj).catch(e => ({ error: e.message }));
    const rem = r.error ?? r.properties?.remaining;
    const ok = typeof rem === 'bigint' && rem > 0n;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${rem}`);
}

await provider.close();
console.log('\nDone. Pool1 and Pool2 can now pull LP tokens via transferFrom.');
console.log('Try deposit in the frontend.');
