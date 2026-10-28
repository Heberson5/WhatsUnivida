import { useState } from "react";
import { BookOpen, Download, X } from "lucide-react";
import { buildPrintHtml, escapeHtml, printHtml } from "../../lib/printDocument";

/**
 * Conexões › Instagram / Facebook: "Como obter as credenciais" — step by step on developers.facebook.com, for whoever
 * sets the integration up (Gestor/Administrador, TI). The Meta screens change often, so the steps name the menus
 * instead of showing pictures of them. "Baixar PDF" prints the same guide (the print dialog's "Salvar como PDF").
 */

interface GuideSection {
  title: string;
  intro?: string;
  steps: string[];
  note?: string;
}

function guideSections(webhookUrl: string): GuideSection[] {
  return [
    {
      title: "1. Antes de começar",
      steps: [
        "Tenha uma Página do Facebook da empresa e seja administrador dela.",
        "Para o Instagram: a conta precisa ser profissional (Empresa) e estar vinculada à Página do Facebook (no Instagram: Configurações › Conta › Compartilhamento entre aplicativos / Central de Contas).",
        "No aplicativo do Instagram, libere as mensagens para ferramentas conectadas: Configurações › Mensagens e respostas a stories › Ferramentas conectadas › Permitir acesso às mensagens.",
        "Tenha acesso ao Gerenciador de Negócios (business.facebook.com) da empresa — é onde se cria o token que não expira.",
      ],
    },
    {
      title: "2. Criar o App da Meta",
      steps: [
        "Entre em developers.facebook.com com a conta que administra a Página e clique em Meus apps › Criar app.",
        "Escolha o caso de uso de empresa (tipo Empresa) e vincule ao portfólio (Gerenciador de Negócios) da empresa.",
        "No painel do app, em Adicionar produtos, adicione Messenger e Instagram (a opção de API do Instagram com login do Facebook).",
      ],
      note: "Um único app serve para o Instagram e para o Messenger — as credenciais desta tela valem para os dois.",
    },
    {
      title: "3. App ID e App Secret",
      steps: [
        "No app, abra Configurações do app › Básico.",
        "Copie o ID do aplicativo e cole em App ID.",
        "Em Chave secreta do aplicativo, clique em Mostrar, confirme a senha do Facebook e cole em App Secret.",
      ],
      note: "O App Secret é como uma senha: não envie por e-mail nem por WhatsApp. Ele é usado para conferir que as mensagens que chegam vêm mesmo da Meta.",
    },
    {
      title: "4. Token de acesso (que não expira)",
      intro: "O token permite que a plataforma responda o cliente. O ideal é o token de um usuário do sistema, que não expira.",
      steps: [
        "No Gerenciador de Negócios, abra Configurações do negócio › Usuários › Usuários do sistema e crie um usuário (função Administrador).",
        "Em Atribuir ativos, dê a esse usuário o app criado e a Página do Facebook (e a conta do Instagram), com controle total.",
        "Clique em Gerar novo token, escolha o app, a validade Nunca e marque as permissões: pages_messaging, pages_manage_metadata, pages_read_engagement, pages_show_list, instagram_basic e instagram_manage_messages.",
        "Copie o token gerado (ele só aparece uma vez) e cole em Token de acesso da Página (aba Facebook) e em Token de acesso do Instagram (aba Instagram).",
      ],
      note: "Alternativa para testes: no app, Messenger › Configurações da API › Gerar token para a Página. Esse token pode expirar — troque pelo do usuário do sistema antes de usar com clientes.",
    },
    {
      title: "5. Webhook (para as mensagens chegarem)",
      steps: [
        "Nesta tela, escreva um Verify Token qualquer (por exemplo, uma frase sem espaços) e clique em Salvar credenciais.",
        `No app da Meta, em Messenger › Configurações da API › Webhooks, clique em Adicionar URL de retorno de chamada e cole: ${webhookUrl}`,
        "No campo Verificar token, cole o mesmo Verify Token desta tela e clique em Verificar e salvar.",
        "Ainda em Webhooks, clique em Adicionar assinaturas na Página e marque messages e messaging_postbacks.",
        "Para o Instagram: em Instagram › Configurações da API (ou Webhooks), use a mesma URL e o mesmo Verify Token e assine o campo messages.",
      ],
    },
    {
      title: "6. IDs da Página e da conta do Instagram",
      steps: [
        "ID da Página: na Página do Facebook, Sobre › Transparência da Página (ou no Meta Business Suite › Configurações › Páginas). Cole em ID da Página, na aba Facebook, e clique em Adicionar.",
        "ID da conta do Instagram: no Meta Business Suite › Configurações › Contas do Instagram (ou na Ferramenta Explorer da Graph API, consultando a Página com o campo instagram_business_account). Cole em ID da conta do Instagram, na aba Instagram, e clique em Adicionar.",
      ],
    },
    {
      title: "7. Colocar no ar",
      steps: [
        "Enquanto o app está Em desenvolvimento, só administradores e testadores do app conseguem conversar — use isso para testar.",
        "Para atender os clientes, envie o app para a Análise do app da Meta pedindo as permissões pages_messaging e instagram_manage_messages, e conclua a Verificação da empresa se a Meta pedir.",
        "Aprovado, mude o app para Ao vivo (Publicado). Mande uma mensagem de teste para a Página e para o Instagram: a conversa deve aparecer na Fila.",
      ],
      note: "Se a mensagem não chegar: confira se o webhook está verificado, se a Página está assinada (messages) e se o token tem as permissões acima.",
    },
  ];
}

