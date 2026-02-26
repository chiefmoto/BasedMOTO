import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI, OP_20_ABI, BitcoinInterfaceAbi } from 'opnet';

export { OP_20_ABI };

// Cast needed because TypeScript widens BitcoinAbiTypes.Function to BitcoinAbiTypes
// in array literals — the cast is safe since all entries have the correct runtime values.
function abi(...entries: object[]): BitcoinInterfaceAbi {
    return entries as unknown as BitcoinInterfaceAbi;
}

export const BMOTOTokenAbi: BitcoinInterfaceAbi = abi(
    ...OP_NET_ABI,
    ...OP_20_ABI,
    {
        name: 'getGonsPerFragment',
        inputs: [],
        outputs: [{ name: 'gonsPerFragment', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
);

export const Pool1Abi: BitcoinInterfaceAbi = abi(
    ...OP_NET_ABI,
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
        name: 'pendingStored',
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'user',   type: ABIDataTypes.ADDRESS },
        ],
        outputs: [{ name: 'committed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getUserStake',
        inputs: [
            { name: 'poolId', type: ABIDataTypes.UINT8 },
            { name: 'user',   type: ABIDataTypes.ADDRESS },
        ],
        outputs: [{ name: 'stake', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTotalDistributed',
        inputs: [],
        outputs: [{ name: 'totalDistributed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
);

export const Pool2Abi: BitcoinInterfaceAbi = abi(
    ...OP_NET_ABI,
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
        name: 'pendingStored',
        inputs: [{ name: 'user', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'committed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getUserStake',
        inputs: [{ name: 'user', type: ABIDataTypes.ADDRESS }],
        outputs: [{ name: 'stake', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTotalDistributed',
        inputs: [],
        outputs: [{ name: 'totalDistributed', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
);

export const RebaserAbi: BitcoinInterfaceAbi = abi(
    ...OP_NET_ABI,
    {
        name: 'isRebaseEnabled',
        inputs: [],
        outputs: [{ name: 'enabled', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'rebase',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
);
