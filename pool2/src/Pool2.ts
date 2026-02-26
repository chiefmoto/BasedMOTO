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
// Pool2 constants
// ---------------------------------------------------------------------------

/** Hard cap: pool can never distribute more than 750,000 BMOTO (= 750_000 × 10^8 base units). */
const TOTAL_REWARDS: u256 = u256.fromString('75000000000000'); // 750_000 × 10^8

/**
 * Epoch length in Bitcoin blocks. One halving per epoch.
 * 9 epochs × 432 blocks = 3888 blocks total (~27 days at 10 min/block).
 * Farming begins at Pool1's farmStartBlock + 288 (set by deployer via setFarmStart).
 */
const EPOCH_DURATION: u64 = 432; // blocks per epoch

/**
 * Maximum number of epochs. After 9 epochs (epochs 0–8) the rate is set to 0.
 * Any call to halve() when epoch >= MAX_EPOCHS is a silent no-op.
 */
const MAX_EPOCHS: u64 = 9;

/**
 * Initial per-block reward rate.
 * = floor(375_000 × 10^8 / 432) = floor(37_500_000_000_000 / 432) = 86_805_555_555 base-units/block
 */
const INITIAL_RATE: u256 = u256.fromString('86805555555'); // base units/block

// Precision multiplier for reward-per-token accumulator
const PRECISION: u256 = u256.fromString('1000000000000000000'); // 10^18

// Cross-contract call selectors
const SELECTOR_TRANSFER: u32 = encodeSelector('transfer(address,uint256)');
const SELECTOR_TRANSFER_FROM: u32 = encodeSelector('transferFrom(address,address,uint256)');

// ---------------------------------------------------------------------------
// Module-level storage pointers (after ReentrancyGuard's 2 pointers)
// ---------------------------------------------------------------------------
const bmotoTokenP: u16 = Blockchain.nextPointer;
const lpTokenP: u16 = Blockchain.nextPointer;
const rewardRateP: u16 = Blockchain.nextPointer;
const currentEpochP: u16 = Blockchain.nextPointer;
const epochStartBlockP: u16 = Blockchain.nextPointer;  // block number stored as u256
const farmStartBlockP: u16 = Blockchain.nextPointer;   // block number at which farm activates
const totalDistributedP: u16 = Blockchain.nextPointer;
const totalStakedP: u16 = Blockchain.nextPointer;
const rptP: u16 = Blockchain.nextPointer;              // rewardPerTokenStored × PRECISION
const lastUpdateP: u16 = Blockchain.nextPointer;
const userStakeP: u16 = Blockchain.nextPointer;
const userRptPaidP: u16 = Blockchain.nextPointer;
const userRewardsP: u16 = Blockchain.nextPointer;

// ---------------------------------------------------------------------------
// Custom events
// ---------------------------------------------------------------------------

@final
class DepositedEvent extends NetEvent {
    constructor(user: Address, amount: u256) {
        const data = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(user);
        data.writeU256(amount);
        super('Deposited', data);
    }
}

@final
class WithdrawnEvent extends NetEvent {
    constructor(user: Address, amount: u256) {
        const data = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
        data.writeAddress(user);
        data.writeU256(amount);
        super('Withdrawn', data);
    }
}

