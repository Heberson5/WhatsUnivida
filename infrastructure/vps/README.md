# Gerenciador de VPS (Windows)

`gerenciador-vps.bat` é um menu interativo para deploy e operação do
WhatsAtendende (e, opcionalmente, de outros projetos que já rodem na mesma
VPS) via SSH, a partir de um Windows local.

## Antes de usar

Edite as primeiras linhas do arquivo com os dados do seu servidor:

```bat
set IP=147.15.110.106
set USER=ubuntu
set KEY=C:\caminho\para\sua-chave-ssh.key
set PROJETO=~/whatsatendende
set REPO_WHATSATENDENDE=https://github.com/Heberson5/WhatsAtendende.git
```

A VPS precisa de Docker e Docker Compose (opção **[13]** do menu instala,
se ainda não tiver) e, se tiver pouca RAM, de swap (opção **[18]**) antes do
primeiro build — o build da imagem da API compila TypeScript de três
pacotes e pode precisar de mais memória do que o plano gratuito da Oracle
Cloud oferece de RAM real.

## Primeiro deploy

1. **[14]** Preparar VPS — instala dependências do sistema.
2. **[13]** Instalar Docker (se ainda não tiver).
3. **[18]** Criar Swap — recomendado antes do primeiro build.
4. **[15]** Deploy/Atualizar WhatsAtendende — clona o repositório, cria um
   `.env` com segredos JWT aleatórios na primeira vez (esse arquivo não
   fica no Git — **faça backup dele**, sem ele os logins existentes param
   de funcionar caso a VPS precise ser refeita) e sobe os containers.
5. **[21]** Popular usuários iniciais — cria o admin/gestor/atendentes de
   exemplo do `prisma/seed.ts`. Troque as senhas padrão em **Usuários**
   assim que acessar o sistema.
6. **[10]** Abrir o sistema no navegador, entrar em **Configurações** e
   conectar o WhatsApp real (QR Code ou código de pareamento).

Deploys seguintes usam só a opção **[15]** (`git pull` + rebuild) ou a
**[1]** (mesma coisa, atalho genérico).

## O que o compose expõe

Só o container `web` (nginx, porta **8080**) fica acessível pela internet;
o nginx já faz proxy interno de `/api`, `/uploads` e `/socket.io` para a
API. PostgreSQL, Redis e a API **não** têm porta publicada no host — é
proposital, para não expor banco de dados/cache numa VPS pública (veja
`docker-compose.yml`). Para inspecionar o banco diretamente, use
`docker compose exec postgres psql -U whatsatendende`.

## Tamanho máximo dos arquivos enviados

Quem recebe o arquivo primeiro é o nginx do container `web`, que deixa
passar até **300 MB** por envio (`client_max_body_size` em
`infrastructure/docker/nginx.conf`) — é o tamanho máximo do arquivo de Dados ›
Fontes de dados. Depois vem o limite da própria API para anexos do atendimento,
**25 MB por arquivo** por padrão — acima disso a tela mostra "Arquivo muito
grande". Para mudar esse segundo limite, coloque `UPLOAD_MAX_SIZE_MB=40` (por
exemplo) no `.env` da VPS e rode o deploy **[15]**; não passe de 100.

Se existir outro proxy na frente do container (o que faz o HTTPS, ou uma CDN),
ele tem o limite dele, que o repositório não controla. Um envio recusado com
**413 Request Entity Too Large** e uma página HTML simples vem de um nginx, e o
rodapé dessa página (aba Rede do F12 › Resposta) diz de qual: `nginx/1.27.x` é
o do container `web` (corrigido aqui); outro número, como `nginx/1.24.0
(Ubuntu)`, é o proxy da VPS — e lá é preciso colocar `client_max_body_size
300m;` no `server` do site (a opção **[24]** do gerenciador já cria assim).

