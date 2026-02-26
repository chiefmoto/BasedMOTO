/**
 * Contract addresses per network.
 * After running deploy-regtest.mjs, fill in the regtest addresses from deployment.json.
 * For mainnet, fill in after mainnet deploy.
 */

export interface BMOTOAddresses {
    readonly bmoto: string;
    readonly pool1: string;
    readonly pool2: string;
    readonly rebaser: string;
    /** Pool1 LP tokens: [PILL/MOTO, PEPE/MOTO, UNGA/MOTO] */
    readonly lpTokens: readonly [string, string, string];
    /** Pool2 LP token: BMOTO/MOTO */
    readonly pool2Lp: string;
    /** Block number at which Pool1 farming begins (0 = not set). */
    readonly pool1FarmStart: bigint;
    /** Block number at which Pool2 farming begins (0 = not set). */
    readonly pool2FarmStart: bigint;
    /** Number of active Pool1 sub-pools (1 on testnet — PILL/MOTO only; 3 on regtest/mainnet). */
    readonly pool1NumPools: 1 | 2 | 3;
}

export const REGTEST_ADDRESSES: BMOTOAddresses = {
    bmoto:   'opr1sqrr6rfp7kge932wrg8lhfcc77nvhcsr3c54gtn4h',
    pool1:   'opr1sqqjrqvc8ecf57yly97n5mggea9tcsadersv6fzcv',
    pool2:   'opr1sqq3khs50svsdrsqwztuttxz7psk383uwmsawuf2y',
    rebaser: 'opr1sqpr8vpfc0h06rquj9qfx5afzanyd34d2mu9njdrs',
    lpTokens: [
        'opr1sqpw93pc79zj5xs4ur2ltxsul0y3s7rfxzu6ey7e8', // mockLp0 (PILL/MOTO)
        'opr1sqph5kd3gjfwkjyc4ffd3y25vr7xjafj2esk9x9aj', // mockLp1 (PEPE/MOTO)
        'opr1sqq0em4llex4lhnvvy7d4hm68j7u5dhkg0ysj8xe3', // mockLp2 (UNGA/MOTO)
    ],
    pool2Lp: 'opr1sqpw93pc79zj5xs4ur2ltxsul0y3s7rfxzu6ey7e8', // mockLp0 reused as BMOTO/MOTO LP
    pool1FarmStart: 3405n,
    pool2FarmStart: 3406n,
    pool1NumPools: 3,
};

/**
 * OPNet Testnet (Signet fork) — fill in after testnet deploy.
 * LP pair addresses come from MotoSwap testnet (PILL/MOTO, PEPE/MOTO, UNGA/MOTO).
 * Pool2 LP (BMOTO/MOTO) is created by the team after farming starts.
 */
export const TESTNET_ADDRESSES: BMOTOAddresses = {
    bmoto:   'opt1sqrf773f6n3nxm3clsem3z5zt6pqddq60scvhysud',
    pool1:   'opt1sqzt4fugeweu3tvmqxz4gqtl0z9wt9xll0uvdnah7',
    pool2:   'opt1sqpfgp4gr0mep6pzd5tn0tmn7xkukjtw8e5kcguev',
    rebaser: 'opt1sqqne48k598kyhp6j3u25re6jxhj90vtcdv8k0y2n',
    lpTokens: [
        'opt1sqq47sszp4zrj9xhss2ep54dc456za9aweqvqzr3g', // PILL/MOTO LP (testnet)
        'FILL_WHEN_LIVE',                                  // PEPE/MOTO — not yet on testnet
        'FILL_WHEN_LIVE',                                  // UNGA/MOTO — not yet on testnet
    ],
    pool2Lp: 'FILL_AFTER_BMOTO_MOTO_LP_CREATED',
    pool1FarmStart: 0n,
    pool2FarmStart: 0n,
    pool1NumPools: 1,
};

export const MAINNET_ADDRESSES: BMOTOAddresses = {
    bmoto:   'FILL_AFTER_MAINNET_DEPLOY',
    pool1:   'FILL_AFTER_MAINNET_DEPLOY',
    pool2:   'FILL_AFTER_MAINNET_DEPLOY',
    rebaser: 'FILL_AFTER_MAINNET_DEPLOY',
    lpTokens: [
        'FILL_AFTER_MAINNET_DEPLOY',
        'FILL_AFTER_MAINNET_DEPLOY',
        'FILL_AFTER_MAINNET_DEPLOY',
    ],
    pool2Lp: 'FILL_AFTER_MAINNET_DEPLOY',
    pool1FarmStart: 0n,
    pool2FarmStart: 0n,
    pool1NumPools: 3,
};

export const POOL1_NAMES = ['PILL/MOTO LP', 'PEPE/MOTO LP', 'UNGA/MOTO LP'] as const;
export const POOL1_WEIGHTS = [70, 15, 15] as const;
export const BMOTO_DECIMALS = 8;
export const LP_DECIMALS = 8;

// Emission schedule constants — must match Pool1.ts / Pool2.ts
export const POOL1_INITIAL_RATE  = 43_402_777_777n; // base units per block (8 decimals)
export const POOL1_EPOCH_DURATION = 288n;            // blocks per epoch
export const POOL1_MAX_EPOCHS    = 7n;

export const POOL2_INITIAL_RATE  = 86_805_555_555n;
export const POOL2_EPOCH_DURATION = 432n;
export const POOL2_MAX_EPOCHS    = 9n;
