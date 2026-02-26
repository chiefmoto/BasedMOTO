/**
 * Saved cover page sections — Farm & Rebase mechanics.
 * Re-add these inside <div className="cover-lore"> (or after it) in CoverPage.tsx.
 * Also restore the CSS blocks marked below from app.css if they were removed.
 */

// ── JSX ──────────────────────────────────────────────────────────────────────

const FarmSection = () => (
    /* Farm mechanics */
    <section className="cover-section">
        <h2 className="cover-section-title">The Farm</h2>
        <p className="cover-section-body" style={{ marginBottom: '28px' }}>
            BMOTO is distributed to liquidity providers across two pools
            via a halving emission schedule. Each epoch cuts the reward
            rate in half, incentivising early participation.
        </p>

        <div className="cover-pool-grid">
            {/* Pool 1 */}
            <div className="cover-pool-card">
                <div className="cover-pool-header">Pool 1 &mdash; 250,000 BMOTO</div>
                <table className="cover-metrics-table">
                    <tbody>
                        <tr>
                            <td className="cmt-label">Epochs</td>
                            <td className="cmt-value">7</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Epoch length</td>
                            <td className="cmt-value">288 blocks (~2 days)</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Initial rate</td>
                            <td className="cmt-value">434 BMOTO / block</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Halvings</td>
                            <td className="cmt-value">Every epoch</td>
                        </tr>
                    </tbody>
                </table>
                <div className="cover-pool-subheader">Sub-pools</div>
                <table className="cover-metrics-table">
                    <tbody>
                        <tr>
                            <td className="cmt-label">Alpha</td>
                            <td className="cmt-value accent2">70%</td>
                            <td className="cmt-note">PILL / MOTO LP</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Beta</td>
                            <td className="cmt-value accent2">15%</td>
                            <td className="cmt-note">PEPE / MOTO LP</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Gamma</td>
                            <td className="cmt-value accent2">15%</td>
                            <td className="cmt-note">UNGA / MOTO LP</td>
                        </tr>
                    </tbody>
                </table>
            </div>

            {/* Pool 2 */}
            <div className="cover-pool-card">
                <div className="cover-pool-header">Pool 2 &mdash; 750,000 BMOTO</div>
                <table className="cover-metrics-table">
                    <tbody>
                        <tr>
                            <td className="cmt-label">Epochs</td>
                            <td className="cmt-value">9</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Epoch length</td>
                            <td className="cmt-value">432 blocks (~3 days)</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Initial rate</td>
                            <td className="cmt-value">868 BMOTO / block</td>
                        </tr>
                        <tr>
                            <td className="cmt-label">Halvings</td>
                            <td className="cmt-value">Every epoch</td>
                        </tr>
                    </tbody>
                </table>
                <div className="cover-pool-subheader">Sub-pools</div>
                <table className="cover-metrics-table">
                    <tbody>
                        <tr>
                            <td className="cmt-label">Delta</td>
                            <td className="cmt-value accent2">100%</td>
                            <td className="cmt-note">BMOTO / MOTO LP</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </section>
);

const RebaseSection = () => (
    /* Rebase mechanics */
    <section className="cover-section" style={{ marginTop: '36px' }}>
        <h2 className="cover-section-title">The Rebase</h2>
        <p className="cover-section-body" style={{ marginBottom: '28px' }}>
            The Rebaser Oracle enforces Jorge's theorem on-chain.
            It samples the BMOTO/MOTO price continuously and
            adjusts the total supply of every holder proportionally —
            wallet balances change, but ownership share does not.
        </p>
        <table className="cover-metrics-table cover-metrics-full">
            <tbody>
                <tr>
                    <td className="cmt-label">Target peg</td>
                    <td className="cmt-value accent2">1 BMOTO = 1 MOTO</td>
                </tr>
                <tr>
                    <td className="cmt-label">Price feed</td>
                    <td className="cmt-value">On-chain TWAP (BMOTO/MOTO pair)</td>
                </tr>
                <tr>
                    <td className="cmt-label">Min samples</td>
                    <td className="cmt-value">6 unique blocks before rebase</td>
                </tr>
                <tr>
                    <td className="cmt-label">Min interval</td>
                    <td className="cmt-value">144 blocks (~24 hours)</td>
                </tr>
                <tr>
                    <td className="cmt-label">Expansion</td>
                    <td className="cmt-value">BMOTO above peg → supply grows</td>
                </tr>
                <tr>
                    <td className="cmt-label">Contraction</td>
                    <td className="cmt-value">BMOTO below peg → supply shrinks</td>
                </tr>
                <tr>
                    <td className="cmt-label">After rebase</td>
                    <td className="cmt-value">TWAP window resets; fresh accumulation begins</td>
                </tr>
            </tbody>
        </table>
    </section>
);

// ── CSS (keep in app.css) ─────────────────────────────────────────────────────
//
// .cover-pool-grid        — 2-col grid, stacks on mobile
// .cover-pool-card        — dark card with subtle border
// .cover-pool-header      — blue accent title row
// .cover-pool-subheader   — muted label above sub-pool table
// .cover-metrics-table    — full-width borderless table
// .cover-metrics-full     — modifier: no top margin
// .cmt-label              — muted uppercase left cell
// .cmt-value              — white right cell
// .cmt-value.accent2      — green highlighted value
// .cmt-note               — dim third cell (LP name)
//
// All styles are present in app.css under "/* Pool grid */" and "/* Metrics table */"
