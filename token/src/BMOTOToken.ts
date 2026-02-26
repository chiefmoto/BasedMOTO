import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    OP20,
    OP20InitParameters,
    Revert,
    SafeMath,
    StoredAddress,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';
import { U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';

// ---------------------------------------------------------------------------
// Elastic supply constants
// TOTAL_GONS = 10^32 (divisible by INITIAL_SUPPLY = 10^14)
// GONS_PER_FRAGMENT_INITIAL = 10^18
// ---------------------------------------------------------------------------
const TOTAL_GONS: u256 = u256.fromString('100000000000000000000000000000000');
const INITIAL_SUPPLY: u256 = u256.fromString('100000000000000'); // 1_000_000 × 10^8
const INITIAL_GONS_PER_FRAGMENT: u256 = u256.fromString('1000000000000000000'); // 10^18
const MAX_SUPPLY: u256 = u256.fromString('10000000000000000'); // 100_000_000 × 10^8 (100× cap)
const MIN_SUPPLY: u256 = u256.fromString('1000000000000'); // 10_000 × 10^8 (1/100× floor)

// Module-level unique storage pointers (allocated after OP20's own pointers)
const gonsPerFragmentPointer: u16 = Blockchain.nextPointer;
const rebaseContractPointer: u16 = Blockchain.nextPointer;
const epochCounterPointer: u16 = Blockchain.nextPointer;

// ---------------------------------------------------------------------------
// Custom events
// ---------------------------------------------------------------------------

/** Emitted on every successful rebase. */
@final
class RebaseEvent extends NetEvent {
    constructor(epoch: u256, newSupply: u256) {
        const data = new BytesWriter(U256_BYTE_LENGTH * 2);
        data.writeU256(epoch);
        data.writeU256(newSupply);
        super('Rebase', data);
    }
}

// ---------------------------------------------------------------------------
// BMOTOToken — elastic-supply OP20 token using gons-based internal accounting
// ---------------------------------------------------------------------------

/**
 * BMOTOToken — 1,000,000 BMOTO elastic supply token pegged to MOTO.
 *
 * Storage internally uses "gons" (a fixed total) so that rebase operations
 * automatically adjust every holder's balance without any per-account update.
 * The public API (balanceOf, transfer, …) always works in "fragments" (BMOTO).
 *
 * Architecture:
 * - balanceOfMap stores GONS per address (not fragments)
 * - gonsPerFragment is updated on each rebase
 * - balanceOf = gonBalance / gonsPerFragment
 * - transfer N fragments ↔ N * gonsPerFragment gons
 *
 * Rules:
 * - Constructor runs EVERY interaction — no init logic here.
 * - One-time init goes in onDeployment().
 * - onUpdate() is MANDATORY even if empty.
 * - SafeMath for ALL u256 arithmetic.
 */
@final
export class BMOTOToken extends OP20 {
    /**
     * Ratio: gons per BMOTO fragment. Decreases on expansion rebase,
     * increases on contraction rebase. All holder balances shift proportionally.
     */
    protected readonly gonsPerFragment: StoredU256 = new StoredU256(
        gonsPerFragmentPointer,
        EMPTY_POINTER,
    );

    /** Address of the Rebaser contract — the only caller allowed to invoke rebase(). */
    protected readonly rebaseContract: StoredAddress = new StoredAddress(rebaseContractPointer);

    /** Monotonically increasing epoch counter, incremented on every rebase. */
    protected readonly epochCounter: StoredU256 = new StoredU256(
        epochCounterPointer,
        EMPTY_POINTER,
    );

    public constructor() {
        super();
    }

    /**
     * Called exactly once when the contract is deployed.
     * Initializes OP20 metadata and mints 1,000,000 BMOTO to the deployer.
     * The deployer then transfers 250k to Pool1 and 750k to Pool2.
     */
    public override onDeployment(_calldata: Calldata): void {
        // Initialise OP20 metadata (name, symbol, decimals, maxSupply)
        this.instantiate(new OP20InitParameters(MAX_SUPPLY, 8, 'BASED MOTO', 'basedMOTO'));

        // Set initial gons-per-fragment ratio
        this.gonsPerFragment.set(INITIAL_GONS_PER_FRAGMENT);

        // Mint full 1M supply to deployer; deployer distributes to pools manually
        this._mint(Blockchain.tx.origin, INITIAL_SUPPLY);
    }

    /**
     * Called on contract upgrade. Restricts upgrades to the original deployer.
     */
    public override onUpdate(_calldata: Calldata): void {
        this.onlyDeployer(Blockchain.tx.sender);
    }

    // -----------------------------------------------------------------------
    // Rebase methods
    // -----------------------------------------------------------------------

    /**
     * Adjusts total supply toward the MOTO peg. Only callable by rebaseContract.
     *
     * @param calldata  uint256 supplyDelta, bool isExpansion
     */
    @method(
        { name: 'supplyDelta', type: ABIDataTypes.UINT256 },
        { name: 'isExpansion', type: ABIDataTypes.BOOL },
    )
    @emit('Rebase')
    public rebase(calldata: Calldata): BytesWriter {
        if (this.rebaseContract.isDead()) {
            throw new Revert('Rebaser not set');
        }
        if (!Blockchain.tx.sender.equals(this.rebaseContract.value)) {
            throw new Revert('Only rebaser');
        }

        const supplyDelta: u256 = calldata.readU256();
        const isExpansion: bool = calldata.readBoolean();

        const currentSupply: u256 = this._totalSupply.value;
        let newSupply: u256;

        if (isExpansion) {
            newSupply = SafeMath.add(currentSupply, supplyDelta);
            if (newSupply > MAX_SUPPLY) {
                newSupply = MAX_SUPPLY;
            }
        } else {
            if (supplyDelta >= currentSupply || SafeMath.sub(currentSupply, supplyDelta) < MIN_SUPPLY) {
                newSupply = MIN_SUPPLY;
            } else {
                newSupply = SafeMath.sub(currentSupply, supplyDelta);
            }
        }

        // Update stored fragment supply and recompute gons-per-fragment
        this._totalSupply.set(newSupply);
        this.gonsPerFragment.set(SafeMath.div(TOTAL_GONS, newSupply));

        // Advance epoch and emit event
        const newEpoch: u256 = SafeMath.add(this.epochCounter.value, u256.One);
        this.epochCounter.set(newEpoch);

        this.emitEvent(new RebaseEvent(newEpoch, newSupply));

        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(newSupply);
        return w;
    }

    /**
     * Sets the rebaser contract address. Deployer only, one-time.
     *
     * @param calldata  address
     */
    @method({ name: 'addr', type: ABIDataTypes.ADDRESS })
    public setRebaseContract(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        if (!this.rebaseContract.isDead()) {
            throw new Revert('Rebaser already set');
        }

        const addr: Address = calldata.readAddress();
        if (addr.equals(Address.zero())) {
            throw new Revert('Zero address');
        }

        this.rebaseContract.value = addr;

        return new BytesWriter(0);
    }

    /**
     * Returns the current gonsPerFragment ratio (view).
     */
    @view
    @method()
    @returns({ name: 'gonsPerFragment', type: ABIDataTypes.UINT256 })
    public getGonsPerFragment(_: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH);
        w.writeU256(this.gonsPerFragment.value);
        return w;
    }

    // -----------------------------------------------------------------------
    // OP20 internal overrides — store gons in balanceOfMap, expose fragments
    // -----------------------------------------------------------------------

    /**
     * Returns fragment balance: stored gons / gonsPerFragment.
     * @protected
     */
    protected override _balanceOf(owner: Address): u256 {
        if (!this.balanceOfMap.has(owner)) return u256.Zero;
        const gons: u256 = this.balanceOfMap.get(owner);
        return SafeMath.div(gons, this.gonsPerFragment.value);
    }

    /**
     * Mints `amount` BMOTO (fragments) to `to` by storing the equivalent gons.
     * @protected
     */
    protected override _mint(to: Address, amount: u256): void {
        if (to.equals(Address.zero())) {
            throw new Revert('Invalid receiver');
        }

        // CHECK: verify max supply before any state change
        const newSupply: u256 = SafeMath.add(this._totalSupply.value, amount);
        if (newSupply > this._maxSupply.value) {
            throw new Revert('Max supply reached');
        }

        const gpf: u256 = this.gonsPerFragment.value;
        const gons: u256 = SafeMath.mul(amount, gpf);

        // EFFECTS: update state
        const currentGons: u256 = this.balanceOfMap.get(to);
        this.balanceOfMap.set(to, SafeMath.add(currentGons, gons));
        this._totalSupply.set(newSupply);

        this.createMintedEvent(to, amount);
    }

    /**
     * Burns `amount` BMOTO (fragments) from `from`.
     * @protected
     */
    protected override _burn(from: Address, amount: u256): void {
        if (from.equals(Address.zero())) {
            throw new Revert('Invalid sender');
        }

        const gpf: u256 = this.gonsPerFragment.value;
        const gons: u256 = SafeMath.mul(amount, gpf);

        const currentGons: u256 = this.balanceOfMap.get(from);
        this.balanceOfMap.set(from, SafeMath.sub(currentGons, gons));

        this._totalSupply.set(SafeMath.sub(this._totalSupply.value, amount));

        this.createBurnedEvent(from, amount);
    }

    /**
     * Transfers `amount` BMOTO (fragments) from `from` to `to` via gon accounting.
     * @protected
     */
    protected override _transfer(from: Address, to: Address, amount: u256): void {
        if (from.equals(Address.zero())) {
            throw new Revert('Invalid sender');
        }
        if (to.equals(Address.zero())) {
            throw new Revert('Invalid receiver');
        }

        const gpf: u256 = this.gonsPerFragment.value;
        const gonAmount: u256 = SafeMath.mul(amount, gpf);

        const fromGons: u256 = this.balanceOfMap.get(from);
        if (fromGons < gonAmount) {
            throw new Revert('Insufficient balance');
        }

        this.balanceOfMap.set(from, SafeMath.sub(fromGons, gonAmount));

        const toGons: u256 = this.balanceOfMap.get(to);
        this.balanceOfMap.set(to, SafeMath.add(toGons, gonAmount));

        this.createTransferredEvent(Blockchain.tx.sender, from, to, amount);
    }
}
