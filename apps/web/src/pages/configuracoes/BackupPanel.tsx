import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { AlertTriangle, Cloud, CloudUpload, DatabaseBackup, Download, FileArchive, KeyRound, Lock, Server, Upload } from "lucide-react";
import { api, getApiErrorMessage } from "../../lib/api";

interface BackupInfo {
  version: string;
  tables: number;
  approximateRows: number;
  filesBytes: number;
  whatsappSessionsBytes: number;
  last: { at: string; byName: string; kind: "BACKUP" | "RESTORE" } | null;
}

interface BackupSettings {
  drive: {
    configured: boolean;
    connected: boolean;
    clientId: string | null;
    accountEmail: string | null;
    connectedAt: string | null;
    lastError: string | null;
    redirectUri: string;
    folderName: string;
  };
  hasBackupPassword: boolean;
  auto: { enabled: boolean; keep: number; includeFiles: boolean; includeSessions: boolean };
  lastBackupAt: string | null;
  lastBackupSize: number | null;
  lastError: string | null;
  running: boolean;
  backupHour: number;
  freeSpaceMb: number;
  minFreeSpaceMb: number;
  keepRange: { min: number; max: number };
}

interface DriveFile {
  id: string;
  name: string;
  size: number;
  createdTime: string;
}

interface RestoreResult {
  version: string;
  createdAt: string;
  rows: number;
  files: number;
  restarting: boolean;
}

const PASSWORD_MIN = 8;
const input = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";
const primaryButton = "focus-ring inline-flex items-center gap-2 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg shadow-sm disabled:opacity-50";
const ghostButton = "focus-ring inline-flex items-center gap-2 rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt disabled:opacity-50";

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("pt-BR")} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  return `${(bytes / 1024 ** 3).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} GB`;
}

const dateTime = (iso: string | null) => (iso ? format(new Date(iso), "dd/MM/yyyy 'às' HH:mm") : "—");

function afterRestore(r: RestoreResult) {
  toast.success(`Backup de ${format(new Date(r.createdAt), "dd/MM/yyyy HH:mm")} restaurado: ${r.rows.toLocaleString("pt-BR")} registros e ${r.files.toLocaleString("pt-BR")} arquivos.`, { duration: 10_000 });
  if (r.restarting) toast.info("O sistema está reiniciando para carregar tudo. Entre de novo em alguns segundos.", { duration: 10_000 });
  setTimeout(() => window.location.assign("/login"), r.restarting ? 8000 : 2500);
}

/**
 * Configurações › Backup (administrador): one password-protected file with everything — downloaded, or kept on the
 * administrator's Google Drive (by hand or every night) — and restoring it, here or on another server.
 */
