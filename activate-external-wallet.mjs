/**
 * activate-external-wallet.mjs
 * Activates an external wallet (non-deployer mnemonic) by:
 *   1. Registering its ML-DSA key on-chain (linkMLDSAPublicKeyToAddress: true)
 *   2. Setting MAX_U256 LP allowances for all pool pairs
 *
 * Usage: node activate-external-wallet.mjs "<mnemonic>"
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
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
const MAX_U256 = 2n ** 256n - 1n;

const mnemonic = process.argv[2];
if (!mnemonic) {
    console.error('Usage: node activate-external-wallet.mjs "<mnemonic>"');
    process.exit(1);
}

const dep = JSON.parse(readFileSync('./deployment.json', 'utf8'));
const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });

const m = new Mnemonic(mnemonic, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet = m.deriveOPWallet(AddressTypes.P2TR, 0);

console.log('Wallet P2TR:', wallet.p2tr);

// Register this wallet in wallets.json so the sign proxy can sign for it
function registerWallet(p2tr, mnemonicPhrase) {
    const path = './wallets.json';
    const entries = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    if (entries[p2tr] !== mnemonicPhrase) {
        entries[p2tr] = mnemonicPhrase;
        writeFileSync(path, JSON.stringify(entries, null, 2) + '\n');
        console.log('Registered in wallets.json');
    }
}

registerWallet(wallet.p2tr, mnemonic);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function mineBlock() {
    execSync(
        `bitcoin-cli -regtest generatetoaddress 1 bcrt1p3w6y8zzsxm7ugvweafrwmus7aleynnrhaaf2wfea49c0mtwz5wdqgvgw4l`,
        { encoding: 'utf8' },
    );
}

function getSpendableUtxos(address) {
    const scan = JSON.parse(
        execSync(`bitcoin-cli -regtest scantxoutset start '["addr(${address})"]'`, { encoding: 'utf8' }),
    );
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
    return utxos;
}

async function signAndBroadcast(sim, linkMLDSA) {
    const utxos = getSpendableUtxos(wallet.p2tr);
    if (utxos.length === 0) throw new Error(`No spendable UTXOs for ${wallet.p2tr}`);

    const customProvider = {
        network: NETWORK,
        utxoManager: {
            getUTXOsForAmount: async () => utxos,
            spentUTXO: () => {},
            clean: () => {},
        },
        getChallenge: () => provider.getChallenge(),
        sendRawTransaction: async () => { throw new Error('use signTransaction'); },
        getCSV1ForAddress: () => undefined,
    };

    const { CallResult } = await import('opnet');
    const cr = new CallResult(
        { result: new Uint8Array(0), accessList: {}, events: {} },
        customProvider,
    );
    cr.setCalldata(sim.calldata);
    cr.to = sim.to;
    cr.address = sim.address;
    cr.estimatedSatGas = sim.estimatedSatGas;

    const signed = await cr.signTransaction({
        signer: wallet.keypair,
        mldsaSigner: wallet.mldsaKeypair,
        refundTo: wallet.p2tr,
        network: NETWORK,
        maximumAllowedSatToSpend: 100_000n,
        linkMLDSAPublicKeyToAddress: linkMLDSA,
        utxos,
    });

    if (signed.fundingTransactionRaw) {
        execSync(
            `bitcoin-cli -regtest sendrawtransaction ${signed.fundingTransactionRaw}`,
            { encoding: 'utf8' },
        );
        mineBlock();
        await sleep(800);
    }

    const txid = execSync(
        `bitcoin-cli -regtest sendrawtransaction ${signed.interactionTransactionRaw}`,
        { encoding: 'utf8' },
    ).trim();
    mineBlock();
    await sleep(1500);
    return txid;
}

async function main() {
    const [pool1Obj, pool2Obj] = await Promise.all([
        provider.getPublicKeyInfo(dep.pool1Addr, true),
        provider.getPublicKeyInfo(dep.pool2Addr, true),
    ]);

    const approvals = [
        { lpAddr: dep.mockLp0, spenderObj: pool1Obj, label: 'LP0→Pool1' },
        { lpAddr: dep.mockLp1, spenderObj: pool1Obj, label: 'LP1→Pool1' },
        { lpAddr: dep.mockLp2, spenderObj: pool1Obj, label: 'LP2→Pool1' },
        { lpAddr: dep.mockLp0, spenderObj: pool2Obj, label: 'LP0→Pool2' },
    ];

    let isFirst = true;
    for (const { lpAddr, spenderObj, label } of approvals) {
        const lp = getContract(lpAddr, OP_20_ABI, provider, NETWORK, wallet.address);
        const sim = await lp.increaseAllowance(spenderObj, MAX_U256);
        if ('error' in sim) {
            console.warn(`  ✗ Simulation failed for ${label}:`, sim.error);
            continue;
        }
        process.stdout.write(`  → ${label}... `);
        const txid = await signAndBroadcast(sim, isFirst);
        isFirst = false;
        console.log(`✓ ${txid.slice(0, 16)}...`);
    }

    console.log('\nDone. Wallet is activated and all LP allowances are set.');
}

main().catch(err => { console.error(err); process.exit(1); });
