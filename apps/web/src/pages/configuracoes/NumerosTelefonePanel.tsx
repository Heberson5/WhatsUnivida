import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PERMISSION, normalizeTypedPhone, type PhoneSettingsDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { formatPhone } from "../../lib/format-phone";
import { UnsavedChangesBar } from "../../components/common/UnsavedChangesBar";
import { PHONE_SETTINGS_QUERY_KEY, usePhoneSettings } from "../../hooks/usePhoneSettings";
import { useAuthStore } from "../../store/auth-store";

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-primary" />
    </label>
  );
}

/** Configurações › Números de telefone: how a number typed by hand is completed — the default country code and the extra 9 of Brazilian mobiles. */
export function NumerosTelefonePanel() {
  const queryClient = useQueryClient();
  const canEditar = useAuthStore((s) => s.permissions?.[PERMISSION.CONFIGURACOES_TELEFONE_EDITAR]);
  const { data } = usePhoneSettings();

  const [values, setValues] = useState<PhoneSettingsDTO | null>(null);
  const [example, setExample] = useState("");
  useEffect(() => {
    if (data) setValues(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async (next: PhoneSettingsDTO) => (await api.patch<PhoneSettingsDTO>("/settings/phone", next)).data,
    onSuccess: (saved) => {
      queryClient.setQueryData(PHONE_SETTINGS_QUERY_KEY, saved);
      toast.success("Configuração de números de telefone salva.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  if (!data || !values) return null;
  const dirty = JSON.stringify(values) !== JSON.stringify(data);
  const valid = /^\d{1,3}$/.test(values.defaultCountryCode);
  const set = (patch: Partial<PhoneSettingsDTO>) => setValues((v) => (v ? { ...v, ...patch } : v));

  // The same function the server applies, run on what is typed in the form right now (even unsaved).
  const tested = example.replace(/\D/g, "") ? normalizeTypedPhone(example, values) : null;

  return (
    <div className="shadow-soft max-w-2xl space-y-6 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Números de telefone</h2>
        <p className="mt-1 text-sm text-muted">
          Como o sistema completa um número digitado à mão: em Atendimento › Nova conversa › Novo número e na importação de contatos por planilha.
          Contatos escolhidos em “Contatos salvos” e mensagens recebidas não são alterados, pois esses números já vêm do WhatsApp.
        </p>
      </div>

      <fieldset disabled={!canEditar} className="space-y-6 disabled:opacity-70">
        <div className="space-y-3">
          <Switch
            checked={values.defaultCountryCodeEnabled}
            onChange={(defaultCountryCodeEnabled) => set({ defaultCountryCodeEnabled })}
            label="Incluir o DDI padrão"
            hint={
              values.defaultCountryCodeEnabled
                ? `Ligado — um número digitado sem DDI recebe +${values.defaultCountryCode || "…"}.`
                : "Desligado — o número precisa ser digitado com o DDI."
            }
          />
          <div>
            <label className="block max-w-[10rem]">
              <span className="mb-1 block text-sm font-medium">DDI padrão</span>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted">+</span>
                <input
                  value={values.defaultCountryCode}
                  onChange={(e) => set({ defaultCountryCode: e.target.value.replace(/\D/g, "").slice(0, 3) })}
                  inputMode="numeric"
                  maxLength={3}
                  disabled={!values.defaultCountryCodeEnabled}
                  aria-invalid={!valid}
                  className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm tabular-nums disabled:opacity-60"
                />
              </div>
            </label>
            <p className="mt-1 text-xs text-muted">
              55 = Brasil. No Brasil, vale para números com DDD (10 ou 11 dígitos); para outro DDI, para números de até 11 dígitos que não comecem com ele.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <Switch
            checked={values.fixExtraNineEnabled}
            onChange={(fixExtraNineEnabled) => set({ fixExtraNineEnabled })}
            label="Corrigir o dígito 9 a mais (celulares do Brasil)"
            hint={values.fixExtraNineEnabled ? "Ligado — o 9 a mais é descartado." : "Desligado — o número é usado como foi digitado."}
          />
          <p className="text-xs text-muted">
            Um celular digitado como DDD + 9 + 8 números (ex.: 65 99928-6623) passa a ser DDD + 8 números (65 9928-6623), forma com que o WhatsApp costuma
            registrar a conta. Em Nova conversa, o sistema confere no WhatsApp: tenta sem o 9 e, se não achar, com o 9.
          </p>
          <p className="text-xs text-muted">
            Nos DDDs 11 a 19, 21, 22, 24, 27 e 28 (SP, RJ e ES) o WhatsApp mantém o 9: ali o número fica como foi digitado, e só se tenta sem o 9 se o
            WhatsApp não o encontrar. Na importação de contatos, que não consulta o WhatsApp, o 9 só é descartado nos demais DDDs.
          </p>
        </div>
      </fieldset>

      <div className="rounded-card border border-border bg-surface-alt p-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Testar um número</span>
          <input
            value={example}
            onChange={(e) => setExample(e.target.value)}
            placeholder="65 99928-6623"
            className="focus-ring w-full max-w-xs rounded-card border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        <div className="mt-2 text-sm" aria-live="polite">
          {tested === null ? (
            <p className="text-xs text-muted">Digite um número para ver como o sistema vai usá-lo, com as opções acima (mesmo antes de salvar).</p>
          ) : (
            <>
              <p>
                Será usado: <span className="font-semibold tabular-nums">{formatPhone(tested.phone)}</span>
              </p>
              {tested.alternates.length > 0 && (
                <p className="mt-0.5 text-xs text-muted">
                  Se o WhatsApp não o encontrar, tenta também <span className="tabular-nums">{tested.alternates.map(formatPhone).join(", ")}</span>.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {canEditar && <UnsavedChangesBar dirty={dirty} saving={save.isPending} canSave={valid} onSave={() => save.mutate(values)} onDiscard={() => setValues(data)} />}
    </div>
  );
}