Um arquivo de 300 MB (cerca de 720 mil linhas) leva perto de 3 minutos para ser
lido e usa até 2,2 GB de memória enquanto isso: a VPS precisa ter memória livre
para isso, além do que o sistema já usa.

## Backup e restauração completos

Antes de qualquer atualização arriscada (ex.: trocar a versão do Baileys),
use a opção **[24]** — salva na própria VPS, numa pasta com data/hora, o
commit atual do código, o `.env`, um dump do banco (Postgres) e os
volumes Docker (sessões do WhatsApp, uploads, apk). O sistema continua no
ar durante o backup.

A opção **[25]** lista os backups salvos (com o tamanho de cada um). Se
precisar voltar exatamente como estava, a opção **[26]** restaura um
backup pelo nome da pasta — pede confirmação explícita, já que substitui
código, `.env`, banco e volumes atuais pelos do backup escolhido, e o
sistema fica fora do ar durante a restauração.

## Sobre o Baileys (conexão real do WhatsApp)

O `.env` gerado automaticamente já usa `WHATSAPP_PROVIDER=baileys` (conexão
real, não o simulador usado em desenvolvimento). Depois do primeiro deploy,
teste a conexão com calma pela tela de Configurações — o README principal
do projeto documenta o trade-off de usar uma biblioteca não-oficial
(Baileys) para isso.

## Disponibilizar o app Android (.apk) para download

A tela de login já mostra um botão "Baixar aplicativo (.apk)" para quem
acessa pelo Android e cujo navegador não oferece o instalador nativo. O
arquivo em si **não** vem no repositório — precisa ser gerado uma vez (ex.:
[pwabuilder.com](https://pwabuilder.com), gratuito, sem instalar nada:
cole a URL pública do sistema, baixe o pacote Android) e enviado para a
VPS uma única vez:

```bash
docker cp caminho/para/whatsatendende.apk whatsatendende-web-1:/usr/share/nginx/downloads/whatsatendende.apk
```

Fica guardado num volume Docker próprio (`app_downloads`, veja
`docker-compose.yml`), separado da imagem do `web` — sobrevive a qualquer
`git pull` + rebuild seguinte, sem precisar reenviar o arquivo de novo.
Só repita o `docker cp` acima se gerar uma versão nova do `.apk`.

## WhatsUnivida — porta 8086, domínio e dados de demonstração

Esta cópia publica o container `web` na porta **8086** do host
(`docker-compose.yml`) e usa `WEB_APP_URL=https://whatsunivida.sauberlich.com.br`
por padrão. Aponte o DNS de `whatsunivida.sauberlich.com.br` para a VPS e
configure o proxy do host (nginx/Caddy) para encaminhar o domínio para
`http://127.0.0.1:8086`, incluindo os cabeçalhos de WebSocket (`Upgrade` e
`Connection`) para o `/socket.io`.

O seed (opção **[21]**, ou `docker compose exec api npx tsx prisma/seed.ts`)
também cria dados de exemplo para apresentação (`prisma/seed-demo.ts`):
conexões "Central Univida (Demonstração)" e "Comercial Univida (Demonstração)",
contatos com etiquetas, conversas na fila, em atendimento, transferidas e
encerradas, 3 grupos do WhatsApp, respostas rápidas e o chat interno (#Geral
com enquete e mensagem fixada, grupo "Financeiro & Cobrança" e uma conversa
direta), além dos usuários de exemplo. Nenhum login ou senha fica no
repositório: o domínio dos e-mails vem de `SEED_EMAIL_DOMAIN` e a senha de
`SEED_USERS_PASSWORD`; sem ela, o seed sorteia uma senha e mostra os logins e a
senha só no console, no fim da execução. Os números são fictícios e
as conexões de demonstração nunca são pareadas — conecte o WhatsApp real numa
conexão nova em **Configurações**. Para rodar o seed sem os dados de exemplo,
use `SEED_DEMO=false`. Roda uma vez só: se a conexão de demonstração já
existir, não cria nada de novo.
