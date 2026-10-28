import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { toast } from "sonner";
import type { SatisfactionSettingsDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

const OPTIONS: { value: SatisfactionSettingsDTO["presentationCustomer"]; label: string; hint: string }[] = [
  { value: "full", label: "Nome e número", hint: "Ex.: Marina Alves · (65) 99999-0001" },
  { value: "initials", label: "Só as iniciais", hint: "Ex.: M. A. — para apresentações que saem da empresa" },
];

/**
 * Respostas › Pesquisa › Relatórios e apresentação: one setting for every survey — the NPS goal (a line on the
 * charts, "acima/abaixo da meta" in Relatórios, the Dashboard and the presentation) and how the presentation
 * names customers in the latest evaluations.
 */
export function SatisfactionSettingsCard({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["satisfaction-settings"],
    queryFn: async () => (await api.get<SatisfactionSettingsDTO>("/satisfaction-survey/settings")).data,
  });
  const [goal, setGoal] = useState("");
  const [customer, setCustomer] = useState<SatisfactionSettingsDTO["presentationCustomer"]>("full");
  useEffect(() => {
    if (!data) return;
    setGoal(data.npsGoal === null ? "" : String(data.npsGoal));
    setCustomer(data.presentationCustomer);
  }, [data]);

  const goalValue = goal.trim() === "" ? null : Number(goal);
  const goalInvalid = goalValue !== null && (!Number.isInteger(goalValue) || goalValue < 0 || goalValue > 100);
  const dirty = data && (goalValue !== data.npsGoal || customer !== data.presentationCustomer);

  const save = useMutation({
    mutationFn: async () => (await api.put<SatisfactionSettingsDTO>("/satisfaction-survey/settings", { npsGoal: goalValue, presentationCustomer: customer })).data,
    onSuccess: (saved) => {
      queryClient.setQueryData(["satisfaction-settings"], saved);
      toast.success("Configurações dos relatórios salvas.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <section className="shadow-soft mb-4 rounded-card border border-border bg-surface p-4" aria-label="Relatórios e apresentação">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Target className="h-4 w-4 text-primary" /> Relatórios e apresentação
      </h3>
      <p className="mt-1 text-xs text-muted">Vale para todas as pesquisas. O NPS é mostrado de 0 a 100 no Dashboard, em Relatórios e na apresentação (PPT).</p>
      <div className="mt-3 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Meta de NPS (0 a 100)</span>
          <input
            type="number"
            min={0}
            max={100}
            inputMode="numeric"
            value={goal}
            disabled={!canEdit}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Sem meta"
            className="focus-ring w-32 rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
          <span className={`mt-1 block text-xs ${goalInvalid ? "text-danger" : "text-muted"}`}>
            {goalInvalid ? "Informe um número inteiro de 0 a 100." : "Aparece como linha nos gráficos e como acima/abaixo da meta. Em branco, sem meta."}
          </span>
        </label>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Cliente na apresentação (PPT)</legend>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cliente na apresentação">
            {OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`flex min-w-[220px] flex-1 cursor-pointer items-start gap-2 rounded-card border px-3 py-2 text-sm ${customer === o.value ? "border-primary bg-primary/5" : "border-border"} ${!canEdit ? "cursor-default opacity-70" : ""}`}
              >
                <input type="radio" name="presentation-customer" checked={customer === o.value} disabled={!canEdit} onChange={() => setCustomer(o.value)} className="mt-0.5 accent-primary" />
                <span>
                  <span className="block font-medium">{o.label}</span>
                  <span className="block text-xs text-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {canEdit && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => save.mutate()}
            disabled={!dirty || goalInvalid || save.isPending}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-50"
          >
            {save.isPending ? "Salvando..." : "Salvar configurações"}
          </button>
        </div>
      )}
    </section>
  );
}
