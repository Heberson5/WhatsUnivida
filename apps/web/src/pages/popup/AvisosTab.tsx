import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { BarChart3, BellRing, Copy, Download, Pause, Pencil, Pin, Play, Plus, Power, Search, ShieldCheck, Trash2, X } from "lucide-react";
import {
  ANNOUNCEMENT_RECURRENCE_LABEL,
  PERMISSION,
  type AnnouncementAdminDTO,
  type AnnouncementReceiptRowDTO,
  type AnnouncementStatus,
} from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { downloadFile } from "../../lib/download";
import { useBoardName } from "../../hooks/useAnnouncements";
import { KIND_STYLE, KindBadge, announcementPeriod } from "../../components/announcements/announcement-ui";
import { AnnouncementFormModal } from "./AnnouncementFormModal";

const STATUS: Record<AnnouncementStatus, { label: string; className: string }> = {
  ACTIVE: { label: "No ar", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  SCHEDULED: { label: "Agendado", className: "bg-primary/10 text-primary" },
  PAUSED: { label: "Pausado", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  ENDED: { label: "Encerrado", className: "bg-surface-alt text-muted" },
};
const FILTERS: { key: AnnouncementStatus | "all"; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "ACTIVE", label: "No ar" },
  { key: "SCHEDULED", label: "Agendados" },
  { key: "PAUSED", label: "Pausados" },
  { key: "ENDED", label: "Histórico (encerrados)" },
];
const tz = () => new Date().getTimezoneOffset();
const formatDay = (day: string) => day.split("-").reverse().join("/");

function Bar({ value, total, label, color }: { value: number; total: number; label: string; color: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="min-w-[110px] flex-1">
      <div className="mb-1 flex justify-between text-[11px] text-muted">
        <span>{label}</span>
        <span>
          {value}/{total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-alt">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/** Pop Up › Avisos: every notice — on air, scheduled, paused and the history of ended ones, to duplicate and publish again. */
export function AvisosTab() {
  const permissions = useAuthStore((s) => s.permissions);
  const can = {
    add: Boolean(permissions?.[PERMISSION.POPUP_AVISOS_ADICIONAR]),
    edit: Boolean(permissions?.[PERMISSION.POPUP_AVISOS_EDITAR]),
    remove: Boolean(permissions?.[PERMISSION.POPUP_AVISOS_EXCLUIR]),
  };
  const queryClient = useQueryClient();
  const boardName = useBoardName();
  const { data } = useQuery({ queryKey: ["announcements", "admin"], queryFn: async () => (await api.get<AnnouncementAdminDTO[]>("/announcements/admin", { params: { tz: tz() } })).data });
  const [filter, setFilter] = useState<AnnouncementStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AnnouncementAdminDTO | "new" | null>(null);
  const [readingsOf, setReadingsOf] = useState<AnnouncementAdminDTO | null>(null);
  const [name, setName] = useState(boardName);
  useEffect(() => setName(boardName), [boardName]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["announcements"] });

  const rename = useMutation({
    mutationFn: () => api.patch("/announcements/settings", { name }),
    onSuccess: () => {
      refresh();
      toast.success("Nome salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const pause = useMutation({
    mutationFn: (a: AnnouncementAdminDTO) => api.post(`/announcements/admin/${a.id}/pause`, { paused: !a.paused }),
    onSuccess: refresh,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const duplicate = useMutation({
    mutationFn: async (a: AnnouncementAdminDTO) => (await api.post<AnnouncementAdminDTO>(`/announcements/admin/${a.id}/duplicate`, { tz: tz() })).data,
    onSuccess: (copy) => {
      refresh();
      toast.success("Cópia criada, pausada e começando hoje — revise as datas e retome.");
      setEditing(copy);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const endNow = useMutation({
    mutationFn: (a: AnnouncementAdminDTO) => api.post(`/announcements/admin/${a.id}/end-now`, { tz: tz() }),
    onSuccess: () => {
      refresh();
      toast.success("Aviso encerrado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const trash = useMutation({
    mutationFn: (a: AnnouncementAdminDTO) => api.delete(`/announcements/admin/${a.id}`),
    onSuccess: () => {
      refresh();
      toast.success("Aviso enviado para a Lixeira.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const all = useMemo(() => data ?? [], [data]);
  const categories = useMemo(() => [...new Set(all.map((a) => a.category).filter((c): c is string => Boolean(c)))], [all]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, f.key === "all" ? all.length : all.filter((a) => a.status === f.key).length])), [all]);
  const list = all.filter((a) => (filter === "all" || a.status === filter) && (!search.trim() || `${a.title} ${a.body} ${a.category ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));

  return (
    <div className="h-full overflow-y-auto pb-6">
      <div className="shadow-soft mb-4 flex flex-wrap items-start justify-between gap-4 rounded-card border border-border bg-surface p-5">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold">Avisos</h2>
          <p className="mt-1 text-sm text-muted">
            Avisos que aparecem a cada login — e na hora, para quem já estiver no sistema — do início ao término, até a pessoa clicar em "Li e estou ciente". Os avisos também ficam em {boardName}.
          </p>
          {can.edit && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">Nome da central:</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="focus-ring w-48 rounded-card border border-border bg-transparent px-3 py-1.5 text-sm" />
              {name.trim() && name !== boardName && (
                <button onClick={() => rename.mutate()} className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-alt">
                  Salvar nome
                </button>
              )}
            </div>
          )}
        </div>
        {can.add && (
          <button onClick={() => setEditing("new")} className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg">
            <Plus className="h-4 w-4" /> Novo aviso
          </button>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={clsx("focus-ring rounded-full border px-3 py-1 text-xs font-medium", filter === f.key ? "border-primary bg-primary text-primary-fg" : "border-border hover:bg-surface-alt")}
          >
            {f.label} {counts[f.key] ? <span className="opacity-70">· {counts[f.key]}</span> : null}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 rounded-full border border-border px-3 py-1">
          <Search className="h-3.5 w-3.5 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar aviso" className="w-40 bg-transparent text-xs outline-none" />
        </label>
      </div>

      {data && list.length === 0 && (
        <div className="rounded-card border border-dashed border-border p-8 text-center text-sm text-muted">{all.length === 0 ? "Nenhum aviso ainda. Crie o primeiro." : "Nenhum aviso neste filtro."}</div>
      )}

      <ul className="space-y-2.5">
        {list.map((a) => {
          const style = KIND_STYLE[a.kind];
          const cover = a.images[0];
          return (
            <li key={a.id} className="shadow-soft flex flex-wrap gap-4 rounded-card border border-border bg-surface p-3.5">
              <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg" style={{ background: style.tint, color: style.ink }}>
                {cover ? <img src={cover.url} alt="" className="h-full w-full object-cover" /> : <style.icon className="h-6 w-6" />}
              </div>
              <div className="min-w-[220px] flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{a.title}</span>
                  <KindBadge kind={a.kind} />
                  <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS[a.status].className)}>{STATUS[a.status].label}</span>
                  {a.pinned && <Pin className="h-3.5 w-3.5 text-muted" aria-label="Fixado" />}
                  {a.requireAck && <ShieldCheck className="h-3.5 w-3.5 text-warning" aria-label="Pede ciente" />}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {announcementPeriod(a)} · {ANNOUNCEMENT_RECURRENCE_LABEL[a.recurrence]}
                  {a.display === "BOARD_ONLY" ? ` · só em ${boardName}` : ""}
                  {a.category ? ` · ${a.category}` : ""}
                  {a.nextDay && a.status !== "ACTIVE" ? ` · próximo: ${formatDay(a.nextDay)}` : ""}
                </p>
                <div className="mt-2 flex max-w-md flex-wrap gap-3">
                  <Bar value={a.readCount} total={a.audienceCount} label="Leram" color="var(--color-primary)" />
                  {a.requireAck && <Bar value={a.ackCount} total={a.audienceCount} label="Ciente" color="var(--color-success)" />}
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-1.5">
                <button onClick={() => setReadingsOf(a)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                  <BarChart3 className="h-3.5 w-3.5" /> Leitura
                </button>
                {can.edit && (
                  <button onClick={() => setEditing(a)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </button>
                )}
                {can.add && (
                  <button onClick={() => duplicate.mutate(a)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                    <Copy className="h-3.5 w-3.5" /> Duplicar
                  </button>
                )}
                {can.edit && a.status !== "ENDED" && (
                  <button onClick={() => pause.mutate(a)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                    {a.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} {a.paused ? "Retomar" : "Pausar"}
                  </button>
                )}
                {can.edit && a.status === "ACTIVE" && (
                  <button
                    onClick={() => window.confirm(`Encerrar "${a.title}" agora? Ele deixa de abrir para quem ainda não viu.`) && endNow.mutate(a)}
                    className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt"
                  >
                    <Power className="h-3.5 w-3.5" /> Encerrar agora
                  </button>
                )}
                {can.remove && (
                  <button
                    onClick={() => window.confirm(`Enviar "${a.title}" para a Lixeira?`) && trash.mutate(a)}
                    className="focus-ring flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Excluir
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {editing && (
        <AnnouncementFormModal
          existing={editing === "new" ? null : editing}
          categories={categories}
          boardName={boardName}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
            setEditing(null);
          }}
        />
      )}
      {readingsOf && <ReceiptsModal announcement={readingsOf} canRemind={can.edit} onClose={() => setReadingsOf(null)} />}
    </div>
  );
}

const ROLE_LABEL = { ADMIN: "Administrador", MANAGER: "Gestor", AGENT: "Atendente" } as const;

function ReceiptsModal({ announcement, canRemind, onClose }: { announcement: AnnouncementAdminDTO; canRemind: boolean; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ["announcements", "receipts", announcement.id],
    queryFn: async () => (await api.get<AnnouncementReceiptRowDTO[]>(`/announcements/admin/${announcement.id}/receipts`)).data,
  });
  const remind = useMutation({
    mutationFn: async () => (await api.post<{ count: number }>(`/announcements/admin/${announcement.id}/remind`)).data,
    onSuccess: (res) => toast.success(res.count ? `Lembrete enviado para ${res.count} ${res.count === 1 ? "pessoa" : "pessoas"}.` : "Ninguém pendente."),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
  const pending = (data ?? []).filter((r) => (announcement.requireAck ? !r.ackAt : !r.readAt)).length;
  const exportAs = (format: "xlsx" | "pdf") =>
    downloadFile(`/announcements/admin/${announcement.id}/receipts?format=${format}&tz=${tz()}`, `comprovante.${format}`).catch((err) => toast.error(getApiErrorMessage(err, "Não foi possível exportar")));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-card border border-border bg-surface shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="font-semibold">Leitura — {announcement.title}</h2>
            <p className="text-xs text-muted">
              {announcement.readCount} de {announcement.audienceCount} leram
              {announcement.requireAck ? ` · ${announcement.ackCount} confirmaram o ciente` : ""}
            </p>
          </div>
          <button onClick={onClose} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
          {canRemind && (
            <button
              onClick={() => remind.mutate()}
              disabled={!pending || remind.isPending}
              className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-50"
            >
              <BellRing className="h-3.5 w-3.5" /> Lembrar pendentes ({pending})
            </button>
          )}
          <button onClick={() => exportAs("xlsx")} className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">
            <Download className="h-3.5 w-3.5" /> Comprovante em Excel
          </button>
          <button onClick={() => exportAs("pdf")} className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">
            <Download className="h-3.5 w-3.5" /> Comprovante em PDF
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Pessoa</th>
                <th className="px-2 py-2 font-medium">Leu em</th>
                {announcement.requireAck && <th className="px-2 py-2 font-medium">Ciente em</th>}
                <th className="px-5 py-2 text-right font-medium">Apareceu</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((r) => (
                <tr key={r.userId} className="border-t border-border">
                  <td className="px-5 py-2">
                    <p className="font-medium">{r.name}</p>
                    <p className="text-xs text-muted">{ROLE_LABEL[r.role]}</p>
                  </td>
                  <td className={clsx("px-2 py-2", !r.readAt && "text-muted")}>{when(r.readAt)}</td>
                  {announcement.requireAck && <td className={clsx("px-2 py-2", r.ackAt ? "text-success" : "font-medium text-warning")}>{r.ackAt ? when(r.ackAt) : "Pendente"}</td>}
                  <td className="px-5 py-2 text-right text-muted">{r.shownCount}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
