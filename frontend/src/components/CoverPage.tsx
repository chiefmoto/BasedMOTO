import { useState, useEffect, useRef } from 'react';

interface CoverPageProps {
    onEnter: () => void;
}

export function CoverPage({ onEnter }: CoverPageProps) {
    const [visible, setVisible] = useState(false);
    const [exiting, setExiting] = useState(false);
    const motoRef       = useRef<HTMLImageElement>(null);
    const moto2Ref      = useRef<HTMLImageElement>(null);
    const pageRef       = useRef<HTMLDivElement>(null);
    const canvasRef     = useRef<HTMLCanvasElement>(null);
    const canvas2Ref    = useRef<HTMLCanvasElement>(null);
    const motoTrackRef  = useRef<HTMLDivElement>(null);
    const moto2TrackRef = useRef<HTMLDivElement>(null);
    const motoXRef      = useRef(-400);
    const lastXRef      = useRef(-400);
    const moto2XRef     = useRef(2000);
    const last2XRef     = useRef(2000);
    const prevScrollRef = useRef(0);

    useEffect(() => {
        const t = setTimeout(() => setVisible(true), 80);
        return () => clearTimeout(t);
    }, []);

    // Scroll → motorcycle position
    useEffect(() => {
        const el = pageRef.current;
        if (!el) return;
        const localProgress = (trackEl: HTMLDivElement, multiplier = 1.5) => {
            const trackTop = trackEl.offsetTop;
            const trackH   = trackEl.offsetHeight;
            const enterAt  = Math.max(0, trackTop - el.clientHeight * multiplier);
            const exitAt   = trackTop + trackH;
            const range    = exitAt - enterAt;
            return range > 0 ? Math.max(0, Math.min(1, (el.scrollTop - enterAt) / range)) : 0;
        };

        const handleScroll = () => {
            const scrollingUp = el.scrollTop < prevScrollRef.current;
            prevScrollRef.current = el.scrollTop;

            if (motoRef.current && motoTrackRef.current) {
                const progress = localProgress(motoTrackRef.current);
                const motoW = motoRef.current.offsetWidth;
                const translateX = progress * (el.clientWidth + motoW) - motoW;
                // Scrolling down: faces right (normal). Scrolling up: faces left (flipped).
                const flip = scrollingUp ? ' scaleX(-1)' : '';
                motoRef.current.style.transform = `translateX(${translateX}px)${flip}`;
                motoXRef.current = translateX;
            }

            if (moto2Ref.current && moto2TrackRef.current) {
                const maxScroll = el.scrollHeight - el.clientHeight;
                const trackTop  = moto2TrackRef.current.offsetTop;
                const trackH    = moto2TrackRef.current.offsetHeight;
                const enterAt   = Math.max(0, trackTop - el.clientHeight * 5);
                const exitAt    = maxScroll * 0.96;
                const range     = exitAt - enterAt;
                const progress  = range > 0 ? Math.max(0, Math.min(1, (el.scrollTop - enterAt) / range)) : 0;
                const motoW = moto2Ref.current.offsetWidth;
                const translateX = (1 - progress) * (el.clientWidth + motoW) - motoW;
                // Scrolling down: faces left (normal). Scrolling up: faces right (flipped).
                const flip = scrollingUp ? ' scaleX(-1)' : '';
                moto2Ref.current.style.transform = `translateX(${translateX}px)${flip}`;
                moto2XRef.current = translateX;
            }
        };
        el.addEventListener('scroll', handleScroll, { passive: true });
        handleScroll();
        return () => el.removeEventListener('scroll', handleScroll);
    }, []);

    // Particle exhaust animation
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        type Particle = { x: number; y: number; vx: number; vy: number; r: number; life: number; maxLife: number };
        const particles: Particle[] = [];

        const resize = () => {
            canvas.width  = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        };
        resize();
        window.addEventListener('resize', resize);

        let rafId: number;
        const animate = () => {
            rafId = requestAnimationFrame(animate);
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const motoX = motoXRef.current;
            const speed = motoX - lastXRef.current;
            lastXRef.current = motoX;

            const motoImg = motoRef.current;
            if (motoImg && Math.abs(speed) > 0.3) {
                const motoW    = motoImg.offsetWidth;
                const goingRight = speed > 0;
                // Exhaust from back: left edge when going right, right edge when going left
                const exhaustX = goingRight ? motoX + 4 : motoX + motoW - 4;
                const exhaustY = canvas.height * 0.72;
                const count    = Math.min(Math.ceil(Math.abs(speed) * 1.2), 5);
                for (let i = 0; i < count; i++) {
                    particles.push({
                        x: exhaustX + (Math.random() - 0.5) * 6,
                        y: exhaustY + (Math.random() - 0.5) * 10,
                        vx: goingRight
                            ? -(Math.random() * 1.5 + Math.abs(speed) * 0.4)
                            :  (Math.random() * 1.5 + Math.abs(speed) * 0.4),
                        vy: (Math.random() - 0.6) * 0.8,
                        r: Math.random() * 4 + 3,
                        life: 1,
                        maxLife: 1,
                    });
                }
            }

            // Update & draw
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.x  += p.vx;
                p.y  += p.vy;
                p.vx *= 0.97;
                p.r  += 0.25;
                p.life -= 0.028;
                if (p.life <= 0) { particles.splice(i, 1); continue; }
                const alpha = p.life * 0.45;
                const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
                grad.addColorStop(0, `rgba(200, 180, 220, ${alpha})`);
                grad.addColorStop(1, `rgba(120, 90, 160, 0)`);
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
            }
        };
        animate();
        return () => {
            cancelAnimationFrame(rafId);
            window.removeEventListener('resize', resize);
        };
    }, []);

    // Particle exhaust — moto2 (right to left, exhaust from right side)
    useEffect(() => {
        const canvas = canvas2Ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        type Particle = { x: number; y: number; vx: number; vy: number; r: number; life: number };
        const particles: Particle[] = [];

        const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
        resize();
        window.addEventListener('resize', resize);

        let rafId: number;
        const animate = () => {
            rafId = requestAnimationFrame(animate);
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const motoX = moto2XRef.current;
            const speed = last2XRef.current - motoX; // positive when moving left
            last2XRef.current = motoX;

            if (moto2Ref.current && Math.abs(speed) > 0.3) {
                const motoW    = moto2Ref.current.offsetWidth;
                const goingLeft = speed > 0;
                // Exhaust from back: right edge when going left, left edge when going right
                const exhaustX = goingLeft ? motoX + motoW - 4 : motoX + 4;
                const exhaustY = canvas.height * 0.72;
                const count    = Math.min(Math.ceil(Math.abs(speed) * 1.2), 5);
                for (let i = 0; i < count; i++) {
                    particles.push({
                        x: exhaustX + (Math.random() - 0.5) * 6,
                        y: exhaustY + (Math.random() - 0.5) * 10,
                        vx: goingLeft
                            ?  (Math.random() * 1.5 + Math.abs(speed) * 0.4)
                            : -(Math.random() * 1.5 + Math.abs(speed) * 0.4),
                        vy: (Math.random() - 0.6) * 0.8,
                        r: Math.random() * 4 + 3,
                        life: 1,
                    });
                }
            }

            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.x += p.vx; p.y += p.vy; p.vx *= 0.97; p.r += 0.25; p.life -= 0.028;
                if (p.life <= 0) { particles.splice(i, 1); continue; }
                const alpha = p.life * 0.45;
                const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
                grad.addColorStop(0, `rgba(200, 180, 220, ${alpha})`);
                grad.addColorStop(1, `rgba(120, 90, 160, 0)`);
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                ctx.fillStyle = grad;
                ctx.fill();
            }
        };
        animate();
        return () => { cancelAnimationFrame(rafId); window.removeEventListener('resize', resize); };
    }, []);

    function handleEnter() {
        setExiting(true);
        setTimeout(onEnter, 600);
    }

    return (
        <div ref={pageRef} className={`cover-page${visible ? ' cover-visible' : ''}${exiting ? ' cover-exiting' : ''}`}>
            <div className="cover-inner">

                {/* Logo */}
                <div className="cover-logo-wrap">
                    <p className="cover-introducing">Introducing</p>
                    <img src="/basedmotologo.png" alt="basedMOTO" className="cover-logo-img" />
                </div>

                {/* Lore — above bust */}
                <section className="cover-section cover-lore">
                    <div className="cover-lore-col">
                        <h2 className="cover-section-title">Genesis</h2>
                        <p className="cover-section-body">
                            Jorge had a vision. After ruling the Cardano Empire with an iron
                            fist for 4 years and amassing a 6 figure net worth, he realized
                            that he wanted something more. The empire was prosperous,
                            but it was built on sand. Jorge sought Roman concrete, a legacy
                            that would last til the end of time. So he gave up his throne,
                            hopped on his bike, and rode off into the sunset. He now had his
                            sights on Bitcoin — the only chain BASED enough for a King.
                        </p>
                    </div>
                    <div className="cover-lore-divider" />
                    <div className="cover-lore-col">
                        <p className="cover-section-body">
                            On Bitcoin, Jorge discovered OPNet — a native smart contract
                            layer forged directly into the chain — and alongside it,
                            MotoSwap, the decentralized exchange built on top of it.
                            This was innovation that a blockchain expert like himself
                            could truly appreciate. He quickly rose up the ranks of
                            the MOTO community through several displays of sheer genius,
                            and before long was crowned MOTO Supreme Leader. Among those
                            who recognized Jorge's brilliance was a mysterious consortium
                            who called themselves "the Reserve", whose own vision of
                            blockchain supremacy
                            perfectly aligned with Jorge's. Impressed by their financial
                            aptitude, Jorge agreed to collaborate with them on what would
                            become the basedMOTO Reserve — structured deliberately in the
                            image of the Federal Reserve, with Jorge serving as Chairman
                            and the rest of the consortium members forming the Board. From that alliance,
                            the theorem was born: no token can claim sound money status without being
                            anchored to MOTO. The most honest monetary policy any asset
                            can adopt is to rebase its supply to the price of MOTO.
                        </p>
                    </div>
                    <div className="cover-lore-divider" />
                    <div className="cover-lore-col">
                        <h2 className="cover-section-title">The basedMOTO Protocol</h2>
                        <p className="cover-section-body">
                            basedMOTO is the on-chain embodiment of that theorem —
                            the first rebase token built natively on Bitcoin, engineered
                            by Jorge and the Reserve. Its supply expands and contracts
                            automatically, guided by the MOTO/basedMOTO TWAP oracle,
                            enforcing what the market already knows to be true. The
                            basedMOTO Reserve holds the keys to the kingdom. Jorge's
                            bust watches over the protocol. His vision is consensus.
                            Their theorem is code.
                        </p>
                    </div>
                </section>

                {/* Motorcycle scroll animation */}
                <div ref={motoTrackRef} className="cover-moto-track">
                    <canvas ref={canvasRef} className="cover-moto-canvas" />
                    <img ref={motoRef} src="/motobike.png" alt="" className="cover-moto" />
                </div>

                <div className="cover-divider" />

                {/* Hero */}
                <div className="cover-hero">
                    <div className="cover-bust-row">
                    <img src="/pillar.png" alt="" className="cover-pillar" />
                    <div className="cover-jorge-wrap">
                        <div className="cover-jorge-frame">
                            <img src="/jorge.png" alt="Jorge" className="cover-jorge" />
                            <div className="cover-jorge-label">
                                <div className="cover-jorge-label-name">Jorge Cabezas</div>
                                <div className="cover-jorge-label-title">Cardano Emperor 2022 AD</div>
                            </div>
                        </div>
                    </div>
                    <img src="/pillar.png" alt="" className="cover-pillar cover-pillar-right" />
                    </div>
                </div>

                <div className="cover-divider" />

                {/* Farm mechanics */}
                <section className="cover-section">
                    <h2 className="cover-section-title">The Farm</h2>
                    <p className="cover-section-body" style={{ marginBottom: '28px' }}>
                        basedMOTO is distributed to liquidity providers across two pools
                        via a halving emission schedule. Each epoch cuts the reward
                        rate in half, incentivising early participation.
                    </p>

                    <div className="cover-pool-grid">
                        <div className="cover-pool-card">
                            <div className="cover-pool-header">Pool 1 &mdash; 250,000 basedMOTO</div>
                            <table className="cover-metrics-table">
                                <tbody>
                                    <tr><td className="cmt-label">Epochs</td><td className="cmt-value">7</td></tr>
                                    <tr><td className="cmt-label">Epoch length</td><td className="cmt-value">288 blocks (~2 days)</td></tr>
                                    <tr><td className="cmt-label">Initial rate</td><td className="cmt-value">434 basedMOTO / block</td></tr>
                                    <tr><td className="cmt-label">Halvings</td><td className="cmt-value">Every epoch</td></tr>
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

                        <div className="cover-pool-card">
                            <div className="cover-pool-header">Pool 2 &mdash; 750,000 basedMOTO</div>
                            <table className="cover-metrics-table">
                                <tbody>
                                    <tr><td className="cmt-label">Epochs</td><td className="cmt-value">9</td></tr>
                                    <tr><td className="cmt-label">Epoch length</td><td className="cmt-value">432 blocks (~3 days)</td></tr>
                                    <tr><td className="cmt-label">Initial rate</td><td className="cmt-value">868 basedMOTO / block</td></tr>
                                    <tr><td className="cmt-label">Halvings</td><td className="cmt-value">Every epoch</td></tr>
                                </tbody>
                            </table>
                            <div className="cover-pool-subheader">Sub-pools</div>
                            <table className="cover-metrics-table">
                                <tbody>
                                    <tr>
                                        <td className="cmt-label">Delta</td>
                                        <td className="cmt-value accent2">100%</td>
                                        <td className="cmt-note">basedMOTO / MOTO LP</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>

                {/* Rebase mechanics */}
                <section className="cover-section" style={{ marginTop: '36px' }}>
                    <h2 className="cover-section-title">The Rebase</h2>
                    <p className="cover-section-body" style={{ marginBottom: '28px' }}>
                        The Rebaser Oracle enforces Jorge's theorem on-chain.
                        It samples the basedMOTO/MOTO price continuously and
                        adjusts the total supply of every holder proportionally —
                        wallet balances change, but ownership share does not.
                    </p>
                    <table className="cover-metrics-table cover-metrics-full">
                        <tbody>
                            <tr><td className="cmt-label">Target peg</td><td className="cmt-value accent2">1 basedMOTO = 1 MOTO</td></tr>
                            <tr><td className="cmt-label">Price feed</td><td className="cmt-value">On-chain TWAP (basedMOTO/MOTO pair)</td></tr>
                            <tr><td className="cmt-label">Min samples</td><td className="cmt-value">6 unique blocks before rebase</td></tr>
                            <tr><td className="cmt-label">Min interval</td><td className="cmt-value">144 blocks (~24 hours)</td></tr>
                            <tr><td className="cmt-label">Expansion</td><td className="cmt-value">basedMOTO above peg → supply grows</td></tr>
                            <tr><td className="cmt-label">Contraction</td><td className="cmt-value">basedMOTO below peg → supply shrinks</td></tr>
                            <tr><td className="cmt-label">After rebase</td><td className="cmt-value">TWAP window resets; fresh accumulation begins</td></tr>
                        </tbody>
                    </table>
                </section>

                {/* Motorcycle 2 — right to left */}
                <div ref={moto2TrackRef} className="cover-moto-track">
                    <canvas ref={canvas2Ref} className="cover-moto-canvas" />
                    <img ref={moto2Ref} src="/motobike2.png" alt="" className="cover-moto" />
                </div>

                <div className="cover-divider" />

                {/* Jorge dip + CTA */}
                <div className="cover-jorgedip-wrap">
                    <img src="/jorgedip.jpg" alt="" className="cover-jorgedip" />
                    <button className="cover-pool-btn" onClick={handleEnter}>
                        Pool Entrance
                    </button>
                </div>

                <p className="cover-disclaimer">
                    First rebase token on Bitcoin L1 · Powered by OPNet
                </p>
            </div>
        </div>
    );
}
