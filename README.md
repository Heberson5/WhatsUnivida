# WhatsAtendende

Plataforma Web multiusuário de atendimento ao cliente via WhatsApp — semelhante ao WhatsApp Web, mas com fila de atendimento, aceite exclusivo, transferência, gestão, dashboard, relatórios e controle de usuários/permissões.

> **Status:** funcional de ponta a ponta (login → fila → aceite → atendimento → transferência → encerramento → histórico → dashboard → relatórios), com testes automatizados cobrindo as regras críticas de negócio. Consulte [Pendências / Roadmap](#pendências--roadmap) antes de considerar qualquer item "pronto para produção" — a integração real com o WhatsApp em particular exige validação com um número real, que este ambiente de desenvolvimento não pode executar sozinho.

---

## Sumário

- [Visão geral](#visão-geral)
- [Arquitetura](#arquitetura)
- [Tecnologias e decisões técnicas](#tecnologias-e-decisões-técnicas)
- [Estrutura de pastas](#estrutura-de-pastas)
- [Requisitos](#requisitos)
- [Instalação e execução local](#instalação-e-execução-local)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Banco de dados e migrações](#banco-de-dados-e-migrações)
- [Docker](#docker)
- [Integração com WhatsApp](#integração-com-whatsapp)
- [Usuários padrão de desenvolvimento](#usuários-padrão-de-desenvolvimento)
- [Recuperação de senha por e-mail](#recuperação-de-senha-por-e-mail)
- [Regras de negócio](#regras-de-negócio)
- [Segurança e permissões](#segurança-e-permissões)
- [Tempo real](#tempo-real)
- [Testes](#testes)
- [Build e deploy](#build-e-deploy)
- [Comandos principais](#comandos-principais)
- [Pendências / Roadmap](#pendências--roadmap)

---

## Visão geral

O sistema permite que múltiplos atendentes usem a mesma conexão/número de WhatsApp, cada um com login individual, perfil de acesso (Administrador, Gestor, Atendente) e visibilidade restrita apenas às conversas que lhe foram atribuídas. Conversas entram em uma fila comum; o primeiro atendente que clicar em **ACEITAR** assume exclusividade sobre ela — a exclusividade é garantida no banco de dados, não apenas na interface. Gestores e administradores acompanham tudo pela tela de Gestão, em modo somente leitura. Dashboard e Relatórios calculam indicadores (conversas únicas, tempos médios de aceite/resposta/atendimento, etc.) a partir dos mesmos dados, com filtros de período e atendente.

## Arquitetura

```
┌─────────────┐      HTTPS/JSON       ┌──────────────┐      SQL       ┌────────────┐
│  Web (React)│ ───────────────────▶ │  API (Node)  │ ─────────────▶ │ PostgreSQL │
│  Vite + TS  │ ◀─────────────────── │  Express+TS  │ ◀───────────── └────────────┘
└─────────────┘   WebSocket (Socket.IO)└──────┬───────┘
                                              │
                                     WhatsAppProvider (interface)
                                              │
                              ┌───────────────┴────────────────┐
                              │                                │
                    MockWhatsAppProvider              BaileysWhatsAppProvider
                    (dev/test, sem WhatsApp real)      (protocolo WhatsApp Web real)
```

Pontos-chave da arquitetura:

- **Toda regra de autorização vive no backend.** A fila, o aceite exclusivo, a visibilidade de conversas por atendente e o modo somente-leitura de Gestão são impostos por checagens no servidor (`assertAgentCanAccessConversation`, `requireRole`, filtros de `WHERE` nas queries) — o frontend apenas reflete o que a API já filtrou/permitiu. Isso está documentado explicitamente porque a seção 61 do briefing original proíbe esconder dados só no frontend.
- **A integração com WhatsApp é uma interface (`WhatsAppProvider`)**, implementada por duas classes que nunca são importadas fora de `packages/whatsapp` e do módulo `modules/whatsapp` da API: `MockWhatsAppProvider` (simulador funcional para dev/testes) e `BaileysWhatsAppProvider` (protocolo real). Trocar de provedor no futuro (ex.: para a WhatsApp Cloud API oficial) significa escrever uma nova classe que implementa a mesma interface — nenhum outro módulo do sistema muda.
- **Aceite de conversa é atômico.** `acceptConversation` executa um único `UPDATE ... WHERE status IN (NEW, WAITING) AND assignedAgentId IS NULL`, que o PostgreSQL garante ser atômico por linha. Se dois atendentes clicarem ao mesmo tempo, apenas um `UPDATE` afeta a linha; o outro recebe `count = 0` e a API responde `409 Conflict`. Isso é validado por um teste automatizado que dispara os dois `accept` em paralelo (`apps/api/tests/conversations.test.ts`).
- **Tempo real via Socket.IO**, autenticado com o mesmo JWT da API REST. Os sockets são organizados em rooms (`queue`, `user:<id>`, `conversation:<id>`, `oversight`) para que cada evento só chegue a quem tem permissão de vê-lo.

## Tecnologias e decisões técnicas

| Camada | Escolha | Por quê |
|---|---|---|
| Frontend | React 18 + TypeScript + Vite | Conforme solicitado; Vite dá build/dev rápido. |
| Estilo | Tailwind CSS + tokens CSS (`--color-primary`, etc.) | Cores/tema configuráveis sem tocar em componentes (seção 68). |
| Estado servidor | TanStack Query | Cache, invalidação e refetch simples, integra bem com Socket.IO para invalidar caches ao vivo. |
| Estado cliente | Zustand | Sessão de auth é o único estado global real; dispensa Redux. |
| Backend | Node.js + TypeScript + Express | Conforme solicitado; modular, maduro, fácil de auditar. |
| Banco | PostgreSQL + Prisma | Conforme solicitado; migrations versionadas, tipos gerados. |
| Tempo real | Socket.IO | Reconexão automática, rooms, fallback de transporte — evita implementar isso à mão sobre `ws`. |
| Autenticação | JWT de acesso (curto, em memória) + refresh token (cookie `httpOnly`, rotacionado a cada uso) | Sem estado de sessão em memória do servidor (escala horizontalmente); refresh em cookie `httpOnly` reduz superfície de XSS. |
| Validação | Zod | Mesma biblioteca podendo validar no client e no server. |
| WhatsApp | **Baileys** (`@whiskeysockets/baileys`) para conexão real + `MockWhatsAppProvider` para dev/teste | Ver seção [Integração com WhatsApp](#integração-com-whatsapp). |
| Testes | Vitest + Supertest (API), Vitest + Testing Library (Web) | Rápidos, mesma stack de build (Vite) do frontend. |
| Containers | Docker + docker-compose (Postgres, Redis, API, Web/nginx) | Execução local com poucos comandos, conforme pedido. |

## Estrutura de pastas

```
/apps
  /api            Backend Express + Prisma + Socket.IO
    /prisma        schema.prisma, migrations, seed
    /src
      /modules      um módulo por domínio (auth, users, conversations, messages, dashboard, reports, settings, audit, whatsapp)
      /middleware    auth (JWT) e RBAC, tratamento de erros
      /realtime      bootstrap do Socket.IO e emissão de eventos
      /lib           prisma client, logger, auditoria, erros HTTP
    /tests          testes de integração (Vitest + Supertest)
  /web            Frontend React + Vite
    /src
      /pages         uma pasta por tela (login, atendimento, gestao, dashboard, relatorios, usuarios, configuracoes)
      /components    layout (sidebar/topbar), componentes de atendimento, componentes comuns
      /hooks         sessão, tema, branding, eventos de socket
      /store         Zustand (sessão de autenticação)
      /lib           cliente axios (com refresh automático), cliente socket.io
/packages
  /types           DTOs/enums compartilhados entre API e Web
  /whatsapp        WhatsAppProvider (interface), MockWhatsAppProvider, BaileysWhatsAppProvider
/infrastructure
  /docker          Dockerfiles da API e do Web (+ nginx.conf)
/.github
  /workflows       CI (lint, test, build)
docker-compose.yml
```

## Requisitos

- Node.js 20+
- npm 10+
- PostgreSQL 16 (local ou via Docker)
- Opcional: Docker + Docker Compose, Redis

## Instalação e execução local

```bash
# 1. Instalar dependências de todo o monorepo (workspaces npm)
npm install

# 2. Configurar variáveis de ambiente
cp apps/api/.env.example apps/api/.env
# edite apps/api/.env: gere segredos JWT reais, aponte DATABASE_URL para seu Postgres

# 3. Subir um Postgres (se não usar Docker, use uma instância local)
#    Exemplo rápido com Docker apenas para o banco:
docker run -d --name whatsatendende-db -e POSTGRES_USER=whatsatendende \
  -e POSTGRES_PASSWORD=whatsatendende -e POSTGRES_DB=whatsatendende \
  -p 5432:5432 postgres:16-alpine

# 4. Compilar os pacotes compartilhados (necessário antes da API/Web em dev)
npm run build -w packages/types
npm run build -w packages/whatsapp

# 5. Rodar as migrações e popular usuários de desenvolvimento
npm run prisma:migrate -w apps/api
npm run prisma:seed -w apps/api

# 6. Subir a API (porta 4000) e o Web (porta 5173) em terminais separados
npm run dev:api
npm run dev:web
```

Acesse `http://localhost:5173`. O Vite já faz proxy de `/api` e `/socket.io` para `http://localhost:4000` (ver `apps/web/vite.config.ts`).

## Variáveis de ambiente

Veja `apps/api/.env.example` (backend) e `.env.example` na raiz (usado pelo `docker-compose.yml`). Nunca commitar um `.env` com segredos reais — o `.gitignore` já bloqueia `.env`/`.env.local`; `apps/api/.env.test` é a exceção proposital: contém apenas valores fixos e não-sensíveis usados pelos testes automatizados/CI.

Principais variáveis da API:

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Connection string do PostgreSQL |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Segredos de assinatura dos tokens — gerar com `openssl rand -hex 32` |
| `SETTINGS_ENCRYPTION_KEY` | Criptografa em repouso segredos salvos no banco (ex.: senha SMTP em Configurações) — gerar com `openssl rand -hex 32`, nunca reaproveitar os segredos JWT acima |
| `WHATSAPP_PROVIDER` | `mock` (padrão, sem WhatsApp real) ou `baileys` (conexão real) |
| `WHATSAPP_AUTH_DIR` | Diretório onde o Baileys persiste a sessão pareada |
| `UPLOAD_DIR` / `UPLOAD_MAX_SIZE_MB` | Armazenamento local de anexos e limite de tamanho |
| `WEB_APP_URL` | Origem permitida no CORS e nos cookies; também usada para montar o link de redefinição de senha enviado por e-mail |

## Banco de dados e migrações

Schema completo em `apps/api/prisma/schema.prisma`, cobrindo todas as entidades pedidas: `users`, `roles` (enum `Role`), permissões por papel (checadas em código — ver [Segurança](#segurança-e-permissões)), `whatsapp_connections`, `contacts`, `conversations`, `conversation_assignments`, `messages`, `message_attachments`, `message_reactions`, `conversation_transfers`, `conversation_events`, `audit_logs`, `system_settings`, `notifications`. IDs são UUID v4. Índices foram adicionados nos campos usados para filtro/ordenação da fila, da gestão e dos relatórios (`status`, `assignedAgentId`, `enteredQueueAt`, `conversationId+createdAt`, etc.).

```bash
npm run prisma:migrate -w apps/api   # cria/aplica migration em dev
npm run prisma:generate -w apps/api  # regenera o client Prisma
npm run prisma:seed -w apps/api      # usuários de desenvolvimento (ver abaixo)
```

Em produção, o container da API roda `prisma migrate deploy` automaticamente antes de iniciar (ver `infrastructure/docker/Dockerfile.api`).

## Docker

```bash
cp .env.example .env   # preencha JWT_ACCESS_SECRET, JWT_REFRESH_SECRET e SETTINGS_ENCRYPTION_KEY reais
docker compose up --build
```

Sobe: PostgreSQL, Redis, API e Web servido por nginx — apenas o Web (porta 8080) é publicado no host; PostgreSQL, Redis e a API ficam acessíveis somente pela rede interna do compose (nginx faz proxy de `/api`, `/uploads` e `/socket.io` para a API), o que evita expor banco de dados e cache diretamente numa VPS pública. `docker compose config` foi validado neste repositório.

## Integração com WhatsApp

A aplicação define a interface `WhatsAppProvider` (`packages/whatsapp/src/types.ts`) com todos os métodos pedidos no briefing: conectar, desconectar, gerar QR Code, status de conexão, enviar/receber texto, arquivo, áudio, localização, contato/VCard, reagir, responder mensagem específica, obter contato/foto, sincronizar histórico e eventos de conexão/mensagem/entrega/leitura.

**Duas implementações:**

1. **`MockWhatsAppProvider`** — usada por padrão (`WHATSAPP_PROVIDER=mock`). Simula QR Code, conexão, entrega/leitura de mensagens enviadas e gera conversas de exemplo periodicamente. É o que os testes automatizados e o ambiente de desenvolvimento usam — nenhuma conexão de rede real acontece.
2. **`BaileysWhatsAppProvider`** — usa [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys), uma implementação open-source do protocolo *WhatsApp Web multi-device*. Foi escolhida porque:
   - reproduz exatamente o fluxo de pareamento por QR Code pedido no briefing (idêntico ao WhatsApp Web);
   - não depende da API oficial paga (WhatsApp Business Cloud API) nem de verificação de negócio pela Meta;
   - é a biblioteca open-source mais madura e mantida para esse protocolo em Node.js/TypeScript.

   **Trade-off documentado (decisão técnica com impacto — não escondida):** Baileys é um cliente não-oficial. Os Termos de Serviço do WhatsApp restringem clientes não-oficiais, e mudanças no protocolo do lado do WhatsApp podem quebrar a biblioteca até ela ser atualizada. Para um ambiente de produção com exigência contratual de SLA, a recomendação é avaliar a WhatsApp Cloud API oficial — o que significaria apenas escrever uma nova classe implementando `WhatsAppProvider`, sem alterar nada além do módulo `modules/whatsapp` da API.

   **Este ambiente de desenvolvimento não pode validar uma conexão Baileys real de ponta a ponta** — isso exige escanear o QR Code com um celular físico e conectividade de saída para os servidores do WhatsApp. O código foi implementado com base na API pública documentada do Baileys, mas **só deve ser considerado testado depois de uma validação manual com um número real**, antes de qualquer uso em produção.

Ativar a conexão real:

```bash
# apps/api/.env
WHATSAPP_PROVIDER=baileys
WHATSAPP_AUTH_DIR=./whatsapp-sessions
```

Depois, em **Configurações → WhatsApp** (perfil Administrador), clique em **Conectar WhatsApp** e escaneie o QR Code pelo aplicativo (Aparelhos conectados). A sessão fica persistida em `WHATSAPP_AUTH_DIR`.

## Usuários de desenvolvimento e provisionamento de admin real

`npm run prisma:seed -w apps/api` cria alguns usuários e conexões de
exemplo para desenvolvimento local (só num banco ainda sem usuários). Nenhum
login ou senha fica no repositório: o domínio dos e-mails vem de
`SEED_EMAIL_DOMAIN` e a senha de `SEED_USERS_PASSWORD`; sem ela, o seed sorteia
uma senha e mostra os logins e a senha apenas no console. Troque todas as
senhas antes de qualquer uso fora de desenvolvimento.

Para provisionar um administrador **real** (com e-mail e senha próprios,
sem nada disso passar pelo Git), rode o seed com estas variáveis de
ambiente:

```bash
SEED_ADMIN_EMAIL=seu-email@exemplo.com SEED_ADMIN_PASSWORD=sua-senha-forte \
  npm run prisma:seed -w apps/api
```

Rodar de novo não sobrescreve a senha de um usuário que já existe — só cria
os que ainda não existem no banco. Se o e-mail já existir e a senha não
estiver batendo (por exemplo, rodou o comando duas vezes com senhas
diferentes por engano), acrescente `SEED_ADMIN_FORCE_RESET=true` para
redefinir a senha explicitamente:

```bash
SEED_ADMIN_EMAIL=seu-email@exemplo.com SEED_ADMIN_PASSWORD=sua-senha-nova \
  SEED_ADMIN_FORCE_RESET=true npm run prisma:seed -w apps/api
```

## Recuperação de senha por e-mail

Em **Configurações → E-mail** (perfil Administrador), configure um servidor SMTP (host, porta, TLS, usuário/senha, remetente) e use **Testar** para confirmar a entrega antes de depender dele. Com o SMTP configurado, "Recuperar senha" na tela de login envia um e-mail real com um link para `/reset-password?token=...`, onde o usuário define a nova senha (`ResetPasswordPage`). Sem SMTP configurado (padrão em desenvolvimento), a API não consegue entregar o e-mail — fora de produção, o token continua disponível na própria resposta da requisição (`devToken`) só para permitir testar o fluxo end-to-end sem um servidor de e-mail. A senha do SMTP nunca é devolvida pela API depois de salva.

## Regras de negócio

- **Fila e aceite exclusivo:** conversa nasce `NEW`/`WAITING`. Antes do aceite, a fila mostra apenas foto, nome/telefone e horário de entrada — nunca conteúdo de mensagem (aplicado no mapper do backend, `revealPreview=false`, não apenas ocultado por CSS). O primeiro `POST /conversations/:id/accept` bem-sucedido muda o status para `IN_PROGRESS` e atribui `assignedAgentId`; qualquer tentativa concorrente recebe `409` com a mensagem "Esta conversa já foi assumida por outro atendente." — testado em `apps/api/tests/conversations.test.ts`.
- **Transferência:** só o atendente responsável pode transferir. A conversa sai imediatamente da lista do atendente de origem e aparece para o novo atendente com o selo "TRANSFERIDO", nome de quem transferiu, data/hora e observação.
- **Encerramento:** só o atendente responsável encerra; a conversa sai da lista de atendimentos ativos, mas permanece no histórico e na Gestão.
- **Reabertura:** uma nova mensagem de um contato cuja última conversa está `CLOSED` abre uma **nova conversa** (nova entrada na fila, novas métricas), em vez de reabrir silenciosamente a antiga — decisão documentada em `conversations.service.ts` (`findOrOpenConversationForInboundMessage`) para manter "conversas únicas" e relatórios consistentes. Comportamento padrão: volta para a fila (não para o último atendente), conforme especificado.
- **Conversas únicas:** contadas por `contactId` distinto dentro do período filtrado (não por mensagem), calculado em `dashboard.service.ts`.
- **Gestão é somente leitura:** as rotas de aceitar/responder/transferir/encerrar exigem `role=AGENT`; um Gestor/Administrador autenticado que tente chamá-las recebe `403` mesmo tendo acesso de visualização à mesma conversa via `/conversations/oversight` — testado.
- **Nome de exibição:** nunca é inserido no texto enviado ao WhatsApp; é um elemento puramente visual do balão de mensagem no frontend (`MessageBubble.tsx`).
- **Não lidas e notificações:** cada conversa guarda `assignedAgentReadAt` (zerado no aceite/transferência, atualizado quando o atendente abre a conversa via `POST /conversations/:id/read`). O card na lista "Meus atendimentos" mostra a contagem de mensagens recebidas depois desse marcador. Uma nova conversa na fila emite `queue:new-conversation` (toast para todos os atendentes); uma nova mensagem numa conversa já aceita emite `message:inbound-notification` só para o atendente responsável, e só quando ele não está com aquela conversa aberta no momento.

## Segurança e permissões

- Senhas com hash `bcrypt` (custo 12), nunca armazenadas em texto puro.
- Autenticação por JWT de acesso de curta duração + refresh token rotativo em cookie `httpOnly`/`SameSite=Strict`; usuário inativo é bloqueado no login mesmo com senha correta.
- **Tokens JWT com algoritmo fixo** (`HS256` explícito em sign/verify — evita confusão de algoritmo) e **`jti` aleatório no refresh token** (duas emissões no mesmo segundo nunca colidem no hash único salvo no banco — corrigiu uma falha real encontrada durante os testes deste projeto: recarregar a página podia derrubar a sessão por colisão de hash).
- **Sem enumeração de usuário por tempo de resposta**: login e "esqueci minha senha" fazem o mesmo trabalho de bcrypt/crypto tanto para e-mail existente quanto inexistente, para que o tempo de resposta não revele quais contas existem.
- Toda rota sensível usa `requireAuth` + `requireRole(...)` no backend — o menu lateral apenas *esconde* itens que o usuário não pode acessar; a proteção real está nas rotas Express.
- Cabeçalhos de segurança via `helmet` (com `X-Powered-By` também desabilitado explicitamente); rate limiting global, limite mais agressivo no login, e limite dedicado em `forgot-password`/`reset-password`/teste de SMTP (`express-rate-limit`).
- **Logs nunca contêm segredos**: `Authorization`, `Cookie` e `Set-Cookie` são redigidos nos logs de requisição (`pino-http` com `redact`) — sem isso, o access/refresh token de cada request apareceria em texto puro no log.
- IP real do visitante: a API só confia no cabeçalho `X-Forwarded-For` vindo de proxies em endereços internos (o nginx do container e o proxy HTTPS da VPS). Um cliente da internet não consegue falsificar o próprio IP. O proxy HTTPS da VPS precisa repassar o cabeçalho (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).
- Upload de anexos valida MIME type contra uma allowlist e respeita um tamanho máximo configurável (`UPLOAD_MAX_SIZE_MB`); uploads de identidade visual (logo/favicon) usam uma allowlist só de formatos raster (SVG é recusado — evita o vetor de XSS de SVG com `<script>` embutido) e o nome do arquivo salvo é derivado do MIME type validado, nunca do nome enviado pelo cliente.
- Prisma usa consultas parametrizadas (sem SQL bruto concatenado); a única query raw do projeto (contagem de não lidas) usa `Prisma.sql`/`Prisma.join` parametrizados.
- Configurações de negócio (`PATCH /settings/business`) e de e-mail (`PATCH /settings/email`) são validadas com Zod (`.strict()` no primeiro caso) — não persistem JSON arbitrário enviado pelo cliente.
- Senha de SMTP nunca é devolvida pela API (a resposta de `GET /settings/email` só informa `hasPassword: true/false`); ainda assim, hoje ela é armazenada em texto puro no `system_settings` — ver [Pendências](#pendências--roadmap).
- Toda ação sensível é gravada em `audit_logs` (login, logout, criação/edição de usuário, aceite, transferência, encerramento, alteração de configurações, conexão/desconexão do WhatsApp) com usuário, IP, entidade e metadados — nunca com senha/segredo no metadata.

## Tempo real

Socket.IO autenticado por JWT no handshake. Rooms: `queue` (todos os atendentes), `user:<id>`, `conversation:<id>` (só quem está com a tela aberta) e `oversight` (gestores/administradores). Eventos emitidos pelo backend após cada mutação (aceite, transferência, encerramento, nova mensagem, status de entrega/leitura, status da conexão do WhatsApp) — o frontend invalida os caches do React Query correspondentes; não há polling agressivo (apenas um refetch de segurança a cada 20s nas listas de conversas, como rede de proteção caso um evento se perca).

## Testes

```bash
# Backend — sobe contra um banco de testes real (não mocka o Postgres)
createdb whatsatendende_test   # ou: docker run ... postgres, criando esse banco
npm run prisma:migrate -w apps/api -- deploy   # ou DATABASE_URL=... npx prisma migrate deploy
npm run test -w apps/api

# Frontend
npm run test -w apps/web
```

Cobertura atual (17 testes de backend + 7 de frontend, todos passando neste repositório):

- Login com credenciais corretas/incorretas, bloqueio de usuário inativo, ausência de enumeração de usuário, hash de senha.
- **Regressão de concorrência no refresh token** (dois `POST /auth/refresh` simultâneos com o mesmo cookie → ambos `200`, sem colisão de hash).
- RBAC: Atendente não acessa rotas de Administrador; Gestor não aceita/responde conversas.
- **Concorrência no aceite** (dois `accept` simultâneos → um `200`, um `409`, exatamente um registro de atribuição no banco).
- Privacidade da fila (conteúdo de mensagem nunca trafega antes do aceite).
- Isolamento por atendente (outro atendente não abre uma conversa já atribuída).
- Transferência (some da origem, aparece com selo "transferido" no destino, zera o marcador de leitura do novo atendente).
- Badge de não lidas (conta mensagens recebidas após o último acesso, zera ao marcar como lida).
- Encerramento (sai da lista ativa).
- Gestão somente leitura (visualiza, mas `accept` retorna 403).
- Frontend: renderização e submissão do login, alternância de visibilidade de senha, proteção de rotas por autenticação e por perfil.

## Build e deploy

```bash
npm run build   # compila packages/types, packages/whatsapp, apps/api, apps/web nessa ordem
```

Build e lint validados neste repositório (`npm run lint`, `npm run build`) sem erros. O workflow `.github/workflows/ci.yml` reproduz os mesmos passos em CI (instala, builda os pacotes compartilhados, aplica migrations num Postgres de serviço, lint, testes, build) a cada push/PR para `main`.

Para produção: `docker compose up --build` (ver [Docker](#docker)) ou build manual de cada Dockerfile em `infrastructure/docker/`.

## Comandos principais

| Comando | Descrição |
|---|---|
| `npm run dev:api` | API em modo desenvolvimento (hot reload) |
| `npm run dev:web` | Web em modo desenvolvimento (Vite) |
| `npm run build` | Build de produção de todo o monorepo |
| `npm run lint` | Lint de `apps/api` e `apps/web` |
| `npm run test` | Testes de `apps/api` e `apps/web` |
| `npm run prisma:migrate -w apps/api` | Cria/aplica migration em dev |
| `npm run prisma:seed -w apps/api` | Popula usuários de desenvolvimento |

## Pendências / Roadmap

Itens abaixo **não** estão implementados ou estão implementados apenas parcialmente — listados aqui em vez de omitidos, conforme a diretriz de nunca declarar algo pronto sem estar:

- **Validação de conexão Baileys com um número real** — implementado contra a API documentada, mas não exercitado ponta a ponta neste ambiente (ver [Integração com WhatsApp](#integração-com-whatsapp)).
- **Senha de SMTP em texto puro no banco** (`system_settings`, chave `email`): a API nunca a devolve ao cliente, mas ela não está criptografada em repouso. Para produção, mover para um secrets manager (ou ao menos criptografar o campo antes de persistir) é o próximo passo — a interface de `EmailSettings` já isola esse detalhe num único lugar (`settings.service.ts`) para facilitar a troca.
- **Senha temporária de reset por Administrador** (`POST /users/:id/reset-password`) não força troca no próximo login — o usuário pode continuar usando a temporária indefinidamente. Uma flag `mustChangePassword` é o próximo passo natural.
- **`react-router-dom` com 2 avisos moderados do `npm audit`** (redirecionamento aberto via `<Link>`/`useNavigate` e um problema de hidratação SSR): avaliados e considerados de baixo risco *nesta aplicação* — é uma SPA 100% client-side (sem SSR, então a segunda CVE não se aplica) e nenhum `to`/`navigate` no código usa valor vindo do usuário (todos são caminhos fixos), então o redirecionamento aberto não tem um "sink" alcançável hoje. Ainda assim, é uma dependência desatualizada; atualizar para a v7 é uma mudança de major (breaking) que não foi feita nesta rodada para não arriscar regressão em todo o roteamento já testado — fica como próximo passo dedicado.
- **Persistência de mídia recebida do WhatsApp para armazenamento em disco** — o evento de mensagem com mídia é recebido e a mensagem é criada, mas a gravação do binário em `UPLOAD_DIR` para mídia *recebida* (diferente de mídia *enviada* pelo atendente, que já é salva) está sinalizada como próximo passo em `whatsapp.service.ts` para não bloquear o callback de eventos do provedor com I/O de disco.
- **Regras configuráveis de negócio** (seção 52): o *storage* (`system_settings`, tabela `business`) e a API (`GET/PATCH /settings/business`) já existem para tempo de inatividade, encerramento automático, horário de atendimento, mensagem de saudação/ausência etc., mas a *aplicação* dessas regras (ex.: encerrar automaticamente após X minutos) ainda não está implementada — arquitetura preparada, comportamento pendente.
- **Exportação de relatórios em Excel/PDF** — CSV está implementado e testado; XLSX/PDF não.
- **Fila/worker assíncrono dedicado (Redis/BullMQ)** — Redis está no `docker-compose.yml` e a variável `REDIS_URL` existe, mas hoje nenhuma tarefa passa por uma fila real; envio de mensagem e criação de conversa acontecem de forma síncrona no request/evento. Para o volume de um MVP isso é aceitável; é o primeiro ponto a rever antes de um volume de produção alto.
- **Code-splitting do bundle do frontend** — o build gera um único chunk de ~814 kB (aviso do Vite); funcional, mas não otimizado para carregamento inicial.
- **Chatbot/respostas automáticas** — fora de escopo desta primeira versão por decisão explícita do briefing; a arquitetura (eventos de conversa, `system_settings` de mensagens automáticas) não impede a evolução futura.
