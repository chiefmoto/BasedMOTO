import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    AddressMemoryMap,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    ReentrancyGuard,
    ReentrancyLevel,
    Revert,
    SafeMath,
    StoredAddress,
    StoredU256,
    encodeSelector,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';
import { U256_BYTE_LENGTH, ADDRESS_BYTE_LENGTH, SELECTOR_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';

// ---------------------------------------------------------------------------
// Pool1 constants
// ---------------------------------------------------------------------------

/** Hard cap: pool can never distribute more than 250,000 BMOTO (= 250_000 × 10^8 base units). */
const TOTAL_REWARDS: u256 = u256.fromString('25000000000000'); // 250_000 × 10^8

/**
 * Epoch length in Bitcoin blocks. One halving per epoch.
 * 7 epochs × 288 blocks = 2016 blocks total (~14 days at 10 min/block).
 */
const EPOCH_DURATION: u64 = 288; // blocks per epoch

/**
 * Initial per-block reward rate (across all three sub-pools combined).
 * = floor(125_000 × 10^8 / 288) = floor(12_500_000_000_000 / 288) = 43_402_777_777 base-units/block
 *
 * With 70/15/15 weights:
 *   PILL/MOTO LP: 43_402_777_777 × 70% = 30_381_944_443 base-units/block
 *   PEPE/MOTO LP: 43_402_777_777 × 15% =  6_510_416_666 base-units/block
 *   UNGA/MOTO LP: 43_402_777_777 × 15% =  6_510_416_666 base-units/block
 */
const INITIAL_RATE: u256 = u256.fromString('43402777777'); // base units/block

/**
 * Maximum number of epochs. After 7 epochs (epochs 0–6) the rate is set to 0.
 * Any call to halve() when epoch >= MAX_EPOCHS is a silent no-op.
 */
const MAX_EPOCHS: u64 = 7;

// Sub-pool weights (must sum to 100)
// Testnet: only PILL/MOTO LP (pool 0) is active with 100% weight.
const WEIGHT_0: u256 = u256.fromU32(100); // PILL/MOTO LP — 100% on testnet
const WEIGHT_1: u256 = u256.fromU32(0);   // inactive
const WEIGHT_2: u256 = u256.fromU32(0);   // inactive
const WEIGHT_SUM: u256 = u256.fromU32(100);

// Reward-per-token precision multiplier
const PRECISION: u256 = u256.fromString('1000000000000000000'); // 10^18

// Cross-contract call selectors
const SELECTOR_TRANSFER: u32 = encodeSelector('transfer(address,uint256)');
const SELECTOR_TRANSFER_FROM: u32 = encodeSelector('transferFrom(address,address,uint256)');

// ---------------------------------------------------------------------------
// Module-level storage pointers
// ReentrancyGuard claims the first 2 pointers; Pool1 starts at 3.
// ---------------------------------------------------------------------------
const bmotoTokenP: u16 = Blockchain.nextPointer;
const rewardRateP: u16 = Blockchain.nextPointer;       // base units/block (combined)
const currentEpochP: u16 = Blockchain.nextPointer;     // u256
const epochStartBlockP: u16 = Blockchain.nextPointer;  // block number stored as u256
const totalDistributedP: u16 = Blockchain.nextPointer; // lifetime BMOTO paid out
const farmStartBlockP: u16 = Blockchain.nextPointer;   // block number at which farm activates

// Sub-pool 0 (PILL/MOTO LP)
const lpToken0P: u16 = Blockchain.nextPointer;
const totalStaked0P: u16 = Blockchain.nextPointer;
const rpt0P: u16 = Blockchain.nextPointer;             // rewardPerToken × PRECISION
const lastUpdate0P: u16 = Blockchain.nextPointer;
const userStake0P: u16 = Blockchain.nextPointer;
const userRptPaid0P: u16 = Blockchain.nextPointer;
const userRewards0P: u16 = Blockchain.nextPointer;

// Sub-pool 1 (PEPE/MOTO LP)
const lpToken1P: u16 = Blockchain.nextPointer;
const totalStaked1P: u16 = Blockchain.nextPointer;
const rpt1P: u16 = Blockchain.nextPointer;
const lastUpdate1P: u16 = Blockchain.nextPointer;
const userStake1P: u16 = Blockchain.nextPointer;
const userRptPaid1P: u16 = Blockchain.nextPointer;
const userRewards1P: u16 = Blockchain.nextPointer;

// Sub-pool 2 (UNGA/MOTO LP)
const lpToken2P: u16 = Blockchain.nextPointer;
const totalStaked2P: u16 = Blockchain.nextPointer;
const rpt2P: u16 = Blockchain.nextPointer;
const lastUpdate2P: u16 = Blockchain.nextPointer;
const userStake2P: u16 = Blockchain.nextPointer;
const userRptPaid2P: u16 = Blockchain.nextPointer;
const userRewards2P: u16 = Blockchain.nextPointer;

// ---------------------------------------------------------------------------
// Custom events
// ---------------------------------------------------------------------------

@final
class DepositedEvent extends NetEvent {
    constructor(poolId: u256, user: Address, amount: u256) {
        const data = new BytesWriter(U256_BYTE_LENGTH + ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeU256(poolId);
        data.writeAddress(user);
        data.writeU256(amount);
        super('Deposited', data);
    }
}

@final
class WithdrawnEvent extends NetEvent {
    constructor(poolId: u256, user: Address, amount: u256) {
        const data = new BytesWriter(U256_BYTE_LENGTH + ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeU256(poolId);
        data.writeAddress(user);
        data.writeU256(amount);
        super('Withdrawn', data);
    }
}

@final
class HarvestedEvent extends NetEvent {
    constructor(poolId: u256, user: Address, amount: u256) {
        const data = new BytesWriter(U256_BYTE_LENGTH + ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeU256(poolId);
        data.writeAddress(user);
        data.writeU256(amount);
        super('Harvested', data);
    }
}

@final
class HalvedEvent extends NetEvent {
    constructor(epoch: u256, newRate: u256) {
        const data = new BytesWriter(U256_BYTE_LENGTH * 2);
        data.writeU256(epoch);
        data.writeU256(newRate);
        super('Halved', data);
    }
}

// ---------------------------------------------------------------------------
// Pool1 — 250k BMOTO staking farm, 3 sub-pools, 7 block-based epochs
// ---------------------------------------------------------------------------

/**
 * Pool1 distributes up to 250,000 BMOTO across three LP sub-pools using a
 * Synthetix-style reward-per-token accumulator.
 *
 * Sub-pools:
 *   0 → PILL/MOTO LP (70% weight)
 *   1 → PEPE/MOTO LP (15% weight)
 *   2 → UNGA/MOTO LP (15% weight)
 *
 * Emission schedule (block-based halvings, 288 blocks each):
 *   Epoch 0 (blocks    0– 287) → ~125,000 BMOTO
 *   Epoch 1 (blocks  288– 575) → ~ 62,500 BMOTO
 *   Epoch 2 (blocks  576– 863) → ~ 31,250 BMOTO
 *   Epoch 3 (blocks  864–1151) → ~ 15,625 BMOTO
 *   Epoch 4 (blocks 1152–1439) → ~  7,813 BMOTO
 *   Epoch 5 (blocks 1440–1727) → ~  3,906 BMOTO
 *   Epoch 6 (blocks 1728–2015) → ~  1,953 BMOTO
 *   After block 2016: rate = 0, no further emission.
 *
 * Rewards are earned on a block-by-block basis (discrete, not continuous).
 * halve() is permissionless, callable once per epoch by anyone.
 */
@final
export class Pool1 extends ReentrancyGuard {
    protected override readonly reentrancyLevel: ReentrancyLevel = ReentrancyLevel.CALLBACK;

    // Global state
    protected readonly bmotoToken: StoredAddress = new StoredAddress(bmotoTokenP);
    protected readonly rewardRate: StoredU256 = new StoredU256(rewardRateP, EMPTY_POINTER);
    protected readonly currentEpoch: StoredU256 = new StoredU256(currentEpochP, EMPTY_POINTER);
    protected readonly epochStartBlock: StoredU256 = new StoredU256(epochStartBlockP, EMPTY_POINTER);
    protected readonly totalDistributed: StoredU256 = new StoredU256(totalDistributedP, EMPTY_POINTER);
    protected readonly farmStartBlock: StoredU256 = new StoredU256(farmStartBlockP, EMPTY_POINTER);

    // Sub-pool 0
    protected readonly lpToken0: StoredAddress = new StoredAddress(lpToken0P);
    protected readonly totalStaked0: StoredU256 = new StoredU256(totalStaked0P, EMPTY_POINTER);
    protected readonly rpt0: StoredU256 = new StoredU256(rpt0P, EMPTY_POINTER);
    protected readonly lastUpdate0: StoredU256 = new StoredU256(lastUpdate0P, EMPTY_POINTER);
    protected readonly userStake0: AddressMemoryMap = new AddressMemoryMap(userStake0P);
    protected readonly userRptPaid0: AddressMemoryMap = new AddressMemoryMap(userRptPaid0P);
    protected readonly userRewards0: AddressMemoryMap = new AddressMemoryMap(userRewards0P);

    // Sub-pool 1
    protected readonly lpToken1: StoredAddress = new StoredAddress(lpToken1P);
    protected readonly totalStaked1: StoredU256 = new StoredU256(totalStaked1P, EMPTY_POINTER);
    protected readonly rpt1: StoredU256 = new StoredU256(rpt1P, EMPTY_POINTER);
    protected readonly lastUpdate1: StoredU256 = new StoredU256(lastUpdate1P, EMPTY_POINTER);
    protected readonly userStake1: AddressMemoryMap = new AddressMemoryMap(userStake1P);
    protected readonly userRptPaid1: AddressMemoryMap = new AddressMemoryMap(userRptPaid1P);
    protected readonly userRewards1: AddressMemoryMap = new AddressMemoryMap(userRewards1P);

    // Sub-pool 2
    protected readonly lpToken2: StoredAddress = new StoredAddress(lpToken2P);
    protected readonly totalStaked2: StoredU256 = new StoredU256(totalStaked2P, EMPTY_POINTER);
    protected readonly rpt2: StoredU256 = new StoredU256(rpt2P, EMPTY_POINTER);
    protected readonly lastUpdate2: StoredU256 = new StoredU256(lastUpdate2P, EMPTY_POINTER);
    protected readonly userStake2: AddressMemoryMap = new AddressMemoryMap(userStake2P);
    protected readonly userRptPaid2: AddressMemoryMap = new AddressMemoryMap(userRptPaid2P);
    protected readonly userRewards2: AddressMemoryMap = new AddressMemoryMap(userRewards2P);

    public constructor() {
        super();
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Called once at deployment. Reward rate and epoch clock are NOT started here —
     * they are initialised lazily on the first interaction at or after farmStartBlock.
     * LP token addresses must be set via initialize() afterwards.
     * Farm start block must be set via setFarmStart() afterwards.
     */
    public override onDeployment(_calldata: Calldata): void {
        this.rewardRate.set(u256.Zero);
        this.currentEpoch.set(u256.Zero);
        // epochStartBlock left at 0 — set when farm starts
        // farmStartBlock left at 0 — deployer must call setFarmStart() before farm can begin
    }

    /**
     * Sets the BMOTO token address and LP token addresses. Deployer only, one-time.
     *
     * @param calldata  address bmoto, address lp0, address lp1, address lp2
     */
    @method(
        { name: 'bmoto', type: ABIDataTypes.ADDRESS },
        { name: 'lp0', type: ABIDataTypes.ADDRESS },
        { name: 'lp1', type: ABIDataTypes.ADDRESS },
        { name: 'lp2', type: ABIDataTypes.ADDRESS },
    )
    public initialize(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        if (!this.bmotoToken.isDead()) {
            throw new Revert('Already initialized');
        }

        const bmoto: Address = calldata.readAddress();
        const lp0: Address = calldata.readAddress();
        const lp1: Address = calldata.readAddress();
        const lp2: Address = calldata.readAddress();

        if (bmoto.equals(Address.zero())) throw new Revert('Zero bmoto');
        if (lp0.equals(Address.zero())) throw new Revert('Zero lp0');
        if (lp1.equals(Address.zero())) throw new Revert('Zero lp1');
        if (lp2.equals(Address.zero())) throw new Revert('Zero lp2');

        this.bmotoToken.value = bmoto;
        this.lpToken0.value = lp0;
        this.lpToken1.value = lp1;
        this.lpToken2.value = lp2;

        return new BytesWriter(0);
    }

    /**
     * Sets the block number at which farming begins. Deployer only.
     * Can be updated any time before the farm has started.
     * For testnet: pass the current block number to start immediately on the next interaction.
     * For mainnet: pass a future block number.
     *
     * @param calldata  uint256 startBlock
     */
    @method({ name: 'startBlock', type: ABIDataTypes.UINT256 })
    public setFarmStart(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);
        if (!this.epochStartBlock.value.isZero()) throw new Revert('Farm already started');

        const startBlock: u256 = calldata.readU256();
        this.farmStartBlock.set(startBlock);

        return new BytesWriter(0);
    }

    /** Called on contract upgrade. Restricts to deployer. */
    public override onUpdate(_calldata: Calldata): void {
        this.onlyDeployer(Blockchain.tx.sender);
    }

    // -----------------------------------------------------------------------
    // Core staking methods
    // -----------------------------------------------------------------------

    /**
     * Deposits LP tokens into sub-pool `poolId`.
     * Caller must have pre-approved this contract on the LP token.
     *
     * @param calldata  uint8 poolId, uint256 amount
     */
    @method(
        { name: 'poolId', type: ABIDataTypes.UINT8 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('Deposited')
    public deposit(calldata: Calldata): BytesWriter {
        const poolId: u8 = calldata.readU8();
        const amount: u256 = calldata.readU256();

        this._requireValidPool(poolId);
        if (amount.isZero()) throw new Revert('Zero amount');

        const user: Address = Blockchain.tx.sender;

        this._updateReward(poolId, user);

        // EFFECTS: update state before external call (Checks-Effects-Interactions)
        const currentStake: u256 = this._getUserStake(poolId, user);
        this._setUserStake(poolId, user, SafeMath.add(currentStake, amount));
        this._setTotalStaked(poolId, SafeMath.add(this._getTotalStaked(poolId), amount));

        // INTERACTION: external call last
        this._callTransferFrom(this._getLpToken(poolId), user, this.address, amount);

        this.emitEvent(new DepositedEvent(u256.fromU32(u32(poolId)), user, amount));

        return new BytesWriter(0);
    }

    /**
     * Withdraws `amount` LP tokens from sub-pool `poolId`.
     *
     * @param calldata  uint8 poolId, uint256 amount
     */
    @method(
        { name: 'poolId', type: ABIDataTypes.UINT8 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('Withdrawn')
    public withdraw(calldata: Calldata): BytesWriter {
        const poolId: u8 = calldata.readU8();
        const amount: u256 = calldata.readU256();

        this._requireValidPool(poolId);
        if (amount.isZero()) throw new Revert('Zero amount');

        const user: Address = Blockchain.tx.sender;

        this._updateReward(poolId, user);

        const currentStake: u256 = this._getUserStake(poolId, user);
        if (currentStake < amount) throw new Revert('Insufficient stake');

        this._setUserStake(poolId, user, SafeMath.sub(currentStake, amount));
        this._setTotalStaked(poolId, SafeMath.sub(this._getTotalStaked(poolId), amount));

        this._callTransfer(this._getLpToken(poolId), user, amount);

        this.emitEvent(new WithdrawnEvent(u256.fromU32(u32(poolId)), user, amount));

        return new BytesWriter(0);
    }

    /**
     * Emergency withdrawal — returns LP tokens WITHOUT settling rewards.
     *
     * Use only if normal withdraw() is blocked (e.g., extreme edge case in reward math).
     * Any unsettled (accrued-but-uncommitted) rewards for the withdrawn amount are forfeited.
     * Already-committed rewards in storage remain harvestable via harvest().
     *
     * @param calldata  uint8 poolId, uint256 amount
     */
    @method(
        { name: 'poolId', type: ABIDataTypes.UINT8 },
        { name: 'amount', type: ABIDataTypes.UINT256 },
    )
    @emit('Withdrawn')
    public emergencyWithdraw(calldata: Calldata): BytesWriter {
        const poolId: u8 = calldata.readU8();
        const amount: u256 = calldata.readU256();

        this._requireValidPool(poolId);
        if (amount.isZero()) throw new Revert('Zero amount');

        const user: Address = Blockchain.tx.sender;
        const currentStake: u256 = this._getUserStake(poolId, user);
        if (currentStake < amount) throw new Revert('Insufficient stake');

        // Skip _updateReward — no reward settlement. User forfeits unsettled accrual.
        this._setUserStake(poolId, user, SafeMath.sub(currentStake, amount));
        this._setTotalStaked(poolId, SafeMath.sub(this._getTotalStaked(poolId), amount));

        this._callTransfer(this._getLpToken(poolId), user, amount);

        this.emitEvent(new WithdrawnEvent(u256.fromU32(u32(poolId)), user, amount));

        return new BytesWriter(0);
    }

    /**
     * Claims all pending BMOTO rewards from sub-pool `poolId`.
     *
     * The amount paid out is capped so that lifetime totalDistributed never
     * exceeds TOTAL_REWARDS (250,000 BMOTO).
     *
     * @param calldata  uint8 poolId
     */
    @method({ name: 'poolId', type: ABIDataTypes.UINT8 })
    @emit('Harvested')
    public harvest(calldata: Calldata): BytesWriter {
        const poolId: u8 = calldata.readU8();
        this._requireValidPool(poolId);

        const user: Address = Blockchain.tx.sender;

        this._updateReward(poolId, user);

        const earned: u256 = this._getUserRewards(poolId, user);
        if (earned.isZero()) throw new Revert('Nothing to harvest');

        // Hard cap: never distribute more than TOTAL_REWARDS in aggregate.
        const distributed: u256 = this.totalDistributed.value;
        const remaining: u256 = distributed >= TOTAL_REWARDS
            ? u256.Zero
            : SafeMath.sub(TOTAL_REWARDS, distributed);

        const payout: u256 = earned > remaining ? remaining : earned;
        if (payout.isZero()) throw new Revert('Cap reached');

        this._setUserRewards(poolId, user, u256.Zero);
        this.totalDistributed.set(SafeMath.add(distributed, payout));

        this._callTransfer(this.bmotoToken.value, user, payout);

        this.emitEvent(new HarvestedEvent(u256.fromU32(u32(poolId)), user, payout));

        return new BytesWriter(0);
    }

    /**
     * Cuts the reward rate in half and advances to the next epoch.
     *
     * Rules:
     *   - Permissionless — anyone may call.
     *   - Reverts if the farm has not started yet.
     *   - Reverts if the current epoch has not yet ended (< EPOCH_DURATION blocks elapsed).
     *   - If epoch >= MAX_EPOCHS (farm finished), this is a silent no-op.
     *   - On the final epoch transition (6 → 7), sets rate to 0.
     */
    @method()
    @emit('Halved')
    public halve(_: Calldata): BytesWriter {
        if (this.epochStartBlock.value.isZero()) throw new Revert('Farm not started');

        const epoch: u64 = this.currentEpoch.value.toU64();
        if (epoch >= MAX_EPOCHS) {
            // Farm finished — silent no-op.
            return new BytesWriter(0);
        }

        const nowBlock: u64 = Blockchain.block.number;
        const epochStart: u64 = this.epochStartBlock.value.toU64();

        if (nowBlock < epochStart + EPOCH_DURATION) {
            throw new Revert('Epoch not ended');
        }

        // Flush all sub-pool accumulators before changing the rate.
        this._flushAccumulator(0, nowBlock);
        this._flushAccumulator(1, nowBlock);
        this._flushAccumulator(2, nowBlock);

        const oldRate: u256 = this.rewardRate.value;
        const newEpoch: u64 = epoch + 1;

        // On the final transition set rate to 0; otherwise halve.
        const newRate: u256 = newEpoch >= MAX_EPOCHS
            ? u256.Zero
            : SafeMath.div(oldRate, u256.fromU32(2));
        this.rewardRate.set(newRate);

        this.currentEpoch.set(u256.fromU64(newEpoch));
        this.epochStartBlock.set(u256.fromU64(nowBlock));

        this.emitEvent(new HalvedEvent(u256.fromU64(newEpoch), newRate));

        return new BytesWriter(0);
    }

    // -----------------------------------------------------------------------
    // View methods
    // -----------------------------------------------------------------------

    /**
     * Returns pending BMOTO rewards for `user` in `poolId` (view, not capped).
     *
     * @param calldata  uint8 poolId, address user
     */
    @view
    @method(
        { name: 'poolId', type: ABIDataTypes.UINT8 },
        { name: 'user', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'pending', type: ABIDataTypes.UINT256 })
    public pending(calldata: Calldata): BytesWriter {
        const poolId: u8 = calldata.readU8();
        const user: Address = calldata.readAddress();
        this._requireValidPool(poolId);

        const nowBlock: u64 = Blockchain.block.number;
        const currentRpt: u256 = this._computeCurrentRpt(poolId, nowBlock);

        const stake: u256 = this._getUserStake(poolId, user);
        const paid: u256 = this._getUserRptPaid(poolId, user);
        const accumulated: u256 = this._getUserRewards(poolId, user);

        let extraEarned: u256 = u256.Zero;
        if (!stake.isZero() && currentRpt > paid) {
            extraEarned = SafeMath.div(
                SafeMath.mul(stake, SafeMath.sub(currentRpt, paid)),
                PRECISION,
            );
        }

        const total: u256 = SafeMath.add(accumulated, extraEarned);

        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(total);
        return w;
    }

    /**
     * Returns only the committed (storage-settled) BMOTO owed to `user` in `poolId`.
     *
     * @param calldata  uint8 poolId, address user
     */
    @view
    @method(
        { name: 'poolId', type: ABIDataTypes.UINT8 },
        { name: 'user', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'committed', type: ABIDataTypes.UINT256 })
    public pendingStored(calldata: Calldata): BytesWriter {
        const poolId: u8 = calldata.readU8();
        const user: Address = calldata.readAddress();
        this._requireValidPool(poolId);
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this._getUserRewards(poolId, user));
        return w;
    }

    /**
     * Returns the staked LP balance for `user` in `poolId` (view).
     *
     * @param calldata  uint8 poolId, address user
     */
    @view
    @method(
        { name: 'poolId', type: ABIDataTypes.UINT8 },
        { name: 'user', type: ABIDataTypes.ADDRESS },
    )
    @returns({ name: 'stake', type: ABIDataTypes.UINT256 })
    public getUserStake(calldata: Calldata): BytesWriter {
        const poolId: u8 = calldata.readU8();
        const user: Address = calldata.readAddress();
        this._requireValidPool(poolId);
        const stake: u256 = this._getUserStake(poolId, user);
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(stake);
        return w;
    }

    /**
     * Returns the total BMOTO distributed (paid out) so far (view).
     */
    @view
    @method()
    @returns({ name: 'totalDistributed', type: ABIDataTypes.UINT256 })
    public getTotalDistributed(_: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.totalDistributed.value);
        return w;
    }

    /**
     * Returns how many BMOTO base units are still available for distribution.
     */
    @view
    @method()
    @returns({ name: 'remaining', type: ABIDataTypes.UINT256 })
    public remainingRewards(_: Calldata): BytesWriter {
        const distributed: u256 = this.totalDistributed.value;
        const remaining: u256 = distributed >= TOTAL_REWARDS
            ? u256.Zero
            : SafeMath.sub(TOTAL_REWARDS, distributed);
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(remaining);
        return w;
    }

    /**
     * Returns the current epoch number and per-block reward rate (view).
     */
    @view
    @method()
    @returns(
        { name: 'epoch', type: ABIDataTypes.UINT256 },
        { name: 'rate', type: ABIDataTypes.UINT256 },
    )
    public epochInfo(_: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH * 2);
        w.writeU256(this.currentEpoch.value);
        w.writeU256(this.rewardRate.value);
        return w;
    }

    /**
     * Returns the block number at which farming begins (0 = not set).
     */
    @view
    @method()
    @returns({ name: 'startBlock', type: ABIDataTypes.UINT256 })
    public getFarmStartBlock(_: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.farmStartBlock.value);
        return w;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /** Updates the reward-per-token accumulator for `poolId` and credits `user`. */
    private _updateReward(poolId: u8, user: Address): void {
        const nowBlock: u64 = Blockchain.block.number;

        this._flushAccumulator(poolId, nowBlock);

        if (!user.equals(Address.zero())) {
            const rpt: u256 = this._getRpt(poolId);
            const paid: u256 = this._getUserRptPaid(poolId, user);

            if (rpt > paid) {
                const stake: u256 = this._getUserStake(poolId, user);
                if (!stake.isZero()) {
                    const newRewards: u256 = SafeMath.div(
                        SafeMath.mul(stake, SafeMath.sub(rpt, paid)),
                        PRECISION,
                    );
                    this._setUserRewards(
                        poolId,
                        user,
                        SafeMath.add(this._getUserRewards(poolId, user), newRewards),
                    );
                }
            }
            this._setUserRptPaid(poolId, user, rpt);
        }
    }

    /**
     * Advances the reward-per-token accumulator for `poolId` to block `nowBlock`.
     *
     * Before farmStartBlock is reached (or not set), advances lastUpdate only so
     * no phantom elapsed blocks accumulate once the farm starts.
     *
     * On the first call at or after farmStartBlock, lazily initialises the epoch
     * clock and reward rate, and resets all three lastUpdate values to `nowBlock`
     * so pre-farm deposit blocks are never counted as reward-eligible elapsed time.
     */
    private _flushAccumulator(poolId: u8, nowBlock: u64): void {
        const lastBlock: u64 = this._getLastUpdate(poolId).toU64();
        if (nowBlock <= lastBlock) return;

        // Farm not started yet (or startBlock not set) — advance lastUpdate only.
        const startBlock: u64 = this.farmStartBlock.value.toU64();
        if (startBlock == 0 || nowBlock < startBlock) {
            this._setLastUpdate(poolId, u256.fromU64(nowBlock));
            return;
        }

        // Lazy-init: first flush at or after farmStartBlock.
        // Reset all lastUpdates so pre-farm elapsed blocks are discarded.
        if (this.epochStartBlock.value.isZero()) {
            this.epochStartBlock.set(u256.fromU64(nowBlock));
            this.rewardRate.set(INITIAL_RATE);
            this._setLastUpdate(0, u256.fromU64(nowBlock));
            this._setLastUpdate(1, u256.fromU64(nowBlock));
            this._setLastUpdate(2, u256.fromU64(nowBlock));
            // elapsed is 0 for all pools — nothing to accumulate this flush
            return;
        }

        const rate: u256 = this.rewardRate.value;
        if (!rate.isZero()) {
            const totalStaked: u256 = this._getTotalStaked(poolId);
            if (!totalStaked.isZero()) {
                const weight: u256 = this._getWeight(poolId);
                const subRate: u256 = SafeMath.div(SafeMath.mul(rate, weight), WEIGHT_SUM);
                const elapsed: u256 = u256.fromU64(nowBlock - lastBlock);

                // rptDelta = subRate * elapsed * PRECISION / totalStaked
                const rptDelta: u256 = SafeMath.div(
                    SafeMath.mul(SafeMath.mul(subRate, elapsed), PRECISION),
                    totalStaked,
                );
                this._setRpt(poolId, SafeMath.add(this._getRpt(poolId), rptDelta));
            }
        }

        this._setLastUpdate(poolId, u256.fromU64(nowBlock));
    }

    /** Computes the current (real-time) reward-per-token for `poolId` without writing. */
    private _computeCurrentRpt(poolId: u8, nowBlock: u64): u256 {
        const rpt: u256 = this._getRpt(poolId);
        const rate: u256 = this.rewardRate.value;

        if (rate.isZero()) return rpt;

        const lastBlock: u64 = this._getLastUpdate(poolId).toU64();
        const totalStaked: u256 = this._getTotalStaked(poolId);

        if (nowBlock <= lastBlock || totalStaked.isZero()) return rpt;

        const weight: u256 = this._getWeight(poolId);
        const subRate: u256 = SafeMath.div(SafeMath.mul(rate, weight), WEIGHT_SUM);
        const elapsed: u256 = u256.fromU64(nowBlock - lastBlock);

        const rptDelta: u256 = SafeMath.div(
            SafeMath.mul(SafeMath.mul(subRate, elapsed), PRECISION),
            totalStaked,
        );
        return SafeMath.add(rpt, rptDelta);
    }

    /** Validates poolId is 0 (only PILL/MOTO active on testnet) and contract is initialized. */
    private _requireValidPool(poolId: u8): void {
        if (poolId > 0) throw new Revert('Invalid poolId');
        if (this.bmotoToken.isDead()) throw new Revert('Not initialized');
    }

    // -----------------------------------------------------------------------
    // Cross-contract call helpers
    // -----------------------------------------------------------------------

    private _callTransfer(token: Address, to: Address, amount: u256): void {
        const cd = new BytesWriter(SELECTOR_BYTE_LENGTH + ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        cd.writeSelector(SELECTOR_TRANSFER);
        cd.writeAddress(to);
        cd.writeU256(amount);
        Blockchain.call(token, cd);
    }

    private _callTransferFrom(token: Address, from: Address, to: Address, amount: u256): void {
        const cd = new BytesWriter(
            SELECTOR_BYTE_LENGTH + ADDRESS_BYTE_LENGTH * 2 + U256_BYTE_LENGTH,
        );
        cd.writeSelector(SELECTOR_TRANSFER_FROM);
        cd.writeAddress(from);
        cd.writeAddress(to);
        cd.writeU256(amount);
        Blockchain.call(token, cd);
    }

    // -----------------------------------------------------------------------
    // Per-pool storage accessors
    // -----------------------------------------------------------------------

    private _getLpToken(poolId: u8): Address {
        if (poolId == 0) return this.lpToken0.value;
        if (poolId == 1) return this.lpToken1.value;
        return this.lpToken2.value;
    }

    private _getTotalStaked(poolId: u8): u256 {
        if (poolId == 0) return this.totalStaked0.value;
        if (poolId == 1) return this.totalStaked1.value;
        return this.totalStaked2.value;
    }

    private _setTotalStaked(poolId: u8, value: u256): void {
        if (poolId == 0) { this.totalStaked0.set(value); return; }
        if (poolId == 1) { this.totalStaked1.set(value); return; }
        this.totalStaked2.set(value);
    }

    private _getRpt(poolId: u8): u256 {
        if (poolId == 0) return this.rpt0.value;
        if (poolId == 1) return this.rpt1.value;
        return this.rpt2.value;
    }

    private _setRpt(poolId: u8, value: u256): void {
        if (poolId == 0) { this.rpt0.set(value); return; }
        if (poolId == 1) { this.rpt1.set(value); return; }
        this.rpt2.set(value);
    }

    private _getLastUpdate(poolId: u8): u256 {
        if (poolId == 0) return this.lastUpdate0.value;
        if (poolId == 1) return this.lastUpdate1.value;
        return this.lastUpdate2.value;
    }

    private _setLastUpdate(poolId: u8, value: u256): void {
        if (poolId == 0) { this.lastUpdate0.set(value); return; }
        if (poolId == 1) { this.lastUpdate1.set(value); return; }
        this.lastUpdate2.set(value);
    }

    private _getWeight(poolId: u8): u256 {
        if (poolId == 0) return WEIGHT_0;
        if (poolId == 1) return WEIGHT_1;
        return WEIGHT_2;
    }

    // Per-user storage accessors

    private _getUserStake(poolId: u8, user: Address): u256 {
        if (poolId == 0) return this.userStake0.get(user);
        if (poolId == 1) return this.userStake1.get(user);
        return this.userStake2.get(user);
    }

    private _setUserStake(poolId: u8, user: Address, value: u256): void {
        if (poolId == 0) { this.userStake0.set(user, value); return; }
        if (poolId == 1) { this.userStake1.set(user, value); return; }
        this.userStake2.set(user, value);
    }

    private _getUserRptPaid(poolId: u8, user: Address): u256 {
        if (poolId == 0) return this.userRptPaid0.get(user);
        if (poolId == 1) return this.userRptPaid1.get(user);
        return this.userRptPaid2.get(user);
    }

    private _setUserRptPaid(poolId: u8, user: Address, value: u256): void {
        if (poolId == 0) { this.userRptPaid0.set(user, value); return; }
        if (poolId == 1) { this.userRptPaid1.set(user, value); return; }
        this.userRptPaid2.set(user, value);
    }

    private _getUserRewards(poolId: u8, user: Address): u256 {
        if (poolId == 0) return this.userRewards0.get(user);
        if (poolId == 1) return this.userRewards1.get(user);
        return this.userRewards2.get(user);
    }

    private _setUserRewards(poolId: u8, user: Address, value: u256): void {
        if (poolId == 0) { this.userRewards0.set(user, value); return; }
        if (poolId == 1) { this.userRewards1.set(user, value); return; }
        this.userRewards2.set(user, value);
    }
}
