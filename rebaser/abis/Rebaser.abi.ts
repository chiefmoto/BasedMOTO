import { ABIDataTypes, BitcoinAbiTypes, OP_NET_ABI } from 'opnet';

export const RebaserEvents = [
    {
        name: 'TWAPSampled',
        values: [
            { name: 'spotPrice', type: ABIDataTypes.UINT256 },
            { name: 'sampleCount', type: ABIDataTypes.UINT256 },
        ],
        type: BitcoinAbiTypes.Event,
    },
    {
        name: 'RebaseExecuted',
        values: [
            { name: 'epoch', type: ABIDataTypes.UINT256 },
            { name: 'twapPrice', type: ABIDataTypes.UINT256 },
            { name: 'supplyDelta', type: ABIDataTypes.UINT256 },
            { name: 'isExpansion', type: ABIDataTypes.BOOL },
        ],
        type: BitcoinAbiTypes.Event,
    },
];

export const RebaserAbi = [
    {
        name: 'setContracts',
        inputs: [
            { name: 'bmoto', type: ABIDataTypes.ADDRESS },
            { name: 'pool1', type: ABIDataTypes.ADDRESS },
            { name: 'pool2', type: ABIDataTypes.ADDRESS },
            { name: 'bmotoMotoPair', type: ABIDataTypes.ADDRESS },
            { name: 'pool1LaunchBlock', type: ABIDataTypes.UINT64 },
            { name: 'bmotoIsToken0', type: ABIDataTypes.BOOL },
        ],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'updateTWAP',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'rebase',
        inputs: [],
        outputs: [],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'isRebaseEnabled',
        constant: true,
        inputs: [],
        outputs: [{ name: 'enabled', type: ABIDataTypes.BOOL }],
        type: BitcoinAbiTypes.Function,
    },
    {
        name: 'getTWAPInfo',
        constant: true,
        inputs: [],
        outputs: [
            { name: 'twapPrice', type: ABIDataTypes.UINT256 },
            { name: 'sampleCount', type: ABIDataTypes.UINT256 },
            { name: 'lastSampleBlock', type: ABIDataTypes.UINT64 },
            { name: 'lastRebaseBlock', type: ABIDataTypes.UINT64 },
            { name: 'currentBlock', type: ABIDataTypes.UINT64 },
        ],
        type: BitcoinAbiTypes.Function,
    },
    ...RebaserEvents,
    ...OP_NET_ABI,
];

export default RebaserAbi;
