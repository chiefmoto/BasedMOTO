import { Blockchain } from '@btc-vision/btc-runtime/runtime';
import { revertOnError } from '@btc-vision/btc-runtime/runtime/abort/abort';
import { MockPair } from './MockPair';

// Contract factory — DO NOT MODIFY
Blockchain.contract = (): MockPair => {
    return new MockPair();
};

// Required runtime exports — DO NOT MODIFY
export * from '@btc-vision/btc-runtime/runtime/exports';

// Required abort handler — must match `use: ["abort=src/index/abort"]` in asconfig.json
export function abort(message: string, fileName: string, line: u32, column: u32): void {
    revertOnError(message, fileName, line, column);
}
