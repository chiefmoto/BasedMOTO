/**
 * Mint mock LP tokens to the deployer/OPWallet address for frontend testing.
 *
 * Mints 1000 of each LP token (mockLp0, mockLp1, mockLp2) to wallet.address.
 * Run this after deploy-regtest.mjs, then use the frontend to approve/stake.
 *
 * Usage:
 *   node mint-lp-regtest.mjs
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

const RPC_URL = 'http://localhost:9001/api/v1/json-rpc';
const NETWORK  = networks.regtest;

process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }

const dep = JSON.parse(readFileSync('./deployment.json', 'utf8'));
const { mockLp0, mockLp1, mockLp2 } = dep;

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

console.log('Wallet P2TR :', wallet.p2tr);
console.log('');

const spentTxids = new Set();

async function mint(label, lpAddress) {
    console.log(`  → ${label}`);
    const utxos = await getSpendableUtxos(wallet.p2tr, spentTxids);
    for (const u of utxos) spentTxids.add(u.transactionId);

    const contract = getContract(lpAddress, MockLpAbi, provider, NETWORK, wallet.address);
    const sim = await contract.mint(wallet.address, 1_000n * 100_000_000n);
    if ('error' in sim) throw new Error(`Simulation failed: ${JSON.stringify(sim.error)}`);

    const signed = await sim.signTransaction({
        signer:                    wallet.keypair,
        mldsaSigner:               wallet.mldsaKeypair,
        refundTo:                  wallet.p2tr,
        network:                   NETWORK,
        maximumAllowedSatToSpend:  100_000n,
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

console.log('=== Minting mock LP tokens for frontend testing ===\n');
await mint('Mint 1000 mockLp0 (PILL/MOTO) to wallet', mockLp0);
await mint('Mint 1000 mockLp1 (PEPE/MOTO) to wallet', mockLp1);
await mint('Mint 1000 mockLp2 (UNGA/MOTO) to wallet', mockLp2);

console.log('\n=== Done ===');
console.log('Your wallet now has 1000 of each LP token.');
console.log('Open the frontend, connect OPWallet, and test approve → deposit → harvest.');
console.log(`  Pool1 LP tokens: ${mockLp0}, ${mockLp1}, ${mockLp2}`);
console.log(`  Pool2 LP token:  ${mockLp0} (same as PILL/MOTO mock)`);

await provider.close();
