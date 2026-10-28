import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { AuditLogDTO, PaginatedResult } from "@whatsunivida/types";
import { api } from "../../lib/api";

// Every distinct `entity` string ever passed to writeAudit() across the API
// — see e.g. auth.service.ts, users.routes.ts, conversations.routes.ts. The
// backend filter is an exact match, so the keys here double as the filter's
// option list; a new entity added on the backend just won't have a
// dedicated filter option or translated label here until this map is
// updated (it still shows up fine under "Todas", just untranslated).
const ENTITY_LABEL: Record<string, string> = {
  User: "Usuário",
  Conversation: "Conversa",
  Contact: "Contato",
  Message: "Mensagem",
  WhatsAppConnection: "Conexão WhatsApp",
  SystemSetting: "Configuração",
  RolePermission: "Permissão",
};

// Every distinct `action` string ever passed to writeAudit() — see the same
// call sites as ENTITY_LABEL above. formatAction falls back to a generic
// (still readable, just untranslated) rendering for anything not listed
// here, so a new action added later never shows up blank.
const ACTION_LABEL: Record<string, string> = {
  LOGIN_SUCCESS: "Login realizado",
  LOGIN_FAILED: "Falha no login",
  LOGIN_BLOCKED_INACTIVE: "Login bloqueado (usuário inativo)",
  LOGOUT: "Logout",
  PASSWORD_RESET_REQUESTED: "Redefinição de senha solicitada",
  PASSWORD_RESET_COMPLETED: "Redefinição de senha concluída",
  CONVERSATION_STARTED: "Conversa iniciada",
  CONVERSATION_ACCEPTED: "Conversa aceita",
  CONVERSATION_TRANSFERRED: "Conversa transferida",
  CONVERSATION_TRANSFER_REVERTED: "Transferência revertida (destinatário não logou a tempo)",
  CONVERSATIONS_MERGED: "Conversas mescladas",
  CONVERSATION_CLOSED: "Conversa encerrada",
  CONTACTS_AUTO_MERGED: "Contatos mesclados automaticamente",
  MESSAGE_SENT: "Mensagem enviada",
  MESSAGE_DELETED: "Mensagem excluída",
  USER_CREATED: "Usuário criado",
  USER_UPDATED: "Usuário atualizado",
  USER_ACTIVATED: "Usuário ativado",
  USER_DEACTIVATED: "Usuário inativado",
  USER_FORCE_LOGGED_OUT: "Usuário desconectado por um administrador",
  USER_PASSWORD_RESET_BY_ADMIN: "Senha redefinida por um administrador",
  PROFILE_UPDATED: "Perfil atualizado",
  PROFILE_PHOTO_UPLOADED: "Foto de perfil enviada",
  PROFILE_PHOTO_REMOVED: "Foto de perfil removida",
  PROFILE_PASSWORD_CHANGED: "Senha alterada",
  SETTINGS_BRANDING_UPDATED: "Identidade visual atualizada",
  SETTINGS_LOGO_UPLOADED: "Logo enviada",
  SETTINGS_FAVICON_UPLOADED: "Favicon enviado",
  SETTINGS_BUSINESS_UPDATED: "Configurações gerais atualizadas",
  SETTINGS_EMAIL_UPDATED: "Configuração de e-mail atualizada",
  SETTINGS_EMAIL_TEST_SENT: "E-mail de teste enviado",
  PERMISSIONS_UPDATED: "Permissões atualizadas",
  WHATSAPP_CONNECTION_CREATED: "Conexão WhatsApp criada",
  WHATSAPP_CONNECTION_UPDATED: "Conexão WhatsApp atualizada",
  WHATSAPP_CONNECTION_DELETED: "Conexão WhatsApp excluída",
  WHATSAPP_CONNECT_REQUESTED: "Conexão WhatsApp solicitada",
  WHATSAPP_DISCONNECTED: "WhatsApp desconectado",
  WHATSAPP_RECONNECT_REQUESTED: "Reconexão WhatsApp solicitada",
};

function formatAction(action: string): string {
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  // Fallback for anything not in the map above: "MENSAGEM_ENVIADA" -> "Mensagem enviada".
  const readable = action.toLowerCase().replace(/_/g, " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

function formatEntity(entity: string): string {
  return ENTITY_LABEL[entity] ?? entity;
}

interface MessageAuditMetadata {
  contactName?: string | null;
  contactPhone?: string | null;
  text?: string | null;
}

/** Only Message-entity entries (send/delete) currently carry contact/text info — see messages.routes.ts. */
function readMessageMetadata(log: AuditLogDTO): MessageAuditMetadata {
  if (log.entity !== "Message" || typeof log.metadata !== "object" || log.metadata === null) return {};
  return log.metadata as MessageAuditMetadata;
}

async function fetchAuditLog(cursor: string | undefined, entity: string) {
  const res = await api.get<PaginatedResult<AuditLogDTO>>("/audit-logs", {
    params: { cursor, limit: 50, entity: entity || undefined },
  });
  return res.data;
}

export default function AuditoriaPage() {
  const [entity, setEntity] = useState("");
  const [logs, setLogs] = useState<AuditLogDTO[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  const query = useQuery({
    queryKey: ["audit-log", entity],
    queryFn: () => fetchAuditLog(undefined, entity),
  });

  // A filter change restarts the list from page one rather than appending —
  // same reset-on-filter-change shape as everywhere else filters exist in
  // this app (Relatórios, Gestão).
  useEffect(() => {
    if (!query.data) return;
    setLogs(query.data.items);
    setCursor(query.data.nextCursor ?? undefined);
  }, [query.data]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchAuditLog(cursor, entity);
      setLogs((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor ?? undefined);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Histórico de ações realizadas no sistema — logins, alterações de conversas, usuários e configurações.</p>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Entidade</span>
          <select
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            className="focus-ring rounded-card border border-border bg-transparent px-3 py-1.5 text-sm"
          >
            <option value="">Todas</option>
            {Object.entries(ENTITY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="shadow-soft flex-1 overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Data/hora</th>
              <th className="px-4 py-3">Usuário</th>
              <th className="px-4 py-3">Ação</th>
              <th className="px-4 py-3">Entidade</th>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Texto</th>
              <th className="px-4 py-3">IP</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!query.isLoading && logs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted">
                  Nenhum registro encontrado.
                </td>
              </tr>
            )}
            {logs.map((log) => {
              const { contactName, contactPhone, text } = readMessageMetadata(log);
              const client = contactName || contactPhone;
              return (
                <tr key={log.id} className="border-t border-border align-top hover:bg-surface-alt">
                  <td className="whitespace-nowrap px-4 py-3 text-muted">{format(new Date(log.createdAt), "dd/MM/yyyy HH:mm:ss")}</td>
                  <td className="px-4 py-3">{log.userDisplayName}</td>
                  <td className="px-4 py-3">{formatAction(log.action)}</td>
                  <td className="px-4 py-3 text-muted">{formatEntity(log.entity)}</td>
                  <td className="px-4 py-3 text-muted">{client ?? "-"}</td>
                  <td className="max-w-xs truncate px-4 py-3 text-muted" title={text ?? undefined}>
                    {text ?? "-"}
                  </td>
                  <td className="px-4 py-3 text-muted">{log.ipAddress ?? "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {cursor && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
          >
            {loadingMore ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      )}
    </div>
  );
}
