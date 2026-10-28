import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import clsx from "clsx";
import { BellOff, ChevronsLeft, ChevronsRight, Clock, Plus, Tag as TagIcon, User, X } from "lucide-react";
import { toast } from "sonner";
import { AUTO_MESSAGE_KINDS, AUTO_MESSAGE_KIND_LABEL, type ContactPanelDTO, type ConversationListItemDTO, type TagDTO } from "@whatsatendende/types";
import { PreviousConversationDrawer } from "./PreviousConversationDrawer";
import { ClientDataSection } from "./ClientDataSection";
import { ContactContractField } from "./ContactContractField";
import { ContactFirstNameField } from "./ContactFirstNameField";
import { useClientData } from "../../hooks/useClientData";
import { api, getApiErrorMessage } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";
import { formatPhone } from "../../lib/format-phone";
import { ContactPhoto } from "../common/ContactPhoto";

// "Mostrar mais" under Conversas anteriores loads this many at a time.
const PREVIOUS_PAGE = 5;

const STATUS_LABEL: Record<string, string> = {
  IN_FLOW: "No fluxo",
  NEW: "Nova",
  WAITING: "Na fila",
  IN_PROGRESS: "Em atendimento",
  TRANSFERRED: "Transferida",
  CLOSED: "Encerrada",
  ABANDONED: "Abandonada",
  FLOW_ABANDONED: "Abandonado no fluxo",
  HANDLED_EXTERNALLY: "Pelo celular",
};

