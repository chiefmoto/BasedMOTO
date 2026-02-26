import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------
export type RebaseEvent = {
    readonly epoch: bigint;
    readonly newSupply: bigint;
};

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the rebase function call.
 */
export type Rebase = CallResult<{}, OPNetEvent<RebaseEvent>[]>;

/**
 * @description Represents the result of the setRebaseContract function call.
 */
export type SetRebaseContract = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the getGonsPerFragment function call.
 */
export type GetGonsPerFragment = CallResult<
    {
        gonsPerFragment: bigint;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IBMOTOToken
// ------------------------------------------------------------------
export interface IBMOTOToken extends IOP_NETContract {
    rebase(supplyDelta: bigint, isExpansion: boolean): Promise<Rebase>;
    setRebaseContract(addr: Address): Promise<SetRebaseContract>;
    getGonsPerFragment(): Promise<GetGonsPerFragment>;
}
