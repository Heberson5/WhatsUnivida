import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import clsx from "clsx";
import { Database, FileSpreadsheet, Link2, LogIn, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  DATA_SOURCE_ROLES,
  PERMISSION,
  type BoletoLayoutDTO,
  type DataSourceBankDTO,
  type DataSourceDTO,
  type DataSourceKind,
  type DataSourceRole,
  type DataSourceStatus,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { ConnectionScopePicker } from "../respostas/ConnectionScopePicker";

const KIND_LABEL: Record<DataSourceKind, string> = {
  LINK: "Planilha por link (OneDrive ou Google)",
  MICROSOFT: "Planilha privada (conta Microsoft)",
  UPLOAD: "Arquivo enviado (CSV/XLSX)",
  DATABASE: "Banco de dados (somente leitura)",
};
const KIND_ICON = { LINK: Link2, MICROSOFT: LogIn, UPLOAD: FileSpreadsheet, DATABASE: Database };
const STATUS_STYLE: Record<DataSourceStatus, { label: string; className: string }> = {
  OK: { label: "Funcionando", className: "bg-success/15 text-success" },
  INACTIVE: { label: "Desativada", className: "bg-surface-alt text-muted" },
  ERROR: { label: "Com erro", className: "bg-danger-soft text-danger" },
  STALE: { label: "Desatualizada", className: "bg-warning-soft text-warning" },
  EMPTY: { label: "Sem dados", className: "bg-warning-soft text-warning" },
};
const DEFAULT_PORT = { sqlserver: 1433, postgres: 5432, mysql: 3306 };

type Draft = {
  id?: string;
  name: string;
  kind: DataSourceKind;
  config: Record<string, string | number | null>;
  secrets: { clientSecret?: string; password?: string };
  columnMap: Partial<Record<DataSourceRole, string>>;
  sensitiveColumns: string[];
  overrideContactName: boolean;
  maxAgeHours: number;
  refreshMinutes: number;
  columns: string[];
  allConnections: boolean;
  connectionIds: string[];
  bankLayouts: Record<string, string>;
};

function newDraft(kind: DataSourceKind): Draft {
  return {
    name: "",
    kind,
    config: kind === "DATABASE" ? { dialect: "sqlserver", port: DEFAULT_PORT.sqlserver } : kind === "MICROSOFT" ? { tenantId: "common" } : {},
    secrets: {},
    columnMap: {},
    sensitiveColumns: [DATA_SOURCE_ROLES.cpf.column],
    overrideContactName: false,
    maxAgeHours: 24,
    refreshMinutes: 60,
    columns: [],
    allConnections: true,
    connectionIds: [],
    bankLayouts: {},
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const SYNC_POLL_MS = 5_000;

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";

/** Each bank found in the source's parcels, with the layout its boletos come out in. */
function BankLayoutsField({ sourceId, value, onChange }: { sourceId: string; value: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const { data: banks } = useQuery({
    queryKey: ["data-source-banks", sourceId],
    queryFn: async () => (await api.get<DataSourceBankDTO[]>(`/boletos/sources/${sourceId}/banks`)).data,
  });
  const { data: layouts } = useQuery({ queryKey: ["boleto-layouts"], queryFn: async () => (await api.get<BoletoLayoutDTO[]>("/boletos/layouts")).data });
  return (
    <div>
      <p className="text-sm font-medium">Layout de boleto por banco</p>
      <p className="mb-1.5 text-xs text-muted">Os bancos das parcelas desta fonte. Cada um sai no layout escolhido aqui (Dados › Layouts de boleto).</p>
      {banks?.length === 0 && <p className="text-xs text-muted">Nenhum banco nas parcelas (confira a coluna &quot;Código do banco&quot;).</p>}
      {banks && banks.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase text-muted">
              <th className="py-1 font-semibold">Banco</th>
              <th className="py-1 font-semibold">Parcelas</th>
              <th className="py-1 font-semibold">Layout</th>
            </tr>
          </thead>
          <tbody>
            {banks.map((bank) => {
              const options = layouts?.filter((l) => l.bankCode === bank.code) ?? [];
              return (
                <tr key={bank.code} className="border-t border-border">
                  <td className="py-1.5">
                    {bank.name} ({bank.code})
                  </td>
                  <td className="py-1.5">{bank.parcels.toLocaleString("pt-BR")}</td>
                  <td className="py-1.5">
                    {options.length === 0 ? (
                      <span className="text-xs text-muted">Sem envio de boleto</span>
                    ) : (
                      <select value={value[bank.code] ?? options[0].id} onChange={(e) => onChange({ ...value, [bank.code]: e.target.value })} className={inputClass}>
                        {options.map((layout) => (
                          <option key={layout.id} value={layout.id}>
                            {layout.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {options.length > 0 && !bank.enabled && <span className="mt-0.5 block text-xs text-warning">Envio bloqueado até validar 3 boletos reais</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Dados › Fontes de dados: the spreadsheets or databases behind "Dados do cliente", the {{dados.*}} tags and the boleto — each for its connections. */
export function DataSourcesPanel() {
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdd = Boolean(permissions?.[PERMISSION.FONTES_DADOS_ADICIONAR]);
  const canEdit = Boolean(permissions?.[PERMISSION.FONTES_DADOS_EDITAR]);
  const canDelete = Boolean(permissions?.[PERMISSION.FONTES_DADOS_EXCLUIR]);
  const { data: sources } = useQuery({
    queryKey: ["data-sources"],
    queryFn: async () => (await api.get<DataSourceDTO[]>("/data-sources")).data,
    // A big sheet is read in the background: check until it ends (the socket also refreshes it right when it does).
    refetchInterval: (query) => (query.state.data?.some((s) => s.syncing) ? SYNC_POLL_MS : false),
  });
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<{ id: string; name: string }[]>("/whatsapp/connections")).data,
  });
  const { data: layouts } = useQuery({ queryKey: ["boleto-layouts"], queryFn: async () => (await api.get<BoletoLayoutDTO[]>("/boletos/layouts")).data });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["data-sources"] });
  const onError = (err: unknown) => toast.error(getApiErrorMessage(err));
  // Sources read in the background: when one ends, tell how it went.
  const syncingIds = useRef(new Set<string>());
  const reportSync = (source: DataSourceDTO) => {
    if (source.syncing) {
      syncingIds.current.add(source.id);
      toast.info("Planilha grande: está sendo processada em segundo plano. Pode continuar usando o sistema, avisamos quando terminar.");
    } else if (source.lastSyncError) toast.error(`Erro ao ler: ${source.lastSyncError}`);
    else toast.success(`${source.rowCount.toLocaleString("pt-BR")} linhas carregadas.`);
  };

  useEffect(() => {
    for (const source of sources ?? []) {
      if (syncingIds.current.has(source.id) && !source.syncing) reportSync(source);
      else if (source.syncing) syncingIds.current.add(source.id);
    }
    for (const source of sources ?? []) if (!source.syncing) syncingIds.current.delete(source.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources]);

  const saveMutation = useMutation({
    mutationFn: async (d: Draft) => {
      const body = {
        name: d.name,
        kind: d.kind,
        config: d.config,
        secrets: d.secrets,
        columnMap: d.columnMap,
        sensitiveColumns: d.sensitiveColumns,
        overrideContactName: d.overrideContactName,
        maxAgeHours: d.maxAgeHours,
        refreshMinutes: d.refreshMinutes,
        allConnections: d.allConnections,
        connectionIds: d.connectionIds,
        bankLayouts: d.bankLayouts,
      };
      return (d.id ? await api.put<DataSourceDTO>(`/data-sources/${d.id}`, body) : await api.post<DataSourceDTO>("/data-sources", body)).data;
    },
    onSuccess: () => {
      refresh();
      setDraft(null);
      toast.success("Fonte de dados salva.");
    },
    onError,
  });
  const activeMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => (await api.post<DataSourceDTO>(`/data-sources/${id}/active`, { active })).data,
    onSuccess: (source) => {
      refresh();
      if (source.active && source.kind !== "UPLOAD") reportSync(source);
    },
    onError,
  });
  const syncMutation = useMutation({
    mutationFn: async (id: string) => (await api.post<DataSourceDTO>(`/data-sources/${id}/sync`)).data,
    onSuccess: (source) => {
      refresh();
      reportSync(source);
    },
    onError,
  });
  const uploadMutation = useMutation({
    mutationFn: async ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("file", file);
      return (await api.post<DataSourceDTO>(`/data-sources/${id}/upload`, form)).data;
    },
    onSuccess: (source) => {
      refresh();
      reportSync(source);
    },
    onError,
  });
  const deleteMutation = useMutation({ mutationFn: (id: string) => api.delete(`/data-sources/${id}`), onSuccess: refresh, onError });
  const microsoftMutation = useMutation({
    mutationFn: async (id: string) => (await api.get<{ url: string }>(`/data-sources/${id}/microsoft/authorize`)).data,
    onSuccess: ({ url }) => {
      window.open(url, "microsoft-signin", "width=520,height=680");
      toast.info("Entre com a conta Microsoft na janela que abriu. Depois clique em Atualizar agora.");
    },
    onError,
  });

  function edit(source: DataSourceDTO) {
    setDraft({
      id: source.id,
      name: source.name,
      kind: source.kind,
      config: source.config,
      secrets: {},
      columnMap: source.columnMap,
      sensitiveColumns: source.sensitiveColumns,
      overrideContactName: source.overrideContactName,
      maxAgeHours: source.maxAgeHours,
      refreshMinutes: source.refreshMinutes,
      columns: source.columns,
      allConnections: source.allConnections,
      connectionIds: source.connectionIds,
      bankLayouts: source.bankLayouts,
    });
  }

  const setConfig = (key: string, value: string | number | null) => draft && setDraft({ ...draft, config: { ...draft.config, [key]: value } });

  return (
    <div className="shadow-soft max-w-3xl space-y-5 rounded-card border border-border bg-surface p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Fontes de dados</h2>
          <p className="mt-1 text-sm text-muted">
            A planilha ou o banco que alimenta &quot;Dados do cliente&quot;, as tags <code className="rounded bg-surface-alt px-1">{"{{dados.coluna}}"}</code> e o envio de
            boleto. O cliente é achado pelo telefone (com ou sem 55 e com ou sem o 9). Cada fonte vale para as conexões escolhidas nela, e várias podem ficar ativas
            ao mesmo tempo. Nada aparece para o atendente se a fonte estiver com erro ou passar do prazo de atualização.
          </p>
        </div>
        {canAdd && !draft && (
          <button onClick={() => setDraft(newDraft("LINK"))} className="focus-ring inline-flex shrink-0 items-center gap-1 rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg">
            <Plus className="h-4 w-4" /> Nova fonte
          </button>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.txt,.xlsx,.zip,.gz,text/csv,text/plain,application/zip,application/gzip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && uploadFor) uploadMutation.mutate({ id: uploadFor, file });
          e.target.value = "";
        }}
      />

      {sources?.length === 0 && !draft && <p className="text-sm text-muted">Nenhuma fonte de dados cadastrada.</p>}
      <div className="space-y-2">
        {sources?.map((source) => {
          const Icon = KIND_ICON[source.kind];
          const status = STATUS_STYLE[source.status];
          return (
            <div key={source.id} className="rounded-card border border-border p-3">
              <div className="flex flex-wrap items-center gap-3">
                <Icon className="h-5 w-5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {source.name}
                    <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold", status.className)}>{status.label}</span>
                    {source.syncing && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                        <RefreshCw className="h-3 w-3 animate-spin" /> Processando...
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {KIND_LABEL[source.kind]} · {source.rowCount.toLocaleString("pt-BR")} linhas
                    {source.dataUpdatedAt && ` · dados de ${format(new Date(source.dataUpdatedAt), "dd/MM HH:mm")}`}
                    {source.lastSyncAt && ` · lida às ${format(new Date(source.lastSyncAt), "dd/MM HH:mm")}`}
                  </p>
                  <p className="text-xs text-muted">
                    Conexões:{" "}
                    {source.allConnections
                      ? "todas (as que não estão em outra fonte)"
                      : connections
                          ?.filter((c) => source.connectionIds.includes(c.id))
                          .map((c) => c.name)
                          .join(", ") || "nenhuma"}
                    {Object.entries(source.bankLayouts).map(([bank, layoutId]) => {
                      const layout = layouts?.find((l) => l.id === layoutId);
                      return layout ? ` · ${bank} → ${layout.name}` : "";
                    })}
                  </p>
                </div>
                {canEdit && (
                  <label className="flex items-center gap-1.5 text-xs font-medium">
                    <input
                      type="checkbox"
                      checked={source.active}
                      onChange={(e) => activeMutation.mutate({ id: source.id, active: e.target.checked })}
                      className="h-4 w-4 accent-[var(--color-primary)]"
                    />
                    Ativa
                  </label>
                )}
              </div>
              {source.lastSyncError && <p className="mt-2 rounded-card bg-danger-soft px-3 py-2 text-xs text-danger">{source.lastSyncError}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {canEdit && source.kind === "UPLOAD" && (
                  <button
                    onClick={() => {
                      setUploadFor(source.id);
                      fileRef.current?.click();
                    }}
                    disabled={uploadMutation.isPending || source.syncing}
                    className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-2.5 py-1 text-xs hover:bg-surface-alt disabled:opacity-60"
                  >
                    <Upload className="h-3.5 w-3.5" /> {uploadMutation.isPending ? "Enviando..." : "Enviar arquivo"}
                  </button>
                )}
                {canEdit && source.kind === "MICROSOFT" && (
                  <button onClick={() => microsoftMutation.mutate(source.id)} className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-2.5 py-1 text-xs hover:bg-surface-alt">
                    <LogIn className="h-3.5 w-3.5" /> {source.hasSecrets ? "Entrar com outra conta Microsoft" : "Entrar com a conta Microsoft"}
                  </button>
                )}
                {canEdit && source.kind !== "UPLOAD" && (
                  <button
                    onClick={() => syncMutation.mutate(source.id)}
                    disabled={syncMutation.isPending || source.syncing}
                    className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-2.5 py-1 text-xs hover:bg-surface-alt disabled:opacity-60"
                  >
                    <RefreshCw className={clsx("h-3.5 w-3.5", (syncMutation.isPending || source.syncing) && "animate-spin")} /> Atualizar agora
                  </button>
                )}
                {canEdit && (
                  <button onClick={() => edit(source)} className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-2.5 py-1 text-xs hover:bg-surface-alt">
                    <Pencil className="h-3.5 w-3.5" /> Editar
                  </button>
                )}
                {canDelete && (
                  <button
                    onClick={() => window.confirm(`Excluir a fonte "${source.name}" e os dados que ela trouxe?`) && deleteMutation.mutate(source.id)}
                    className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-2.5 py-1 text-xs text-danger hover:bg-danger-soft"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Excluir
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {draft && (
        <div className="space-y-4 rounded-card border border-primary/40 p-4">
          <h3 className="text-sm font-semibold">{draft.id ? "Editar fonte de dados" : "Nova fonte de dados"}</h3>
          {!draft.id && (
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(KIND_LABEL) as DataSourceKind[]).map((kind) => {
                const Icon = KIND_ICON[kind];
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setDraft({ ...newDraft(kind), name: draft.name })}
                    className={clsx(
                      "focus-ring flex items-center gap-2 rounded-card border px-3 py-2 text-left text-sm",
                      draft.kind === kind ? "border-primary bg-primary/10 font-semibold" : "border-border hover:bg-surface-alt"
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" /> {KIND_LABEL[kind]}
                  </button>
                );
              })}
            </div>
          )}
          <Field label="Nome">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ex.: Planilha de clientes" className={inputClass} />
          </Field>

          {draft.kind === "LINK" && (
            <Field label="Link da planilha" hint='Google Planilhas ou arquivo .xlsx/.csv/.zip no Google Drive: Compartilhar › "Qualquer pessoa com o link". Planilha grande: suba o CSV no Drive sem converter para Planilhas, de preferência compactado em .zip (fica cerca de 10 vezes menor). Links novos do OneDrive pessoal (1drv.ms/…/c/…) a Microsoft não deixa baixar sem entrar na conta: use "Planilha privada (conta Microsoft)".'>
              <input value={String(draft.config.url ?? "")} onChange={(e) => setConfig("url", e.target.value)} placeholder="https://1drv.ms/x/..." className={inputClass} />
            </Field>
          )}

          {draft.kind === "MICROSOFT" && (
            <>
              <Field label="Link do arquivo no OneDrive/SharePoint" hint="O link do arquivo (pode ser só para pessoas da empresa). O acesso usa a conta Microsoft que entrar.">
                <input value={String(draft.config.shareUrl ?? "")} onChange={(e) => setConfig("shareUrl", e.target.value)} className={inputClass} />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="ID do aplicativo (Azure)">
                  <input value={String(draft.config.clientId ?? "")} onChange={(e) => setConfig("clientId", e.target.value)} className={inputClass} />
                </Field>
                <Field label="Locatário (tenant)" hint='"common" serve para a maioria.'>
                  <input value={String(draft.config.tenantId ?? "")} onChange={(e) => setConfig("tenantId", e.target.value)} className={inputClass} />
                </Field>
              </div>
              <Field label="Segredo do aplicativo" hint={draft.id ? "Deixe em branco para manter o que está salvo." : undefined}>
                <input type="password" value={draft.secrets.clientSecret ?? ""} onChange={(e) => setDraft({ ...draft, secrets: { ...draft.secrets, clientSecret: e.target.value } })} className={inputClass} />
              </Field>
              <p className="text-xs text-muted">
                No portal do Azure, registre um aplicativo com a permissão Files.Read.All e este endereço de retorno:{" "}
                <code className="break-all rounded bg-surface-alt px-1">{`${window.location.origin}/api/data-sources/microsoft/callback`}</code>. Depois de salvar, clique em
                &quot;Entrar com a conta Microsoft&quot;.
              </p>
            </>
          )}

          {draft.kind === "UPLOAD" && (
            <p className="text-xs text-muted">
              Depois de salvar, use &quot;Enviar arquivo&quot; para mandar a planilha do jeito que está, em XLSX, CSV ou TXT separado por ponto e vírgula (até 750 mil linhas e 300 MB). CSV é o mais leve, e compactado em .zip ou .gz fica cerca de 10 vezes menor. Planilhas grandes são
              processadas em segundo plano. Para atualizar, envie de novo.
            </p>
          )}

          {draft.kind === "DATABASE" && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Banco">
                  <select
                    value={String(draft.config.dialect)}
                    onChange={(e) => setDraft({ ...draft, config: { ...draft.config, dialect: e.target.value, port: DEFAULT_PORT[e.target.value as keyof typeof DEFAULT_PORT] } })}
                    className={inputClass}
                  >
                    <option value="sqlserver">SQL Server</option>
                    <option value="postgres">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                  </select>
                </Field>
                <Field label="Servidor">
                  <input value={String(draft.config.host ?? "")} onChange={(e) => setConfig("host", e.target.value)} className={inputClass} />
                </Field>
                <Field label="Porta">
                  <input type="number" value={Number(draft.config.port ?? 0)} onChange={(e) => setConfig("port", Number(e.target.value))} className={inputClass} />
                </Field>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Nome do banco">
                  <input value={String(draft.config.database ?? "")} onChange={(e) => setConfig("database", e.target.value)} className={inputClass} />
                </Field>
                <Field label="Usuário (só leitura)">
                  <input value={String(draft.config.user ?? "")} onChange={(e) => setConfig("user", e.target.value)} className={inputClass} />
                </Field>
                <Field label="Senha" hint={draft.id ? "Em branco mantém a salva." : undefined}>
                  <input type="password" value={draft.secrets.password ?? ""} onChange={(e) => setDraft({ ...draft, secrets: { ...draft.secrets, password: e.target.value } })} className={inputClass} />
                </Field>
              </div>
              <Field label="Consulta (um único SELECT)" hint="Use um usuário do banco que só pode ler. A consulta é conferida e nunca altera dados.">
                <textarea rows={5} value={String(draft.config.query ?? "")} onChange={(e) => setConfig("query", e.target.value)} className={clsx(inputClass, "font-mono text-xs")} />
              </Field>
            </>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bloquear dados com mais de (horas)" hint="Passou disso sem atualizar, o atendente vê os dados como indisponíveis.">
              <input type="number" min={1} value={draft.maxAgeHours} onChange={(e) => setDraft({ ...draft, maxAgeHours: Number(e.target.value) })} className={inputClass} />
            </Field>
            {draft.kind !== "UPLOAD" && (
              <Field label="Ler de novo a cada (minutos)">
                <input type="number" min={5} value={draft.refreshMinutes} onChange={(e) => setDraft({ ...draft, refreshMinutes: Number(e.target.value) })} className={inputClass} />
              </Field>
            )}
          </div>
          <ConnectionScopePicker
            value={{ allConnections: draft.allConnections, connectionIds: draft.connectionIds }}
            onChange={(scope) => setDraft({ ...draft, ...scope })}
            hint="Nas conversas dessas conexões, os Dados do cliente, o envio de boleto e as tags de dados usam esta fonte. Uma conexão só pode estar em uma fonte ativa; “Todas as conexões” vale para as conexões que não estão em outra."
          />
          {draft.id && <BankLayoutsField sourceId={draft.id} value={draft.bankLayouts} onChange={(bankLayouts) => setDraft({ ...draft, bankLayouts })} />}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.overrideContactName} onChange={(e) => setDraft({ ...draft, overrideContactName: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
            O nome da planilha substitui o nome do contato (quando o telefone é de um cliente só)
          </label>

          {draft.columns.length > 0 && (
            <>
              <div>
                <p className="mb-1 text-sm font-medium">Colunas sensíveis (aparecem mascaradas)</p>
                <div className="flex flex-wrap gap-1.5">
                  {draft.columns.map((column) => {
                    const on = draft.sensitiveColumns.includes(column);
                    return (
                      <button
                        key={column}
                        type="button"
                        onClick={() => setDraft({ ...draft, sensitiveColumns: on ? draft.sensitiveColumns.filter((c) => c !== column) : [...draft.sensitiveColumns, column] })}
                        className={clsx("focus-ring rounded-full border px-2 py-0.5 text-xs", on ? "border-danger bg-danger-soft text-danger" : "border-border hover:bg-surface-alt")}
                      >
                        {column}
                      </button>
                    );
                  })}
                </div>
              </div>
              <details>
                <summary className="cursor-pointer text-sm font-medium">Qual coluna é cada informação</summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {(Object.entries(DATA_SOURCE_ROLES) as [DataSourceRole, { label: string }][]).map(([role, { label }]) => (
                    <Field key={role} label={label}>
                      <select
                        value={draft.columnMap[role] ?? ""}
                        onChange={(e) => setDraft({ ...draft, columnMap: { ...draft.columnMap, [role]: e.target.value || undefined } })}
                        className={inputClass}
                      >
                        <option value="">—</option>
                        {draft.columns.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
              </details>
            </>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={() => setDraft(null)} className="focus-ring rounded-card px-3 py-2 text-sm hover:bg-surface-alt">
              Cancelar
            </button>
            <button
              onClick={() => saveMutation.mutate(draft)}
              disabled={saveMutation.isPending || !draft.name.trim()}
              className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
            >
              Salvar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
