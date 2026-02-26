export function formatBMOTO(raw: bigint, decimals = 8): string {
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    // Take 2 decimal places (divide fractional part down to 2 digits)
    const fracStr = frac.toString().padStart(decimals, '0');
    const twoDecimals = fracStr.slice(0, 2);
    return `${whole.toLocaleString()}.${twoDecimals}`;
}

export function parseBMOTO(input: string, decimals = 8): bigint {
    const [whole = '0', frac = ''] = input.split('.');
    const paddedFrac = frac.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole.replace(/[^0-9]/g, '') + paddedFrac);
}

export function formatAddr(addr: string, chars = 8): string {
    if (addr.length <= chars * 2 + 3) return addr;
    return `${addr.slice(0, chars)}...${addr.slice(-chars)}`;
}

/** Maximum U256 for approve-all allowance */
export const MAX_U256 = 2n ** 256n - 1n;
