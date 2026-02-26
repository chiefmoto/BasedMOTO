import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const MockPairEvents = [];

export const MockPairAbi = [
    {
        name: 'setReserves',
        inputs: [
            { name: 'reserve0', type: ABIDataTypes.UINT256 },
            { name: 'reserve1', type: ABIDataTypes.UINT256 },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getReserves',
        constant: true,
        inputs: [],
        outputs: [{ name: 'blockTimestampLast', type: ABIDataTypes.UINT64 }],
        type: BitcoinAbiTypes.Function,
    },
    ...MockPairEvents,
    ...OP_NET_ABI,
];

export default MockPairAbi;
