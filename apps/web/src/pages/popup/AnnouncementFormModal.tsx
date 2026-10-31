import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { Bold, FileText, ImagePlus, Italic, LayoutTemplate, Paperclip, Pin, ShieldCheck, Star, Strikethrough, Trash2, Type, X } from "lucide-react";
import {
  ANNOUNCEMENT_KIND_LABEL,
  ANNOUNCEMENT_RECURRENCE_LABEL,
  type AnnouncementAdminDTO,
  type AnnouncementFileDTO,
  type AnnouncementInput,
  type AnnouncementKind,
  type AnnouncementLayout,
  type AnnouncementRecurrence,
  type Role,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { KIND_STYLE, StoryCard } from "../../components/announcements/announcement-ui";

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";
const labelClass = "mb-1 block text-sm font-medium";
const WEEKDAY = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const ROLE_LABEL: Record<Role, string> = { ADMIN: "Administradores", MANAGER: "Gestores", AGENT: "Atendentes" };
const LAYOUTS: { key: AnnouncementLayout; label: string; help: string; icon: typeof Type }[] = [
  { key: "COVER", label: "Imagem no topo", help: "Imagem em cima e o texto embaixo", icon: LayoutTemplate },
  { key: "POSTER", label: "Cartaz", help: "A imagem ocupa o aviso inteiro", icon: ImagePlus },
  { key: "TEXT", label: "Só texto", help: "Ícone do tipo e o texto", icon: Type },
];
const IMAGE_MAX_MB = 10;
const PDF_MAX_MB = 15;

interface Attendant {
  id: string;
  displayName: string;
  role: Role;
  status: string;
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowLocal() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function emptyAnnouncement(): AnnouncementInput {
  return {
    title: "",
    body: "",
    kind: "INFO",
    layout: "COVER",
    display: "POPUP_AND_BOARD",
    category: null,
    requireAck: true,
    pinned: false,
    linkUrl: null,
    linkLabel: null,
    startDate: todayLocal(),
    startTime: nowLocal(),
    endDate: todayLocal(),
    endTime: "23:59",
    recurrence: "ONCE",
    audience: { all: true, roles: [], connectionIds: [], userIds: [] },
  };
}

export function toAnnouncementInput(a: AnnouncementAdminDTO): AnnouncementInput {
  return {
    title: a.title,
    body: a.body,
    kind: a.kind,
    layout: a.layout,
    display: a.display,
    category: a.category,
    requireAck: a.requireAck,
    pinned: a.pinned,
    linkUrl: a.linkUrl,
    linkLabel: a.linkLabel,
    startDate: a.startDate,
    // Older notices had no times, and a single-day one no end date: they ran for the whole day.
    startTime: a.startTime ?? "00:00",
    endDate: a.endDate ?? (a.recurrence === "ONCE" ? a.startDate : null),
    endTime: a.endTime ?? "23:59",
    recurrence: a.recurrence,
    audience: a.audience,
  };
}

interface QueuedFile {
  file: File;
  preview: string;
}

/** Pop Up › Avisos: writing a notice — text, kind, layout, images and PDFs, the days it shows and who sees it — with the pop-up as people will see it. */
export function AnnouncementFormModal({
  existing,
  categories,
  boardName,
  onClose,
  onSaved,
}: {
  existing: AnnouncementAdminDTO | null;
  categories: string[];
  boardName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<AnnouncementInput>(existing ? toAnnouncementInput(existing) : emptyAnnouncement());
  const images = useMemo(() => existing?.images ?? [], [existing]);
  const attachments = existing?.attachments ?? [];
  const [removed, setRemoved] = useState<string[]>([]);
  const [coverKey, setCoverKey] = useState<string | null>(null);
  const [queuedImages, setQueuedImages] = useState<QueuedFile[]>([]);
  const [queuedPdfs, setQueuedPdfs] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [userQuery, setUserQuery] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const set = <K extends keyof AnnouncementInput>(key: K, value: AnnouncementInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const { data: attendants } = useQuery({ queryKey: ["attendants"], queryFn: async () => (await api.get<Attendant[]>("/agents/attendants")).data });
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<{ id: string; name: string }[]>("/whatsapp/connections")).data,
  });

  const storageKey = (f: AnnouncementFileDTO) => f.url.split("/").pop() ?? "";
  const orderedImages = useMemo(() => {
    const list = images.filter((f) => !removed.includes(storageKey(f)));
    const cover = coverKey ? list.find((f) => storageKey(f) === coverKey) : null;
    return cover ? [cover, ...list.filter((f) => f !== cover)] : list;
  }, [images, removed, coverKey]);
  const previewImages: AnnouncementFileDTO[] = [
    ...orderedImages,
    ...queuedImages.map((q) => ({ url: q.preview, fileName: q.file.name, mimeType: q.file.type, sizeBytes: q.file.size })),
  ];
  const previewPdfs: AnnouncementFileDTO[] = [
    ...attachments.filter((f) => !removed.includes(storageKey(f))),
    ...queuedPdfs.map((f) => ({ url: "#", fileName: f.name, mimeType: f.type, sizeBytes: f.size })),
  ];

  function wrapSelection(mark: string) {
    const el = bodyRef.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b, value } = el;
    const next = `${value.slice(0, a)}${mark}${value.slice(a, b) || "texto"}${mark}${value.slice(b)}`;
    set("body", next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + mark.length, (b > a ? b : a + 5) + mark.length);
    });
  }

  function addImages(files: FileList | null) {
    if (!files) return;
    const ok: QueuedFile[] = [];
    for (const file of Array.from(files)) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) toast.error(`${file.name}: use JPG, PNG ou WEBP.`);
      else if (file.size > IMAGE_MAX_MB * 1024 * 1024) toast.error(`${file.name}: a imagem pode ter até ${IMAGE_MAX_MB} MB.`);
      else ok.push({ file, preview: URL.createObjectURL(file) });
    }
    setQueuedImages((q) => [...q, ...ok]);
  }

  function addPdfs(files: FileList | null) {
    if (!files) return;
    const ok = Array.from(files).filter((file) => {
      if (file.type !== "application/pdf") toast.error(`${file.name}: anexe um PDF.`);
      else if (file.size > PDF_MAX_MB * 1024 * 1024) toast.error(`${file.name}: o PDF pode ter até ${PDF_MAX_MB} MB.`);
      else return true;
      return false;
    });
    setQueuedPdfs((q) => [...q, ...ok]);
  }

  async function save() {
    setSaving(true);
    try {
      const payload = { ...form, requireAck: popupNeedsAck || form.requireAck };
      const saved = existing ? (await api.patch<AnnouncementAdminDTO>(`/announcements/admin/${existing.id}`, payload)).data : (await api.post<AnnouncementAdminDTO>("/announcements/admin", payload)).data;
      for (const key of removed) await api.delete(`/announcements/admin/${saved.id}/files/${key}`);
      for (const { file } of queuedImages) {
        const body = new FormData();
        body.append("file", file);
        await api.post(`/announcements/admin/${saved.id}/files`, body);
      }
      for (const file of queuedPdfs) {
        const body = new FormData();
        body.append("file", file);
        await api.post(`/announcements/admin/${saved.id}/files`, body);
      }
      if (coverKey && !removed.includes(coverKey)) await api.post(`/announcements/admin/${saved.id}/files/${coverKey}/cover`);
      toast.success(existing ? "Aviso salvo." : "Aviso publicado.");
      onSaved();
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Não foi possível salvar o aviso"));
    } finally {
      setSaving(false);
    }
  }

  const start = new Date(`${form.startDate}T12:00`);
  const repeatHelp =
    form.recurrence === "WEEKLY"
      ? `Aparece toda ${WEEKDAY[start.getDay()]}`
      : form.recurrence === "MONTHLY"
        ? `Aparece todo dia ${start.getDate()}${start.getDate() > 28 ? " (no último dia, nos meses mais curtos)" : ""}`
        : form.recurrence === "DAILY"
          ? "Aparece todos os dias"
          : "Aparece durante todo o período";
  const popupNeedsAck = form.display === "POPUP_AND_BOARD";
  const endMoment = form.endDate && form.endTime ? `${form.endDate} ${form.endTime}` : null;
  const periodError = !form.startTime || !endMoment
    ? "Informe a data e o horário de início e de término."
    : endMoment <= `${form.startDate} ${form.startTime}`
      ? "O término precisa ser depois do início."
      : endMoment <= `${todayLocal()} ${nowLocal()}`
        ? "O término já passou: escolha uma data e um horário futuros."
        : null;
  const users = (attendants ?? []).filter((u) => u.status === "ACTIVE" && u.displayName.toLowerCase().includes(userQuery.trim().toLowerCase()));
  const toggleIn = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  const audience = form.audience;
  const audienceEmpty = !audience.all && audience.roles.length + audience.connectionIds.length + audience.userIds.length === 0;
  const invalid = !form.title.trim() || audienceEmpty || periodError !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-6xl rounded-card border border-border bg-surface shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-base font-semibold">{existing ? "Editar aviso" : "Novo aviso"}</h2>
          <button onClick={onClose} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1fr)_400px]">
          <div className="space-y-5">
            <div>
              <span className={labelClass}>Tipo</span>
              <div className="flex flex-wrap gap-1.5">
                {(Object.keys(ANNOUNCEMENT_KIND_LABEL) as AnnouncementKind[]).map((k) => {
                  const style = KIND_STYLE[k];
                  const on = form.kind === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => set("kind", k)}
                      className="focus-ring flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors"
                      style={on ? { background: style.solid, color: "#fff", borderColor: style.solid } : { borderColor: "var(--color-border)", color: style.ink }}
                    >
                      <style.icon className="h-3.5 w-3.5" /> {ANNOUNCEMENT_KIND_LABEL[k]}
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="block">
              <span className={labelClass}>Título</span>
              <input value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={160} placeholder="Ex.: Sistema fora do ar hoje às 19h" className={inputClass} />
            </label>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium">Texto</span>
                <div className="flex gap-0.5">
                  {[
                    { mark: "*", icon: Bold, label: "Negrito" },
                    { mark: "_", icon: Italic, label: "Itálico" },
                    { mark: "~", icon: Strikethrough, label: "Riscado" },
                  ].map((b) => (
                    <button key={b.mark} type="button" onClick={() => wrapSelection(b.mark)} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" title={b.label} aria-label={b.label}>
                      <b.icon className="h-4 w-4" />
                    </button>
                  ))}
                </div>
              </div>
              <textarea ref={bodyRef} value={form.body} onChange={(e) => set("body", e.target.value)} rows={6} maxLength={5000} className={inputClass} />
              <span className="mt-1 block text-xs text-muted">*negrito*, _itálico_ e ~riscado~, como no WhatsApp. Deixe uma linha em branco para um novo parágrafo. Emojis funcionam normalmente.</span>
            </div>

            <div>
              <span className={labelClass}>Formato</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {LAYOUTS.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    onClick={() => set("layout", l.key)}
                    className={clsx("focus-ring rounded-card border p-3 text-left transition-colors", form.layout === l.key ? "border-primary bg-primary/5" : "border-border hover:bg-surface-alt")}
                  >
                    <l.icon className={clsx("mb-1.5 h-5 w-5", form.layout === l.key ? "text-primary" : "text-muted")} />
                    <p className="text-sm font-semibold">{l.label}</p>
                    <p className="text-xs text-muted">{l.help}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className={labelClass}>Imagens</span>
              <div className="flex flex-wrap gap-2">
                {orderedImages.map((f, i) => (
                  <div key={f.url} className="group relative h-20 w-28 overflow-hidden rounded-lg border border-border">
                    <img src={f.url} alt="" className="h-full w-full object-cover" />
                    {i === 0 && <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[10px] font-semibold text-white">Capa</span>}
                    <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-black/50 p-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {i > 0 && (
                        <button type="button" onClick={() => setCoverKey(storageKey(f))} className="rounded p-1 text-white hover:bg-white/20" title="Usar como capa" aria-label="Usar como capa">
                          <Star className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button type="button" onClick={() => setRemoved((r) => [...r, storageKey(f)])} className="rounded p-1 text-white hover:bg-white/20" title="Remover" aria-label="Remover imagem">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
                {queuedImages.map((q) => (
                  <div key={q.preview} className="group relative h-20 w-28 overflow-hidden rounded-lg border border-dashed border-primary">
                    <img src={q.preview} alt="" className="h-full w-full object-cover" />
                    <button type="button" onClick={() => setQueuedImages((list) => list.filter((x) => x !== q))} className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white" aria-label="Remover imagem">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <label className="focus-within:ring-2 flex h-20 w-28 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted hover:bg-surface-alt">
                  <ImagePlus className="h-5 w-5" /> Adicionar
                  <input type="file" accept="image/jpeg,image/png,image/webp" multiple className="sr-only" onChange={(e) => addImages(e.target.files)} />
                </label>
              </div>
              <span className="mt-1 block text-xs text-muted">JPG, PNG ou WEBP até {IMAGE_MAX_MB} MB — as grandes são reduzidas para abrir rápido. A primeira é a capa; mais de uma vira galeria em {boardName}.</span>
            </div>

            <div>
              <span className={labelClass}>PDFs anexos</span>
              <div className="flex flex-wrap items-center gap-2">
                {previewPdfs.map((f, i) => (
                  <span key={`${f.fileName}-${i}`} className="flex items-center gap-1.5 rounded-full border border-border py-1 pl-2.5 pr-1 text-xs">
                    <FileText className="h-3.5 w-3.5 text-muted" /> {f.fileName}
                    <button
                      type="button"
                      onClick={() => (f.url === "#" ? setQueuedPdfs((q) => q.filter((x) => x.name !== f.fileName)) : setRemoved((r) => [...r, storageKey(f)]))}
                      className="rounded-full p-0.5 hover:bg-surface-alt"
                      aria-label={`Remover ${f.fileName}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <label className="flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted hover:bg-surface-alt">
                  <Paperclip className="h-3.5 w-3.5" /> Anexar PDF
                  <input type="file" accept="application/pdf" multiple className="sr-only" onChange={(e) => addPdfs(e.target.files)} />
                </label>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
              <label className="block">
                <span className={labelClass}>Texto do botão do link</span>
                <input value={form.linkLabel ?? ""} onChange={(e) => set("linkLabel", e.target.value || null)} placeholder="Abrir link" className={inputClass} />
              </label>
              <label className="block">
                <span className={labelClass}>Link (opcional)</span>
                <input value={form.linkUrl ?? ""} onChange={(e) => set("linkUrl", e.target.value || null)} placeholder="https://" className={inputClass} />
              </label>
            </div>

            <section className="rounded-card border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">Quando aparece</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className={labelClass}>Início</span>
                  <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} className={inputClass} />
                </label>
                <label className="block">
                  <span className={labelClass}>Horário de início</span>
                  <input type="time" value={form.startTime ?? ""} onChange={(e) => set("startTime", e.target.value || null)} className={inputClass} />
                </label>
                <label className="block">
                  <span className={labelClass}>Término</span>
                  <input type="date" value={form.endDate ?? ""} min={form.startDate} onChange={(e) => set("endDate", e.target.value || null)} className={inputClass} />
                </label>
                <label className="block">
                  <span className={labelClass}>Horário de término</span>
                  <input type="time" value={form.endTime ?? ""} onChange={(e) => set("endTime", e.target.value || null)} className={inputClass} />
                </label>
                <label className="col-span-2 block">
                  <span className={labelClass}>Repetição</span>
                  <select value={form.recurrence} onChange={(e) => set("recurrence", e.target.value as AnnouncementRecurrence)} className={inputClass}>
                    {(Object.keys(ANNOUNCEMENT_RECURRENCE_LABEL) as AnnouncementRecurrence[]).map((r) => (
                      <option key={r} value={r}>
                        {ANNOUNCEMENT_RECURRENCE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="mt-2 text-xs text-muted">
                {repeatHelp}, no horário de cada pessoa.
                {popupNeedsAck ? " O pop-up aparece a cada login — e na hora, para quem já estiver no sistema — e só fecha quando a pessoa clica em \"Li e estou ciente\". Depois do término, não abre mais." : ""}
              </p>
              {periodError && <p className="mt-1 text-xs font-medium text-red-600">{periodError}</p>}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" className="mt-1" checked={form.display === "POPUP_AND_BOARD"} onChange={() => set("display", "POPUP_AND_BOARD")} />
                  <span>
                    <span className="font-medium">Pop-up e {boardName}</span>
                    <span className="block text-xs text-muted">Abre na tela e fica em {boardName}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" className="mt-1" checked={form.display === "BOARD_ONLY"} onChange={() => set("display", "BOARD_ONLY")} />
                  <span>
                    <span className="font-medium">Só em {boardName}</span>
                    <span className="block text-xs text-muted">Sem pop-up: aparece com o selo "Novo"</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={popupNeedsAck || form.requireAck} disabled={popupNeedsAck} onChange={(e) => set("requireAck", e.target.checked)} />
                  <span>
                    <span className="flex items-center gap-1 font-medium">
                      <ShieldCheck className="h-4 w-4 text-warning" /> Exigir "Li e estou ciente"
                    </span>
                    <span className="block text-xs text-muted">{popupNeedsAck ? "Obrigatório em todo pop-up; fica o comprovante" : "Fica o comprovante de quem confirmou"}</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={form.pinned} onChange={(e) => set("pinned", e.target.checked)} />
                  <span>
                    <span className="flex items-center gap-1 font-medium">
                      <Pin className="h-4 w-4" /> Fixar no topo de {boardName}
                    </span>
                    <span className="block text-xs text-muted">Fica nas manchetes enquanto estiver no período</span>
                  </span>
                </label>
              </div>
              <label className="mt-3 block">
                <span className={labelClass}>Categoria (opcional)</span>
                <input value={form.category ?? ""} onChange={(e) => set("category", e.target.value || null)} list="announcement-categories" placeholder="Ex.: RH, Sistema, Comercial" className={inputClass} />
                <datalist id="announcement-categories">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </label>
            </section>

            <section className="rounded-card border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">Quem recebe</h3>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" checked={audience.all} onChange={() => set("audience", { ...audience, all: true })} /> Todos
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={!audience.all} onChange={() => set("audience", { ...audience, all: false })} /> Escolher
                </label>
              </div>
              {!audience.all && (
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-muted">Perfis</p>
                    {(["AGENT", "MANAGER", "ADMIN"] as Role[]).map((r) => (
                      <label key={r} className="flex items-center gap-2 py-0.5 text-sm">
                        <input type="checkbox" checked={audience.roles.includes(r)} onChange={() => set("audience", { ...audience, roles: toggleIn(audience.roles, r) })} /> {ROLE_LABEL[r]}
                      </label>
                    ))}
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-muted">Atendentes da conexão</p>
                    <div className="max-h-36 overflow-y-auto">
                      {connections?.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 py-0.5 text-sm">
                          <input type="checkbox" checked={audience.connectionIds.includes(c.id)} onChange={() => set("audience", { ...audience, connectionIds: toggleIn(audience.connectionIds, c.id) })} /> {c.name}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs font-semibold text-muted">Pessoas ({audience.userIds.length})</p>
                    <input value={userQuery} onChange={(e) => setUserQuery(e.target.value)} placeholder="Buscar" className="focus-ring mb-1 w-full rounded-lg border border-border bg-transparent px-2 py-1 text-xs" />
                    <div className="max-h-28 overflow-y-auto">
                      {users.map((u) => (
                        <label key={u.id} className="flex items-center gap-2 py-0.5 text-sm">
                          <input type="checkbox" checked={audience.userIds.includes(u.id)} onChange={() => set("audience", { ...audience, userIds: toggleIn(audience.userIds, u.id) })} /> {u.displayName}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {audienceEmpty && <p className="mt-2 text-xs text-red-600">Escolha pelo menos um perfil, conexão ou pessoa.</p>}
              <p className="mt-2 text-xs text-muted">Quem combina com qualquer uma das escolhas recebe.</p>
            </section>
          </div>

          <div className="lg:sticky lg:top-4 lg:self-start">
            <p className="mb-2 text-sm font-medium">Como vai aparecer</p>
            <div className="rounded-[26px] bg-surface-alt p-4">
              <div className="mx-auto h-[600px] max-w-[360px]">
                <StoryCard
                  item={{ ...form, images: previewImages, attachments: previewPdfs }}
                  boardName={boardName}
                  index={0}
                  total={1}
                  progress={0.35}
                  primaryLabel={popupNeedsAck || form.requireAck ? "Li e estou ciente" : "Entendi"}
                  onPrimary={() => undefined}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          {!form.title.trim() && <p className="mr-auto text-xs text-muted">Dê um título ao aviso.</p>}
          <button onClick={onClose} className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
            Cancelar
          </button>
          <button onClick={save} disabled={invalid || saving} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
            {saving ? "Salvando..." : existing ? "Salvar aviso" : "Publicar aviso"}
          </button>
        </div>
      </div>
    </div>
  );
}
