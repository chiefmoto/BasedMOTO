import { useState } from 'react';
import { OPNetProvider } from './contexts/OPNetProvider';
import { useOPNet } from './contexts/OPNetProvider';
import { ToastProvider } from './contexts/ToastContext';
import { WalletBar } from './components/WalletBar';
import { BMOTOBalance } from './components/BMOTOBalance';
import { Pool1Panel } from './components/Pool1Panel';
import { Pool2Panel } from './components/Pool2Panel';
import { CoverPage } from './components/CoverPage';
import { REGTEST_ADDRESSES, TESTNET_ADDRESSES, MAINNET_ADDRESSES } from './config/contracts';
import './styles/app.css';

type Page = 'pool1' | 'pool2';

function Dashboard() {
    const { walletAddress, networkId, isConnected } = useOPNet();
    const addresses =
        networkId === 'regtest' ? REGTEST_ADDRESSES :
        networkId === 'testnet' ? TESTNET_ADDRESSES :
        MAINNET_ADDRESSES;
    const [page, setPage] = useState<Page>('pool1');

    return (
        <div>
            <div className="status-bar">
                <span>
                    <span className="status-dot" />
                    {isConnected ? 'RPC CONNECTED' : 'RPC OFFLINE'}
                </span>
                <span style={{ color: 'var(--color-accent2)' }}>
                    {networkId.toUpperCase()}
                </span>
            </div>

            <header className="app-header">
                <div>
                    <img src="/logo.png" alt="Based Moto" className="app-logo" />
                    <div className="app-subtitle">First Rebase Token on Bitcoin</div>
                </div>
                <WalletBar />
            </header>

            <nav className="app-nav">
                <button
                    className={`nav-link${page === 'pool1' ? ' active' : ''}`}
                    onClick={() => setPage('pool1')}
                >
                    Pool 1
                </button>
                <button
                    className={`nav-link${page === 'pool2' ? ' active' : ''}`}
                    onClick={() => setPage('pool2')}
                >
                    Pool 2
                </button>
            </nav>

            {!walletAddress ? (
                <div className="card">
                    <p className="card-subtitle">
                        Connect your OPWallet to view balances and stake LP tokens.
                    </p>
                </div>
            ) : page === 'pool1' ? (
                <div className="page-grid">
                    <Pool1Panel
                        pool1Address={addresses.pool1}
                        lpTokens={addresses.lpTokens}
                        farmStart={addresses.pool1FarmStart}
                        bmotoAddress={addresses.bmoto}
                        numPools={addresses.pool1NumPools}
                    />
                </div>
            ) : (
                <div className="page-grid">
                    <Pool2Panel
                        pool2Address={addresses.pool2}
                        pool2LpAddress={addresses.pool2Lp}
                        farmStart={addresses.pool2FarmStart}
                    />
                    <div className="balance-widget-row">
                        <BMOTOBalance bmotoAddress={addresses.bmoto} />
                    </div>
                </div>
            )}
        </div>
    );
}

export default function App() {
    const [entered, setEntered] = useState(false);

    return (
        <OPNetProvider defaultNetwork="testnet">
            <ToastProvider>
                <div className="synth-bg" />
                <img src="/motohelmet.png" className="pool-helmet-bg" alt="" />
                {entered ? <Dashboard /> : <CoverPage onEnter={() => setEntered(true)} />}
            </ToastProvider>
        </OPNetProvider>
    );
}
