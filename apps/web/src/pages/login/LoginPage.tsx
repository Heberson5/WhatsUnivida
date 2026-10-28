import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { useBranding } from "../../hooks/useBranding";
import { useMaintenanceStatus } from "../../hooks/useMaintenanceStatus";
import { MaintenanceScreen } from "./MaintenanceScreen";
import { InstallPromptModal } from "./InstallPromptModal";

export default function LoginPage() {
  const { user, setSession } = useAuthStore();
  const { data: branding } = useBranding();
  const { data: maintenance, isLoading: maintenanceLoading } = useMaintenanceStatus();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
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
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)]">
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

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <InstallPromptModal />
      <div className="shadow-soft w-full max-w-md rounded-card border border-border bg-surface p-8">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          {branding?.logoUrl ? (
            <img src={branding.logoUrl} alt={branding.companyName} className="h-14 w-14 object-contain" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-fg">
              {(branding?.companyName ?? "WA").slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-xl font-semibold">{branding?.companyName ?? "WhatsUnivida"}</h1>
            <p className="text-sm text-muted">Plataforma de atendimento via WhatsApp</p>
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
              <input
                id="email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2.5 text-sm"
                placeholder="voce@empresa.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium">
                Senha
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2.5 pr-10 text-sm"
                  placeholder="********"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 text-muted"
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Lembrar acesso
              </label>
              <button type="button" onClick={() => setForgotOpen(true)} className="focus-ring text-primary hover:underline">
                Recuperar senha
              </button>
            </div>

            {error && (
              <p role="alert" className="rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="focus-ring flex w-full items-center justify-center gap-2 rounded-card bg-primary py-2.5 text-sm font-semibold text-primary-fg transition hover:opacity-90 disabled:opacity-60"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Entrar
            </button>
          </form>
        )}
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
        className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2.5 text-sm"
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
