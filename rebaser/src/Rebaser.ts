import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    OP_NET,
    Revert,
    SafeMath,
    StoredAddress,
    StoredBoolean,
    StoredU256,
    encodeSelector,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';
import { U256_BYTE_LENGTH, SELECTOR_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// Scaling factor: all prices expressed as (value × 10^8)
const PRICE_SCALE: u256 = u256.fromString('100000000'); // 10^8
// Rebase target: 1 BMOTO = 1 MOTO → target price = PRICE_SCALE
const PRICE_TARGET: u256 = PRICE_SCALE;
// Deviation threshold: 5% = 5 × 10^6 (in 10^8 scale)
const DEVIATION_THRESHOLD: u256 = u256.fromString('5000000');
// Rebase lag: dampen correction to 1/10 per rebase
const REBASE_LAG: u256 = u256.fromU32(10);
// Min gap between rebases: 144 blocks (~24 hours at 10 min/block on mainnet)
const MIN_REBASE_INTERVAL: u64 = 144;
// 4 weeks in blocks: 28 days × 144 blocks/day = 4032
const FOUR_WEEKS_BLOCKS: u64 = 4032;
// 97% of 1M BMOTO = 970_000 × 10^8
const ACTIVATION_THRESHOLD: u256 = u256.fromString('97000000000000');

// TWAP: maximum 1 sample per block (block-number gating).
// On mainnet each Bitcoin block is ~10 min, so 12 samples ≈ 2 hours of price data.
// Minimum number of samples required before rebase is permitted.
const MIN_SAMPLES: u256 = u256.fromU32(6);

// Cross-contract call selectors
const SELECTOR_TOTAL_SUPPLY: u32 = encodeSelector('totalSupply()');
const SELECTOR_REBASE: u32 = encodeSelector('rebase(uint256,bool)');
const SELECTOR_GET_TOTAL_DISTRIBUTED: u32 = encodeSelector('getTotalDistributed()');
const SELECTOR_GET_RESERVES: u32 = encodeSelector('getReserves()');

// ---------------------------------------------------------------------------
// Storage pointers (order must be preserved across upgrades)
// ---------------------------------------------------------------------------
const bmotoTokenP: u16 = Blockchain.nextPointer;
const pool1P: u16 = Blockchain.nextPointer;
const pool2P: u16 = Blockchain.nextPointer;
const bmotoMotoPairP: u16 = Blockchain.nextPointer;
const pool1LaunchBlockP: u16 = Blockchain.nextPointer;
const lastRebaseBlockP: u16 = Blockchain.nextPointer;
const epochP: u16 = Blockchain.nextPointer;
const rebaseLagP: u16 = Blockchain.nextPointer;
const rebaseEnabledP: u16 = Blockchain.nextPointer;
const bmotoIsToken0P: u16 = Blockchain.nextPointer;
// TWAP accumulators
const priceAccumulatorP: u16 = Blockchain.nextPointer;
const sampleCountP: u16 = Blockchain.nextPointer;
const lastTWAPSampleBlockP: u16 = Blockchain.nextPointer;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

@final
class RebaseExecutedEvent extends NetEvent {
    constructor(
        epoch: u256,
        twapPrice: u256,
        supplyDelta: u256,
        isExpansion: bool,
    ) {
        const data = new BytesWriter(U256_BYTE_LENGTH * 3 + 1);
        data.writeU256(epoch);
        data.writeU256(twapPrice);
        data.writeU256(supplyDelta);
        data.writeBoolean(isExpansion);
        super('RebaseExecuted', data);
    }
}

@final
class TWAPSampledEvent extends NetEvent {
    constructor(spotPrice: u256, sampleCount: u256) {
        const data = new BytesWriter(U256_BYTE_LENGTH * 2);
        data.writeU256(spotPrice);
        data.writeU256(sampleCount);
        super('TWAPSampled', data);
    }
}

// ---------------------------------------------------------------------------
// Rebaser
// ---------------------------------------------------------------------------

/**
 * Rebaser — oracle + rebase policy for BMOTOToken.
 *
 * Target: 1 BMOTO = 1 MOTO (using BMOTO/MOTO pair only).
 *
 * TWAP protection: anyone calls updateTWAP() periodically to push price
 * samples into the accumulator. rebase() uses the TWAP (accumulator / count)
 * rather than the live spot price, making manipulation extremely expensive.
 *
 * Activation conditions (either enables rebasing):
 * 1. 4032 blocks (~4 weeks) elapsed since Pool1 launch block
 * 2. 97% of 1M BMOTO distributed by pools
 *
 * Rebase cadence: max once per 144 blocks (~24 hours).
 * TWAP requirement: at least MIN_SAMPLES samples before first rebase.
 */
@final
export class Rebaser extends OP_NET {
    protected readonly bmotoToken: StoredAddress = new StoredAddress(bmotoTokenP);
    protected readonly pool1: StoredAddress = new StoredAddress(pool1P);
    protected readonly pool2: StoredAddress = new StoredAddress(pool2P);
    protected readonly bmotoMotoPair: StoredAddress = new StoredAddress(bmotoMotoPairP);
    protected readonly pool1LaunchBlock: StoredU256 = new StoredU256(pool1LaunchBlockP, EMPTY_POINTER);
    protected readonly lastRebaseBlock: StoredU256 = new StoredU256(lastRebaseBlockP, EMPTY_POINTER);
    protected readonly epoch: StoredU256 = new StoredU256(epochP, EMPTY_POINTER);
    protected readonly rebaseLag: StoredU256 = new StoredU256(rebaseLagP, EMPTY_POINTER);
    protected readonly rebaseEnabled: StoredBoolean = new StoredBoolean(rebaseEnabledP, false);
    protected readonly bmotoIsToken0: StoredBoolean = new StoredBoolean(bmotoIsToken0P, false);
    // TWAP
    protected readonly priceAccumulator: StoredU256 = new StoredU256(priceAccumulatorP, EMPTY_POINTER);
    protected readonly sampleCount: StoredU256 = new StoredU256(sampleCountP, EMPTY_POINTER);
    protected readonly lastTWAPSampleBlock: StoredU256 = new StoredU256(lastTWAPSampleBlockP, EMPTY_POINTER);

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {
        this.rebaseLag.set(REBASE_LAG);
    }

    public override onUpdate(_calldata: Calldata): void {
        this.onlyDeployer(Blockchain.tx.sender);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /**
     * Configures all contract addresses. Deployer only, one-time.
     *
     * @param calldata
     *   address bmoto             — BMOTOToken contract
     *   address pool1             — Pool1 staking contract
     *   address pool2             — Pool2 staking contract
     *   address bmotoMotoPair     — Motoswap BMOTO/MOTO pair
     *   uint64  pool1LaunchBlock  — Block number of Pool1 launch (use 1 for immediate activation in tests)
     *   bool    bmotoIsToken0     — True if BMOTO is reserve0 in the BMOTO/MOTO pair
     */
    @method(
        { name: 'bmoto',            type: ABIDataTypes.ADDRESS },
        { name: 'pool1',            type: ABIDataTypes.ADDRESS },
        { name: 'pool2',            type: ABIDataTypes.ADDRESS },
        { name: 'bmotoMotoPair',    type: ABIDataTypes.ADDRESS },
        { name: 'pool1LaunchBlock', type: ABIDataTypes.UINT64  },
        { name: 'bmotoIsToken0',    type: ABIDataTypes.BOOL    },
    )
    public setContracts(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        if (!this.bmotoToken.isDead()) {
            throw new Revert('Already configured');
        }

        const bmoto: Address   = calldata.readAddress();
        const p1: Address      = calldata.readAddress();
        const p2: Address      = calldata.readAddress();
        const pair: Address    = calldata.readAddress();
        const launchBlock: u64 = calldata.readU64();
        const isToken0: bool   = calldata.readBoolean();

        if (bmoto.equals(Address.zero())) throw new Revert('Zero bmoto');
        if (p1.equals(Address.zero()))    throw new Revert('Zero pool1');
        if (p2.equals(Address.zero()))    throw new Revert('Zero pool2');
        if (pair.equals(Address.zero()))  throw new Revert('Zero bmotoMotoPair');

        this.bmotoToken.value    = bmoto;
        this.pool1.value         = p1;
        this.pool2.value         = p2;
        this.bmotoMotoPair.value = pair;
        this.pool1LaunchBlock.set(u256.fromU64(launchBlock));
        this.bmotoIsToken0.value = isToken0;

        return new BytesWriter(0);
    }

    // -----------------------------------------------------------------------
    // TWAP
    // -----------------------------------------------------------------------

    /**
     * Permissionless. Pushes a new spot price sample into the TWAP accumulator.
     * Max one sample per block to prevent sample stuffing.
     * Anyone (user, bot, keeper) should call this every ~2 hours.
     */
    @method()
    @emit('TWAPSampled')
    public updateTWAP(_: Calldata): BytesWriter {
        if (this.bmotoToken.isDead()) throw new Revert('Not configured');

        const currentBlock: u256 = u256.fromU64(Blockchain.block.number);

        if (currentBlock <= this.lastTWAPSampleBlock.value) {
            throw new Revert('Already sampled this block');
        }

        const spot: u256 = this._getBMOTOSpot();
        if (spot.isZero()) throw new Revert('Pair unavailable');

        const newAccumulator: u256 = SafeMath.add(this.priceAccumulator.value, spot);
        const newCount: u256 = SafeMath.add(this.sampleCount.value, u256.One);

        this.priceAccumulator.set(newAccumulator);
        this.sampleCount.set(newCount);
        this.lastTWAPSampleBlock.set(currentBlock);

        this.emitEvent(new TWAPSampledEvent(spot, newCount));

        return new BytesWriter(0);
    }

    // -----------------------------------------------------------------------
    // Core rebase
    // -----------------------------------------------------------------------

    /**
     * Executes a rebase if conditions are met. Permissionless.
     *
     * 1. Checks activation (4032 blocks elapsed or 97% distributed).
     * 2. Checks 144-block cooldown (~24 hours).
     * 3. Requires MIN_SAMPLES in the TWAP accumulator.
     * 4. Computes TWAP = priceAccumulator / sampleCount.
     * 5. If deviation from PRICE_TARGET > 5%, adjusts supply.
     * 6. Resets TWAP accumulator after a real rebase.
     */
    @method()
    @emit('RebaseExecuted')
    public rebase(_: Calldata): BytesWriter {
        if (this.bmotoToken.isDead()) throw new Revert('Not configured');

        if (!this._isRebaseEnabled()) throw new Revert('Rebase not yet active');

        const currentBlock: u64 = Blockchain.block.number;
        const lastBlock: u64 = this.lastRebaseBlock.value.toU64();
        if (currentBlock < lastBlock + MIN_REBASE_INTERVAL) throw new Revert('Too soon');

        if (this.sampleCount.value < MIN_SAMPLES) throw new Revert('Insufficient TWAP samples');

        // TWAP price = sum of samples / number of samples
        const twapPrice: u256 = SafeMath.div(this.priceAccumulator.value, this.sampleCount.value);

        // Absolute deviation from target (1 MOTO = PRICE_SCALE)
        let absDev: u256;
        if (twapPrice > PRICE_TARGET) {
            absDev = SafeMath.sub(twapPrice, PRICE_TARGET);
        } else {
            absDev = SafeMath.sub(PRICE_TARGET, twapPrice);
        }

        // devRatio = absDev × PRICE_SCALE / PRICE_TARGET (percent × 10^6)
        const devRatio: u256 = SafeMath.div(
            SafeMath.mul(absDev, PRICE_SCALE),
            PRICE_TARGET,
        );

        // Within 5% threshold — no-op, do NOT reset accumulator or update lastRebaseBlock
        if (devRatio <= DEVIATION_THRESHOLD) {
            const noop = new BytesWriter(U256_BYTE_LENGTH + 1);
            noop.writeU256(u256.Zero);
            noop.writeBoolean(false);
            return noop;
        }

        const totalSupply: u256 = this._getBMOTOTotalSupply();

        // supplyDelta = totalSupply × absDev / PRICE_TARGET / rebaseLag
        const supplyDelta: u256 = SafeMath.div(
            SafeMath.div(SafeMath.mul(totalSupply, absDev), PRICE_TARGET),
            this.rebaseLag.value,
        );

        const isExpansion: bool = twapPrice > PRICE_TARGET;

        // Checks-effects-interactions
        this.lastRebaseBlock.set(u256.fromU64(currentBlock));
        const newEpoch: u256 = SafeMath.add(this.epoch.value, u256.One);
        this.epoch.set(newEpoch);

        // Reset TWAP accumulator so next window starts fresh
        this.priceAccumulator.set(u256.Zero);
        this.sampleCount.set(u256.Zero);

        this._callRebase(supplyDelta, isExpansion);

        this.emitEvent(new RebaseExecutedEvent(newEpoch, twapPrice, supplyDelta, isExpansion));

        const w = new BytesWriter(U256_BYTE_LENGTH + 1);
        w.writeU256(supplyDelta);
        w.writeBoolean(isExpansion);
        return w;
    }

    // -----------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------

    @view
    @method()
    @returns({ name: 'enabled', type: ABIDataTypes.BOOL })
    public isRebaseEnabled(_: Calldata): BytesWriter {
        const w = new BytesWriter(1);
        w.writeBoolean(this._isRebaseEnabled());
        return w;
    }

    @view
    @method()
    @returns(
        { name: 'twapPrice',        type: ABIDataTypes.UINT256 },
        { name: 'sampleCount',      type: ABIDataTypes.UINT256 },
        { name: 'lastSampleBlock',  type: ABIDataTypes.UINT64  },
        { name: 'lastRebaseBlock',  type: ABIDataTypes.UINT64  },
        { name: 'currentBlock',     type: ABIDataTypes.UINT64  },
    )
    public getTWAPInfo(_: Calldata): BytesWriter {
        const count = this.sampleCount.value;
        const twap = count.isZero()
            ? u256.Zero
            : SafeMath.div(this.priceAccumulator.value, count);

        const w = new BytesWriter(U256_BYTE_LENGTH * 2 + 24);
        w.writeU256(twap);
        w.writeU256(count);
        w.writeU64(this.lastTWAPSampleBlock.value.toU64());
        w.writeU64(this.lastRebaseBlock.value.toU64());
        w.writeU64(Blockchain.block.number);
        return w;
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private _isRebaseEnabled(): bool {
        if (this.rebaseEnabled.value) return true;

        const currentBlock: u64 = Blockchain.block.number;
        const launchBlock: u64 = this.pool1LaunchBlock.value.toU64();

        if (launchBlock > 0 && currentBlock >= launchBlock + FOUR_WEEKS_BLOCKS) {
            this.rebaseEnabled.value = true;
            return true;
        }

        const distributed: u256 = this._getTotalDistributed();
        if (distributed >= ACTIVATION_THRESHOLD) {
            this.rebaseEnabled.value = true;
            return true;
        }

        return false;
    }

    /**
     * Reads the BMOTO spot price from the BMOTO/MOTO pair.
     * Returns: BMOTO price in MOTO units × 10^8.
     * Target is PRICE_SCALE (= 1 MOTO per BMOTO).
     */
    private _getBMOTOSpot(): u256 {
        const cd = new BytesWriter(SELECTOR_BYTE_LENGTH);
        cd.writeSelector(SELECTOR_GET_RESERVES);

        const result = Blockchain.call(this.bmotoMotoPair.value, cd, false);
        if (!result.success) return u256.Zero;
        if (result.data.byteLength < 64) return u256.Zero;

        const reserve0: u256 = result.data.readU256();
        const reserve1: u256 = result.data.readU256();

        if (reserve0.isZero() || reserve1.isZero()) return u256.Zero;

        let reserveBMOTO: u256;
        let reserveMOTO: u256;

        if (this.bmotoIsToken0.value) {
            reserveBMOTO = reserve0;
            reserveMOTO  = reserve1;
        } else {
            reserveBMOTO = reserve1;
            reserveMOTO  = reserve0;
        }

        // price = reserveMOTO × PRICE_SCALE / reserveBMOTO
        return SafeMath.div(SafeMath.mul(reserveMOTO, PRICE_SCALE), reserveBMOTO);
    }

    private _getBMOTOTotalSupply(): u256 {
        const cd = new BytesWriter(SELECTOR_BYTE_LENGTH);
        cd.writeSelector(SELECTOR_TOTAL_SUPPLY);

        const result = Blockchain.call(this.bmotoToken.value, cd);
        if (result.data.byteLength < 32) return u256.Zero;

        return result.data.readU256();
    }

    private _getTotalDistributed(): u256 {
        const cd = new BytesWriter(SELECTOR_BYTE_LENGTH);
        cd.writeSelector(SELECTOR_GET_TOTAL_DISTRIBUTED);

        let total: u256 = u256.Zero;

        const r1 = Blockchain.call(this.pool1.value, cd, false);
        if (r1.success && r1.data.byteLength >= 32) {
            total = SafeMath.add(total, r1.data.readU256());
        }

        const r2 = Blockchain.call(this.pool2.value, cd, false);
        if (r2.success && r2.data.byteLength >= 32) {
            total = SafeMath.add(total, r2.data.readU256());
        }

        return total;
    }

    private _callRebase(supplyDelta: u256, isExpansion: bool): void {
        const cd = new BytesWriter(SELECTOR_BYTE_LENGTH + U256_BYTE_LENGTH + 1);
        cd.writeSelector(SELECTOR_REBASE);
        cd.writeU256(supplyDelta);
        cd.writeBoolean(isExpansion);

        Blockchain.call(this.bmotoToken.value, cd);
    }
}
