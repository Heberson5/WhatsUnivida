import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { api, getApiErrorMessage } from "../../lib/api";
import { useBranding } from "../../hooks/useBranding";

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const navigate = useNavigate();
  const { data: branding } = useBranding();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("As senhas não coincidem");
      return;
    }
    setLoading(true);
    try {
      await api.post("/auth/reset-password", { token, password });
      setDone(true);
      setTimeout(() => navigate("/login"), 3000);
    } catch (err) {
      setError(getApiErrorMessage(err, "Link inválido ou expirado. Solicite uma nova redefinição."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <div className="shadow-soft w-full max-w-md rounded-card border border-border bg-surface p-8">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          {branding?.logoUrl ? (
            <img src={branding.logoUrl} alt={branding.companyName} className="h-14 w-14 object-contain" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-fg">
              {(branding?.companyName ?? "WA").slice(0, 2).toUpperCase()}
            </div>
          )}
          <h1 className="text-xl font-semibold">Redefinir senha</h1>
        </div>

        {!token && (
          <p className="rounded-card bg-red-50 px-3 py-2 text-center text-sm text-red-700">
            Link de redefinição inválido. Solicite um novo link na tela de login.
          </p>
        )}

        {token && done && (
          <div className="flex flex-col items-center gap-3 text-center text-sm">
            <CheckCircle2 className="h-10 w-10 text-green-600" />
            <p>Senha redefinida com sucesso. Redirecionando para o login...</p>
          </div>
        )}

        {token && !done && (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <label htmlFor="password" className="mb-1 block text-sm font-medium">
                Nova senha
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2.5 pr-10 text-sm"
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

            <div>
              <label htmlFor="confirmPassword" className="mb-1 block text-sm font-medium">
                Confirmar nova senha
              </label>
              <input
                id="confirmPassword"
                type={showPassword ? "text" : "password"}
                required
                minLength={8}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2.5 text-sm"
              />
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
              Redefinir senha
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-sm">
          <Link to="/login" className="focus-ring text-primary hover:underline">
            Voltar ao login
          </Link>
        </p>
      </div>
    </div>
  );
}
