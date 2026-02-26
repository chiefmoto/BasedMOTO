// Quick stake checker — reads Pool1 getUserStake for all 3 sub-pools
import { JSONRpcProvider, getContract, ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';
import { Mnemonic, AddressTypes, MLDSASecurityLevel } from '@btc-vision/transaction';
import { networks } from '@btc-vision/bitcoin';

process.loadEnvFile();
const MNEMONIC = process.env.DEPLOYER_MNEMONIC;
if (!MNEMONIC) { console.error('Error: DEPLOYER_MNEMONIC not set in .env'); process.exit(1); }
const RPC_URL = 'http://localhost:9001/api/v1/json-rpc';
const NETWORK = networks.regtest;
const POOL1 = 'opr1sqrhhs4vj5wp9tu4qnsnnwmqauf4t605q2ys93vsn';

const Pool1Abi = [
    ...OP_NET_ABI,
    { name: 'getUserStake', inputs: [{ name: 'poolId', type: ABIDataTypes.UINT8 }, { name: 'user', type: ABIDataTypes.ADDRESS }], outputs: [{ name: 'stake', type: ABIDataTypes.UINT256 }], type: BitcoinAbiTypes.Function },
    { name: 'pending', inputs: [{ name: 'poolId', type: ABIDataTypes.UINT8 }, { name: 'user', type: ABIDataTypes.ADDRESS }], outputs: [{ name: 'pending', type: ABIDataTypes.UINT256 }], type: BitcoinAbiTypes.Function },
];

const provider = new JSONRpcProvider({ url: RPC_URL, network: NETWORK });
const mnemonic = new Mnemonic(MNEMONIC, '', NETWORK, MLDSASecurityLevel.LEVEL2);
const wallet = mnemonic.deriveOPWallet(AddressTypes.P2TR, 0);
console.log('Wallet:', wallet.p2tr);

const pool = getContract(POOL1, Pool1Abi, provider, NETWORK, wallet.address);
for (let i = 0; i < 3; i++) {
    try {
        const s = await pool.getUserStake(i, wallet.address);
        const p = await pool.pending(i, wallet.address);
        const stake = s.properties?.stake ?? 0n;
        const pend  = p.properties?.pending ?? 0n;
        console.log(`Sub-pool ${i}: stake=${Number(stake)/1e8} LP, pending=${Number(pend)/1e8} BMOTO`);
    } catch(e) { console.log(`Sub-pool ${i}: error - ${e.message}`); }
}
