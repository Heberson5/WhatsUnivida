import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Send, XCircle } from "lucide-react";
import { PERMISSION } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { UnsavedChangesBar } from "../../components/common/UnsavedChangesBar";

interface EmailSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  fromName: string;
  fromEmail: string;
  configured: boolean;
  hasPassword: boolean;
}

export function EmailSettingsPanel() {
  const queryClient = useQueryClient();
  const canEditar = useAuthStore((s) => s.permissions?.[PERMISSION.CONFIGURACOES_EMAIL_EDITAR]);
  const { data } = useQuery({
    queryKey: ["email-settings"],
    queryFn: async () => (await api.get<EmailSettings>("/settings/email")).data,
  });

  const [host, setHost] = useState("");
  const [port, setPort] = useState(587);
  const [secure, setSecure] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromName, setFromName] = useState("WhatsAtendende");
  const [fromEmail, setFromEmail] = useState("");
  const [testTo, setTestTo] = useState("");

  function resetToSaved() {
    if (!data) return;
    setHost(data.host);
    setPort(data.port);
    setSecure(data.secure);
    setUsername(data.username ?? "");
    setPassword("");
    setFromName(data.fromName);
    setFromEmail(data.fromEmail);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(resetToSaved, [data]);

  const dirty =
    Boolean(data) &&
    (host !== data!.host ||
      port !== data!.port ||
      secure !== data!.secure ||
      username !== (data!.username ?? "") ||
      password !== "" ||
      fromName !== data!.fromName ||
      fromEmail !== data!.fromEmail);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch("/settings/email", {
        host,
        port,
        secure,
        username: username || null,
        password: password || undefined, // empty = keep the currently stored password
        fromName,
        fromEmail,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-settings"] });
      setPassword("");
      toast.success("Configuração de e-mail salva.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const testMutation = useMutation({
    mutationFn: () => api.post("/settings/email/test", { to: testTo }),
    onSuccess: () => toast.success(`E-mail de teste enviado para ${testTo}.`),
    onError: (err) => toast.error(getApiErrorMessage(err, "Falha ao enviar e-mail de teste")),
  });

  return (
    <div className="shadow-soft max-w-xl space-y-6 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Envio de e-mail (SMTP)</h2>
        <p className="mt-1 text-sm text-muted">
          Usado para enviar o link de redefinição de senha aos usuários. Sem essa configuração, o link de
          redefinição não é entregue automaticamente.
        </p>
        <div className={`mt-3 flex items-center gap-2 rounded-card px-3 py-2 text-sm ${data?.configured ? "bg-success-soft text-success" : "bg-secondary/30 text-text"}`}>
          {data?.configured ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {data?.configured ? "SMTP configurado" : "SMTP ainda não configurado"}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="col-span-2 block">
          <span className="mb-1 block text-sm font-medium">Servidor SMTP (host)</span>
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.seuservidor.com" className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Porta</span>
          <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
        </label>
        <label className="mt-6 flex items-center gap-2">
          <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} />
          <span className="text-sm">Conexão segura (TLS implícito, porta 465)</span>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Usuário</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Senha {data?.hasPassword && <span className="text-xs text-muted">(já configurada — deixe em branco para manter)</span>}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Nome do remetente</span>
          <input value={fromName} onChange={(e) => setFromName(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">E-mail do remetente</span>
          <input type="email" autoComplete="off" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="atendimento@suaempresa.com" className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
        </label>
      </div>

      {canEditar && (
        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
        >
          Salvar configuração
        </button>
      )}
      {canEditar && <UnsavedChangesBar dirty={dirty} saving={saveMutation.isPending} onSave={() => saveMutation.mutate()} onDiscard={resetToSaved} />}

      {canEditar && (
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-sm font-medium">Enviar e-mail de teste</p>
          <div className="flex gap-2">
            <input
              type="email"
              autoComplete="off"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="seuemail@empresa.com"
              className="focus-ring flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <button
              onClick={() => testMutation.mutate()}
              disabled={!testTo || testMutation.isPending}
              className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
            >
              <Send className="h-4 w-4" /> {testMutation.isPending ? "Enviando..." : "Testar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
