import { format } from "date-fns";
import { AUTO_MESSAGE_KIND_LABEL, type AutoMessageBlocksReportDTO } from "@whatsatendende/types";

/**
 * Relatórios › Mensagens bloqueadas: the automatic messages the tags stopped (Etiquetas › Bloqueia) — the totals by
 * message and by tag, then each one with the customer, connection and attendant.
 */
export function AutoMessageBlocksReport({ data, isLoading }: { data: AutoMessageBlocksReportDTO | undefined; isLoading: boolean }) {
  if (isLoading) return <p className="py-8 text-center text-sm text-muted">Carregando...</p>;
  if (!data || data.total === 0) {
    return <p className="py-8 text-center text-sm text-muted">Nenhuma mensagem automática bloqueada por etiqueta no período.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="shadow-soft rounded-card border border-border bg-surface p-4">
          <p className="text-xs uppercase text-muted">Mensagens bloqueadas</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{data.total.toLocaleString("pt-BR")}</p>
        </div>
        <Breakdown title="Por mensagem" rows={data.byKind.map((r) => ({ label: AUTO_MESSAGE_KIND_LABEL[r.kind] ?? r.kind, count: r.count }))} />
        <Breakdown title="Por etiqueta" rows={data.byTag.map((r) => ({ label: r.tagName, count: r.count }))} />
      </div>

      <div className="shadow-soft flex-1 overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              {["Data e hora", "Mensagem", "Etiqueta", "Cliente", "Conexão", "Atendente"].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 py-3">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.id} className="border-t border-border hover:bg-surface-alt">
                <td className="whitespace-nowrap px-4 py-2.5 tabular-nums">{format(new Date(item.at), "dd/MM/yyyy HH:mm")}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{AUTO_MESSAGE_KIND_LABEL[item.kind] ?? item.kind}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{item.tagName}</td>
                <td className="whitespace-nowrap px-4 py-2.5">{item.contactName}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{item.connectionName ?? "—"}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{item.agentName ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { label: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="shadow-soft rounded-card border border-border bg-surface p-4">
      <p className="mb-2 text-xs uppercase text-muted">{title}</p>
      <ul className="space-y-1.5">
        {rows.slice(0, 5).map((r) => (
          <li key={r.label} className="text-xs">
            <div className="flex justify-between gap-2">
              <span className="truncate">{r.label}</span>
              <span className="font-semibold tabular-nums">{r.count.toLocaleString("pt-BR")}</span>
            </div>
            <div className="mt-0.5 h-1.5 rounded-full bg-surface-alt">
              <div className="h-1.5 rounded-full bg-primary" style={{ width: `${(r.count / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
