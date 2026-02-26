import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------
export type TWAPSampledEvent = {
    readonly spotPrice: bigint;
    readonly sampleCount: bigint;
};
export type RebaseExecutedEvent = {
    readonly epoch: bigint;
    readonly twapPrice: bigint;
    readonly supplyDelta: bigint;
    readonly isExpansion: boolean;
};

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the setContracts function call.
 */
export type SetContracts = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the updateTWAP function call.
 */
export type UpdateTWAP = CallResult<{}, OPNetEvent<TWAPSampledEvent>[]>;

/**
 * @description Represents the result of the rebase function call.
 */
export type Rebase = CallResult<{}, OPNetEvent<RebaseExecutedEvent>[]>;

/**
 * @description Represents the result of the isRebaseEnabled function call.
 */
export type IsRebaseEnabled = CallResult<
    {
        enabled: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getTWAPInfo function call.
 */
export type GetTWAPInfo = CallResult<
    {
        twapPrice: bigint;
        sampleCount: bigint;
        lastSampleBlock: bigint;
        lastRebaseBlock: bigint;
        currentBlock: bigint;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IRebaser
// ------------------------------------------------------------------
export interface IRebaser extends IOP_NETContract {
    setContracts(
        bmoto: Address,
        pool1: Address,
        pool2: Address,
        bmotoMotoPair: Address,
        pool1LaunchBlock: bigint,
        bmotoIsToken0: boolean,
    ): Promise<SetContracts>;
    updateTWAP(): Promise<UpdateTWAP>;
    rebase(): Promise<Rebase>;
    isRebaseEnabled(): Promise<IsRebaseEnabled>;
    getTWAPInfo(): Promise<GetTWAPInfo>;
}
