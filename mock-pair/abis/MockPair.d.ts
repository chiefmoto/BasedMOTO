import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the setReserves function call.
 */
export type SetReserves = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the getReserves function call.
 */
export type GetReserves = CallResult<
    {
        blockTimestampLast: bigint;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IMockPair
// ------------------------------------------------------------------
export interface IMockPair extends IOP_NETContract {
    setReserves(reserve0: bigint, reserve1: bigint): Promise<SetReserves>;
    getReserves(): Promise<GetReserves>;
}
