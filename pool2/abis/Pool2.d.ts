import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------
export type DepositedEvent = {
    readonly user: Address;
    readonly amount: bigint;
};
export type WithdrawnEvent = {
    readonly user: Address;
    readonly amount: bigint;
};
export type HarvestedEvent = {
    readonly user: Address;
    readonly amount: bigint;
};
export type HalvedEvent = {
    readonly epoch: bigint;
    readonly newRate: bigint;
};

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the initialize function call.
 */
export type Initialize = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the setFarmStart function call.
 */
export type SetFarmStart = CallResult<{}, OPNetEvent<never>[]>;

/**
 * @description Represents the result of the deposit function call.
 */
export type Deposit = CallResult<{}, OPNetEvent<DepositedEvent>[]>;

/**
 * @description Represents the result of the withdraw function call.
 */
export type Withdraw = CallResult<{}, OPNetEvent<WithdrawnEvent>[]>;

/**
 * @description Represents the result of the emergencyWithdraw function call.
 */
export type EmergencyWithdraw = CallResult<{}, OPNetEvent<WithdrawnEvent>[]>;

/**
 * @description Represents the result of the harvest function call.
 */
export type Harvest = CallResult<{}, OPNetEvent<HarvestedEvent>[]>;

/**
 * @description Represents the result of the halve function call.
 */
export type Halve = CallResult<{}, OPNetEvent<HalvedEvent>[]>;

/**
 * @description Represents the result of the pending function call.
 */
export type Pending = CallResult<
    {
        pending: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the pendingStored function call.
 */
export type PendingStored = CallResult<
    {
        committed: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getUserStake function call.
 */
export type GetUserStake = CallResult<
    {
        stake: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getTotalDistributed function call.
 */
export type GetTotalDistributed = CallResult<
    {
        totalDistributed: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the getFarmStartBlock function call.
 */
export type GetFarmStartBlock = CallResult<
    {
        startBlock: bigint;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// IPool2
// ------------------------------------------------------------------
export interface IPool2 extends IOP_NETContract {
    initialize(bmoto: Address, lp: Address): Promise<Initialize>;
    setFarmStart(startBlock: bigint): Promise<SetFarmStart>;
    deposit(amount: bigint): Promise<Deposit>;
    withdraw(amount: bigint): Promise<Withdraw>;
    emergencyWithdraw(amount: bigint): Promise<EmergencyWithdraw>;
    harvest(): Promise<Harvest>;
    halve(): Promise<Halve>;
    pending(user: Address): Promise<Pending>;
    pendingStored(user: Address): Promise<PendingStored>;
    getUserStake(user: Address): Promise<GetUserStake>;
    getTotalDistributed(): Promise<GetTotalDistributed>;
    getFarmStartBlock(): Promise<GetFarmStartBlock>;
}
