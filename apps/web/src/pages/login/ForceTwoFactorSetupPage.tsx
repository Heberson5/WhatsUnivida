import { useMutation } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { TwoFactorSection } from "../../components/security/TwoFactorSection";

/**
 * Shown instead of the whole system to an Administrador who has to switch the verificação em duas etapas on first
 * (Configurações › Segurança). The server refuses everything else until then (middleware/auth.ts).
 */
export default function ForceTwoFactorSetupPage() {
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clearSession);
  const logoutMutation = useMutation({ mutationFn: () => api.post("/auth/logout"), onSettled: () => clearSession() });

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-alt px-4 py-8">
      <div className="shadow-soft w-full max-w-[460px] rounded-card border border-border bg-surface p-6">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold">Ative a verificação em duas etapas</h1>
            <p className="text-sm text-muted">{user?.fullName}</p>
          </div>
        </div>
        <p className="mb-4 text-sm text-muted">Ela é obrigatória para administradores. Depois de ativar, entre de novo com a senha e o código do aplicativo.</p>
        <TwoFactorSection
          enabled={false}
          onEnabled={() => {
            // The session was opened without the second step: the person signs in again, now with it.
            toast.success("Verificação em duas etapas ativada. Entre de novo.");
            logoutMutation.mutate();
          }}
        />
        <button type="button" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending} className="focus-ring mt-4 w-full rounded-card px-4 py-2 text-sm text-muted hover:bg-surface-alt">
          Sair
        </button>
      </div>
    </div>
  );
}
