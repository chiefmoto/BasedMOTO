import { JSONRpcProvider, getContract, OP_20_ABI } from 'opnet';
import { networks } from '@btc-vision/bitcoin';

const provider = new JSONRpcProvider({ url: 'http://127.0.0.1:9001', network: networks.regtest });

const LP0  = 'opr1sqzj54jdfvwjh9ah784qkutn4xwkek6g64g0ucstj';
const POOL1 = 'opr1sqqsvj9qwplf5cwqs7kljnh458cs95330nya6sv8h';
const USER_P2TR = 'bcrt1p3w6y8zzsxm7ugvweafrwmus7aleynnrhaaf2wfea49c0mtwz5wdqgvgw4l';

const userAddr  = await provider.getPublicKeyInfo(USER_P2TR, false);
const pool1Addr = await provider.getPublicKeyInfo(POOL1, true);

console.log('user  address bytes:', Buffer.from(userAddr.p2op).toString('hex'));
console.log('pool1 address bytes:', Buffer.from(pool1Addr.p2op).toString('hex'));

const lp = getContract(LP0, OP_20_ABI, provider, networks.regtest, userAddr);
const res = await lp.allowance(userAddr, pool1Addr);
console.log('allowance[user][pool1]:', res.properties);
