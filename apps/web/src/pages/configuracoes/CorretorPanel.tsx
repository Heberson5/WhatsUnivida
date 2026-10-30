import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DEFAULT_WRITING_ASSIST_SETTINGS, type WritingAssistSettingsDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

const KINDS: { key: "spelling" | "grammar" | "informal" | "punctuation"; label: string; hint: string }[] = [
  { key: "spelling", label: "Ortografia", hint: "Palavras escritas errado, como “amanha”." },
  { key: "grammar", label: "Gramática", hint: "Concordância, crase e outras regras. Alguns erros podem passar sem aviso." },
  { key: "informal", label: "Abreviações e informalidade", hint: "“vc”, “tb”, “pq” e outras formas informais." },
  { key: "punctuation", label: "Maiúsculas e pontuação", hint: "Frase começando com minúscula, espaços e pontuação." },
];

const parseTerms = (text: string) => [...new Set(text.split(/[\n,;]/).map((t) => t.trim()).filter(Boolean))];

/** Configurações › Corretor: one setting for everyone, administrador or gestor only (the API enforces it too). */
export function CorretorPanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["writing-assist-settings"],
    queryFn: async () => (await api.get<WritingAssistSettingsDTO>("/writing-assist/settings")).data,
  });
  const [form, setForm] = useState<WritingAssistSettingsDTO>(DEFAULT_WRITING_ASSIST_SETTINGS);
  const [terms, setTerms] = useState("");
  useEffect(() => {
    if (!data) return;
    setForm(data);
    setTerms(data.companyTerms.join("\n"));
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.patch("/writing-assist/settings", { ...form, companyTerms: parseTerms(terms) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["writing-assist-settings"] });
      toast.success("Corretor salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="shadow-soft max-w-xl space-y-5 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Corretor</h2>
        <p className="mt-1 text-sm text-muted">
          Ao enviar uma mensagem digitada para o cliente, o sistema verifica o texto. Se encontrar erros, mostra um alerta e só envia quando o atendente corrigir ou clicar em Enviar mesmo assim. O
          sublinhado vermelho do Windows continua funcionando à parte.
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        Corretor ligado
      </label>
      <fieldset disabled={!form.enabled} className="space-y-3 disabled:opacity-50">
        <legend className="text-sm font-semibold">O que gera alerta</legend>
        {KINDS.map(({ key, label, hint }) => (
          <label key={key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} />
            <span>
              {label}
              <span className="block text-xs text-muted">{hint}</span>
            </span>
          </label>
        ))}
        <label className="block space-y-1 text-sm">
          <span className="font-semibold">Termos da empresa</span>
          <span className="block text-xs text-muted">Nunca geram alerta. Um por linha. O nome da empresa, do cliente e do atendente já são ignorados.</span>
          <textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={5} className="focus-ring w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm" />
        </label>
      </fieldset>
      <button type="button" disabled={save.isPending} onClick={() => save.mutate()} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
        Salvar
      </button>
    </div>
  );
}
