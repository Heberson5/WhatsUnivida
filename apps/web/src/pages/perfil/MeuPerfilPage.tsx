import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2, Volume2, X } from "lucide-react";
import { toast } from "sonner";
import type { UserDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { playAlertSound } from "../../lib/alert-sounds";

const ROLE_LABEL: Record<string, string> = { ADMIN: "Administrador", MANAGER: "Gestor", AGENT: "Atendente" };

export default function MeuPerfilPage() {
  const user = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);
  const accessToken = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  const photoInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);

  function applyUser(updated: UserDTO) {
    if (accessToken) setSession(accessToken, updated);
    queryClient.invalidateQueries({ queryKey: ["users"] });
  }

  const photoMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post<UserDTO>("/profile/photo", form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: (res) => {
      applyUser(res.data);
      toast.success("Foto atualizada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const removePhotoMutation = useMutation({
    mutationFn: () => api.delete<UserDTO>("/profile/photo"),
    onSuccess: (res) => {
      applyUser(res.data);
      toast.success("Foto removida.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const passwordMutation = useMutation({
    mutationFn: () => api.post("/profile/password", { currentPassword, newPassword, confirmPassword }),
    onSuccess: () => {
      toast.success("Senha alterada com sucesso.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    },
    onError: (err) => setPasswordError(getApiErrorMessage(err)),
  });

  // Back to the screen the profile was opened from; opened straight from the address bar, to the start screen.
  const close = useCallback(() => {
    if ((window.history.state as { idx?: number } | null)?.idx) navigate(-1);
    else navigate("/", { replace: true });
  }, [navigate]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (e.key === "Escape" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  function handlePasswordSubmit(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("As senhas não coincidem");
      return;
    }
    passwordMutation.mutate();
  }

  if (!user) return null;

  return (
    <div className="h-full overflow-auto p-3 sm:p-6">
      <div className="relative mx-auto flex max-w-2xl flex-col gap-6 pt-12 sm:pt-0">
        <button
          type="button"
          onClick={close}
          className="focus-ring shadow-soft absolute end-0 top-0 rounded-full border border-border bg-surface p-2 text-muted hover:bg-surface-alt hover:text-[var(--color-text)] sm:-end-14"
          aria-label="Fechar e voltar"
          title="Fechar e voltar"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="shadow-soft rounded-card border border-border bg-surface p-6">
          <h2 className="mb-4 text-base font-semibold">Foto de perfil</h2>
          <div className="flex items-center gap-4">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-primary text-2xl font-semibold text-primary-fg">
              {user.photoUrl ? (
                <img src={user.photoUrl} alt={user.displayName} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">{user.displayName.slice(0, 1).toUpperCase()}</div>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <input
                ref={photoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) photoMutation.mutate(file);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={photoMutation.isPending}
                className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
              >
                <Camera className="h-4 w-4" /> {photoMutation.isPending ? "Enviando..." : "Alterar foto"}
              </button>
              {user.photoUrl && (
                <button
                  type="button"
                  onClick={() => removePhotoMutation.mutate()}
                  disabled={removePhotoMutation.isPending}
                  className="focus-ring flex items-center gap-1.5 text-sm text-red-600 hover:underline disabled:opacity-60"
                >
                  <Trash2 className="h-4 w-4" /> Remover foto
                </button>
              )}
              <p className="text-xs text-muted">PNG, JPEG ou WEBP, até 8MB.</p>
            </div>
          </div>
        </div>

        <section className="shadow-soft space-y-3 rounded-card border border-border bg-surface p-6">
          <h2 className="mb-1 text-base font-semibold">Dados pessoais</h2>
          <Field label="Nome completo">
            <input disabled value={user.fullName} className="w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm text-muted" />
          </Field>
          <Field label="E-mail">
            <input disabled value={user.email} className="w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm text-muted" />
          </Field>
          <Field label="Perfil">
            <input disabled value={ROLE_LABEL[user.role] ?? user.role} className="w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm text-muted" />
          </Field>
          <p className="text-xs text-muted">Para alterar o nome, fale com o gestor ou o administrador.</p>
        </section>

        <SoundsSection user={user} onSaved={applyUser} />

        <form onSubmit={handlePasswordSubmit} className="shadow-soft space-y-3 rounded-card border border-border bg-surface p-6">
          <h2 className="mb-1 text-base font-semibold">Alterar senha</h2>
          <Field label="Senha atual">
            <input required type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="Nova senha">
            <input required type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="Confirmar nova senha">
            <input required type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          {passwordError && <p className="rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">{passwordError}</p>}
          <div className="pt-1">
            <button type="submit" disabled={passwordMutation.isPending} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
              {passwordMutation.isPending ? "Alterando..." : "Alterar senha"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

type SoundPatch = Partial<Pick<UserDTO, "soundNewMessage" | "soundNewQueue" | "soundVolume">>;

function SoundsSection({ user, onSaved }: { user: UserDTO; onSaved: (user: UserDTO) => void }) {
  const [volume, setVolume] = useState(user.soundVolume);
  const soundsMutation = useMutation({
    mutationFn: async (patch: SoundPatch) => (await api.patch<UserDTO>("/profile/sounds", patch)).data,
    onSuccess: onSaved,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <section className="shadow-soft space-y-3 rounded-card border border-border bg-surface p-6">
      <h2 className="mb-1 text-base font-semibold">Sons</h2>
      {(
        [
          ["soundNewMessage", "newMessage", "Nova mensagem de cliente"],
          ["soundNewQueue", "newQueue", "Nova conversa na fila"],
        ] as const
      ).map(([field, sound, label]) => (
        <div key={field} className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={user[field]} onChange={(e) => soundsMutation.mutate({ [field]: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
            {label}
          </label>
          <button type="button" onClick={() => playAlertSound(sound, volume)} className="focus-ring inline-flex items-center gap-1 rounded-card px-2 py-1 text-xs text-muted hover:bg-surface-alt">
            <Volume2 className="h-3.5 w-3.5" /> Ouvir
          </button>
        </div>
      ))}
      <Field label={`Volume: ${volume}%`}>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          onPointerUp={() => soundsMutation.mutate({ soundVolume: volume })}
          onKeyUp={() => soundsMutation.mutate({ soundVolume: volume })}
          className="w-full accent-[var(--color-primary)]"
        />
      </Field>
      <p className="text-xs text-muted">Valem só para você, em qualquer computador em que entrar.</p>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