export function MetaCredentialsGuideButton({ webhookUrl }: { webhookUrl: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt"
      >
        <BookOpen className="h-3.5 w-3.5" /> Como obter as credenciais
      </button>
      {open && <MetaCredentialsGuide webhookUrl={webhookUrl} onClose={() => setOpen(false)} />}
    </>
  );
}

function MetaCredentialsGuide({ webhookUrl, onClose }: { webhookUrl: string; onClose: () => void }) {
  const sections = guideSections(webhookUrl);

  function downloadPdf() {
    const body = [
      "<h1>Instagram e Facebook — como obter as credenciais</h1>",
      ...sections.map(
        (s) =>
          `<h2>${escapeHtml(s.title)}</h2>${s.intro ? `<p>${escapeHtml(s.intro)}</p>` : ""}<ol>${s.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>${
            s.note ? `<p class="note">${escapeHtml(s.note)}</p>` : ""
          }`
      ),
    ].join("");
    void printHtml(
      buildPrintHtml({
        title: "Como obter as credenciais da Meta",
        body,
        page: "margin: 18mm",
        css: "body{font-family:Arial,sans-serif;font-size:11pt;color:#0f172a}h1{font-size:18pt}h2{font-size:13pt;margin-top:16pt}li{margin:3pt 0}.note{background:#f1f5f9;padding:6pt 8pt;border-radius:4pt;font-size:10pt}",
      })
    );
  }

  return (
    <div className="drawer-backdrop" role="dialog" aria-modal="true" aria-label="Como obter as credenciais">
      <div className="drawer-panel max-w-2xl overflow-y-auto p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Como obter as credenciais da Meta</h2>
            <p className="text-xs text-muted">Instagram e Facebook Messenger — para quem vai configurar a integração.</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={downloadPdf}
              className="focus-ring inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt"
            >
              <Download className="h-3.5 w-3.5" /> Baixar PDF
            </button>
            <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <p className="mb-4 rounded-card bg-surface-alt px-3 py-2 text-xs text-muted">
          As telas da Meta mudam com frequência: se um menu estiver com outro nome, procure pelo mesmo assunto no painel do app.
        </p>
        <div className="space-y-4">
          {sections.map((s) => (
            <section key={s.title}>
              <h3 className="mb-1 text-sm font-semibold">{s.title}</h3>
              {s.intro && <p className="mb-1 text-sm text-muted">{s.intro}</p>}
              <ol className="list-decimal space-y-1 ps-5 text-sm">
                {s.steps.map((step) => (
                  <li key={step} className="break-words">
                    {step}
                  </li>
                ))}
              </ol>
              {s.note && <p className="mt-1.5 rounded-card bg-surface-alt px-3 py-2 text-xs text-muted">{s.note}</p>}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
