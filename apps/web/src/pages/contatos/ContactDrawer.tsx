import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Star, X } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, firstNameOf, type ContactDetailDTO, type TagDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { STATUS_COLOR, STATUS_LABEL } from "../../lib/conversationStatus";
import { useAuthStore } from "../../store/auth-store";
import { formatContactPhone } from "./contactFormat";
import { ContractChips } from "../../components/common/ContractChips";

/** One contact: name, contract and tags (editable with Contatos — editar) and every conversation they had. */
export function ContactDrawer({ contactId, tags, onClose }: { contactId: string; tags: TagDTO[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canEditar = permissions?.[PERMISSION.CONTATOS_EDITAR];
  const canOpenGestao = permissions?.[PERMISSION.GESTAO_ACESSAR];

  const { data: contact } = useQuery({
    queryKey: ["contact", contactId],
    queryFn: async () => (await api.get<ContactDetailDTO>(`/contacts/${contactId}`)).data,
  });

  const [name, setName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [contractNumber, setContractNumber] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  useEffect(() => {
    if (!contact) return;
    setName(contact.name ?? "");
    setFirstName(contact.firstName ?? "");
    setContractNumber(contact.contractNumber ?? "");
    setTagIds(contact.tags.map((t) => t.id));
  }, [contact]);

  const save = useMutation({
    mutationFn: async () =>
      (
        await api.patch<ContactDetailDTO>(`/contacts/${contactId}`, {
          name,
          firstName: firstName.trim() || null,
          // Contracts from the Fonte de dados are replaced at each upload — only a typed one is sent.
          ...(fromDataSource ? {} : { contractNumber: contractNumber.trim() || null }),
          tagIds,
        })
      ).data,
    onSuccess: (updated) => {
      queryClient.setQueryData(["contact", contactId], updated);
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
      toast.success("Contato salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const fromDataSource = (contact?.contracts?.length ?? 0) > 0;
  const dirty =
    contact &&
    (name !== (contact.name ?? "") ||
      firstName !== (contact.firstName ?? "") ||
      (!fromDataSource && contractNumber.trim() !== (contact.contractNumber ?? "")) ||
      tagIds.join() !== contact.tags.map((t) => t.id).join());
  const toggleTag = (id: string) => setTagIds((ids) => (ids.includes(id) ? ids.filter((t) => t !== id) : [...ids, id]));

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel max-w-lg" role="dialog" aria-modal="true" aria-labelledby="contact-drawer-title" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id="contact-drawer-title" className="truncate text-base font-semibold">
              {contact ? contact.name || "Sem nome" : "Carregando..."}
            </h2>
            {contact && (
              <p className="text-xs text-muted">
                {formatContactPhone(contact)} · {contact.connectionName ?? "-"} · cliente desde {new Date(contact.firstConversationAt).toLocaleDateString("pt-BR")}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        {contact && (
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Nome</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canEditar}
                maxLength={120}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-70"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium">Primeiro nome</span>
              <input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={!canEditar}
                maxLength={60}
                placeholder={firstNameOf(name) || "Como o cliente é chamado"}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-70"
              />
              <span className="mt-1 block text-xs text-muted">Usado na tag {"{{primeiro_nome}}"} das respostas. Em branco, usa a primeira palavra do nome.</span>
            </label>

            {fromDataSource ? (
              <div>
                <p className="mb-1 text-sm font-medium">Contrato</p>
                <ContractChips contracts={contact.contracts!} detailed />
                <span className="mt-1 block text-xs text-muted">Vem da lista de clientes da Fonte de dados e é atualizado a cada envio da lista — por isso não é editado aqui.</span>
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Contrato</span>
                <input
                  value={contractNumber}
                  onChange={(e) => setContractNumber(e.target.value)}
                  disabled={!canEditar}
                  maxLength={200}
                  placeholder="Número do contrato"
                  className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-70"
                />
                <span className="mt-1 block text-xs text-muted">O mesmo contrato de Atendimento › Dados do cliente. Em branco, o contato fica sem contrato.</span>
              </label>
            )}

            <div>
              <p className="mb-1.5 text-sm font-medium">Etiquetas</p>
              {tags.length === 0 && <p className="text-xs text-muted">Nenhuma etiqueta criada ainda. Crie em Contatos › Etiquetas ou no painel do cliente no Atendimento.</p>}
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => {
                  const on = tagIds.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={!canEditar}
                      onClick={() => toggleTag(t.id)}
                      aria-pressed={on}
                      className={clsx(
                        "focus-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium disabled:cursor-default",
                        on ? "border-[var(--color-text)] bg-surface-alt" : "border-border text-muted hover:text-[var(--color-text)]"
                      )}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t.color }} />
                      {t.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {canEditar && (
              <button
                type="button"
                onClick={() => save.mutate()}
                disabled={!dirty || save.isPending}
                className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-50"
              >
                {save.isPending ? "Salvando..." : "Salvar contato"}
              </button>
            )}

            <div>
              <p className="mb-1.5 text-sm font-medium">Histórico de conversas ({contact.conversations.length})</p>
              {contact.conversations.length === 0 && <p className="text-xs text-muted">Este contato ainda não conversou com a empresa.</p>}
              <ul className="divide-y divide-border rounded-card border border-border">
                {contact.conversations.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="tabular-nums">
                        {new Date(c.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                        <span className="text-muted"> · {c.messageCount} mensagens</span>
                      </p>
                      <p className="truncate text-xs text-muted">{c.agentName ? `Atendido por ${c.agentName}` : "Sem atendente"}</p>
                    </div>
                    {c.satisfactionScore !== null && (
                      <span className="flex items-center gap-0.5 text-xs font-semibold tabular-nums" title="Nota da pesquisa de satisfação">
                        <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" /> {c.satisfactionScore}
                        <span className="font-normal text-muted">/{c.satisfactionScoreMax}</span>
                      </span>
                    )}
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                    {canOpenGestao && (
                      <Link to={`/gestao?open=${c.id}`} className="focus-ring rounded text-xs font-semibold text-primary hover:underline">
                        Abrir
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
