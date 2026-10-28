import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Send, Tag } from "lucide-react";
import { api, getApiErrorMessage } from "../../lib/api";

type EmailTemplateType = "PASSWORD_RESET" | "USER_WELCOME" | "USER_DEACTIVATED" | "PASSWORD_CHANGED";

interface EmailTemplateConfig {
  enabled: boolean;
  subject: string;
  title: string;
  bodyText: string;
  buttonText: string;
}

interface TagInfo {
  tag: string;
  description: string;
}

interface EmailTemplatesResponse {
  templates: Record<EmailTemplateType, EmailTemplateConfig>;
  tags: Record<EmailTemplateType, TagInfo[]>;
  commonTags: TagInfo[];
  hasButton: Record<EmailTemplateType, boolean>;
}

const TYPE_LABEL: Record<EmailTemplateType, string> = {
  PASSWORD_RESET: "Redefinição de senha",
  USER_WELCOME: "Boas-vindas (novo usuário)",
  USER_DEACTIVATED: "Conta desativada",
  PASSWORD_CHANGED: "Senha alterada",
};

const TYPE_HELP: Record<EmailTemplateType, string> = {
  PASSWORD_RESET: "Enviado quando um usuário pede para redefinir a senha.",
  USER_WELCOME: "Enviado automaticamente sempre que um novo usuário é criado em Usuários.",
  USER_DEACTIVATED: "Enviado automaticamente quando um usuário é desativado em Usuários.",
  PASSWORD_CHANGED: "Enviado automaticamente sempre que a senha é alterada — pela redefinição (esqueci minha senha) ou pelo próprio usuário em Meu Perfil.",
};

type FocusableField = "subject" | "title" | "bodyText";

export function EmailTemplatesPanel() {
  const queryClient = useQueryClient();
  const [type, setType] = useState<EmailTemplateType>("PASSWORD_RESET");

  const { data } = useQuery({
    queryKey: ["email-templates"],
    queryFn: async () => (await api.get<EmailTemplatesResponse>("/settings/email-templates")).data,
  });

  const [enabled, setEnabled] = useState(true);
  const [subject, setSubject] = useState("");
  const [title, setTitle] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [buttonText, setButtonText] = useState("");
  const [testTo, setTestTo] = useState("");
  // Which field "Tags disponíveis" inserts into — whichever the admin last clicked into.
  const [lastFocusedField, setLastFocusedField] = useState<FocusableField>("bodyText");

  const current = data?.templates[type];
  const hasButton = data?.hasButton[type] ?? false;

  useEffect(() => {
    if (!current) return;
    setEnabled(current.enabled);
    setSubject(current.subject);
    setTitle(current.title);
    setBodyText(current.bodyText);
    setButtonText(current.buttonText);
  }, [current, type]);

  const saveMutation = useMutation({
    mutationFn: () => api.patch(`/settings/email-templates/${type}`, { enabled, subject, title, bodyText, buttonText }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Modelo de e-mail salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const testMutation = useMutation({
    mutationFn: () => api.post(`/settings/email-templates/${type}/test`, { to: testTo }),
    onSuccess: () => toast.success(`E-mail de teste enviado para ${testTo}.`),
    onError: (err) => toast.error(getApiErrorMessage(err, "Falha ao enviar e-mail de teste")),
  });

  // The real markup (layout, logo, button styling) only lives on the
  // backend now (renderEmailTemplateHtml) — no HTML for the admin to touch
  // — so the preview asks the server to render it from the current field
  // values, debounced so it doesn't fire on every keystroke.
  const [previewHtml, setPreviewHtml] = useState("");
  useEffect(() => {
    if (!title.trim() || !bodyText.trim()) {
      setPreviewHtml("");
      return;
    }
    const timer = setTimeout(() => {
      api
        .post<{ subject: string; html: string }>(`/settings/email-templates/${type}/preview`, { subject, title, bodyText, buttonText })
        .then((res) => setPreviewHtml(res.data.html))
        .catch(() => undefined); // best-effort — a transient failure just leaves the last preview showing
    }, 400);
    return () => clearTimeout(timer);
  }, [type, subject, title, bodyText, buttonText]);

  const tagList = [...(data?.tags[type] ?? []), ...(data?.commonTags ?? [])];

  function insertTag(tag: string) {
    if (lastFocusedField === "subject") setSubject((prev) => prev + tag);
    else if (lastFocusedField === "title") setTitle((prev) => prev + tag);
    else setBodyText((prev) => prev + tag);
  }

  return (
    <div className="space-y-4">
      <div className="shadow-soft flex w-fit flex-wrap gap-1 rounded-card border border-border bg-surface p-1">
        {(Object.keys(TYPE_LABEL) as EmailTemplateType[]).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`rounded-card px-3 py-1.5 text-sm font-medium ${type === t ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt"}`}
          >
            {TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="shadow-soft grid gap-6 rounded-card border border-border bg-surface p-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">{TYPE_LABEL[type]}</h2>
            <p className="mt-1 text-sm text-muted">{TYPE_HELP[type]}</p>
          </div>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="text-sm font-medium">Enviar este e-mail automaticamente</span>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Assunto</span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onFocus={() => setLastFocusedField("subject")}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Título</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={() => setLastFocusedField("title")}
              placeholder="Aparece em destaque no topo do e-mail"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Texto do e-mail</span>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              onFocus={() => setLastFocusedField("bodyText")}
              rows={10}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-muted">Deixe uma linha em branco para começar um novo parágrafo.</span>
          </label>

          {hasButton && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Texto do botão</span>
              <input
                value={buttonText}
                onChange={(e) => setButtonText(e.target.value)}
                placeholder="Deixe em branco para não mostrar nenhum botão"
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
          )}

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Tag className="h-3.5 w-3.5" /> Tags disponíveis (clique para inserir no campo selecionado)
            </p>
            <div className="flex flex-wrap gap-1.5">
              {tagList.map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  title={t.description}
                  onClick={() => insertTag(t.tag)}
                  className="focus-ring rounded-full border border-border px-2 py-1 font-mono text-xs hover:bg-surface-alt"
                >
                  {t.tag}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
            >
              Salvar modelo
            </button>
            <input
              type="email"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="Enviar teste para..."
              className="focus-ring min-w-[180px] flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
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

        <div>
          <p className="mb-2 text-sm font-medium">Pré-visualização (com dados de exemplo)</p>
          <iframe
            title="Pré-visualização do e-mail"
            srcDoc={previewHtml}
            className="h-[600px] w-full rounded-card border border-border bg-white"
            sandbox=""
          />
        </div>
      </div>
    </div>
  );
}
