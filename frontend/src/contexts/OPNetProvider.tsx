import { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { JSONRpcProvider } from 'opnet';
import { networks, Network } from '@btc-vision/bitcoin';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const opnetTestnet: Network = (networks as any).opnetTestnet as Network;
import { Address } from '@btc-vision/transaction';
import { useWalletConnect } from '@btc-vision/walletconnect';

const OPNetNetworks = {
    mainnet: {
        url: 'https://mainnet.opnet.org',
        network: networks.bitcoin,
        label: 'Mainnet',
    },
    testnet: {
        url: 'https://testnet.opnet.org',
        network: opnetTestnet,
        label: 'Testnet',
    },
    regtest: {
        url: 'http://142.93.84.52:9001',
        network: networks.regtest,
        label: 'Regtest',
    },
} as const;

export type OPNetNetworkId = keyof typeof OPNetNetworks;

interface OPNetContextType {
    provider: JSONRpcProvider | null;
    network: Network;
    networkId: OPNetNetworkId;
    networkLabel: string;
    walletAddress: string | null;
    walletAddressObj: Address | null;
    /** Address object directly from OPWallet (has ML-DSA key). Non-null when OPWallet is connected. */
    wcAddressObj: Address | null;
    isConnected: boolean;
    rpcError: string | null;
    /** Timestamp (Date.now()) of the most recent successful auto-approve-all call.
     *  LP token hooks watch this to trigger a balance/allowance refresh. */
    autoApprovedAt: number;
    setWalletAddress: (address: string | null) => void;
    switchNetwork: (id: OPNetNetworkId) => void;
    refreshWalletAddressObj: () => Promise<void>;
}

const OPNetContext = createContext<OPNetContextType | undefined>(undefined);

interface OPNetProviderProps {
    children: ReactNode;
    defaultNetwork?: OPNetNetworkId;
}

export function OPNetProvider({ children, defaultNetwork = 'regtest' }: OPNetProviderProps) {
    const [networkId, setNetworkId] = useState<OPNetNetworkId>(defaultNetwork);
    const [provider, setProvider] = useState<JSONRpcProvider | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [rpcError, setRpcError] = useState<string | null>(null);
    const [walletAddressObj, setWalletAddressObj] = useState<Address | null>(null);
    const [autoApprovedAt, setAutoApprovedAt] = useState<number>(0);
    const { walletAddress: wcAddress, network: wcNetwork, address: wcAddressObj } = useWalletConnect();
    const [manualAddress, setManualAddress] = useState<string | null>(null);
    // Wallet extension address takes priority over manual input
    const walletAddress = wcAddress ?? manualAddress;
    const providerRef = useRef<JSONRpcProvider | null>(null);

    const config = OPNetNetworks[networkId];

    useEffect(() => {
        let isMounted = true;
        void providerRef.current?.close();
        const rpcProvider = new JSONRpcProvider({ url: config.url, network: config.network });
        providerRef.current = rpcProvider;
        setProvider(null);
        setIsConnected(false);

        rpcProvider
            .getBlockNumber()
            .then(() => {
                if (isMounted) {
                    setProvider(rpcProvider);
                    setIsConnected(true);
                    setRpcError(null);
                }
            })
            .catch((err: unknown) => {
                if (isMounted) {
                    setIsConnected(false);
                    setRpcError(err instanceof Error ? err.message : String(err));
                }
            });

        return () => {
            isMounted = false;
        };
    }, [config]);

    // Auto-sync network from OPWallet when it changes
    useEffect(() => {
        if (!wcNetwork) return;
        const net = wcNetwork.network; // 'mainnet' | 'testnet' | 'regtest'
        if (net === 'mainnet' || net === 'testnet' || net === 'regtest') {
            setNetworkId((prev) => (prev !== net ? (net as OPNetNetworkId) : prev));
        }
    }, [wcNetwork]);

    // Resolve wallet Address object.
    // On MAINNET: prefer wcAddressObj (OPWallet's own ML-DSA key) — it matches
    //   Blockchain.tx.sender when OPWallet signs.
    // On REGTEST: always use getPublicKeyInfo (the on-chain registered ML-DSA key
    //   set by the sign proxy via the deployer mnemonic). OPWallet's self-reported
    //   ML-DSA key may differ from the mnemonic's LEVEL2 key that the sign proxy
    //   registers, causing allowance reads to return 0.
    useEffect(() => {
        if (!walletAddress) {
            setWalletAddressObj(null);
            return;
        }
        if (wcAddressObj && networkId !== 'regtest') {
            setWalletAddressObj(wcAddressObj);
            return;
        }
        if (!provider) return;
        let isMounted = true;
        provider
            .getPublicKeyInfo(walletAddress, false)
            .then((addr) => {
                if (isMounted) setWalletAddressObj(addr);
            })
            .catch(() => {
                if (isMounted) setWalletAddressObj(null);
            });
        return () => {
            isMounted = false;
        };
    }, [provider, walletAddress, wcAddressObj, networkId]);

    const switchNetwork = (id: OPNetNetworkId) => {
        if (id !== networkId) {
            setNetworkId(id);
            setManualAddress(null);
        }
    };

    // On regtest: when a wallet connects, automatically pre-approve all LP → Pool
    // allowances via the sign proxy so users never need to click Approve.
    // After the proxy completes (registering the ML-DSA key + setting allowances),
    // re-fetch walletAddressObj via getPublicKeyInfo so it reflects the registered key.
    useEffect(() => {
        if (!walletAddress || networkId !== 'regtest') return;
        let cancelled = false;
        const currentProvider = provider;
        void fetch('http://142.93.84.52:9003/auto-approve-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ p2tr: walletAddress }),
        })
            .then(async () => {
                if (cancelled || !currentProvider) return;
                // Re-fetch so walletAddressObj has the sign-proxy-registered ML-DSA key
                try {
                    const addr = await currentProvider.getPublicKeyInfo(walletAddress, false);
                    if (!cancelled) setWalletAddressObj(addr);
                } catch { /* ignore */ }
                if (!cancelled) setAutoApprovedAt(Date.now());
            })
            .catch(() => { if (!cancelled) setAutoApprovedAt(Date.now()); });
        return () => { cancelled = true; };
    }, [walletAddress, networkId, provider]); // eslint-disable-line react-hooks/exhaustive-deps

    // Force a fresh RPC lookup of walletAddressObj. Call this after a tx that
    // registers the ML-DSA key on-chain so the fallback path returns the full
    // Address (with ML-DSA component) that matches Blockchain.tx.sender.
    const refreshWalletAddressObj = useCallback(async () => {
        // On regtest always re-fetch (same reasoning as walletAddressObj effect above).
        if (wcAddressObj && networkId !== 'regtest') {
            setWalletAddressObj(wcAddressObj);
            return;
        }
        if (!provider || !walletAddress) return;
        try {
            const addr = await provider.getPublicKeyInfo(walletAddress, false);
            setWalletAddressObj(addr);
        } catch {
            // ignore
        }
    }, [provider, walletAddress, wcAddressObj, networkId]);

    return (
        <OPNetContext.Provider
            value={{
                provider,
                network: config.network,
                networkId,
                networkLabel: config.label,
                walletAddress,
                walletAddressObj,
                wcAddressObj,
                isConnected,
                rpcError,
                autoApprovedAt,
                setWalletAddress: setManualAddress,
                switchNetwork,
                refreshWalletAddressObj,
            }}
        >
            {children}
        </OPNetContext.Provider>
    );
}

export function useOPNet(): OPNetContextType {
    const ctx = useContext(OPNetContext);
    if (ctx === undefined) throw new Error('useOPNet must be used within OPNetProvider');
    return ctx;
}
