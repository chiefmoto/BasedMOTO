import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';

export type ToastType = 'success' | 'error';

export interface Toast {
    id: number;
    type: ToastType;
    message: string;
    txid?: string;
}

interface ToastContextValue {
    showToast: (type: ToastType, message: string, txid?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const OPSCAN = 'https://opscan.org/tx';
const AUTO_DISMISS_MS = 7000;

let serial = 0;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
    const barRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // animate the progress bar down to 0 over AUTO_DISMISS_MS
        const el = barRef.current;
        if (!el) return;
        el.style.transition = `width ${AUTO_DISMISS_MS}ms linear`;
        el.style.width = '0%';
    }, []);

    const isSuccess = toast.type === 'success';
    const color = isSuccess ? 'var(--color-accent)' : 'var(--color-error)';
    const shadow = isSuccess ? 'var(--shadow-green-sm)' : '2px 2px 0 var(--color-error)';

    return (
        <div
            className="toast-item"
            style={{ borderColor: color, boxShadow: shadow }}
            role="alert"
        >
            <div className="toast-body">
                <span className="toast-icon">{isSuccess ? '✓' : '✕'}</span>
                <span className="toast-message" style={{ color }}>
                    {toast.message}
                </span>
                {toast.txid && (
                    <a
                        href={`${OPSCAN}/${toast.txid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="toast-link"
                        style={{ color }}
                    >
                        View on OPScan →
                    </a>
                )}
                <button
                    className="toast-close"
                    onClick={() => onDismiss(toast.id)}
                    aria-label="Dismiss"
                >
                    ✕
                </button>
            </div>
            <div className="toast-bar-track">
                <div ref={barRef} className="toast-bar" style={{ background: color, width: '100%' }} />
            </div>
        </div>
    );
}

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
    if (toasts.length === 0) return null;
    return (
        <div className="toast-container" aria-live="polite">
            {toasts.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
            ))}
        </div>
    );
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const dismiss = useCallback((id: number) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const showToast = useCallback(
        (type: ToastType, message: string, txid?: string) => {
            const id = ++serial;
            setToasts((prev) => [...prev, { id, type, message, txid }]);
            setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
        },
        [dismiss],
    );

    return (
        <ToastContext.Provider value={{ showToast }}>
            {children}
            <ToastContainer toasts={toasts} onDismiss={dismiss} />
        </ToastContext.Provider>
    );
}

export function useToast() {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error('useToast must be used within ToastProvider');
    return ctx;
}
