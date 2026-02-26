import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const Pool1Events = [
    {
        name: 'Deposited',
        values: [
            { name: 'poolId', type: ABIDataTypes.UINT256 },
            { name: 'user', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
    {
        name: 'Withdrawn',
        values: [
            { name: 'poolId', type: ABIDataTypes.UINT256 },
            { name: 'user', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
    {
        name: 'Harvested',
        values: [
            { name: 'poolId', type: ABIDataTypes.UINT256 },
            { name: 'user', type: ABIDataTypes.ADDRESS },
            { name: 'amount', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
    {
        name: 'Halved',
        values: [
            { name: 'epoch', type: ABIDataTypes.UINT256 },
            { name: 'newRate', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
];

export const Pool1Abi = [
    {
        name: 'initialize',
        inputs: [
            { name: 'bmoto', type: ABIDataTypes.ADDRESS },
            { name: 'lp0', type: ABIDataTypes.ADDRESS },
            { name: 'lp1', type: ABIDataTypes.ADDRESS },
            { name: 'lp2', type: ABIDataTypes.ADDRESS },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setFarmStart',
        inputs: [{ name: 'startBlock', type: ABIDataTypes.UINT256 }],
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
        name: 'emergencyWithdraw',
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
        constant: true,
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'user', type: ABIDataTypes.ADDRESS },
        ],
        outputs: [{ name: 'pending', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'pendingStored',
        constant: true,
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'user', type: ABIDataTypes.ADDRESS },
        ],
        outputs: [{ name: 'committed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getUserStake',
        constant: true,
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'user', type: ABIDataTypes.ADDRESS },
        ],
        outputs: [{ name: 'stake', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTotalDistributed',
        constant: true,
        inputs: [],
        outputs: [{ name: 'totalDistributed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'remainingRewards',
        constant: true,
        inputs: [],
        outputs: [{ name: 'remaining', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'epochInfo',
        constant: true,
        inputs: [],
        outputs: [
            { name: 'epoch', type: ABIDataTypes.UINT256 },
            { name: 'rate', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getFarmStartBlock',
        constant: true,
        inputs: [],
        outputs: [{ name: 'startBlock', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    ...Pool1Events,
    ...OP_NET_ABI,
];

export default Pool1Abi;
