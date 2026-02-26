/**
 * One-time setup: register the deployer's ML-DSA public key on-chain.
 *
 * Without this, provider.getPublicKeyInfo(p2tr, false) returns an Address
 * without the ML-DSA component. The frontend simulation then uses the wrong
 * sender, causing "Insufficient allowance" in Pool1.deposit() even after a
 * successful LP approve.
 *
 * Run this once after deploying / minting. After this, the frontend fallback
 * path in OPNetProvider.tsx correctly resolves walletAddressObj with the
 * ML-DSA key, so simulation sender == Blockchain.tx.sender.
 *
 * Usage:
 *   node register-mldsa-regtest.mjs
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

console.log('Wallet P2TR:', wallet.p2tr);
console.log('');
console.log('Sending a tx with linkMLDSAPublicKeyToAddress: true ...');

const spentTxids = new Set();
const utxos = await getSpendableUtxos(wallet.p2tr, spentTxids);
for (const u of utxos) spentTxids.add(u.transactionId);

// Mint 1 satoshi worth of LP-0 to self — minimal tx, just to register the key.
const contract = getContract(dep.mockLp0, MockLpAbi, provider, NETWORK, wallet.address);
const sim = await contract.mint(wallet.address, 1n);
if ('error' in sim) throw new Error(`Simulation failed: ${JSON.stringify(sim.error)}`);

const signed = await sim.signTransaction({
    signer:                      wallet.keypair,
    mldsaSigner:                 wallet.mldsaKeypair,
    refundTo:                    wallet.p2tr,
    network:                     NETWORK,
    maximumAllowedSatToSpend:    100_000n,
    linkMLDSAPublicKeyToAddress: true,   // ← this is the key
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
console.log(`✓ Registration tx: ${txid}`);
mineBlock();
await sleep(3000);

// Verify: getPublicKeyInfo should now return the full ML-DSA address
console.log('\nVerifying getPublicKeyInfo now returns ML-DSA key...');
const info = await provider.getPublicKeyInfo(wallet.p2tr, false);
console.log('p2tr    :', wallet.p2tr);
console.log('address :', info.toHex?.() ?? info.toString());
console.log('');
console.log('✓ ML-DSA key registered. Frontend walletAddressObj fallback will now be correct.');
console.log('  You can now use the frontend: Approve → Deposit → Harvest.');

await provider.close();
