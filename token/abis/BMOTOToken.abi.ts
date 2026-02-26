import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const BMOTOTokenEvents = [
    {
        name: 'Rebase',
        values: [
            { name: 'epoch', type: ABIDataTypes.UINT256 },
            { name: 'newSupply', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
];

export const BMOTOTokenAbi = [
    {
        name: 'rebase',
        inputs: [
            { name: 'supplyDelta', type: ABIDataTypes.UINT256 },
            { name: 'isExpansion', type: ABIDataTypes.BOOL },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'setRebaseContract',
        inputs: [{ name: 'addr', type: ABIDataTypes.ADDRESS }],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getGonsPerFragment',
        constant: true,
        inputs: [],
        outputs: [{ name: 'gonsPerFragment', type: ABIDataTypes.UINT256 }],
        type: BitcoinAbiTypes.Function,
    },
    ...BMOTOTokenEvents,
    ...OP_NET_ABI,
];

export default BMOTOTokenAbi;
