import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellOff, ChevronDown, Plus, Trash2, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { AUTO_MESSAGE_KINDS, AUTO_MESSAGE_KIND_HINT, AUTO_MESSAGE_KIND_LABEL, PERMISSION, type AutoMessageKind, type ManagedTagDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

const NEW_TAG_COLOR = "#0097B4";

const sameKinds = (a: AutoMessageKind[], b: AutoMessageKind[]) => a.length === b.length && a.every((k) => b.includes(k));

/** "Bloqueia": a summary of the automatic messages the tag stops — "—" when none. */
function blockedSummary(kinds: AutoMessageKind[]) {
  return kinds.length === 0 ? "—" : AUTO_MESSAGE_KINDS.filter((k) => kinds.includes(k)).map((k) => AUTO_MESSAGE_KIND_LABEL[k]).join(", ");
}

/**
 * "Não enviar estas mensagens automáticas": the list of automatic messages customers with this tag never get —
 * Gestor/Administrador only (Etiquetas — mensagens automáticas bloqueadas).
 */
function BlockedMessagesPicker({ value, onChange, disabled }: { value: AutoMessageKind[]; onChange: (v: AutoMessageKind[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = (kind: AutoMessageKind) => onChange(value.includes(kind) ? value.filter((k) => k !== kind) : [...value, kind]);
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-start text-xs text-muted hover:text-[var(--color-text)]"
      >
        <BellOff className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">Bloqueia:</span>
        <span className={value.length ? "text-[var(--color-text)]" : undefined}>{blockedSummary(value)}</span>
        <ChevronDown className={`ms-auto h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <fieldset disabled={disabled} className="mt-1.5 rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs font-semibold">Não enviar estas mensagens automáticas</legend>
          {disabled && <p className="mb-1.5 text-[11px] text-muted">Só gestor e administrador podem mudar esta lista.</p>}
          <div className="grid gap-1.5 sm:grid-cols-2">
            {AUTO_MESSAGE_KINDS.map((kind) => (
              <label key={kind} className="flex cursor-pointer items-start gap-2 rounded-md p-1 text-xs hover:bg-surface-alt">
                <input type="checkbox" checked={value.includes(kind)} onChange={() => toggle(kind)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" />
                <span>
                  <span className="font-medium">{AUTO_MESSAGE_KIND_LABEL[kind]}</span>
                  <span className="block text-muted">{AUTO_MESSAGE_KIND_HINT[kind]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

interface QueueUserOption {
  id: string;
  displayName: string;
  presence: "ONLINE" | "AWAY" | "OFFLINE";
}

const PRESENCE_LABEL: Record<QueueUserOption["presence"], string> = { ONLINE: "online", AWAY: "pausado", OFFLINE: "offline" };
const PRESENCE_DOT: Record<QueueUserOption["presence"], string> = { ONLINE: "bg-success", AWAY: "bg-warning", OFFLINE: "bg-muted" };

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * "Atendida por": a new conversation of a customer with this tag goes straight to the least busy marked user online; in
 * the queue, only they see the customer. With nobody of them online (or all paused) the customer goes to everyone.
 * Gestor/Administrador only, like Bloqueia.
 */
function QueueUsersPicker({ value, onChange, users, disabled }: { value: string[]; onChange: (v: string[]) => void; users: QueueUserOption[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  const names = users.filter((u) => value.includes(u.id)).map((u) => u.displayName);
  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-start text-xs text-muted hover:text-[var(--color-text)]"
      >
        <UserCheck className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">Atendida por:</span>
        <span className={names.length ? "text-[var(--color-text)]" : undefined}>{names.length ? names.join(", ") : "todos"}</span>
        <ChevronDown className={`ms-auto h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <fieldset disabled={disabled} className="mt-1.5 rounded-lg border border-border p-2.5">
          <legend className="px-1 text-xs font-semibold">Quem atende os clientes com esta etiqueta</legend>
          <p className="mb-1.5 text-[11px] text-muted">
            Na fila, só os usuários marcados veem esses clientes. Se nenhum deles estiver online (pausado também conta como fora), o cliente vai para
            todos. Nenhum marcado = todos atendem.
          </p>
          {disabled && <p className="mb-1.5 text-[11px] text-muted">Só gestor e administrador podem mudar esta lista.</p>}
          <div className="grid gap-1 sm:grid-cols-2">
            {users.map((user) => (
              <label key={user.id} className="flex cursor-pointer items-center gap-2 rounded-md p-1 text-xs hover:bg-surface-alt">
                <input type="checkbox" checked={value.includes(user.id)} onChange={() => toggle(user.id)} className="h-3.5 w-3.5 shrink-0 accent-primary" />
                <span className="min-w-0 flex-1 truncate">{user.displayName}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${PRESENCE_DOT[user.presence]}`} />
                  {PRESENCE_LABEL[user.presence]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

function TagRow({
  tag,
  onChanged,
  canEdit,
  canDelete,
  canBlock,
  users,
}: {
  tag: ManagedTagDTO;
  onChanged: () => void;
  canEdit: boolean;
  canDelete: boolean;
  canBlock: boolean;
  users: QueueUserOption[];
}) {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [blocked, setBlocked] = useState<AutoMessageKind[]>(tag.blockedAutoMessages);
  const [queueUsers, setQueueUsers] = useState<string[]>(tag.queueUserIds);
  const [confirming, setConfirming] = useState(false);
  const blockedChanged = !sameKinds(blocked, tag.blockedAutoMessages);
  const queueUsersChanged = !sameIds(queueUsers, tag.queueUserIds);
  const dirty = name.trim() !== tag.name || color.toLowerCase() !== tag.color.toLowerCase() || blockedChanged || queueUsersChanged;

  const save = useMutation({
    // The list goes only when it changed — and only someone allowed to change it can.
    mutationFn: () =>
      api.patch(`/contacts/tags/${tag.id}`, {
        name: name.trim(),
        color,
        ...(blockedChanged && { blockedAutoMessages: blocked }),
        ...(queueUsersChanged && { queueUserIds: queueUsers }),
      }),
    onSuccess: () => {
      toast.success("Etiqueta salva.");
      onChanged();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/contacts/tags/${tag.id}`),
    onSuccess: () => {
      toast.success(`Etiqueta "${tag.name}" excluída.`);
      onChanged();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          value={color}
          disabled={!canEdit}
          onChange={(e) => setColor(e.target.value)}
          aria-label={`Cor da etiqueta ${tag.name}`}
          className="h-8 w-8 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
        />
        <input
          value={name}
          readOnly={!canEdit}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          aria-label="Nome da etiqueta"
          className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 py-1.5 text-sm"
        />
        <span className="w-20 shrink-0 text-end text-xs tabular-nums text-muted">
          {tag.contactCount} {tag.contactCount === 1 ? "contato" : "contatos"}
        </span>
        {canDelete && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="focus-ring shrink-0 rounded-lg p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
            aria-label={`Excluir etiqueta ${tag.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      <BlockedMessagesPicker value={blocked} onChange={setBlocked} disabled={!canBlock} />
      <QueueUsersPicker value={queueUsers} onChange={setQueueUsers} users={users} disabled={!canBlock} />
      {dirty && !confirming && (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setName(tag.name);
              setColor(tag.color);
              setBlocked(tag.blockedAutoMessages);
              setQueueUsers(tag.queueUserIds);
            }}
            className="focus-ring rounded-lg border border-border px-2.5 py-1 text-xs"
          >
            Descartar
          </button>
          <button
            type="button"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
            className="focus-ring rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-fg disabled:opacity-50"
          >
            Salvar
          </button>
        </div>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center justify-end gap-2 rounded-lg bg-danger-soft px-2.5 py-2 text-xs text-danger">
          <span className="me-auto">
            Excluir "{tag.name}"? {tag.contactCount > 0 && `Sai de ${tag.contactCount} ${tag.contactCount === 1 ? "contato" : "contatos"}.`}
          </span>
          <button type="button" onClick={() => setConfirming(false)} className="focus-ring rounded-lg border border-danger/30 px-2.5 py-1">
            Cancelar
          </button>
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
            className="focus-ring rounded-lg bg-danger px-2.5 py-1 font-semibold text-white disabled:opacity-50"
          >
            Excluir
          </button>
        </div>
      )}
    </li>
  );
}

/** Automação › Etiquetas: o único lugar onde as etiquetas são cadastradas; no atendimento elas só são escolhidas na lista. */
export default function EtiquetasPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const canAdd = !!permissions?.[PERMISSION.ETIQUETAS_ADICIONAR];
  const canEdit = !!permissions?.[PERMISSION.ETIQUETAS_EDITAR];
  const canDelete = !!permissions?.[PERMISSION.ETIQUETAS_EXCLUIR];
  const canBlock = !!permissions?.[PERMISSION.ETIQUETAS_BLOQUEIOS];
  const queryClient = useQueryClient();
  const { data: tags } = useQuery({
    queryKey: ["managed-tags"],
    queryFn: async () => (await api.get<ManagedTagDTO[]>("/contacts/tags")).data,
  });
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(NEW_TAG_COLOR);
  const [newBlocked, setNewBlocked] = useState<AutoMessageKind[]>([]);
  const [newQueueUsers, setNewQueueUsers] = useState<string[]>([]);
  // "Atendida por": everyone active who attends, with their presence now.
  const { data: users = [] } = useQuery({
    queryKey: ["tag-queue-users"],
    queryFn: async () => (await api.get<QueueUserOption[]>("/agents/transfer-targets", { params: { excludeSelf: false } })).data,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["managed-tags"] });
    queryClient.invalidateQueries({ queryKey: ["tags"] });
    queryClient.invalidateQueries({ queryKey: ["contacts"] });
  }

  const create = useMutation({
    mutationFn: () =>
      api.post("/contacts/tags", {
        name: newName.trim(),
        color: newColor,
        ...(newBlocked.length && { blockedAutoMessages: newBlocked }),
        ...(newQueueUsers.length && { queueUserIds: newQueueUsers }),
      }),
    onSuccess: () => {
      setNewName("");
      setNewBlocked([]);
      setNewQueueUsers([]);
      refresh();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    // The page scrolls on its own (the app's main area doesn't): on a phone, Bloqueia / Atendida por open need it.
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-3 pb-8 sm:p-6">
        <p className="text-sm text-muted">
          Etiquetas que os atendentes escolhem no painel do cliente durante o atendimento. Em <strong>Bloqueia</strong>, escolha as mensagens automáticas
          que os clientes com a etiqueta não recebem — por exemplo, funcionários sem pesquisa de satisfação. O que for bloqueado fica registrado em
          Relatórios › Mensagens bloqueadas. Em <strong>Atendida por</strong>, escolha quem atende esses clientes: a conversa nova vai direto para um deles que estiver online,
          e na fila só eles os veem. Com todos offline ou em pausa, o cliente vai para a fila de todos.
        </p>
        {canAdd && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) create.mutate();
            }}
            className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface p-3"
          >
            <input
              type="color"
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
              aria-label="Cor da nova etiqueta"
              className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-border bg-transparent p-0.5"
            />
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={40}
              placeholder="Nova etiqueta"
              className="focus-ring min-w-[10rem] flex-1 rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={!newName.trim() || create.isPending}
              className="focus-ring flex shrink-0 items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-fg disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> Criar
            </button>
            {canBlock && <BlockedMessagesPicker value={newBlocked} onChange={setNewBlocked} />}
            {canBlock && <QueueUsersPicker value={newQueueUsers} onChange={setNewQueueUsers} users={users} />}
          </form>
        )}

        {tags?.length === 0 && <p className="text-center text-sm text-muted">Nenhuma etiqueta ainda.</p>}
        {!!tags?.length && (
          <ul className="divide-y divide-border rounded-card border border-border bg-surface">
            {tags.map((t) => (
              <TagRow
                key={`${t.id}-${t.name}-${t.color}-${t.blockedAutoMessages.join()}-${t.queueUserIds.join()}`}
                tag={t}
                onChanged={refresh}
                canEdit={canEdit}
                canDelete={canDelete}
                canBlock={canEdit && canBlock}
                users={users}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