export function BackupPanel() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: info, refetch: refetchInfo } = useQuery({ queryKey: ["backup-info"], queryFn: async () => (await api.get<BackupInfo>("/settings/backup/info")).data });
  const { data: settings, refetch: refetchSettings } = useQuery({
    queryKey: ["backup-settings"],
    queryFn: async () => (await api.get<BackupSettings>("/settings/backup/settings")).data,
    // While a backup is going to the Drive, the screen follows it.
    refetchInterval: (q) => (q.state.data?.running ? 3000 : false),
  });

  // Back from Google's authorization page.
  useEffect(() => {
    const outcome = searchParams.get("drive");
    if (!outcome) return;
    if (outcome === "conectado") toast.success("Google Drive conectado");
    else if (outcome === "cancelado") toast.info("Conexão com o Google Drive cancelada");
    else toast.error("Não foi possível conectar o Google Drive. Confira o ID, a chave e o endereço de redirecionamento.");
    const next = new URLSearchParams(searchParams);
    next.delete("drive");
    setSearchParams(next, { replace: true });
    void refetchSettings();
  }, [searchParams, setSearchParams, refetchSettings]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["backup-settings"] });
    void queryClient.invalidateQueries({ queryKey: ["backup-drive-files"] });
    void refetchInfo();
  };

  return (
    <div className="max-w-3xl space-y-5">
      {settings && <DriveSection settings={settings} info={info} onChange={refresh} />}
      <DownloadSection info={info} onDone={() => setTimeout(() => void refetchInfo(), 5000)} />

      <section className="shadow-soft space-y-4 rounded-card border border-border bg-surface p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-info-soft text-info">
            <Server className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Migrar para outro servidor</h2>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>Faça um backup aqui (baixado ou no Google Drive).</li>
              <li>Instale o sistema no servidor novo, na mesma versão ({info?.version ?? "a mesma deste"}).</li>
              <li>
                No arquivo <code>.env</code> do servidor novo, use o mesmo <code>SETTINGS_ENCRYPTION_KEY</code> do atual. Sem ele, as senhas guardadas (e-mail, Meta, fontes de dados e o Google Drive) não podem ser lidas.
              </li>
              <li>Entre no servidor novo como administrador e restaure o arquivo abaixo, com a senha do backup.</li>
            </ol>
          </div>
        </div>
        <p className="flex items-start gap-2 rounded-card bg-surface-alt px-3 py-2 text-xs text-muted">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">
            Arquivo muito grande para enviar pelo navegador? Copie-o para o servidor e rode{" "}
            <code className="break-all rounded bg-surface px-1">docker compose exec api node dist/scripts/restore-backup.js /caminho/do/backup.wabk "senha do backup"</code>
          </span>
        </p>
      </section>

      <RestoreUploadSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Google Drive: connection, backup password, automatic backup, backups kept there
// ---------------------------------------------------------------------------

function DriveSection({ settings, info, onChange }: { settings: BackupSettings; info?: BackupInfo; onChange: () => void }) {
  const drive = settings.drive;
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [keep, setKeep] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<DriveFile | null>(null);

  const { data: driveFiles } = useQuery({
    queryKey: ["backup-drive-files", settings.lastBackupAt ?? ""],
    queryFn: async () => (await api.get<{ connected: boolean; files: DriveFile[] }>("/settings/backup/drive/files")).data,
    enabled: drive.connected,
  });

  const saveCredentials = useMutation({
    mutationFn: () => api.patch("/settings/backup/drive", { clientId: (clientId ?? drive.clientId ?? "").trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) }),
    onSuccess: () => {
      toast.success("Credenciais do Google salvas");
      setClientSecret("");
      onChange();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const connect = useMutation({
    mutationFn: async () => (await api.post<{ url: string }>("/settings/backup/drive/connect")).data,
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const disconnect = useMutation({
    mutationFn: () => api.post("/settings/backup/drive/disconnect"),
    onSuccess: () => {
      toast.success("Google Drive desconectado");
      onChange();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const savePassword = useMutation({
    mutationFn: () => api.put("/settings/backup/password", { password, confirm }),
    onSuccess: () => {
      toast.success("Senha de backup salva");
      setPassword("");
      setConfirm("");
      onChange();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const saveAuto = useMutation({
    mutationFn: (patch: Partial<BackupSettings["auto"]>) => api.patch("/settings/backup/auto", patch),
    onSuccess: () => {
      toast.success("Backup automático atualizado");
      setKeep(null);
      onChange();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const sendNow = useMutation({
    mutationFn: () => api.post("/settings/backup/drive/backup", { files: settings.auto.includeFiles, sessions: settings.auto.includeSessions }),
    onSuccess: () => {
      toast.success("Backup sendo enviado ao Google Drive…");
      onChange();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const ready = drive.connected && settings.hasBackupPassword;
  const hour = `${String(settings.backupHour).padStart(2, "0")}h`;

  return (
    <section className="shadow-soft space-y-5 rounded-card border border-border bg-surface p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Cloud className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Backup no Google Drive</h2>
          <p className="mt-0.5 text-sm text-muted">
            O backup completo vai para a sua conta Google, protegido pela senha de backup. Nada fica guardado neste servidor: o arquivo é montado, enviado e apagado.
          </p>
        </div>
      </div>

      {/* 1. Connection */}
      <div className="rounded-card border border-border p-4">
        <h3 className="text-sm font-semibold">1. Conta do Google Drive</h3>
        <p className="mt-1 text-xs text-muted">
          {drive.connected ? (
            <>
              Conectado como <strong>{drive.accountEmail ?? "sua conta Google"}</strong> desde {dateTime(drive.connectedAt)}. Os backups ficam na pasta <strong>“{drive.folderName}”</strong>.
            </>
          ) : drive.configured ? (
            "Credenciais salvas. Falta conectar com a sua conta Google."
          ) : (
            "Ainda não configurado."
          )}
        </p>
        {drive.lastError && <p className="mt-2 rounded-card bg-danger-soft px-3 py-2 text-xs text-danger">{drive.lastError}</p>}
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveCredentials.mutate();
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium">ID do cliente OAuth</span>
            <input className={input} value={clientId ?? drive.clientId ?? ""} onChange={(e) => setClientId(e.target.value)} placeholder="000000000000-xxxx.apps.googleusercontent.com" autoComplete="off" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Chave secreta do cliente</span>
            <input className={input} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={drive.configured ? "Já cadastrada — preencha só para trocar" : ""} autoComplete="new-password" />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block font-medium">URI de redirecionamento (cole no Google Cloud)</span>
            <input className={`${input} font-mono text-xs`} readOnly value={drive.redirectUri} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" className={ghostButton} disabled={saveCredentials.isPending || !(clientId ?? drive.clientId ?? "").trim()}>
              Salvar credenciais
            </button>
            <button type="button" className={primaryButton} disabled={!drive.configured || connect.isPending} onClick={() => connect.mutate()}>
              {drive.connected ? "Conectar outra vez" : "Conectar com o Google"}
            </button>
            {drive.connected && (
              <button type="button" className={ghostButton} onClick={() => window.confirm("Desconectar o Google Drive? O backup automático para.") && disconnect.mutate()}>
                Desconectar
              </button>
            )}
          </div>
        </form>
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer font-medium text-[var(--color-text)]">Como obter o ID e a chave (uma vez)</summary>
          <ol className="mt-2 list-decimal space-y-1 ps-4">
            <li>Entre em console.cloud.google.com com a conta Google que vai guardar os backups e crie um projeto (gratuito).</li>
            <li>Em APIs e serviços › Biblioteca, ative a “Google Drive API”.</li>
            <li>Na tela de consentimento OAuth, escolha o público “Externo” e preencha o nome do app e o seu e-mail.</li>
            <li>Publique o app (status “Em produção”). Em “Teste”, o Google cancela a autorização a cada 7 dias e os backups param.</li>
            <li>Em Credenciais (ou Clientes), crie um “ID do cliente OAuth” do tipo “Aplicativo da Web” e cole em “URIs de redirecionamento autorizados” o endereço acima.</li>
            <li>Copie o ID do cliente e a chave secreta para cá, salve e clique em “Conectar com o Google”.</li>
            <li>Se o Google mostrar “app não verificado”, é o seu próprio app: clique em Avançado e continue.</li>
          </ol>
          <p className="mt-2">
            O sistema só enxerga as pastas e arquivos que ele mesmo cria no Drive; o resto da sua conta fica invisível para ele. Pode usar a mesma conta (e o mesmo projeto do Google Cloud) em outros sistemas: cada um tem a própria pasta — só cadastre o URI de
            redirecionamento de cada um.
          </p>
        </details>
      </div>

      {/* 2. Password */}
      <div className="rounded-card border border-border p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Lock className="h-4 w-4" /> 2. Senha de backup
        </h3>
        <p className="mt-1 text-xs text-muted">
          {settings.hasBackupPassword ? <strong>Cadastrada.</strong> : <strong>Ainda não cadastrada.</strong>} Protege os backups enviados ao Google Drive. Sem ela ninguém abre um backup — nem você.{" "}
          <strong>Anote em lugar seguro:</strong> se este servidor for perdido, é ela que abre os backups no servidor novo.
        </p>
        <form
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            savePassword.mutate();
          }}
        >
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={settings.hasBackupPassword ? "Nova senha" : "Senha"} autoComplete="new-password" />
          <input className={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repita a senha" autoComplete="new-password" />
          <button type="submit" className={ghostButton} disabled={password.length < PASSWORD_MIN || password !== confirm || savePassword.isPending}>
            {settings.hasBackupPassword ? "Trocar" : "Salvar"}
          </button>
        </form>
        {settings.hasBackupPassword && <p className="mt-2 text-xs text-muted">Trocar a senha vale para os próximos backups; os que já estão no Drive continuam abrindo com a senha antiga.</p>}
      </div>

      {/* 3. Automatic backup */}
      <div className="rounded-card border border-border p-4">
        <h3 className="text-sm font-semibold">3. Backup automático</h3>
        <label className="mt-2 flex items-start gap-3">
          <input
            type="checkbox"
            checked={settings.auto.enabled}
            disabled={!ready || saveAuto.isPending}
            onChange={(e) => saveAuto.mutate({ enabled: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
          />
          <span className="text-sm">
            <span className="block font-medium">Fazer backup todo dia a partir das {hour}</span>
            <span className="block text-xs text-muted">{ready ? "Uma vez por noite. Se falhar, os administradores são avisados no sininho e por e-mail." : "Conecte o Google Drive e cadastre a senha de backup para ligar."}</span>
          </span>
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Quantos backups manter no Drive</span>
            <span className="flex gap-2">
              <input
                className={input}
                type="number"
                min={settings.keepRange.min}
                max={settings.keepRange.max}
                value={keep ?? settings.auto.keep}
                onChange={(e) => setKeep(Number(e.target.value))}
              />
              <button type="button" className={ghostButton} disabled={keep === null || keep === settings.auto.keep || saveAuto.isPending} onClick={() => keep !== null && saveAuto.mutate({ keep })}>
                Salvar
              </button>
            </span>
            <span className="mt-1 block text-xs text-muted">Os mais recentes ficam; os mais antigos são apagados sozinhos (de {settings.keepRange.min} a {settings.keepRange.max}).</span>
          </label>
          <div className="space-y-2 text-sm">
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={settings.auto.includeFiles} onChange={(e) => saveAuto.mutate({ includeFiles: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
              <span>
                Incluir os arquivos {info && <span className="text-muted">({size(info.filesBytes)})</span>}
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={settings.auto.includeSessions} onChange={(e) => saveAuto.mutate({ includeSessions: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
              <span>
                Incluir as sessões do WhatsApp <span className="block text-xs text-muted">Num servidor novo, as conexões por QR Code voltam sem ler o QR Code de novo.</span>
              </span>
            </label>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className={primaryButton} disabled={!ready || settings.running || sendNow.isPending} onClick={() => sendNow.mutate()}>
            <CloudUpload className="h-4 w-4" /> {settings.running ? "Enviando ao Drive…" : "Fazer backup no Drive agora"}
          </button>
          <span className="text-xs text-muted">
            Último backup no Drive: {dateTime(settings.lastBackupAt)}
            {settings.lastBackupSize ? ` (${size(settings.lastBackupSize)})` : ""} · Espaço livre no servidor: {size(settings.freeSpaceMb * 1024 * 1024)}
          </span>
        </div>
        {settings.lastError && !settings.running && (
          <p className="mt-2 flex items-start gap-2 rounded-card bg-danger-soft px-3 py-2 text-xs text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Último erro: {settings.lastError}
          </p>
        )}
      </div>

      {/* 4. Backups on the Drive */}
      {drive.connected && (
        <div className="rounded-card border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Backups no Google Drive</th>
                <th className="px-3 py-2 font-medium">Tamanho</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {driveFiles?.files.map((f) => (
                <tr key={f.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className="block">{dateTime(f.createdTime)}</span>
                    <span className="block break-all text-xs text-muted">{f.name}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{size(f.size)}</td>
                  <td className="px-3 py-2 text-right">
                    <button className="focus-ring rounded-card px-2 py-1 text-xs font-semibold text-danger hover:bg-danger-soft" onClick={() => setRestoring(f)}>
                      Restaurar
                    </button>
                  </td>
                </tr>
              ))}
              {driveFiles?.files.length === 0 && (
                <tr className="border-t border-border">
                  <td colSpan={3} className="px-3 py-3 text-xs text-muted">
                    Nenhum backup no Drive ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {restoring && <RestoreDriveDialog file={restoring} onClose={() => setRestoring(null)} />}
    </section>
  );
}

function RestoreDriveDialog({ file, onClose }: { file: DriveFile; onClose: () => void }) {
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const restore = useMutation({
    mutationFn: async () => (await api.post<RestoreResult>(`/settings/backup/drive/files/${file.id}/restore`, { confirm, ...(password ? { password } : {}) }, { timeout: 0 })).data,
    onSuccess: afterRestore,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !restore.isPending && onClose()}>
      <div className="w-full max-w-md space-y-3 rounded-card bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold">Restaurar o backup de {dateTime(file.createdTime)}?</h3>
        <p className="text-sm text-muted">
          Substitui <b>tudo</b> deste servidor pelo que está no backup. O que foi feito aqui depois dele se perde. O arquivo é baixado, aberto e conferido antes de qualquer mudança.
        </p>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Senha do backup</span>
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Em branco: a senha de backup cadastrada" autoComplete="off" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Digite RESTAURAR para confirmar</span>
          <input className={input} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {restore.isPending && <p className="text-xs text-muted">Baixando do Drive e restaurando… não feche esta página.</p>}
        <div className="flex justify-end gap-2">
          <button className={ghostButton} disabled={restore.isPending} onClick={onClose}>
            Cancelar
          </button>
          <button className="focus-ring inline-flex items-center gap-2 rounded-card bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={confirm.trim().toUpperCase() !== "RESTAURAR" || restore.isPending} onClick={() => restore.mutate()}>
            <Upload className="h-4 w-4" /> Restaurar
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Download now (to this computer)
// ---------------------------------------------------------------------------

function DownloadSection({ info, onDone }: { info?: BackupInfo; onDone: () => void }) {
  const [files, setFiles] = useState(true);
  // The connections (WhatsApp sessions) go by default: without them every QR Code connection has to be read again.
  const [sessions, setSessions] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const download = useMutation({
    mutationFn: async () => (await api.post<{ url: string }>("/settings/backup/download-ticket", { files, sessions, password })).data,
    onSuccess: ({ url }) => {
      // A plain link (valid once, for two minutes): the browser saves it as it arrives, however big it is.
      const link = document.createElement("a");
      link.href = url;
      link.click();
      toast.success("Backup sendo gerado — o download começa em instantes.");
      setPassword("");
      setConfirm("");
      onDone();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <section className="shadow-soft space-y-4 rounded-card border border-border bg-surface p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <DatabaseBackup className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Baixar backup agora</h2>
          <p className="mt-0.5 text-sm text-muted">
            Um único arquivo com tudo do sistema (usuários, conversas, contatos, chat interno, configurações e respostas), protegido pela senha que você digitar — para guardar ou levar para outro servidor.
          </p>
        </div>
      </div>
      {info && (
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Versão do sistema" value={info.version} />
          <Stat label="Tabelas" value={info.tables.toLocaleString("pt-BR")} />
          <Stat label="Registros (aprox.)" value={info.approximateRows.toLocaleString("pt-BR")} />
          <Stat label="Arquivos enviados" value={size(info.filesBytes)} />
        </dl>
      )}
      <div className="space-y-2">
        <label className="flex items-start gap-3 rounded-card border border-border px-3 py-2">
          <input type="checkbox" checked={files} onChange={(e) => setFiles(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
          <span>
            <span className="block text-sm font-medium">Incluir os arquivos {info && <span className="text-muted">({size(info.filesBytes)})</span>}</span>
            <span className="block text-xs text-muted">Fotos, áudios, documentos das conversas, boletos, anexos das respostas e imagens das notas de versão.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-card border border-border px-3 py-2">
          <input type="checkbox" checked={sessions} onChange={(e) => setSessions(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
          <span>
            <span className="block text-sm font-medium">Incluir as sessões do WhatsApp {info && <span className="text-muted">({size(info.whatsappSessionsBytes)})</span>}</span>
            <span className="block text-xs text-muted">
              As conexões por QR Code voltam conectadas no servidor novo, sem ler o QR Code de novo. Desligue o servidor antigo antes de ligar o novo, para o WhatsApp não ficar aberto nos dois.
            </span>
          </span>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`Senha do arquivo (mín. ${PASSWORD_MIN} caracteres)`} autoComplete="new-password" />
        <input className={input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repita a senha" autoComplete="new-password" />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => download.mutate()} disabled={password.length < PASSWORD_MIN || password !== confirm || download.isPending} className={primaryButton}>
          <Download className="h-4 w-4" /> Baixar backup
        </button>
        {info?.last && (
          <span className="text-xs text-muted">
            {info.last.kind === "BACKUP" ? "Último backup" : "Última restauração"}: {dateTime(info.last.at)} por {info.last.byName}
          </span>
        )}
      </div>
      <p className="flex items-start gap-2 rounded-card bg-warning-soft px-3 py-2 text-xs text-[var(--color-text)]">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>O arquivo tem todos os dados dos clientes e das conversas. Sem a senha ele não abre — e ela não pode ser recuperada: anote-a.</span>
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Restore from a file on this computer
// ---------------------------------------------------------------------------

function RestoreUploadSection() {
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const restore = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("confirm", confirm);
      if (password) form.append("password", password);
      form.append("file", restoreFile!);
      return (
        await api.post<RestoreResult>("/settings/backup/restore", form, {
          timeout: 0,
          onUploadProgress: (e) => setProgress(e.total ? Math.round((e.loaded / e.total) * 100) : null),
        })
      ).data;
    },
    onSuccess: (r) => {
      setProgress(null);
      afterRestore(r);
    },
    onError: (err) => {
      setProgress(null);
      toast.error(getApiErrorMessage(err));
    },
  });

  return (
    <section className="shadow-soft space-y-4 rounded-card border border-danger/40 bg-surface p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
          <Upload className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold">Restaurar backup de um arquivo</h2>
          <p className="mt-0.5 text-sm text-muted">
            Substitui <b>tudo</b> deste servidor pelo que está no arquivo. O que foi feito aqui depois do backup se perde. O arquivo é lido inteiro e conferido antes de qualquer mudança.
          </p>
        </div>
      </div>
      <input ref={inputRef} type="file" accept=".wabk,.gz,.tgz,application/gzip,application/octet-stream" className="hidden" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
      <button onClick={() => inputRef.current?.click()} className="focus-ring flex w-full items-center gap-3 rounded-card border border-dashed border-border px-4 py-3 text-left text-sm hover:bg-surface-alt">
        <FileArchive className="h-5 w-5 shrink-0 text-muted" />
        {restoreFile ? (
          <span>
            <b>{restoreFile.name}</b> <span className="text-muted">· {size(restoreFile.size)}</span>
          </span>
        ) : (
          <span className="text-muted">Escolher o arquivo do backup (.wabk, ou .tar.gz dos backups antigos)</span>
        )}
      </button>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Senha do backup</span>
          <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Não precisa para os .tar.gz antigos" autoComplete="off" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Digite RESTAURAR para confirmar</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
        </label>
      </div>
      {progress !== null && (
        <div className="space-y-1">
          <div className="h-2 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-xs text-muted">{progress < 100 ? `Enviando ${progress}%…` : "Conferindo e restaurando… não feche esta página."}</p>
        </div>
      )}
      <button
        onClick={() => restore.mutate()}
        disabled={!restoreFile || confirm.trim().toUpperCase() !== "RESTAURAR" || restore.isPending}
        className="focus-ring inline-flex items-center gap-2 rounded-card bg-danger px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        <Upload className="h-4 w-4" /> Restaurar backup
      </button>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card bg-surface-alt px-3 py-2">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
