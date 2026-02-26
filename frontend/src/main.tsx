import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './walletconnect-fix.css'; // MANDATORY — must be first CSS import
import { WalletConnectProvider } from '@btc-vision/walletconnect';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
    <StrictMode>
        <WalletConnectProvider theme="dark">
            <App />
        </WalletConnectProvider>
    </StrictMode>,
);
