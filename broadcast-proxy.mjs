/**
 * Tiny broadcast proxy for regtest.
 * Accepts POST { raw: string } and forwards to bitcoin-cli sendrawtransaction.
 * Needed because the OPNet node's mempool thread fails to start on regtest.
 */
import { createServer } from 'http';
import { execSync } from 'child_process';

const PORT = 9002;

createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
        try {
            const { raw } = JSON.parse(body);
            if (!raw || typeof raw !== 'string') throw new Error('Missing or invalid raw field');
            const txid = execSync(`bitcoin-cli -regtest sendrawtransaction ${raw}`, { encoding: 'utf8' }).trim();
            // Auto-mine a block so UTXOs confirm and the next tx doesn't conflict
            try {
                execSync(`bitcoin-cli -regtest generatetoaddress 1 bcrt1p3w6y8zzsxm7ugvweafrwmus7aleynnrhaaf2wfea49c0mtwz5wdqgvgw4l`, { encoding: 'utf8' });
            } catch (mineErr) {
                console.warn('Auto-mine failed (non-fatal):', mineErr instanceof Error ? mineErr.message : String(mineErr));
            }
            // Refund wallet with a fresh spendable UTXO so OPWallet always has funds for the next tx
            try {
                execSync(`bitcoin-cli -regtest sendtoaddress bcrt1p3w6y8zzsxm7ugvweafrwmus7aleynnrhaaf2wfea49c0mtwz5wdqgvgw4l 0.01`, { encoding: 'utf8' });
                execSync(`bitcoin-cli -regtest generatetoaddress 1 bcrt1p3w6y8zzsxm7ugvweafrwmus7aleynnrhaaf2wfea49c0mtwz5wdqgvgw4l`, { encoding: 'utf8' });
            } catch (refundErr) {
                console.warn('Auto-refund failed (non-fatal):', refundErr instanceof Error ? refundErr.message : String(refundErr));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: txid }));
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
        }
    });
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Broadcast proxy listening on port ${PORT}`);
});
