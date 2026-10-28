import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { MaintenanceSettingsDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { UnsavedChangesBar } from "../../components/common/UnsavedChangesBar";

interface BusinessSettings {
  inactivityTimeoutMinutes?: number;
}

const MIN_HOURS = 1 / 60; // matches the backend's 1-minute floor
const MAX_HOURS = 24; // matches the backend's 1440-minute ceiling

export function SecuritySettingsPanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["business-settings"],
    queryFn: async () => (await api.get<BusinessSettings>("/settings/business")).data,
  });

  // Stored in minutes on the backend (inactivityTimeoutMinutes, shared with
  // the client-side idle-logout timer — see useIdleLogout), shown here in
  // hours per PROMPT: "inativo por xx horas".
  const [hours, setHours] = useState(8);

  useEffect(() => {
    if (data?.inactivityTimeoutMinutes) setHours(Number((data.inactivityTimeoutMinutes / 60).toFixed(2)));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => api.patch("/settings/business", { inactivityTimeoutMinutes: Math.round(hours * 60) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["business-settings"] });
      toast.success("Tempo de inatividade salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const hoursValid = hours >= MIN_HOURS && hours <= MAX_HOURS;
  const savedHours = data?.inactivityTimeoutMinutes ? Number((data.inactivityTimeoutMinutes / 60).toFixed(2)) : undefined;

  return (
    <div className="shadow-soft max-w-xl space-y-6 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Sessão</h2>
        <p className="mt-1 text-sm text-muted">
          Cada usuário só pode ter uma sessão ativa por vez — um novo login em outro local ou dispositivo encerra
          automaticamente a sessão anterior. Fechar o navegador também encerra a sessão. Abaixo, defina após quantas
          horas sem nenhuma atividade uma sessão aberta é encerrada automaticamente.
        </p>
      </div>

      <label className="block max-w-xs">
        <span className="mb-1 block text-sm font-medium">Logoff automático por inatividade (horas)</span>
        <input
          type="number"
          min={MIN_HOURS}
          max={MAX_HOURS}
          step={0.5}
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>

      <button
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending || !hoursValid}
        className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
      >
        Salvar configuração
      </button>
      {savedHours !== undefined && (
        <UnsavedChangesBar
          dirty={hours !== savedHours}
          saving={saveMutation.isPending}
          canSave={hoursValid}
          onSave={() => saveMutation.mutate()}
          onDiscard={() => setHours(savedHours)}
        />
      )}

      <MaintenanceModeSection />
    </div>
  );
}

/**
 * Site-wide maintenance switch — see PROMPT: "botão em configurações para
 * colocar o site em manutenção... somente o administrador" pode acessar
 * durante. Blocks login for AGENT/MANAGER (enforced server-side, see
 * auth.service.ts); an ADMIN always keeps normal access regardless of this
 * toggle. The blocked-out screen itself lives in LoginPage/MaintenanceScreen.
 */
function MaintenanceModeSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["maintenance-settings"],
    queryFn: async () => (await api.get<MaintenanceSettingsDTO>("/settings/maintenance")).data,
  });

  const [message, setMessage] = useState("");
  useEffect(() => {
    setMessage(data?.message ?? "");
  }, [data]);

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => api.patch<MaintenanceSettingsDTO>("/settings/maintenance", { enabled }),
    onSuccess: (res) => {
      queryClient.setQueryData(["maintenance-settings"], res.data);
      toast.success(res.data.enabled ? "Modo de manutenção ativado." : "Modo de manutenção desativado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const saveMessageMutation = useMutation({
    mutationFn: () => api.patch<MaintenanceSettingsDTO>("/settings/maintenance", { message: message.trim() || null }),
    onSuccess: (res) => {
      queryClient.setQueryData(["maintenance-settings"], res.data);
      toast.success("Mensagem de manutenção salva.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const enabled = data?.enabled ?? false;

  return (
    <div className="border-t border-border pt-6">
      <h2 className="text-base font-semibold">Manutenção</h2>
      <p className="mt-1 text-sm text-muted">
        Enquanto ativo, apenas administradores conseguem fazer login. Atendentes e gestores veem uma tela de
        manutenção no lugar do formulário de login.
      </p>

      <div className="mt-4 flex items-center justify-between rounded-card border border-border p-4">
        <div>
          <p className="text-sm font-medium">{enabled ? "Site em manutenção" : "Site funcionando normalmente"}</p>
          <p className="text-xs text-muted">{enabled ? "Somente administradores podem acessar agora." : "Todos os perfis podem fazer login."}</p>
        </div>
        <button
          onClick={() => toggleMutation.mutate(!enabled)}
          disabled={toggleMutation.isPending}
          role="switch"
          aria-checked={enabled}
          aria-label="Ativar modo de manutenção"
          className={`focus-ring relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60 ${enabled ? "bg-red-500" : "bg-border"}`}
        >
          <span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0"}`} />
        </button>
      </div>

      <label className="mt-4 block max-w-md">
        <span className="mb-1 block text-sm font-medium">Mensagem exibida na tela de manutenção (opcional)</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Ex.: Voltamos às 14h."
          className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>
      <button
        onClick={() => saveMessageMutation.mutate()}
        disabled={saveMessageMutation.isPending}
        className="focus-ring mt-2 rounded-card border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-alt disabled:opacity-60"
      >
        Salvar mensagem
      </button>
      {data && (
        <UnsavedChangesBar
          dirty={message !== (data.message ?? "")}
          saving={saveMessageMutation.isPending}
          onSave={() => saveMessageMutation.mutate()}
          onDiscard={() => setMessage(data.message ?? "")}
        />
      )}
    </div>
  );
}
