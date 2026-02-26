import { useWalletConnect, SupportedWallets } from '@btc-vision/walletconnect';
import { useOPNet, OPNetNetworkId } from '../contexts/OPNetProvider';
import { formatAddr } from '../utils/format';

export function WalletBar() {
    const { walletAddress, connectToWallet, disconnect, connecting } = useWalletConnect();
    const handleConnect = () => connectToWallet(SupportedWallets.OP_WALLET);
    const { networkId, networkLabel, switchNetwork, rpcError } = useOPNet();

    const handleNetwork = (id: OPNetNetworkId) => {
        if (id !== networkId) switchNetwork(id);
    };

    return (
        <div className="wallet-bar">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div className="tabs" style={{ marginBottom: 0, maxWidth: 200 }}>
                    <button
                        className={`tab${networkId === 'regtest' ? ' active' : ''}`}
                        onClick={() => handleNetwork('regtest')}
                    >
                        Regtest
                    </button>
                    <button
                        className={`tab${networkId === 'mainnet' ? ' active' : ''}`}
                        onClick={() => handleNetwork('mainnet')}
                    >
                        Mainnet
                    </button>
                </div>
                <button
                    className={`btn btn-sm ${walletAddress ? 'btn-disconnect' : 'btn-primary'}`}
                    onClick={walletAddress ? disconnect : handleConnect}
                    disabled={connecting}
                    style={{ background: 'rgba(0,0,0,0.35)' }}
                >
                    {connecting ? 'Connecting…' : walletAddress ? formatAddr(walletAddress) : 'Connect OPWallet'}
                </button>
            </div>

            {rpcError && (
                <span className="network-badge" style={{ color: 'var(--color-error)' }}>
                    RPC offline
                </span>
            )}
        </div>
    );
}
