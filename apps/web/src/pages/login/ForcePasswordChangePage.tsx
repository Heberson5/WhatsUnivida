import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

/**
 * Shown instead of the whole system while the password is one somebody else chose (an administrator created the
 * account, or set/reset the password): the person chooses their own first. The server refuses everything else until
 * then (middleware/auth.ts), so nothing of the system is even requested from here.
 */
export default function ForcePasswordChangePage() {
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clearSession);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changeMutation = useMutation({
    mutationFn: () => api.post("/profile/password", { currentPassword, newPassword, confirmPassword }),
    onSuccess: () => {
      // Changing the password ends every session, this one included: the person signs in again with the new one.
      toast.success("Senha definida. Entre com a nova senha.");
      clearSession();
    },
    onError: (err) => setError(getApiErrorMessage(err, "Não foi possível alterar a senha")),
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSettled: () => clearSession(),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) return setError("A senha precisa ter pelo menos 8 caracteres");
    if (newPassword !== confirmPassword) return setError("As senhas não coincidem");
    if (newPassword === currentPassword) return setError("A nova senha precisa ser diferente da atual");
    changeMutation.mutate();
  }

  const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2.5 text-sm";
  const type = show ? "text" : "password";

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-alt px-4 py-8">
      <div className="shadow-soft w-full max-w-[420px] rounded-card border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <KeyRound className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Defina a sua senha</h1>
            <p className="text-sm text-muted">{user?.fullName}</p>
          </div>
        </div>
        <p className="mb-4 text-sm text-muted">
          A senha atual foi definida por outra pessoa. Antes de continuar, escolha uma senha que só você conheça: pelo menos 8 caracteres, com
          letra e número.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium">
              Senha atual (a que você recebeu)
            </label>
            <input id="currentPassword" type={type} required autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label htmlFor="newPassword" className="mb-1 block text-sm font-medium">
              Nova senha
            </label>
            <div className="relative">
              <input id="newPassword" type={type} required minLength={8} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={`${inputClass} pr-10`} />
              <button type="button" onClick={() => setShow((s) => !s)} className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 text-muted" aria-label={show ? "Ocultar senhas" : "Mostrar senhas"}>
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div>
            <label htmlFor="confirmPassword" className="mb-1 block text-sm font-medium">
              Confirmar nova senha
            </label>
            <input id="confirmPassword" type={type} required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} />
          </div>

          {error && (
            <p role="alert" className="rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          <button type="submit" disabled={changeMutation.isPending} className="focus-ring w-full rounded-card bg-primary px-4 py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-60">
            {changeMutation.isPending ? "Salvando..." : "Salvar nova senha"}
          </button>
          <button type="button" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending} className="focus-ring w-full rounded-card px-4 py-2 text-sm text-muted hover:bg-surface-alt">
            Sair
          </button>
        </form>
      </div>
    </div>
  );
}