@final
class HarvestedEvent extends NetEvent {
    constructor(user: Address, amount: u256) {
        const data = new BytesWriter(ADDRESS_BYTE_LENGTH + U256_BYTE_LENGTH);
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
// Pool2 — 750k BMOTO staking farm, single LP pool, 9 block-based epochs
// ---------------------------------------------------------------------------

/**
 * Pool2 distributes 750,000 BMOTO to LP stakers over 9 epochs (432 blocks each).
 *
 * Single sub-pool: one LP token (set by deployer via initialize()).
 *
 * Emission schedule (block-based halvings):
 *   Epoch 0 →  ~375,000 BMOTO (86_805_555 × 432 ≈ 37.5B base units)
 *   Epoch 1 →  ~187,500 BMOTO
 *   Epoch 2 →  ~ 93,750 BMOTO
 *   Epoch 3 →  ~ 46,875 BMOTO
 *   Epoch 4 →  ~ 23,438 BMOTO
 *   Epoch 5 →  ~ 11,719 BMOTO
 *   Epoch 6 →  ~  5,859 BMOTO
 *   Epoch 7 →  ~  2,930 BMOTO
 *   Epoch 8 →  ~  1,465 BMOTO
 *   After epoch 8: rate = 0
 *
 * Farming starts at Pool1's farmStartBlock + 288 (deployer calls setFarmStart).
 * Rewards are earned block-by-block (discrete, not continuous).
 * halve() is permissionless, callable once per epoch by anyone.
 */
@final
export class Pool2 extends ReentrancyGuard {
    protected override readonly reentrancyLevel: ReentrancyLevel = ReentrancyLevel.CALLBACK;

    // Addresses
    protected readonly bmotoToken: StoredAddress = new StoredAddress(bmotoTokenP);
    protected readonly lpToken: StoredAddress = new StoredAddress(lpTokenP);

    // Global state
    protected readonly rewardRate: StoredU256 = new StoredU256(rewardRateP, EMPTY_POINTER);
    protected readonly currentEpoch: StoredU256 = new StoredU256(currentEpochP, EMPTY_POINTER);
    protected readonly epochStartBlock: StoredU256 = new StoredU256(epochStartBlockP, EMPTY_POINTER);
    protected readonly farmStartBlock: StoredU256 = new StoredU256(farmStartBlockP, EMPTY_POINTER);
    protected readonly totalDistributed: StoredU256 = new StoredU256(totalDistributedP, EMPTY_POINTER);

    // Single-pool state
    protected readonly totalStaked: StoredU256 = new StoredU256(totalStakedP, EMPTY_POINTER);
    protected readonly rpt: StoredU256 = new StoredU256(rptP, EMPTY_POINTER); // × PRECISION
    protected readonly lastUpdate: StoredU256 = new StoredU256(lastUpdateP, EMPTY_POINTER);

    // Per-user state
    protected readonly userStake: AddressMemoryMap = new AddressMemoryMap(userStakeP);
    protected readonly userRptPaid: AddressMemoryMap = new AddressMemoryMap(userRptPaidP);
    protected readonly userRewards: AddressMemoryMap = new AddressMemoryMap(userRewardsP);

    public constructor() {
        super();
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Called once at deployment. Reward rate and epoch clock are NOT started here —
     * they are initialised lazily on the first interaction at or after farmStartBlock.
     * Token addresses must be set via initialize() afterwards.
     * Farm start block must be set via setFarmStart() afterwards.
     */
    public override onDeployment(_calldata: Calldata): void {
        this.rewardRate.set(u256.Zero);
        this.currentEpoch.set(u256.Zero);
        // epochStartBlock left at 0 — set when farm starts
        // farmStartBlock left at 0 — deployer must call setFarmStart() before farm can begin
    }

    /**
     * Sets token addresses. Deployer only, one-time.
     *
     * @param calldata  address bmoto, address lpToken
     */
    @method(
        { name: 'bmoto', type: ABIDataTypes.ADDRESS },
        { name: 'lp', type: ABIDataTypes.ADDRESS },
    )
    public initialize(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        if (!this.bmotoToken.isDead()) {
            throw new Revert('Already initialized');
        }

        const bmoto: Address = calldata.readAddress();
        const lp: Address = calldata.readAddress();

        if (bmoto.equals(Address.zero())) throw new Revert('Zero bmoto');
        if (lp.equals(Address.zero())) throw new Revert('Zero lp');

        this.bmotoToken.value = bmoto;
        this.lpToken.value = lp;

        return new BytesWriter(0);
    }

    /**
     * Sets the block number at which farming begins. Deployer only.
     * Should be set to Pool1's farmStartBlock + 288.
     * Can be updated any time before the farm has started.
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
     * Deposits LP tokens.
     * Caller must have pre-approved this contract on the LP token.
     *
     * @param calldata  uint256 amount
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @emit('Deposited')
    public deposit(calldata: Calldata): BytesWriter {
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) throw new Revert('Zero amount');
        if (this.bmotoToken.isDead()) throw new Revert('Not initialized');

        const user: Address = Blockchain.tx.sender;

        this._updateReward(user);

        // EFFECTS: update state before external call (Checks-Effects-Interactions)
        this.userStake.set(user, SafeMath.add(this.userStake.get(user), amount));
        this.totalStaked.set(SafeMath.add(this.totalStaked.value, amount));

        // INTERACTION: external call last
        this._callTransferFrom(this.lpToken.value, user, this.address, amount);

        this.emitEvent(new DepositedEvent(user, amount));

        return new BytesWriter(0);
    }

    /**
     * Withdraws staked LP tokens.
     *
     * @param calldata  uint256 amount
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @emit('Withdrawn')
    public withdraw(calldata: Calldata): BytesWriter {
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) throw new Revert('Zero amount');
        if (this.bmotoToken.isDead()) throw new Revert('Not initialized');

        const user: Address = Blockchain.tx.sender;
        this._updateReward(user);

        const stake: u256 = this.userStake.get(user);
        if (stake < amount) throw new Revert('Insufficient stake');

        this.userStake.set(user, SafeMath.sub(stake, amount));
        this.totalStaked.set(SafeMath.sub(this.totalStaked.value, amount));

        this._callTransfer(this.lpToken.value, user, amount);

        this.emitEvent(new WithdrawnEvent(user, amount));

        return new BytesWriter(0);
    }

    /**
     * Emergency withdrawal — returns LP tokens WITHOUT settling rewards.
     *
     * Use only if normal withdraw() is blocked (e.g., extreme edge case in reward math).
     * Any unsettled (accrued-but-uncommitted) rewards are forfeited.
     * Already-committed rewards in storage remain harvestable via harvest().
     *
     * @param calldata  uint256 amount
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @emit('Withdrawn')
    public emergencyWithdraw(calldata: Calldata): BytesWriter {
        const amount: u256 = calldata.readU256();
        if (amount.isZero()) throw new Revert('Zero amount');
        if (this.bmotoToken.isDead()) throw new Revert('Not initialized');

        const user: Address = Blockchain.tx.sender;
        const stake: u256 = this.userStake.get(user);
        if (stake < amount) throw new Revert('Insufficient stake');

        // Skip _updateReward — no reward settlement. User forfeits unsettled accrual.
        this.userStake.set(user, SafeMath.sub(stake, amount));
        this.totalStaked.set(SafeMath.sub(this.totalStaked.value, amount));

        this._callTransfer(this.lpToken.value, user, amount);

        this.emitEvent(new WithdrawnEvent(user, amount));

        return new BytesWriter(0);
    }

    /**
     * Claims all pending BMOTO rewards.
     * Capped at TOTAL_REWARDS (750,000 BMOTO) in aggregate.
     */
    @method()
    @emit('Harvested')
    public harvest(_: Calldata): BytesWriter {
        const user: Address = Blockchain.tx.sender;

        this._updateReward(user);

        const earned: u256 = this.userRewards.get(user);
        if (earned.isZero()) throw new Revert('Nothing to harvest');

        // Hard cap: never distribute more than TOTAL_REWARDS in aggregate.
        const distributed: u256 = this.totalDistributed.value;
        const remaining: u256 = distributed >= TOTAL_REWARDS
            ? u256.Zero
            : SafeMath.sub(TOTAL_REWARDS, distributed);

        const payout: u256 = earned > remaining ? remaining : earned;
        if (payout.isZero()) throw new Revert('Cap reached');

        this.userRewards.set(user, u256.Zero);
        this.totalDistributed.set(SafeMath.add(distributed, payout));

        this._callTransfer(this.bmotoToken.value, user, payout);

        this.emitEvent(new HarvestedEvent(user, payout));

        return new BytesWriter(0);
    }

    /**
     * Cuts reward rate in half and advances epoch.
     * Permissionless after EPOCH_DURATION blocks have elapsed.
     * Silent no-op once all epochs are completed.
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

        this._flushAccumulator(nowBlock);

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
     * Returns pending BMOTO rewards for `user` (view).
     *
     * @param calldata  address user
     */
    @view
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'pending', type: ABIDataTypes.UINT256 })
    public pending(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const nowBlock: u64 = Blockchain.block.number;
        const currentRpt: u256 = this._computeCurrentRpt(nowBlock);

        const stake: u256 = this.userStake.get(user);
        const paid: u256 = this.userRptPaid.get(user);
        const accumulated: u256 = this.userRewards.get(user);

        let extra: u256 = u256.Zero;
        if (!stake.isZero() && currentRpt > paid) {
            extra = SafeMath.div(
                SafeMath.mul(stake, SafeMath.sub(currentRpt, paid)),
                PRECISION,
            );
        }

        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(SafeMath.add(accumulated, extra));
        return w;
    }

    /**
     * Returns only the committed (storage-settled) BMOTO owed to `user`.
     *
     * @param calldata  address user
     */
    @view
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'committed', type: ABIDataTypes.UINT256 })
    public pendingStored(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.userRewards.get(user));
        return w;
    }

    /**
     * Returns the staked LP balance for `user` (view).
     *
     * @param calldata  address user
     */
    @view
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'stake', type: ABIDataTypes.UINT256 })
    public getUserStake(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.userStake.get(user));
        return w;
    }

    /**
     * Returns the total BMOTO distributed so far (view).
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

    private _updateReward(user: Address): void {
        const nowBlock: u64 = Blockchain.block.number;
        this._flushAccumulator(nowBlock);

        if (!user.equals(Address.zero())) {
            const currentRpt: u256 = this.rpt.value;
            const paid: u256 = this.userRptPaid.get(user);

            if (currentRpt > paid) {
                const stake: u256 = this.userStake.get(user);
                if (!stake.isZero()) {
                    const newRewards: u256 = SafeMath.div(
                        SafeMath.mul(stake, SafeMath.sub(currentRpt, paid)),
                        PRECISION,
                    );
                    this.userRewards.set(
                        user,
                        SafeMath.add(this.userRewards.get(user), newRewards),
                    );
                }
            }
            this.userRptPaid.set(user, currentRpt);
        }
    }

    private _flushAccumulator(nowBlock: u64): void {
        const lastBlock: u64 = this.lastUpdate.value.toU64();
        if (nowBlock <= lastBlock) return;

        // Farm not started yet (or startBlock not set) — advance lastUpdate only.
        const startBlock: u64 = this.farmStartBlock.value.toU64();
        if (startBlock == 0 || nowBlock < startBlock) {
            this.lastUpdate.set(u256.fromU64(nowBlock));
            return;
        }

        // Lazy-init: first flush at or after farmStartBlock.
        if (this.epochStartBlock.value.isZero()) {
            this.epochStartBlock.set(u256.fromU64(nowBlock));
            this.rewardRate.set(INITIAL_RATE);
            this.lastUpdate.set(u256.fromU64(nowBlock));
            // elapsed is 0 — nothing to accumulate this flush
            return;
        }

        const staked: u256 = this.totalStaked.value;
        if (!staked.isZero()) {
            const rate: u256 = this.rewardRate.value;
            if (!rate.isZero()) {
                const elapsed: u256 = u256.fromU64(nowBlock - lastBlock);
                // rptDelta = rate * elapsed * PRECISION / totalStaked
                const rptDelta: u256 = SafeMath.div(
                    SafeMath.mul(SafeMath.mul(rate, elapsed), PRECISION),
                    staked,
                );
                this.rpt.set(SafeMath.add(this.rpt.value, rptDelta));
            }
        }

        this.lastUpdate.set(u256.fromU64(nowBlock));
    }

    private _computeCurrentRpt(nowBlock: u64): u256 {
        const currentRpt: u256 = this.rpt.value;
        const lastBlock: u64 = this.lastUpdate.value.toU64();
        const staked: u256 = this.totalStaked.value;

        if (nowBlock <= lastBlock || staked.isZero()) return currentRpt;

        const rate: u256 = this.rewardRate.value;
        if (rate.isZero()) return currentRpt;

        const elapsed: u256 = u256.fromU64(nowBlock - lastBlock);
        const rptDelta: u256 = SafeMath.div(
            SafeMath.mul(SafeMath.mul(rate, elapsed), PRECISION),
            staked,
        );
        return SafeMath.add(currentRpt, rptDelta);
    }

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
}
