import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Blockchain,
    BytesWriter,
    Calldata,
    OP_NET,
    Revert,
    StoredU256,
} from '@btc-vision/btc-runtime/runtime';
import { EMPTY_POINTER } from '@btc-vision/btc-runtime/runtime/math/bytes';
import { U256_BYTE_LENGTH } from '@btc-vision/btc-runtime/runtime/utils';

// ---------------------------------------------------------------------------
// Storage pointers
// ---------------------------------------------------------------------------
const reserve0P: u16 = Blockchain.nextPointer;
const reserve1P: u16 = Blockchain.nextPointer;

// ---------------------------------------------------------------------------
// MockPair
// ---------------------------------------------------------------------------

/**
 * Minimal Motoswap pair mock for regtest testing.
 *
 * Implements getReserves() so the Rebaser can read prices.
 * Deployer can call setReserves() to simulate any price scenario.
 */
@final
export class MockPair extends OP_NET {
    protected readonly reserve0: StoredU256 = new StoredU256(reserve0P, EMPTY_POINTER);
    protected readonly reserve1: StoredU256 = new StoredU256(reserve1P, EMPTY_POINTER);

    public constructor() {
        super();
    }

    public override onDeployment(_calldata: Calldata): void {
        // Default: balanced 1:1 reserves (1000 × 10^8 of each)
        this.reserve0.set(u256.fromString('100000000000'));
        this.reserve1.set(u256.fromString('100000000000'));
    }

    public override onUpdate(_calldata: Calldata): void {
        this.onlyDeployer(Blockchain.tx.sender);
    }

    // -----------------------------------------------------------------------
    // Admin
    // -----------------------------------------------------------------------

    /**
     * Sets both reserves. Deployer only.
     *
     * @param calldata  uint256 reserve0, uint256 reserve1
     */
    @method(
        { name: 'reserve0', type: ABIDataTypes.UINT256 },
        { name: 'reserve1', type: ABIDataTypes.UINT256 },
    )
    public setReserves(calldata: Calldata): BytesWriter {
        this.onlyDeployer(Blockchain.tx.sender);

        const r0: u256 = calldata.readU256();
        const r1: u256 = calldata.readU256();

        if (r0.isZero()) throw new Revert('Zero reserve0');
        if (r1.isZero()) throw new Revert('Zero reserve1');

        this.reserve0.set(r0);
        this.reserve1.set(r1);

        return new BytesWriter(0);
    }

    // -----------------------------------------------------------------------
    // Motoswap interface
    // -----------------------------------------------------------------------

    /**
     * Returns (reserve0: u256, reserve1: u256, blockTimestampLast: u64).
     * Matches the Motoswap pair ABI expected by the Rebaser.
     */
    @view
    @method()
    @returns({ name: 'reserve0', type: ABIDataTypes.UINT256 })
    @returns({ name: 'reserve1', type: ABIDataTypes.UINT256 })
    @returns({ name: 'blockTimestampLast', type: ABIDataTypes.UINT64 })
    public getReserves(_: Calldata): BytesWriter {
        const w = new BytesWriter(U256_BYTE_LENGTH * 2 + 8);
        w.writeU256(this.reserve0.value);
        w.writeU256(this.reserve1.value);
        w.writeU64(Blockchain.block.medianTimestamp);
        return w;
    }
}
