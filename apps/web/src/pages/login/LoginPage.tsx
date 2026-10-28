import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowRight, Eye, EyeOff, Loader2, Lock, Mail, Moon, Sun } from "lucide-react";
import clsx from "clsx";
import { toast } from "sonner";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { useBranding } from "../../hooks/useBranding";
import { useLandingPageSettings } from "../../hooks/useLandingPageSettings";
import { useMaintenanceStatus } from "../../hooks/useMaintenanceStatus";
import { useTheme } from "../../hooks/useTheme";
import { MaintenanceScreen } from "./MaintenanceScreen";
import { InstallPromptModal } from "./InstallPromptModal";
import { InstallAppLink } from "./InstallAppLink";

// Glow blobs behind the card — tinted from the active brand colors via
// color-mix (same technique the global body background already uses in
// styles/index.css) so they re-tint automatically for a custom brand
// palette and re-shade automatically between light/dark, with no per-theme
// values to keep in sync by hand. Each drifts along its own wide, irregular
// path (see the login-drift-* keyframes in index.css) — a first pass with a
// small wobble read as motionless against the blur, and a rotating version
// before that read as jarring, so this is translation only, sized to
// actually be seen. Strength is per theme: on the light background the
// tint needs far more color to show (a pastel secondary vanishes on white),
// and the dark one a little more than a whisper.
const GLOW_SPOTS: { className: string; color: "primary" | "secondary"; strength: { light: number; dark: number }; drift: string }[] = [
  { className: "-left-32 -top-36 h-[520px] w-[520px]", color: "primary", strength: { light: 42, dark: 30 }, drift: "animate-login-drift-a" },
  { className: "-right-36 -top-32 h-[480px] w-[480px]", color: "secondary", strength: { light: 70, dark: 34 }, drift: "animate-login-drift-b" },
  { className: "-bottom-40 left-[20%] h-[560px] w-[560px]", color: "primary", strength: { light: 34, dark: 24 }, drift: "animate-login-drift-c" },
  { className: "-bottom-36 -right-32 h-[440px] w-[440px]", color: "secondary", strength: { light: 60, dark: 24 }, drift: "animate-login-drift-d" },
];

