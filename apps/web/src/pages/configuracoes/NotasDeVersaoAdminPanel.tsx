import { useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Eye, ImagePlus, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  RELEASE_NOTE_AREAS,
  RELEASE_NOTE_TYPE_LABEL,
  compareVersions,
  type Permission,
  type ReleaseContent,
  type ReleaseDTO,
  type ReleaseNoteArea,
  type ReleaseNoteDTO,
  type ReleaseNoteImageDTO,
  type ReleaseNoteType,
  type Role,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { RELEASE_NOTES_QUERY_KEY } from "../../hooks/useReleaseNotes";
import { ReleaseView } from "../../components/release-notes/ReleaseView";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

const ADMIN_QUERY_KEY = ["release-notes-admin"];
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const TYPES: ReleaseNoteType[] = ["novo", "melhoria", "correcao"];

// Who reads a note: everyone who can open its area, or only some roles on top of that.
type Audience = "area" | "managers" | "admins" | "custom";
const AUDIENCE_LABEL: Record<Exclude<Audience, "custom">, string> = {
  area: "Todos que acessam a área",
  managers: "Só gestores e administradores",
  admins: "Só administradores",
};

const IMAGE_SIZE_LABEL = { normal: "Grande", small: "Média", tiny: "Pequena" } as const;
type ImageSize = keyof typeof IMAGE_SIZE_LABEL;

interface NoteDraft {
  key: string;
  type: ReleaseNoteType;
  area: ReleaseNoteArea;
  title: string;
  text: string;
  before: string;
  after: string;
  /** One step per line. */
  steps: string;
  where: string;
  images: { src: string; caption: string; size: ImageSize }[];
  audience: Audience;
  /** Kept as they were — set by whoever wrote the note, not edited here. */
  roles?: Role[];
  requires?: Permission[];
}

interface ReleaseDraft {
  version: string;
  date: string;
  name: string;
  summary: string;
  notes: NoteDraft[];
}

let nextKey = 0;
const newKey = () => `nota-${++nextKey}`;

function todayLabel(now = new Date()): string {
  return `${String(now.getDate()).padStart(2, "0")} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}

/** 2.2.0 → 2.2.1: a starting number for a new version, that the administrator can change. */
export function nextVersionAfter(versions: string[]): string {
  const latest = [...versions].sort((a, b) => compareVersions(b, a))[0];
  if (!latest) return "1.0.0";
  const [major, minor, patch] = latest.split(".").map(Number);
  return `${major}.${minor}.${(patch || 0) + 1}`;
}

function audienceOf(roles: Role[] | undefined): Audience {
  if (!roles || roles.length === 0) return "area";
  const set = [...roles].sort().join(",");
  if (set === "ADMIN,MANAGER") return "managers";
  if (set === "ADMIN") return "admins";
  return "custom";
}

function blankNote(): NoteDraft {
  return { key: newKey(), type: "novo", area: "geral", title: "", text: "", before: "", after: "", steps: "", where: "", images: [], audience: "area" };
}

function toDraft(release: ReleaseContent): ReleaseDraft {
  return {
    version: release.version,
    date: release.date,
    name: release.name,
    summary: release.summary,
    notes: release.notes.map((n) => ({
      key: newKey(),
      type: n.type,
      area: n.area,
      title: n.title,
      text: n.text ?? "",
      before: n.before ?? "",
      after: n.after ?? "",
      steps: (n.steps ?? []).join("\n"),
      where: n.where ?? "",
      images: (n.images ?? []).map((image) => ({ src: image.src, caption: image.caption, size: image.size ?? "normal" })),
      audience: audienceOf(n.roles),
      roles: n.roles,
      requires: n.requires,
    })),
  };
}

/** What is saved — and what the preview draws, so both are always the same. */
export function toContent(draft: ReleaseDraft): ReleaseContent {
  return {
    version: draft.version.trim(),
    date: draft.date.trim(),
    name: draft.name.trim(),
    summary: draft.summary.trim(),
    notes: draft.notes.map((n): ReleaseNoteDTO => {
      const steps = n.steps
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const roles: Role[] | undefined = n.audience === "managers" ? ["ADMIN", "MANAGER"] : n.audience === "admins" ? ["ADMIN"] : n.audience === "custom" ? n.roles : undefined;
      return {
        type: n.type,
        area: n.area,
        title: n.title.trim(),
        ...(n.text.trim() && { text: n.text.trim() }),
        ...(n.before.trim() && { before: n.before.trim() }),
        ...(n.after.trim() && { after: n.after.trim() }),
        ...(steps.length > 0 && { steps }),
        ...(n.where.trim() && { where: n.where.trim() }),
        ...(n.images.length > 0 && {
          images: n.images.map((image): ReleaseNoteImageDTO => ({ src: image.src, caption: image.caption.trim(), ...(image.size !== "normal" && { size: image.size }) })),
        }),
        ...(n.requires && n.requires.length > 0 && { requires: n.requires }),
        ...(roles && { roles }),
      };
    }),
  };
}

/** The first thing to fix before saving, in words — or null when the version can be saved. */
export function draftProblem(draft: ReleaseDraft, otherVersions: string[]): string | null {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(draft.version.trim())) return "Use o número da versão no formato 2.3.0.";
  if (otherVersions.includes(draft.version.trim())) return `Já existe a versão ${draft.version.trim()}.`;
  if (!draft.date.trim()) return "Informe a data.";
  if (!draft.name.trim()) return "Dê um nome à versão.";
  if (!draft.summary.trim()) return "Escreva o resumo da versão.";
  if (draft.notes.length === 0) return "Adicione pelo menos uma nota.";
  for (const [i, n] of draft.notes.entries()) {
    if (!n.title.trim()) return `Nota ${i + 1}: falta o título.`;
    if (Boolean(n.before.trim()) !== Boolean(n.after.trim())) return `Nota ${i + 1}: preencha o Antes e o Agora juntos (ou nenhum dos dois).`;
  }
  return null;
}

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function NoteEditor({
  note,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  note: NoteDraft;
  index: number;
  count: number;
  onChange: (patch: Partial<NoteDraft>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    const form = new FormData();
    form.append("file", file);
    setUploading(true);
    try {
      const { data } = await api.post<{ src: string }>("/release-notes/images", form, { headers: { "Content-Type": "multipart/form-data" } });
      onChange({ images: [...note.images, { src: data.src, caption: "", size: "normal" }] });
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Não foi possível enviar a imagem."));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const setImage = (i: number, patch: Partial<NoteDraft["images"][number]>) => onChange({ images: note.images.map((image, j) => (j === i ? { ...image, ...patch } : image)) });

  return (
    <section className="rounded-card border border-border bg-surface p-4" aria-label={`Nota ${index + 1}`}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">
          Nota {index + 1}
          {note.title.trim() && <span className="font-normal text-muted"> · {note.title.trim()}</span>}
        </h4>
        <div className="flex gap-1">
          <button type="button" onClick={() => onMove(-1)} disabled={index === 0} className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt disabled:opacity-30" aria-label={`Subir nota ${index + 1}`}>
            <ArrowUp className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={index === count - 1} className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt disabled:opacity-30" aria-label={`Descer nota ${index + 1}`}>
            <ArrowDown className="h-4 w-4" />
          </button>
          <button type="button" onClick={onRemove} className="focus-ring rounded-card p-1.5 text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Remover nota ${index + 1}`}>
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1 block text-sm font-medium">Tipo</legend>
            <div className="flex rounded-card border border-border p-0.5" role="radiogroup" aria-label={`Tipo da nota ${index + 1}`}>
              {TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={note.type === type}
                  onClick={() => onChange({ type })}
                  className={clsx("focus-ring flex-1 rounded-[10px] px-2 py-1.5 text-xs font-semibold", note.type === type ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt")}
                >
                  {RELEASE_NOTE_TYPE_LABEL[type]}
                </button>
              ))}
            </div>
          </fieldset>
          <Field label="Área">
            <select value={note.area} onChange={(e) => onChange({ area: e.target.value as ReleaseNoteArea })} className={inputClass}>
              {(Object.keys(RELEASE_NOTE_AREAS) as ReleaseNoteArea[]).map((area) => (
                <option key={area} value={area}>
                  {RELEASE_NOTE_AREAS[area].label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Título">
          <input value={note.title} onChange={(e) => onChange({ title: e.target.value })} maxLength={200} className={inputClass} />
        </Field>
        <Field label="Texto">
          <textarea rows={4} value={note.text} onChange={(e) => onChange({ text: e.target.value })} maxLength={4000} className={clsx(inputClass, "resize-y")} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Antes" hint="Como era. Preencha junto com o Agora.">
            <textarea rows={2} value={note.before} onChange={(e) => onChange({ before: e.target.value })} maxLength={1000} className={clsx(inputClass, "resize-y")} />
          </Field>
          <Field label="Agora" hint="Como ficou.">
            <textarea rows={2} value={note.after} onChange={(e) => onChange({ after: e.target.value })} maxLength={1000} className={clsx(inputClass, "resize-y")} />
          </Field>
        </div>
        <Field label="Como usar" hint="Um passo por linha. Escreva {1}, {2}… para a marcação numerada do print.">
          <textarea rows={3} value={note.steps} onChange={(e) => onChange({ steps: e.target.value })} className={clsx(inputClass, "resize-y")} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Onde fica">
            <input value={note.where} onChange={(e) => onChange({ where: e.target.value })} maxLength={300} placeholder="Ex: Dashboard › Apresentação (PPT)" className={inputClass} />
          </Field>
          <Field label="Quem vê" hint={note.requires?.length ? "Esta nota também exige uma permissão específica da área." : undefined}>
            <select value={note.audience} onChange={(e) => onChange({ audience: e.target.value as Audience })} className={inputClass}>
              {(Object.keys(AUDIENCE_LABEL) as (keyof typeof AUDIENCE_LABEL)[]).map((audience) => (
                <option key={audience} value={audience}>
                  {AUDIENCE_LABEL[audience]}
                </option>
              ))}
              {note.audience === "custom" && <option value="custom">Como estava ({note.roles?.join(", ")})</option>}
            </select>
          </Field>
        </div>

        <div>
          <span className="mb-1 block text-sm font-medium">Imagens</span>
          <div className="space-y-2">
            {note.images.map((image, i) => (
              <div key={`${image.src}-${i}`} className="flex flex-wrap items-start gap-3 rounded-card border border-border p-2">
                <img src={image.src} alt="" className="h-16 w-24 shrink-0 rounded-md border border-border bg-surface-alt object-cover" />
                <div className="min-w-[12rem] flex-1 space-y-2">
                  <input
                    value={image.caption}
                    onChange={(e) => setImage(i, { caption: e.target.value })}
                    maxLength={500}
                    placeholder="Legenda — ex: {1} Apresentação (PPT)"
                    aria-label={`Legenda da imagem ${i + 1} da nota ${index + 1}`}
                    className={inputClass}
                  />
                  <select value={image.size} onChange={(e) => setImage(i, { size: e.target.value as ImageSize })} aria-label={`Tamanho da imagem ${i + 1} da nota ${index + 1}`} className={inputClass}>
                    {(Object.keys(IMAGE_SIZE_LABEL) as ImageSize[]).map((size) => (
                      <option key={size} value={size}>
                        {IMAGE_SIZE_LABEL[size]}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => onChange({ images: note.images.filter((_, j) => j !== i) })}
                  className="focus-ring rounded-card p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                  aria-label={`Remover imagem ${i + 1} da nota ${index + 1}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} aria-label={`Arquivo de imagem da nota ${index + 1}`} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || note.images.length >= 10}
            className="focus-ring mt-2 flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt disabled:opacity-60"
          >
            <ImagePlus className="h-4 w-4" /> {uploading ? "Enviando..." : "Adicionar imagem"}
          </button>
          <p className="mt-1 text-xs text-muted">PNG, JPG ou WebP de até 5 MB. Use prints com dados de exemplo, nunca de clientes reais.</p>
        </div>
      </div>
    </section>
  );
}

function ReleaseEditor({
  editing,
  initial,
  otherVersions,
  onClose,
}: {
  editing: ReleaseDTO | null;
  initial: ReleaseDraft;
  otherVersions: string[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(initial);
  const [mobileView, setMobileView] = useState<"editar" | "previa">("editar");
  const content = useMemo(() => toContent(draft), [draft]);
  const problem = draftProblem(draft, otherVersions);

  const save = useMutation({
    mutationFn: async () => (editing ? await api.put<ReleaseDTO>(`/release-notes/${editing.id}`, content) : await api.post<ReleaseDTO>("/release-notes", content)).data,
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ADMIN_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: RELEASE_NOTES_QUERY_KEY });
      toast.success(`Versão ${saved.version} salva.`);
      onClose();
    },
    onError: (err) => toast.error(getApiErrorMessage(err, "Não foi possível salvar a versão.")),
  });

  const set = (patch: Partial<ReleaseDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setNote = (key: string, patch: Partial<NoteDraft>) => setDraft((d) => ({ ...d, notes: d.notes.map((n) => (n.key === key ? { ...n, ...patch } : n)) }));
  const moveNote = (index: number, delta: -1 | 1) =>
    setDraft((d) => {
      const notes = [...d.notes];
      const [moved] = notes.splice(index, 1);
      notes.splice(index + delta, 0, moved);
      return { ...d, notes };
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{editing ? `Editar versão ${editing.version}` : "Nova versão"}</h2>
          <p className="text-xs text-muted">A prévia mostra a versão como ela vai aparecer em Notas de versão. Cada pessoa vê só as notas das telas que pode acessar.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring rounded-card border border-border px-4 py-2 text-sm">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending || problem !== null}
            title={problem ?? undefined}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {save.isPending ? "Salvando..." : "Salvar versão"}
          </button>
        </div>
      </div>
      {problem && (
        <p className="rounded-card bg-warning-soft px-3 py-2 text-sm text-warning" role="status">
          Para salvar: {problem}
        </p>
      )}

      <div className="flex rounded-card border border-border p-0.5 xl:hidden" role="tablist" aria-label="Editar ou ver a prévia">
        {(["editar", "previa"] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={mobileView === view}
            onClick={() => setMobileView(view)}
            className={clsx("focus-ring flex-1 rounded-[10px] px-2 py-1.5 text-xs font-semibold", mobileView === view ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt")}
          >
            {view === "editar" ? "Editar" : "Prévia"}
          </button>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className={clsx("space-y-4", mobileView === "previa" && "hidden xl:block")}>
          <div className="space-y-3 rounded-card border border-border bg-surface p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Versão" hint="A de número mais alto é a atual.">
                <input value={draft.version} onChange={(e) => set({ version: e.target.value })} placeholder="2.3.0" className={clsx(inputClass, "font-mono")} />
              </Field>
              <Field label="Data">
                <input value={draft.date} onChange={(e) => set({ date: e.target.value })} placeholder={todayLabel()} maxLength={40} className={inputClass} />
              </Field>
            </div>
            <Field label="Nome da versão">
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} placeholder="Ex: Apresentação do Dashboard" className={inputClass} />
            </Field>
            <Field label="Resumo" hint="Aparece no alto da versão e no aviso de novidades.">
              <textarea rows={3} value={draft.summary} onChange={(e) => set({ summary: e.target.value })} maxLength={1000} className={clsx(inputClass, "resize-y")} />
            </Field>
          </div>

          {draft.notes.map((note, i) => (
            <NoteEditor
              key={note.key}
              note={note}
              index={i}
              count={draft.notes.length}
              onChange={(patch) => setNote(note.key, patch)}
              onMove={(delta) => moveNote(i, delta)}
              onRemove={() => set({ notes: draft.notes.filter((n) => n.key !== note.key) })}
            />
          ))}
          <button
            type="button"
            onClick={() => set({ notes: [...draft.notes, blankNote()] })}
            className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-card border border-dashed border-border py-3 text-sm font-medium text-muted hover:bg-surface-alt"
          >
            <Plus className="h-4 w-4" /> Adicionar nota
          </button>
        </div>

        <aside className={clsx("min-w-0 xl:sticky xl:top-0 xl:self-start", mobileView === "editar" && "hidden xl:block")} aria-label="Prévia">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">
            <Eye className="h-3.5 w-3.5" /> Prévia
          </p>
          <div className="max-h-[calc(100vh-12rem)] overflow-y-auto rounded-card border border-border bg-[var(--color-bg)] p-4">
            <ReleaseView release={content} />
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * Configurações › Notas de versão (administrador): every version with its notes — edit, delete, create — with a
 * preview of each one as people will read it. See PROMPT: "precisa ter nas configurações o cadastro das notas de
 * versão, tendo possibilidade de editar as existentes, excluir e também cadastrar as novas, podendo visualizar uma
 * prévia antes de salvar".
 */
export function NotasDeVersaoAdminPanel() {
  const columnView = useColumnView("notasDeVersao");
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ release: ReleaseDTO | null; draft: ReleaseDraft } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReleaseDTO | null>(null);

  const { data: releases, isLoading } = useQuery({
    queryKey: ADMIN_QUERY_KEY,
    queryFn: async () => (await api.get<ReleaseDTO[]>("/release-notes/all")).data,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/release-notes/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ADMIN_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: RELEASE_NOTES_QUERY_KEY });
      toast.success("Versão excluída.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  if (editing) {
    return (
      <ReleaseEditor
        editing={editing.release}
        initial={editing.draft}
        otherVersions={(releases ?? []).filter((r) => r.id !== editing.release?.id).map((r) => r.version)}
        onClose={() => setEditing(null)}
      />
    );
  }

  function startNew() {
    setEditing({
      release: null,
      draft: { version: nextVersionAfter((releases ?? []).map((r) => r.version)), date: todayLabel(), name: "", summary: "", notes: [blankNote()] },
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="text-base font-semibold">Notas de versão</h2>
          <p className="mt-1 text-sm text-muted">
            O que mudou em cada versão, para quem usa o sistema. Cada nota aparece só para quem acessa a área dela (e, se escolhido, só para gestores ou
            administradores). A versão de número mais alto é a atual: ao publicar uma nova, cada pessoa recebe o aviso de novidades uma vez.
          </p>
        </div>
        {/* Waits for the list: the new version's number starts after the latest one. */}
        <button
          onClick={startNew}
          disabled={!releases}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90 disabled:opacity-60"
        >
          <Plus className="h-4 w-4" /> Nova versão
        </button>
      </div>

      <div className="shadow-soft overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-0 py-3 pl-2 pr-0">
                <ColumnViewMenu view={columnView} />
              </th>
              {columnView.visibleKeys.map((key) => {
                switch (key) {
                  case "version":
                    return (
                      <th key="version" className="px-4 py-3">Versão</th>
                    );
                  case "date":
                    return (
                      <th key="date" className="px-4 py-3">Data</th>
                    );
                  case "name":
                    return (
                      <th key="name" className="px-4 py-3">Nome</th>
                    );
                  case "notes":
                    return (
                      <th key="notes" className="px-4 py-3 text-right">Notas</th>
                    );
                  default:
                    return null;
                }
              })}
              <th className="px-4 py-3 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && releases?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhuma versão cadastrada.
                </td>
              </tr>
            )}
            {releases?.map((r, i) => (
              <tr key={r.id} className="border-t border-border hover:bg-surface-alt">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "version":
                      return (
                        <td key="version" className="whitespace-nowrap px-4 py-3 font-mono font-semibold">
                          {r.version}
                          {i === 0 && <span className="ms-1.5 rounded-full bg-primary/10 px-1.5 py-px align-[1px] font-sans text-[9.5px] font-bold uppercase text-primary">Atual</span>}
                        </td>
                      );
                    case "date":
                      return (
                        <td key="date" className="whitespace-nowrap px-4 py-3 text-muted">{r.date}</td>
                      );
                    case "name":
                      return (
                        <td key="name" className="px-4 py-3">{r.name}</td>
                      );
                    case "notes":
                      return (
                        <td key="notes" className="px-4 py-3 text-right tabular-nums text-muted">{r.notes.length}</td>
                      );
                    default:
                      return null;
                  }
                })}
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => setEditing({ release: r, draft: toDraft(r) })}
                      className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt"
                      aria-label={`Editar versão ${r.version}`}
                      title="Editar"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(r)}
                      className="focus-ring rounded-card p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                      aria-label={`Excluir versão ${r.version}`}
                      title="Excluir"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated" role="dialog" aria-label="Excluir versão">
            <h2 className="text-base font-semibold">Excluir a versão {deleteTarget.version}?</h2>
            <p className="mt-2 text-sm text-muted">
              "{deleteTarget.name}" e as suas {deleteTarget.notes.length} {deleteTarget.notes.length === 1 ? "nota somem" : "notas somem"} das Notas de versão de todos. Não dá para desfazer.
            </p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => remove.mutate(deleteTarget.id)}
                disabled={remove.isPending}
                className="focus-ring flex-1 rounded-card bg-red-600 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {remove.isPending ? "Excluindo..." : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
