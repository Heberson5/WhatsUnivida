import { MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { AuditLogDTO, PaginatedResult } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

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
  SatisfactionSurveyConfig: "Pesquisa de satisfação",
  ReleaseNoteVersion: "Nota de versão",
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
  LOGOUT_INACTIVITY: "Logoff por inatividade",
  SATISFACTION_SURVEY_CREATED: "Pesquisa de satisfação criada",
  SATISFACTION_SURVEY_UPDATED: "Pesquisa de satisfação alterada",
  SATISFACTION_SURVEY_DELETED: "Pesquisa de satisfação excluída",
  RELEASE_NOTES_CREATED: "Versão das notas de versão criada",
  RELEASE_NOTES_UPDATED: "Versão das notas de versão alterada",
  RELEASE_NOTES_DELETED: "Versão das notas de versão excluída",
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
  GROUP_MESSAGE_SENT: "Mensagem enviada em grupo",
  QUICK_REPLY_MEDIA_SET: "Anexo incluído em resposta rápida",
  QUICK_REPLY_MEDIA_REMOVED: "Anexo removido de resposta rápida",
  CLOSING_MESSAGE_MEDIA_SET: "Anexo incluído em encerramento",
  CLOSING_MESSAGE_MEDIA_REMOVED: "Anexo removido de encerramento",
  CONNECTION_GROUPS_ENABLED: "Grupos do WhatsApp ligados",
  CONNECTION_GROUPS_DISABLED: "Grupos do WhatsApp desligados",
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
  SATISFACTION_SCORE_CORRECTED: "Nota da pesquisa corrigida",
  COLUMN_VIEW_UPDATED: "Visão de colunas alterada",
  COLUMN_VIEW_DELETED: "Visão de colunas excluída",
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
  const columnView = useColumnView("auditoria");
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
              <th className="w-0 py-3 pl-2 pr-0">
                <ColumnViewMenu view={columnView} />
              </th>
              {columnView.visibleKeys.map((key) => {
                switch (key) {
                  case "createdAt":
                    return (
                      <th key="createdAt" className="px-4 py-3">Data/hora</th>
                    );
                  case "user":
                    return (
                      <th key="user" className="px-4 py-3">Usuário</th>
                    );
                  case "action":
                    return (
                      <th key="action" className="px-4 py-3">Ação</th>
                    );
                  case "entity":
                    return (
                      <th key="entity" className="px-4 py-3">Entidade</th>
                    );
                  case "client":
                    return (
                      <th key="client" className="px-4 py-3">Cliente</th>
                    );
                  case "text":
                    return (
                      <th key="text" className="px-4 py-3">Texto</th>
                    );
                  case "ip":
                    return (
                      <th key="ip" className="px-4 py-3">IP</th>
                    );
                  default:
                    return null;
                }
              })}
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 1} className="px-4 py-8 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!query.isLoading && logs.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 1} className="px-4 py-8 text-center text-muted">
                  Nenhum registro encontrado.
                </td>
              </tr>
            )}
            {logs.map((log) => {
              const { contactName, contactPhone, text } = readMessageMetadata(log);
              const client = contactName || contactPhone;
              return (
                <tr key={log.id} className="border-t border-border align-top hover:bg-surface-alt">
                  <td className="w-0 p-0" />
                  {columnView.visibleKeys.map((key) => {
                    switch (key) {
                      case "createdAt":
                        return (
                          <td key="createdAt" className="whitespace-nowrap px-4 py-3 text-muted">{format(new Date(log.createdAt), "dd/MM/yyyy HH:mm:ss")}</td>
                        );
                      case "user":
                        return (
                          <td key="user" className="px-4 py-3">{log.userDisplayName}</td>
                        );
                      case "action":
                        return (
                          <td key="action" className="px-4 py-3">{formatAction(log.action)}</td>
                        );
                      case "entity":
                        return (
                          <td key="entity" className="px-4 py-3 text-muted">{formatEntity(log.entity)}</td>
                        );
                      case "client":
                        return (
                          <td key="client" className="px-4 py-3 text-muted">{client ?? "-"}</td>
                        );
                      case "text":
                        return (
                          <td key="text" className="max-w-xs truncate px-4 py-3 text-muted" title={text ?? undefined}>
                            {text ?? "-"}
                          </td>
                        );
                      case "ip":
                        return (
                          <td key="ip" className="px-4 py-3 text-muted">
                            <span className="whitespace-nowrap tabular-nums">{log.ipAddress ?? "-"}</span>
                            {log.ipPlace ? (
                              <a
                                href={`https://www.google.com/maps?q=${log.ipPlace.latitude},${log.ipPlace.longitude}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-0.5 flex items-center gap-1 whitespace-nowrap text-xs text-primary hover:underline"
                                title="Localização aproximada pelo IP — ver no Google Maps"
                              >
                                <MapPin className="h-3 w-3 shrink-0" /> {log.ipPlace.label}
                              </a>
                            ) : (
                              log.ipInternal && <span className="mt-0.5 block text-xs">Rede interna</span>
                            )}
                          </td>
                        );
                      default:
                        return null;
                    }
                  })}
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
