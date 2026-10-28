import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { Plus, Trash2 } from "lucide-react";
import {
  BOLETO_INSTRUCTION_LINE_MAX_LENGTH,
  BOLETO_INSTRUCTION_LINES_MAX,
  BOLETO_INSTRUCTION_TAGS,
  DEFAULT_BOLETO_INSTRUCTION,
  PERMISSION,
  fillBoletoInstructions,
  type BoletoInstructionDTO,
  type BoletoInstructionInput,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { TagButtons, insertTag } from "./TagButtons";

// The example boleto of the preview and the hints.
const EXAMPLE = { cents: 12758, contract: "C-10", document: "D-1", due: "10/11/2026" };
const EXAMPLE_VALUE = "R$ 127,58";
const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";

type Draft = { id?: string; name: string; fine: string; interest: string; text: string };

const toDraft = (i: BoletoInstructionDTO | null): Draft =>
  i
    ? { id: i.id, name: i.name, fine: String(i.finePercent), interest: String(i.interestMonthPercent), text: i.lines.join("\n") }
    : { name: "", fine: String(DEFAULT_BOLETO_INSTRUCTION.finePercent), interest: String(DEFAULT_BOLETO_INSTRUCTION.interestMonthPercent), text: "" };

const toInput = (d: Draft): BoletoInstructionInput => ({
  name: d.name.trim(),
  finePercent: Number(d.fine) || 0,
  interestMonthPercent: Number(d.interest) || 0,
  lines: d.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
});

/** Dados › Mensagens do boleto: named instruction texts with multa/juros, brought into a layout with {mensagem:Nome}. */
export function BoletoInstructionsPanel() {
  const queryClient = useQueryClient();
  const canEdit = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.FONTES_DADOS_EDITAR]));
  const { data: instructions } = useQuery({
    queryKey: ["boleto-instructions"],
    queryFn: async () => (await api.get<BoletoInstructionDTO[]>("/boletos/instructions")).data,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);
  const selected = instructions?.find((i) => i.id === selectedId) ?? null;

  useEffect(() => {
    if (!instructions || draft) return;
    const first = instructions[0] ?? null;
    setSelectedId(first?.id ?? null);
    setDraft(toDraft(first));
  }, [instructions, draft]);

  const input = draft ? toInput(draft) : null;
  const preview = input ? fillBoletoInstructions(input, EXAMPLE) : [];
  const [fineExample, dailyExample] = input ? fillBoletoInstructions({ ...input, lines: ["{multa}", "{juros_dia}"] }, EXAMPLE) : [];
  const tooManyLines = (input?.lines.length ?? 0) > BOLETO_INSTRUCTION_LINES_MAX;
  const tooLong = input?.lines.some((line) => line.length > BOLETO_INSTRUCTION_LINE_MAX_LENGTH) ?? false;
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["boleto-instructions"] });
    queryClient.invalidateQueries({ queryKey: ["boleto-layouts"] });
  };

  const saveMutation = useMutation({
    mutationFn: async (d: Draft) =>
      (d.id ? await api.put<BoletoInstructionDTO>(`/boletos/instructions/${d.id}`, toInput(d)) : await api.post<BoletoInstructionDTO>("/boletos/instructions", toInput(d))).data,
    onSuccess: (saved) => {
      refresh();
      setSelectedId(saved.id);
      setDraft(toDraft(saved));
      toast.success("Mensagem do boleto salva.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/boletos/instructions/${id}`),
    onSuccess: () => {
      refresh();
      setDraft(null);
      toast.success("Mensagem excluída.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function select(instruction: BoletoInstructionDTO | null) {
    setSelectedId(instruction?.id ?? null);
    setDraft(toDraft(instruction));
  }

  return (
    <div className="flex max-w-5xl flex-col gap-4 md:flex-row">
      <div className="shadow-soft shrink-0 space-y-2 rounded-card border border-border bg-surface p-3 md:w-64">
        {canEdit && (
          <button onClick={() => select(null)} className="focus-ring inline-flex w-full items-center justify-center gap-1 rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg">
            <Plus className="h-4 w-4" /> Nova mensagem
          </button>
        )}
        {instructions?.map((i) => (
          <button
            key={i.id}
            onClick={() => select(i)}
            className={clsx("focus-ring block w-full rounded-card border px-3 py-2 text-left", draft?.id === i.id ? "border-primary bg-primary/10" : "border-border hover:bg-surface-alt")}
          >
            <span className="block text-sm font-semibold">{i.name}</span>
            <span className="block text-xs text-muted">{i.usedBy.length ? `Usada em: ${i.usedBy.join(", ")}` : "Não usada em nenhum layout"}</span>
          </button>
        ))}
      </div>

      {draft && (
        <div className="shadow-soft min-w-0 flex-1 space-y-3 rounded-card border border-border bg-surface p-6">
          <div>
            <h2 className="text-base font-semibold">{draft.id ? draft.name || "Mensagem do boleto" : "Nova mensagem do boleto"}</h2>
            <p className="mt-1 text-sm text-muted">
              As linhas saem no quadro de instruções do boleto, no layout que trouxer <code className="rounded bg-surface-alt px-1">{`{mensagem:${draft.name || "Nome"}}`}</code>. Multa e
              juros são calculados sobre o valor original de cada boleto.
            </p>
          </div>
          <fieldset disabled={!canEdit} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Nome da mensagem</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} className={inputClass} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Multa após o vencimento (%)</span>
                <input type="number" min={0} max={100} step={0.01} value={draft.fine} onChange={(e) => setDraft({ ...draft, fine: e.target.value })} className={inputClass} />
                <span className="mt-1 block text-xs text-muted">
                  {EXAMPLE_VALUE} → multa de R$ {fineExample}
                </span>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Juros de mora (% ao mês)</span>
                <input type="number" min={0} max={100} step={0.01} value={draft.interest} onChange={(e) => setDraft({ ...draft, interest: e.target.value })} className={inputClass} />
                <span className="mt-1 block text-xs text-muted">
                  Por dia = valor × % ÷ 30 · {EXAMPLE_VALUE} → R$ {dailyExample} ao dia
                </span>
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Texto (uma linha por instrução, até {BOLETO_INSTRUCTION_LINES_MAX})</span>
              <textarea ref={setTextarea} rows={BOLETO_INSTRUCTION_LINES_MAX} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} className={inputClass} />
            </label>
            {tooManyLines && <p className="text-xs text-danger">No máximo {BOLETO_INSTRUCTION_LINES_MAX} linhas — é o que cabe no boleto.</p>}
            {tooLong && <p className="text-xs text-danger">Cada linha pode ter até {BOLETO_INSTRUCTION_LINE_MAX_LENGTH} caracteres.</p>}
            {canEdit && <TagButtons tags={BOLETO_INSTRUCTION_TAGS} onInsert={(tag) => insertTag(textarea, draft.text, tag, (text) => setDraft({ ...draft, text }))} />}
          </fieldset>
          <div className="rounded-card border border-dashed border-border bg-surface-alt px-3 py-2 text-xs">
            <p className="font-semibold">
              Prévia <span className="font-normal text-muted">(boleto de exemplo: {EXAMPLE_VALUE}, vencimento {EXAMPLE.due})</span>
            </p>
            {preview.map((line, i) => (
              <p key={i} className="mt-0.5">
                {line}
              </p>
            ))}
          </div>
          {canEdit && (
            <div className="flex flex-wrap justify-between gap-2">
              {draft.id ? (
                <button
                  type="button"
                  onClick={() => window.confirm(`Excluir a mensagem "${selected?.name}"?`) && deleteMutation.mutate(draft.id!)}
                  className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-3 py-2 text-sm text-danger hover:bg-danger-soft"
                >
                  <Trash2 className="h-4 w-4" /> Excluir
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => saveMutation.mutate(draft)}
                disabled={saveMutation.isPending || !draft.name.trim() || tooManyLines || tooLong}
                className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
              >
                Salvar mensagem
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