export default function LoginPage() {
  const { user, setSession } = useAuthStore();
  const { data: branding } = useBranding();
  const { data: landingPage } = useLandingPageSettings();
  const { data: maintenance, isLoading: maintenanceLoading } = useMaintenanceStatus();
  // The login screen renders before AppLayout (and its Topbar, the only
  // other place this hook was called) ever mounts, so without this the
  // saved/system theme was never applied here — the background and glass
  // card stayed stuck in light mode regardless of the account's or OS's
  // dark-mode preference. See PROMPT: "adaptável para o tema escuro e
  // adaptável quando altera o tema nas configurações".
  const { preference, setTheme } = useTheme();
  const isDark = preference === "DARK" || (preference === "AUTO" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const navigate = useNavigate();

  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem("lastEmail") ?? "";
    } catch {
      return "";
    }
  });
  const [capsLock, setCapsLock] = useState(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);
  // See PROMPT: "isso é somente para o login de atendentes e gerente...
  // somente o administrador" pode acessar durante manutenção. The screen
  // replaces the login form by default (the app has no way to know who's
  // about to log in before they type credentials) — this lets an admin
  // reveal the real form instead. A non-admin who somehow still submits
  // (e.g. right as maintenance flips on) gets the same MAINTENANCE error
  // from the backend surfaced as the normal inline error below.
  const [showAdminLogin, setShowAdminLogin] = useState(false);

  if (user) return <Navigate to="/" replace />;

  // Wait for the maintenance check before deciding which screen to render
  // at all — without this, the very first paint had no data yet
  // (maintenance still undefined/loading) and briefly showed the real
  // login form before flipping to the maintenance screen a moment later,
  // which is exactly the flash the user should never see.
  if (maintenanceLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)]">
        <Loader2 className="h-6 w-6 animate-spin text-muted" />
      </div>
    );
  }

  if (maintenance?.enabled && !showAdminLogin) {
    return <MaintenanceScreen message={maintenance.message} onAdminAccess={() => setShowAdminLogin(true)} />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.post("/auth/login", { email, password, tzOffsetMinutes: new Date().getTimezoneOffset() });
      setSession(res.data.accessToken, res.data.user, res.data.permissions);
      if (remember) localStorage.setItem("lastEmail", email);
      navigate("/");
    } catch (err) {
      setError(getApiErrorMessage(err, "Nao foi possivel entrar"));
    } finally {
      setLoading(false);
    }
  }

  const logoSize = landingPage?.loginLogoSizePx ?? 64;

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[var(--color-bg)] px-4 py-10">
      <InstallPromptModal />

      {/* The glow blobs drift slowly (see GLOW_SPOTS); a faint dot texture
          sits on top, fading out toward the edges. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        {GLOW_SPOTS.map((spot, i) => (
          <div
            key={i}
            className={`absolute rounded-full blur-[70px] ${spot.className} ${spot.drift}`}
            style={{
              background: `radial-gradient(circle, color-mix(in srgb, var(--color-${spot.color}) ${isDark ? spot.strength.dark : spot.strength.light}%, transparent), transparent 68%)`,
            }}
          />
        ))}
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage: "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--color-text) 9%, transparent) 1px, transparent 0)",
            backgroundSize: "18px 18px",
            maskImage: "radial-gradient(ellipse at center, #000 25%, transparent 72%)",
            WebkitMaskImage: "radial-gradient(ellipse at center, #000 25%, transparent 72%)",
          }}
        />
      </div>

      <button
        type="button"
        onClick={() => setTheme(isDark ? "LIGHT" : "DARK")}
        className="focus-ring absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface/80 text-muted backdrop-blur hover:text-[var(--color-text)]"
        aria-label={isDark ? "Usar tema claro" : "Usar tema escuro"}
        title={isDark ? "Tema claro" : "Tema escuro"}
      >
        {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>

      <div className="relative w-full max-w-[400px]">
        <div className="shadow-elevated rounded-[20px] border border-border bg-surface p-7 sm:p-9">
          <div
            className={`mb-7 flex flex-col gap-3 ${
              landingPage?.loginLogoAlign === "left" ? "items-start text-left" : "items-center text-center"
            }`}
          >
            {branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.companyName} className="object-contain" style={{ width: logoSize, height: logoSize }} />
            ) : (
              <div
                className="flex items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-fg shadow-[0_10px_24px_color-mix(in_srgb,var(--color-primary)_35%,transparent)]"
                style={{ width: logoSize, height: logoSize }}
              >
                {(branding?.companyName ?? "WA").slice(0, 2).toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{branding?.companyName ?? "WhatsAtendende"}</h1>
              <p className="text-sm text-muted">{landingPage?.loginSubtitle || "Plataforma de atendimento via WhatsApp"}</p>
            </div>
          </div>

          {forgotOpen ? (
            <ForgotPasswordForm onBack={() => setForgotOpen(false)} />
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium">
                  E-mail
                </label>
                <div className="relative flex items-center">
                  <Mail className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted" />
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="focus-ring w-full rounded-card border border-border bg-[var(--color-surface-alt)] py-2.5 pl-10 pr-3 text-sm focus:bg-surface"
                    placeholder="voce@empresa.com"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="password" className="mb-1 block text-sm font-medium">
                  Senha
                </label>
                <div className="relative flex items-center">
                  <Lock className="pointer-events-none absolute left-3.5 h-4 w-4 text-muted" />
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                    onKeyUp={(e) => setCapsLock(e.getModifierState("CapsLock"))}
                    onBlur={() => setCapsLock(false)}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? "login-error" : capsLock ? "caps-lock-warning" : undefined}
                    className={clsx(
                      "focus-ring w-full rounded-card border bg-[var(--color-surface-alt)] py-2.5 pl-10 pr-10 text-sm focus:bg-surface",
                      error ? "border-danger" : "border-border"
                    )}
                    placeholder="********"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="focus-ring absolute right-2 text-muted"
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {capsLock && (
                  <p id="caps-lock-warning" className="mt-1.5 flex items-center gap-1 text-xs font-medium text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" /> Caps Lock está ligado
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
                  Lembrar acesso
                </label>
                <button type="button" onClick={() => setForgotOpen(true)} className="focus-ring font-medium text-primary hover:underline">
                  Esqueci a senha
                </button>
              </div>

              {error && (
                <p id="login-error" role="alert" className="flex items-start gap-2 rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="focus-ring flex w-full items-center justify-center gap-2 rounded-card bg-primary py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-70"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Entrando…
                  </>
                ) : (
                  <>
                    Entrar <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>
            </form>
          )}

          <InstallAppLink />
        </div>
        <p className="mt-5 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-center text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_0_3px_rgba(34,197,94,0.18)]" /> Sistema funcionando
          </span>
          <span aria-hidden>·</span>
          <span>Problemas para entrar? Fale com o administrador</span>
        </p>
      </div>
    </div>
  );
}

function ForgotPasswordForm({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
      toast.success("Se o e-mail existir, um link de redefinição foi enviado.");
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="space-y-4 text-center text-sm">
        <p>Verifique seu e-mail para continuar a redefinição de senha.</p>
        <button onClick={onBack} className="focus-ring text-primary hover:underline">
          Voltar ao login
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-muted">Informe seu e-mail cadastrado para receber o link de redefinição.</p>
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="focus-ring w-full rounded-card border border-border bg-[var(--color-surface-alt)] px-3 py-2.5 text-sm"
        placeholder="voce@empresa.com"
      />
      <div className="flex gap-2">
        <button type="button" onClick={onBack} className="focus-ring flex-1 rounded-card border border-border py-2.5 text-sm">
          Voltar
        </button>
        <button
          type="submit"
          disabled={loading}
          className="focus-ring flex-1 rounded-card bg-primary py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-60"
        >
          Enviar
        </button>
      </div>
    </form>
  );
}
