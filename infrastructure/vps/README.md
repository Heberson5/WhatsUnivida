# Gerenciador de VPS (Windows)

`gerenciador-vps.bat` é um menu interativo para deploy e operação do
WhatsUnivida (e, opcionalmente, de outros projetos que já rodem na mesma
VPS) via SSH, a partir de um Windows local.

## Antes de usar

Edite as primeiras linhas do arquivo com os dados do seu servidor:

```bat
set IP=147.15.110.106
set USER=ubuntu
set KEY=C:\caminho\para\sua-chave-ssh.key
set PROJETO=~/whatsunivida
set REPO_WHATSUNIVIDA=https://github.com/Heberson5/WhatsUnivida.git
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
4. **[15]** Deploy/Atualizar WhatsUnivida — clona o repositório, cria um
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

Só o container `web` (nginx, porta **8085**) fica acessível pela internet;
o nginx já faz proxy interno de `/api`, `/uploads` e `/socket.io` para a
API. PostgreSQL, Redis e a API **não** têm porta publicada no host — é
proposital, para não expor banco de dados/cache numa VPS pública (veja
`docker-compose.yml`). Para inspecionar o banco diretamente, use
`docker compose exec postgres psql -U whatsunivida`.

## Sobre o Baileys (conexão real do WhatsApp)

O `.env` gerado automaticamente já usa `WHATSAPP_PROVIDER=baileys` (conexão
real, não o simulador usado em desenvolvimento). Depois do primeiro deploy,
teste a conexão com calma pela tela de Configurações — o README principal
do projeto documenta o trade-off de usar uma biblioteca não-oficial
(Baileys) para isso.
