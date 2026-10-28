import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ShieldCheck, Wrench } from "lucide-react";

/**
 * Full-screen "system in maintenance" experience shown to AGENT/MANAGER on
 * the login screen while maintenance mode is on — see PROMPT: "uma tela
 * inovadora, linda, com design futurista em 3d, isso é somente para o
 * login de atendentes e gerente". An ADMIN never sees this by default;
 * `onAdminAccess` reveals the normal login form for them.
 *
 * Pure CSS 3D (perspective + pointer-tracked tilt, animated depth layers) —
 * no new animation/3D dependency for a single screen.
 */
export function MaintenanceScreen({ message, onAdminAccess }: { message: string | null; onAdminAccess: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width - 0.5; // -0.5..0.5
    const py = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: py * -10, y: px * 14 });
  }

  return (
    <div
      onPointerMove={handlePointerMove}
      onPointerLeave={() => setTilt({ x: 0, y: 0 })}
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#05060f] px-4 py-10"
      style={{ perspective: "1400px" }}
    >
      <MaintenanceScreenStyles />

      {/* Depth layer 0: starfield */}
      <div className="maint-stars absolute inset-0" />

      {/* Depth layer 1: drifting aurora blobs */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="maint-blob maint-blob-a" />
        <div className="maint-blob maint-blob-b" />
        <div className="maint-blob maint-blob-c" />
      </div>

      {/* Depth layer 2: perspective floor grid */}
      <div className="maint-floor pointer-events-none absolute inset-x-0 bottom-0 h-1/2" />

      {/* Foreground: tilted glass console */}
      <div
        ref={stageRef}
        className="maint-card relative w-full max-w-lg rounded-[28px] border border-white/10 bg-white/5 p-8 text-center shadow-2xl backdrop-blur-2xl sm:p-10"
        style={{ transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` }}
      >
        <div className="maint-ring-orbit mx-auto mb-7 flex h-28 w-28 items-center justify-center">
          <div className="maint-ring" />
          <div className="maint-ring maint-ring-delay" />
          <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-cyan-400 to-primary shadow-[0_0_40px_rgba(34,211,238,0.55)]">
            <Wrench className="h-7 w-7 text-white" />
          </div>
        </div>

        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.3em] text-cyan-300/80">Sistema em atualização</p>
        <h1 className="maint-title text-3xl font-bold text-white sm:text-4xl">Voltamos já</h1>
        <p className="mx-auto mt-4 max-w-sm text-sm leading-relaxed text-white/60">
          {message || "Estamos em manutenção programada para deixar o atendimento ainda mais rápido. Tente novamente em instantes."}
        </p>

        <div className="mt-7 flex items-center justify-center gap-2 text-xs text-white/40">
          <span className="maint-dot" />
          <span className="maint-dot" style={{ animationDelay: "0.2s" }} />
          <span className="maint-dot" style={{ animationDelay: "0.4s" }} />
        </div>

        <button
          type="button"
          onClick={onAdminAccess}
          className="focus-ring mt-9 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-medium text-white/70 transition hover:border-white/30 hover:bg-white/10 hover:text-white"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          Acesso administrativo
        </button>
      </div>
    </div>
  );
}

function MaintenanceScreenStyles() {
  return (
    <style>{`
      .maint-card { transform-style: preserve-3d; transition: transform 120ms ease-out; }
      .maint-stars {
        background-image: radial-gradient(1.5px 1.5px at 20% 30%, rgba(255,255,255,0.55) 50%, transparent 51%),
          radial-gradient(1.5px 1.5px at 70% 20%, rgba(255,255,255,0.4) 50%, transparent 51%),
          radial-gradient(1px 1px at 40% 70%, rgba(255,255,255,0.5) 50%, transparent 51%),
          radial-gradient(1.5px 1.5px at 85% 65%, rgba(255,255,255,0.35) 50%, transparent 51%),
          radial-gradient(1px 1px at 10% 85%, rgba(255,255,255,0.4) 50%, transparent 51%),
          radial-gradient(1.5px 1.5px at 55% 45%, rgba(255,255,255,0.3) 50%, transparent 51%),
          radial-gradient(1px 1px at 92% 15%, rgba(255,255,255,0.45) 50%, transparent 51%);
        background-size: 100% 100%;
        opacity: 0.8;
        animation: maint-twinkle 4s ease-in-out infinite alternate;
      }
      @keyframes maint-twinkle { from { opacity: 0.5; } to { opacity: 0.9; } }

      .maint-blob { position: absolute; border-radius: 9999px; filter: blur(70px); opacity: 0.45; }
      .maint-blob-a { top: -10%; left: -8%; width: 420px; height: 420px; background: radial-gradient(circle, var(--color-primary, #0097B4), transparent 70%); animation: maint-drift-a 18s ease-in-out infinite; }
      .maint-blob-b { bottom: -15%; right: -10%; width: 480px; height: 480px; background: radial-gradient(circle, #7c3aed, transparent 70%); animation: maint-drift-b 22s ease-in-out infinite; }
      .maint-blob-c { top: 35%; right: 15%; width: 300px; height: 300px; background: radial-gradient(circle, #22d3ee, transparent 70%); animation: maint-drift-c 16s ease-in-out infinite; }
      @keyframes maint-drift-a { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(60px,40px) scale(1.15); } }
      @keyframes maint-drift-b { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-50px,-30px) scale(1.1); } }
      @keyframes maint-drift-c { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-40px,50px); } }

      .maint-floor {
        background-image: linear-gradient(rgba(34,211,238,0.18) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.18) 1px, transparent 1px);
        background-size: 48px 48px;
        transform: perspective(500px) rotateX(60deg) scale(2.2);
        transform-origin: bottom;
        mask-image: linear-gradient(to top, black, transparent);
        -webkit-mask-image: linear-gradient(to top, black, transparent);
      }

      .maint-ring-orbit { position: relative; }
      .maint-ring { position: absolute; inset: 0; border-radius: 9999px; border: 1px solid rgba(34,211,238,0.35); animation: maint-spin 6s linear infinite; }
      .maint-ring::before { content: ""; position: absolute; top: -3px; left: 50%; width: 6px; height: 6px; margin-left: -3px; border-radius: 9999px; background: #22d3ee; box-shadow: 0 0 10px 2px rgba(34,211,238,0.8); }
      .maint-ring-delay { animation-duration: 9s; animation-direction: reverse; opacity: 0.5; inset: -10px; }
      @keyframes maint-spin { to { transform: rotate(360deg); } }

      .maint-title { text-shadow: 0 0 30px rgba(34,211,238,0.35); }

      .maint-dot { width: 6px; height: 6px; border-radius: 9999px; background: currentColor; display: inline-block; animation: maint-pulse-dot 1.2s ease-in-out infinite; }
      @keyframes maint-pulse-dot { 0%,80%,100% { opacity: 0.25; transform: scale(0.85); } 40% { opacity: 1; transform: scale(1); } }

      @media (prefers-reduced-motion: reduce) {
        .maint-stars, .maint-blob, .maint-ring, .maint-dot { animation: none !important; }
        .maint-card { transition: none !important; }
      }
    `}</style>
  );
}