function Avatar({ conversation, size }: { conversation: ConversationListItemDTO; size: "sm" | "lg" }) {
  const name = contactDisplayName(conversation.contact, conversation.channel);
  return (
    <ContactPhoto photoUrl={conversation.contact.photoUrl} name={name} phone={conversation.contact.phone}>
      <div
        className={clsx(
          "shrink-0 overflow-hidden rounded-full bg-primary/15 font-semibold text-primary",
          size === "lg" ? "h-16 w-16 text-lg" : "h-8 w-8 text-[11px]"
        )}
      >
        {conversation.contact.photoUrl ? (
          <img src={conversation.contact.photoUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">{name.slice(0, 2).toUpperCase()}</div>
        )}
      </div>
    </ContactPhoto>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="truncate text-right font-medium">{value}</span>
    </div>
  );
}

/**
 * Third column of Atendimento: who the customer is, their tags and earlier
 * conversations. Collapses into a thin rail (choice remembered by
 * AtendimentoPage) so the chat can take the full width.
 */
export function ClientPanel({
  conversation,
  collapsed,
  onToggle,
  readOnly,
}: {
  conversation: ConversationListItemDTO;
  collapsed: boolean;
  onToggle: () => void;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["contact-panel", conversation.id];
  const [addingTag, setAddingTag] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [openPrevious, setOpenPrevious] = useState<string | null>(null);
  // "Mostrar mais" under Conversas anteriores: the pages loaded after the first few.
  const [morePrevious, setMorePrevious] = useState<ContactPanelDTO["previousConversations"]>([]);
  const { data: clientData } = useClientData(conversation.id);
  // Reading the client's data fills an empty Contrato from the spreadsheet: show it.
  const clientKey = clientData?.client?.key;
  useEffect(() => {
    if (clientKey) queryClient.invalidateQueries({ queryKey: ["contact-panel", conversation.id] });
  }, [clientKey, conversation.id, queryClient]);

  const { data: panel } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<ContactPanelDTO>(`/conversations/${conversation.id}/contact-panel`)).data,
  });
  const { data: allTags } = useQuery({
    queryKey: ["tags"],
    queryFn: async () => (await api.get<TagDTO[]>("/tags")).data,
    enabled: addingTag,
  });

  const addTag = useMutation({
    mutationFn: (input: { tagId: string }) => api.post<ContactPanelDTO>(`/conversations/${conversation.id}/contact-tags`, input),
    onSuccess: (res) => {
      queryClient.setQueryData(queryKey, res.data);
      queryClient.invalidateQueries({ queryKey: ["tags"] });
      setTagInput("");
      setAddingTag(false);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const removeTag = useMutation({
    mutationFn: (tagId: string) => api.delete<ContactPanelDTO>(`/conversations/${conversation.id}/contact-tags/${tagId}`),
    onSuccess: (res) => queryClient.setQueryData(queryKey, res.data),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const loadMorePrevious = useMutation({
    mutationFn: async (skip: number) =>
      (await api.get<ContactPanelDTO["previousConversations"]>(`/conversations/${conversation.id}/previous-conversations`, { params: { skip, take: PREVIOUS_PAGE } })).data,
    onSuccess: (page) => setMorePrevious((list) => [...list, ...page]),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const name = contactDisplayName(conversation.contact, conversation.channel);
  const previous = [...(panel?.previousConversations ?? []), ...morePrevious];
  const previousLeft = (panel?.previousConversationCount ?? 0) - previous.length;

  if (collapsed) {
    const rail = [
      { icon: User, label: "Dados do cliente" },
      { icon: Clock, label: "Conversas anteriores" },
      { icon: TagIcon, label: "Etiquetas" },
    ];
    return (
      <aside className="hidden w-12 shrink-0 flex-col items-center gap-1.5 border-l border-border bg-surface py-3 md:flex" aria-label="Painel do cliente recolhido">
        <button
          type="button"
          onClick={onToggle}
          className="focus-ring mb-1 flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
          aria-label="Abrir painel do cliente"
          title="Abrir painel do cliente"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={onToggle} className="focus-ring rounded-full" title={name} aria-label={`Abrir dados de ${name}`}>
          <Avatar conversation={conversation} size="sm" />
        </button>
        {rail.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={onToggle}
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
            title={item.label}
            aria-label={item.label}
          >
            <item.icon className="h-4 w-4" />
          </button>
        ))}
      </aside>
    );
  }

  const usedTagIds = new Set(panel?.tags.map((t) => t.id));
  const typed = tagInput.trim();
  const suggestions = (allTags ?? []).filter((t) => !usedTagIds.has(t.id) && (!typed || t.name.toLowerCase().includes(typed.toLowerCase()))).slice(0, 6);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden border-l border-border bg-surface" aria-label="Painel do cliente">
      <div className="flex shrink-0 justify-end px-3 pt-3">
        <button
          type="button"
          onClick={onToggle}
          className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
          aria-label="Recolher painel do cliente"
          title="Recolher painel do cliente"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-5">
        <div className="flex flex-col items-center text-center">
          <Avatar conversation={conversation} size="lg" />
          <p className="mt-2 max-w-full truncate text-[15px] font-semibold">{name}</p>
          {conversation.contact.phone && <p className="text-xs tabular-nums text-muted">{formatPhone(conversation.contact.phone)}</p>}
          {panel && <ContactFirstNameField conversationId={conversation.id} firstName={panel.firstName} contactName={conversation.contact.name} readOnly={readOnly} />}
          {panel && <ContactContractField conversationId={conversation.id} contractNumber={panel.contractNumber} contracts={panel.contracts} readOnly={readOnly} />}
        </div>

        {clientData && clientData.status !== "NO_SOURCE" && (
          <Section title="Dados do cliente">
            <ClientDataSection conversationId={conversation.id} readOnly={readOnly} />
          </Section>
        )}

        <Section title="Conversa atual">
          <Row
            label="Conexão"
            value={
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: conversation.whatsappConnectionColor }} />
                {conversation.whatsappConnectionName}
              </span>
            }
          />
          <Row label="Entrou na fila" value={format(new Date(conversation.enteredQueueAt), "dd/MM HH:mm")} />
          {conversation.acceptedAt && (
            <Row label="Em atendimento" value={formatDistanceToNow(new Date(conversation.acceptedAt), { locale: ptBR })} />
          )}
        </Section>

        <Section title="Etiquetas">
          <div className="flex flex-wrap gap-1.5">
            {panel?.tags.map((tag) => (
              <span
                key={tag.id}
                className="group inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                style={{ backgroundColor: `${tag.color}1F`, color: tag.color }}
              >
                {tag.name}
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => removeTag.mutate(tag.id)}
                    className="focus-ring -mr-1 rounded-full p-0.5 opacity-60 hover:opacity-100"
                    aria-label={`Remover etiqueta ${tag.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))}
            {!readOnly && !addingTag && (
              <button
                type="button"
                onClick={() => setAddingTag(true)}
                className="focus-ring inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-0.5 text-xs font-medium text-muted hover:border-primary hover:text-primary"
              >
                <Plus className="h-3 w-3" /> adicionar
              </button>
            )}
            {readOnly && panel?.tags.length === 0 && <span className="text-xs text-muted">Nenhuma etiqueta.</span>}
          </div>
          <BlockedMessagesNotice tags={panel?.tags ?? []} />
          {addingTag && (
            <div className="mt-2 rounded-lg border border-border bg-surface-alt p-2">
              <input
                autoFocus
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setAddingTag(false);
                  if (e.key === "Enter" && typed) {
                    e.preventDefault();
                    const match = allTags?.find((t) => t.name.toLowerCase() === typed.toLowerCase()) ?? suggestions[0];
                    if (match) addTag.mutate({ tagId: match.id });
                  }
                }}
                maxLength={40}
                placeholder="Buscar etiqueta"
                className="focus-ring w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {suggestions.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => addTag.mutate({ tagId: tag.id })}
                    className="focus-ring rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: `${tag.color}1F`, color: tag.color }}
                  >
                    {tag.name}
                  </button>
                ))}
                {suggestions.length === 0 && (
                  <span className="text-[11px] text-muted">Nenhuma etiqueta encontrada. As etiquetas são cadastradas em Automação › Etiquetas.</span>
                )}
              </div>
              <button type="button" onClick={() => setAddingTag(false)} className="focus-ring mt-1.5 text-[11px] text-muted hover:underline">
                Cancelar
              </button>
            </div>
          )}
        </Section>

        <Section title={`Conversas anteriores · ${panel?.previousConversationCount ?? 0}`}>
          {panel && panel.previousConversations.length === 0 && <p className="text-xs text-muted">Primeira conversa deste cliente.</p>}
          <div className="space-y-1.5">
            {previous.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => setOpenPrevious(c.id)}
                className="focus-ring flex w-full items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-xs hover:bg-surface-alt"
                title="Abrir conversa (somente leitura)"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{format(new Date(c.startedAt), "dd MMM yyyy", { locale: ptBR })}</span>
                  {c.agentName && <span className="text-muted"> · {c.agentName}</span>}
                </span>
                <span className="shrink-0 text-muted">{STATUS_LABEL[c.status] ?? c.status}</span>
              </button>
            ))}
          </div>
          {previousLeft > 0 && (
            <button
              type="button"
              onClick={() => loadMorePrevious.mutate(previous.length)}
              disabled={loadMorePrevious.isPending}
              className="focus-ring mt-2 text-[11px] font-semibold text-primary hover:underline disabled:opacity-60"
            >
              {loadMorePrevious.isPending
                ? "Carregando..."
                : `Mostrar mais ${Math.min(PREVIOUS_PAGE, previousLeft)} (${previousLeft} ${previousLeft === 1 ? "restante" : "restantes"})`}
            </button>
          )}
        </Section>
        {openPrevious && <PreviousConversationDrawer conversationId={conversation.id} previousId={openPrevious} onClose={() => setOpenPrevious(null)} />}
      </div>
    </aside>
  );
}

/** "Este cliente não recebe: …" — the automatic messages its tags stop (Etiquetas › Bloqueia), so nobody wonders why. */
function BlockedMessagesNotice({ tags }: { tags: TagDTO[] }) {
  const kinds = AUTO_MESSAGE_KINDS.filter((kind) => tags.some((t) => t.blockedAutoMessages.includes(kind)));
  if (kinds.length === 0) return null;
  const tagNames = tags.filter((t) => t.blockedAutoMessages.length > 0).map((t) => t.name);
  return (
    <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft px-2 py-1.5 text-[11px] text-warning" title={`Pela etiqueta: ${tagNames.join(", ")}`}>
      <BellOff className="mt-px h-3.5 w-3.5 shrink-0" />
      <span>
        <strong>Este cliente não recebe:</strong> {kinds.map((k) => AUTO_MESSAGE_KIND_LABEL[k]).join(", ")}
        {kinds.includes("NO_RETURN") && " — não é encerrado automaticamente"}.
      </span>
    </p>
  );
}
