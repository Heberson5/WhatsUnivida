import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Undo2, X } from "lucide-react";
import type { NameStandardizationLastBatchDTO, NameStandardizationPreviewItemDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { formatPhone } from "../../lib/format-phone";

interface PreviewResponse {
  items: NameStandardizationPreviewItemDTO[];
  lastBatch: NameStandardizationLastBatchDTO | null;
}

/** Shown at a time — the list of a big address book is long. */
const PAGE = 200;

/**
 * Contatos › Padronizar nomes: every name that would change, "antes → depois", each with a checkbox (all marked).
 * Nothing changes until "Aplicar"; the last apply can be undone.
 */
export function PadronizarNomesModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["name-standardization"],
    queryFn: async () => (await api.get<PreviewResponse>("/contacts/name-standardization")).data,
  });
  const items = useMemo(() => data?.items ?? [], [data]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [search, setSearch] = useState("");
  useEffect(() => setUnchecked(new Set()), [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("pt-BR");
    return q ? items.filter((i) => i.current.toLocaleLowerCase("pt-BR").includes(q) || i.proposed.toLocaleLowerCase("pt-BR").includes(q) || i.phone?.includes(q)) : items;
  }, [items, search]);
  const selectedIds = items.filter((i) => !unchecked.has(i.contactId)).map((i) => i.contactId);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["name-standardization"] });
    queryClient.invalidateQueries({ queryKey: ["contacts"] });
  };
  const apply = useMutation({
    mutationFn: async () => (await api.post<{ batchId: string; count: number }>("/contacts/name-standardization", { contactIds: selectedIds })).data,
    onSuccess: (result) => {
      toast.success(`${result.count.toLocaleString("pt-BR")} ${result.count === 1 ? "nome padronizado" : "nomes padronizados"}.`);
      refresh();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const undo = useMutation({
    mutationFn: async (batchId: string) => (await api.post<{ count: number }>(`/contacts/name-standardization/${batchId}/undo`)).data,
    onSuccess: (result) => {
      toast.success(`${result.count.toLocaleString("pt-BR")} ${result.count === 1 ? "nome voltou" : "nomes voltaram"} ao que era.`);
      refresh();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const toggle = (id: string) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const last = data?.lastBatch;

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Padronizar nomes">
      <div className="drawer-panel flex max-w-3xl flex-col p-5">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Padronizar nomes</h2>
            <p className="text-xs text-muted">
              Só a primeira letra de cada nome em maiúscula (da, de, do, das, dos, e em minúsculas), Dr./Dra. com ponto, siglas TGS, CNP, BBG, DEN, NVO,
              LTDA, ME e EPP em maiúsculas, e o número com a sigla no fim (ex.: Ana Lima 456-CNP). Nomes que são só o número ficam como estão.
            </p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        {last && !last.undone && (
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-card bg-surface-alt px-3 py-2 text-xs">
            <span>
              Última padronização: {last.count.toLocaleString("pt-BR")} {last.count === 1 ? "nome" : "nomes"} em {new Date(last.at).toLocaleString("pt-BR")}.
            </span>
            <button
              type="button"
              onClick={() => undo.mutate(last.batchId)}
              disabled={undo.isPending}
              className="focus-ring inline-flex items-center gap-1 rounded-card border border-border bg-surface px-2.5 py-1 font-medium hover:bg-surface-alt disabled:opacity-60"
            >
              <Undo2 className="h-3.5 w-3.5" /> Desfazer
            </button>
          </div>
        )}

        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted">Analisando os nomes...</p>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">Todos os nomes já estão no padrão.</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">
                {selectedIds.length.toLocaleString("pt-BR")} de {items.length.toLocaleString("pt-BR")} marcados
              </span>
              <button type="button" onClick={() => setUnchecked(new Set())} className="focus-ring rounded px-1.5 py-0.5 text-primary hover:underline">
                Marcar todos
              </button>
              <button type="button" onClick={() => setUnchecked(new Set(items.map((i) => i.contactId)))} className="focus-ring rounded px-1.5 py-0.5 text-primary hover:underline">
                Desmarcar todos
              </button>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar na lista"
                className="focus-ring ms-auto w-48 rounded-card border border-border bg-transparent px-2.5 py-1 text-xs"
              />
            </div>
            <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-card border border-border">
              {filtered.slice(0, shown).map((item) => (
                <li key={item.contactId}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-surface-alt">
                    <input type="checkbox" checked={!unchecked.has(item.contactId)} onChange={() => toggle(item.contactId)} className="h-4 w-4 shrink-0 accent-primary" />
                    <span className="min-w-0 flex-1 truncate text-muted line-through decoration-muted/50">{item.current}</span>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate font-medium">{item.proposed}</span>
                    {item.phone && <span className="hidden shrink-0 text-xs tabular-nums text-muted sm:inline">{formatPhone(item.phone)}</span>}
                  </label>
                </li>
              ))}
            </ul>
            {filtered.length > shown && (
              <button type="button" onClick={() => setShown((n) => n + PAGE)} className="focus-ring mt-2 self-center text-xs text-primary hover:underline">
                Mostrar mais ({(filtered.length - shown).toLocaleString("pt-BR")} restantes)
              </button>
            )}
          </>
        )}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Fechar
          </button>
          <button
            type="button"
            onClick={() => apply.mutate()}
            disabled={apply.isPending || selectedIds.length === 0}
            className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {apply.isPending ? "Aplicando..." : `Aplicar em ${selectedIds.length.toLocaleString("pt-BR")}`}
          </button>
        </div>
      </div>
    </div>
  );
}
