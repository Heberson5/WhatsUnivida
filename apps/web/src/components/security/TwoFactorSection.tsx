import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { api, getApiErrorMessage } from "../../lib/api";

/**
 * Verificação em duas etapas, as the person manages it for their own account (Meu Perfil, and the screen an
 * Administrador gets when it is required): switch it on by reading a QR Code with an authenticator app and confirming
 * one code, keep the recovery codes shown once, switch it off with the password and a code.
 */

interface Setup {
  secret: string;
  qrCodeDataUrl: string;
}

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";
const codeInputProps = { inputMode: "numeric" as const, autoComplete: "one-time-code", maxLength: 12, placeholder: "000000" };

export function TwoFactorSection({ enabled, canDisable = true, onEnabled, onDisabled }: { enabled: boolean; canDisable?: boolean; onEnabled: () => void; onDisabled?: () => void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const setupMutation = useMutation({
    mutationFn: () => api.post<Setup>("/profile/two-factor/setup"),
    onSuccess: (res) => {
      setSetup(res.data);
      setCode("");
      setError(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const confirmMutation = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>("/profile/two-factor/confirm", { code }),
    onSuccess: (res) => {
      setRecoveryCodes(res.data.recoveryCodes);
      setSetup(null);
      setCode("");
      setError(null);
    },
    onError: (err) => setError(getApiErrorMessage(err, "Não foi possível confirmar o código")),
  });

  const disableMutation = useMutation({
    mutationFn: () => api.post("/profile/two-factor/disable", { password, code }),
    onSuccess: () => {
      setDisabling(false);
      setPassword("");
      setCode("");
      setError(null);
      toast.success("Verificação em duas etapas desativada.");
      onDisabled?.();
    },
    onError: (err) => setError(getApiErrorMessage(err, "Não foi possível desativar")),
  });

  function copyCodes() {
    if (!recoveryCodes) return;
    navigator.clipboard
      .writeText(recoveryCodes.join("\n"))
      .then(() => toast.success("Códigos copiados."))
      .catch(() => toast.error("Não foi possível copiar. Anote os códigos."));
  }

  // The recovery codes, right after switching it on — shown once.
  if (recoveryCodes) {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm font-medium text-success">
          <ShieldCheck className="h-4 w-4" /> Verificação em duas etapas ativada.
        </p>
        <p className="text-sm text-muted">
          Guarde estes códigos de recuperação em um lugar seguro. Se você perder o celular, cada um deles entra no lugar do código do aplicativo,
          uma única vez. <strong>Eles não serão mostrados de novo.</strong>
        </p>
        <div className="grid grid-cols-2 gap-2 rounded-card border border-border bg-surface-alt p-3 font-mono text-sm">
          {recoveryCodes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={copyCodes} className="focus-ring inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-2 text-sm font-semibold hover:bg-surface-alt">
            <Copy className="h-4 w-4" /> Copiar códigos
          </button>
          <button
            type="button"
            onClick={() => {
              setRecoveryCodes(null);
              onEnabled();
            }}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg"
          >
            Já guardei os códigos
          </button>
        </div>
      </div>
    );
  }

  if (enabled) {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm font-medium text-success">
          <ShieldCheck className="h-4 w-4" /> Ativada: além da senha, o login pede o código do aplicativo autenticador.
        </p>
        {!canDisable ? (
          <p className="text-xs text-muted">Obrigatória para administradores — não pode ser desativada.</p>
        ) : !disabling ? (
          <button type="button" onClick={() => setDisabling(true)} className="focus-ring inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-2 text-sm font-semibold hover:bg-surface-alt">
            <ShieldOff className="h-4 w-4" /> Desativar
          </button>
        ) : (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              disableMutation.mutate();
            }}
            className="max-w-sm space-y-3"
          >
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Sua senha</span>
              <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Código do aplicativo (ou um código de recuperação)</span>
              <input required value={code} onChange={(e) => setCode(e.target.value)} {...codeInputProps} className={inputClass} />
            </label>
            {error && (
              <p role="alert" className="rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button type="submit" disabled={disableMutation.isPending} className="focus-ring rounded-card bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                Desativar
              </button>
              <button
                type="button"
                onClick={() => {
                  setDisabling(false);
                  setError(null);
                }}
                className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-alt"
              >
                Cancelar
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  if (setup) {
    return (
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          confirmMutation.mutate();
        }}
        className="space-y-3"
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
          <li>Abra um aplicativo autenticador no celular (Google Authenticator, Microsoft Authenticator, Authy…).</li>
          <li>Leia o QR Code abaixo, ou digite a chave no aplicativo.</li>
          <li>Digite aqui o código de 6 números que o aplicativo mostrar.</li>
        </ol>
        <img src={setup.qrCodeDataUrl} alt="QR Code para o aplicativo autenticador" width={200} height={200} className="rounded-card border border-border bg-white p-2" />
        <p className="break-all text-xs text-muted">
          Chave: <span className="font-mono text-[13px] text-[var(--color-text)]">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</span>
        </p>
        <label className="block max-w-[200px]">
          <span className="mb-1 block text-sm font-medium">Código do aplicativo</span>
          <input required autoFocus value={code} onChange={(e) => setCode(e.target.value)} {...codeInputProps} className={`${inputClass} font-mono tracking-widest`} />
        </label>
        {error && (
          <p role="alert" className="rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="submit" disabled={confirmMutation.isPending} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
            Confirmar e ativar
          </button>
          <button type="button" onClick={() => setSetup(null)} className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-alt">
            Cancelar
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Além da senha, o login passa a pedir um código de 6 números gerado por um aplicativo no seu celular. Mesmo que alguém descubra a sua
        senha, não consegue entrar sem o seu celular.
      </p>
      <button type="button" onClick={() => setupMutation.mutate()} disabled={setupMutation.isPending} className="focus-ring inline-flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
        <ShieldCheck className="h-4 w-4" /> Ativar verificação em duas etapas
      </button>
    </div>
  );
}
