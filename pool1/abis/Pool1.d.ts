import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------
export type DepositedEvent = {
    readonly poolId: bigint;
    readonly user: Address;
    readonly amount: bigint;
};
export type WithdrawnEvent = {
    readonly poolId: bigint;
    readonly user: Address;
    readonly amount: bigint;
};
export type HarvestedEvent = {
    readonly poolId: bigint;
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
 * @description Represents the result of the remainingRewards function call.
 */
export type RemainingRewards = CallResult<
    {
        remaining: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the epochInfo function call.
 */
export type EpochInfo = CallResult<
    {
        epoch: bigint;
        rate: bigint;
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
// IPool1
// ------------------------------------------------------------------
export interface IPool1 extends IOP_NETContract {
    initialize(bmoto: Address, lp0: Address, lp1: Address, lp2: Address): Promise<Initialize>;
    setFarmStart(startBlock: bigint): Promise<SetFarmStart>;
    deposit(poolId: number, amount: bigint): Promise<Deposit>;
    withdraw(poolId: number, amount: bigint): Promise<Withdraw>;
    emergencyWithdraw(poolId: number, amount: bigint): Promise<EmergencyWithdraw>;
    harvest(poolId: number): Promise<Harvest>;
    halve(): Promise<Halve>;
    pending(poolId: number, user: Address): Promise<Pending>;
    pendingStored(poolId: number, user: Address): Promise<PendingStored>;
    getUserStake(poolId: number, user: Address): Promise<GetUserStake>;
    getTotalDistributed(): Promise<GetTotalDistributed>;
    remainingRewards(): Promise<RemainingRewards>;
    epochInfo(): Promise<EpochInfo>;
    getFarmStartBlock(): Promise<GetFarmStartBlock>;
}
