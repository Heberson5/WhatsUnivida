import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { UserDTO } from "@whatsunivida/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

const ROLE_LABEL: Record<string, string> = { ADMIN: "Administrador", MANAGER: "Gestor", AGENT: "Atendente" };

export default function MeuPerfilPage() {
  const user = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);
  const accessToken = useAuthStore((s) => s.accessToken);
  const queryClient = useQueryClient();
  const photoInputRef = useRef<HTMLInputElement>(null);

  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);

  function applyUser(updated: UserDTO) {
    if (accessToken) setSession(accessToken, updated);
    queryClient.invalidateQueries({ queryKey: ["users"] });
  }

  const profileMutation = useMutation({
    mutationFn: () => api.patch<UserDTO>("/profile", { fullName, displayName }),
    onSuccess: (res) => {
      applyUser(res.data);
      toast.success("Perfil atualizado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

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

  function handleProfileSubmit(e: FormEvent) {
    e.preventDefault();
    profileMutation.mutate();
  }

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
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
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

        <form onSubmit={handleProfileSubmit} className="shadow-soft space-y-3 rounded-card border border-border bg-surface p-6">
          <h2 className="mb-1 text-base font-semibold">Dados pessoais</h2>
          <Field label="Nome completo">
            <input required value={fullName} onChange={(e) => setFullName(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="Nome de exibição">
            <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="E-mail">
            <input disabled value={user.email} className="w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm text-muted" />
          </Field>
          <Field label="Perfil">
            <input disabled value={ROLE_LABEL[user.role] ?? user.role} className="w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm text-muted" />
          </Field>
          <div className="pt-1">
            <button type="submit" disabled={profileMutation.isPending} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
              {profileMutation.isPending ? "Salvando..." : "Salvar alterações"}
            </button>
          </div>
        </form>

        <form onSubmit={handlePasswordSubmit} className="shadow-soft space-y-3 rounded-card border border-border bg-surface p-6">
          <h2 className="mb-1 text-base font-semibold">Alterar senha</h2>
          <Field label="Senha atual">
            <input required type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="Nova senha">
            <input required type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="Confirmar nova senha">
            <input required type="password" minLength={8} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          {passwordError && <p className="rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">{passwordError}</p>}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
