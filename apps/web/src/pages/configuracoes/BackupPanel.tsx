import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { AlertTriangle, DatabaseBackup, Download, FileArchive, KeyRound, Server, Upload } from "lucide-react";
import { api, getApiErrorMessage, withAuthToken } from "../../lib/api";

interface BackupInfo {
  version: string;
  tables: number;
  approximateRows: number;
  filesBytes: number;
  whatsappSessionsBytes: number;
  last: { at: string; byName: string; kind: "BACKUP" | "RESTORE" } | null;
}

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("pt-BR")} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
  return `${(bytes / 1024 ** 3).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} GB`;
}

/** Configurações › Backup (administrador): everything in one file to move the system to another server, and restoring it. */
export function BackupPanel() {
  const { data: info, refetch } = useQuery({ queryKey: ["backup-info"], queryFn: async () => (await api.get<BackupInfo>("/settings/backup/info")).data });
  const [files, setFiles] = useState(true);
  const [sessions, setSessions] = useState(false);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirm, setConfirm] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function download() {
    // A plain link: the browser saves it as it arrives, however big it is.
    const link = document.createElement("a");
    link.href = withAuthToken(`/api/settings/backup/download?files=${files ? 1 : 0}&sessions=${sessions ? 1 : 0}`);
    link.click();
    toast.success("Backup sendo gerado — o download começa em instantes.");
    setTimeout(() => void refetch(), 5000);
  }

  const restore = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("confirm", confirm);
      form.append("file", restoreFile!);
      return (
        await api.post<{ version: string; createdAt: string; rows: number; files: number; restarting: boolean }>("/settings/backup/restore", form, {
          timeout: 0,
          onUploadProgress: (e) => setProgress(e.total ? Math.round((e.loaded / e.total) * 100) : null),
        })
      ).data;
    },
    onSuccess: (r) => {
      setProgress(null);
      toast.success(`Backup de ${format(new Date(r.createdAt), "dd/MM/yyyy HH:mm")} restaurado: ${r.rows.toLocaleString("pt-BR")} registros e ${r.files.toLocaleString("pt-BR")} arquivos.`, { duration: 10_000 });
      if (r.restarting) toast.info("O sistema está reiniciando para carregar tudo. Entre de novo em alguns segundos.", { duration: 10_000 });
      setTimeout(() => window.location.assign("/login"), r.restarting ? 8000 : 2500);
    },
    onError: (err) => {
      setProgress(null);
      toast.error(getApiErrorMessage(err));
    },
  });

  return (
    <div className="max-w-3xl space-y-5">
      <section className="shadow-soft space-y-4 rounded-card border border-border bg-surface p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <DatabaseBackup className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Fazer backup</h2>
            <p className="mt-0.5 text-sm text-muted">
              Um único arquivo com tudo do sistema: usuários, conversas, contatos, chat interno, configurações e respostas — para guardar ou levar para outro servidor.
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
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={download} className="focus-ring inline-flex items-center gap-2 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg shadow-sm">
            <Download className="h-4 w-4" /> Baixar backup
          </button>
          {info?.last && (
            <span className="text-xs text-muted">
              {info.last.kind === "BACKUP" ? "Último backup" : "Última restauração"}: {format(new Date(info.last.at), "dd/MM/yyyy 'às' HH:mm")} por {info.last.byName}
            </span>
          )}
        </div>
        <p className="flex items-start gap-2 rounded-card bg-warning-soft px-3 py-2 text-xs text-[var(--color-text)]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>O arquivo tem todos os dados dos clientes e das conversas. Guarde em local seguro e não envie por e-mail ou WhatsApp.</span>
        </p>
      </section>

      <section className="shadow-soft space-y-4 rounded-card border border-border bg-surface p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-info-soft text-info">
            <Server className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Migrar para outro servidor</h2>
            <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted">
              <li>Baixe o backup aqui, no servidor atual.</li>
              <li>Instale o WhatsAtendende no servidor novo, na mesma versão ({info?.version ?? "a mesma deste"}).</li>
              <li>
                No arquivo <code>.env</code> do servidor novo, use o mesmo <code>SETTINGS_ENCRYPTION_KEY</code> do atual. Sem ele, as senhas guardadas (e-mail, Meta e fontes de dados) não podem ser lidas.
              </li>
              <li>Entre no servidor novo como administrador e restaure o arquivo abaixo.</li>
            </ol>
          </div>
        </div>
        <p className="flex items-start gap-2 rounded-card bg-surface-alt px-3 py-2 text-xs text-muted">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0">
            Arquivo muito grande para enviar pelo navegador? Copie-o para o servidor e rode{" "}
            <code className="break-all rounded bg-surface px-1">docker compose exec api node dist/scripts/restore-backup.js /caminho/do/arquivo.tar.gz</code>
          </span>
        </p>
      </section>

      <section className="shadow-soft space-y-4 rounded-card border border-danger/40 bg-surface p-6">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-soft text-danger">
            <Upload className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold">Restaurar backup</h2>
            <p className="mt-0.5 text-sm text-muted">
              Substitui <b>tudo</b> deste servidor pelo que está no arquivo. O que foi feito aqui depois do backup se perde. O arquivo é lido inteiro e conferido antes de qualquer mudança.
            </p>
          </div>
        </div>
        <input ref={inputRef} type="file" accept=".gz,.tgz,application/gzip" className="hidden" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
        <button onClick={() => inputRef.current?.click()} className="focus-ring flex w-full items-center gap-3 rounded-card border border-dashed border-border px-4 py-3 text-left text-sm hover:bg-surface-alt">
          <FileArchive className="h-5 w-5 shrink-0 text-muted" />
          {restoreFile ? (
            <span>
              <b>{restoreFile.name}</b> <span className="text-muted">· {size(restoreFile.size)}</span>
            </span>
          ) : (
            <span className="text-muted">Escolher o arquivo do backup (.tar.gz)</span>
          )}
        </button>
        <label className="block max-w-xs text-sm">
          <span className="mb-1 block font-medium">Digite RESTAURAR para confirmar</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
        </label>
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
    </div>
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
