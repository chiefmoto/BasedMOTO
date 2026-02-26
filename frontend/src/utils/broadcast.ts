/**
 * Broadcast raw transactions via the local proxy (bypasses the broken OPNet mempool thread).
 * Only used on regtest — mainnet uses the OPNet node's built-in relay.
 */
const BROADCAST_PROXY_URL = 'http://142.93.84.52:9002';

export async function broadcastRaw(raw: string): Promise<string> {
    const res = await fetch(BROADCAST_PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
    });
    const data = (await res.json()) as { result?: string; error?: string };
    if (data.error) throw new Error(data.error);
    return data.result ?? '';
}
