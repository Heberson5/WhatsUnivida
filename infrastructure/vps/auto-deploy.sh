#!/usr/bin/env bash
# Deploy automático na VPS — roda NA VPS, enviado pelo GitHub Actions
# (.github/workflows/deploy.yml) por SSH depois que os testes passaram:
#
#   ssh ... "GH_TOKEN=... REPO_URL=... bash -s -- <pasta> <branch> <porta-web> <commit> [domínio]" < auto-deploy.sh
#
# GH_TOKEN (opcional): token temporário do próprio job (vale só enquanto ele roda), usado
# para buscar o código de um repositório privado sem guardar senha nenhuma na VPS.
#
# Primeira instalação: se a pasta ainda não existe, o script clona o repositório
# (REPO_URL), cria o .env com segredos aleatórios, sobe o sistema, cria o primeiro
# administrador (login e senha aparecem no log do job e ficam em
# ~/<pasta>/CREDENCIAIS-INICIAIS.txt) e configura o domínio no proxy da VPS.
#
# Faz o mesmo que a opção "Atualizar" do gerenciador-vps.bat, com três
# proteções a mais:
#   - uma trava (flock) para dois sistemas nunca construírem ao mesmo tempo:
#     a VPS tem pouca RAM e o build do front disputa memória;
#   - backup do banco (pg_dump) + sessões do WhatsApp (conexões) + .env + commit antes
#     de mexer em qualquer coisa, em ~/backups-auto/<pasta>/AAAAMMDD-HHMMSS (ficam os 7 últimos);
#   - verificação de saúde (/api/health pela porta do site) depois de subir.
#     Se o build falhar ou o sistema não responder, volta sozinho para as
#     imagens e o commit anteriores e o job termina em erro.
set -euo pipefail

# O script chega pela entrada padrão (bash -s); tudo fica dentro de main() e roda com a entrada em /dev/null,
# senão um "docker compose exec" leria o resto do próprio script e o deploy pararia no meio, sem erro.
# Primeira instalação: um administrador com senha sorteada (o banco começa vazio, sem nenhum login).
first_admin() {
  log "Criando o primeiro administrador"
  local email="admin@${DOMAIN:-$PROJECT.local}" pass
  pass="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)#7a"
  if docker compose exec -T -e ADMIN_EMAIL="$email" -e ADMIN_PASSWORD="$pass" api node -e '
    const { PrismaClient } = require("@prisma/client");
    const bcrypt = require("bcryptjs");
    const prisma = new PrismaClient();
    (async () => {
      if ((await prisma.user.count()) > 0) { console.log("Já existem usuários — nenhum administrador criado."); return; }
      await prisma.user.create({ data: { email: process.env.ADMIN_EMAIL, fullName: "Administrador", displayName: "Admin", role: "ADMIN",
        passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12), status: "ACTIVE" } });
      console.log("criado");
    })().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
  ' | grep -qx criado; then
    (umask 077; printf 'Endereço: %s\nLogin: %s\nSenha: %s\nTroque a senha no primeiro acesso (Usuários).\n' \
      "${DOMAIN:+https://$DOMAIN} (ou http://IP-DA-VPS:$PORT)" "$email" "$pass" > "$HOME/$PROJECT/CREDENCIAIS-INICIAIS.txt")
    NEW_ADMIN=1
  else
    echo "AVISO: o administrador inicial não foi criado (já havia usuários ou houve erro)."
  fi
}

# Proxy da VPS (nginx ou Caddy) para o domínio, com HTTPS. Só cria o que ainda não existe e nunca derruba o deploy:
# um site que já menciona o domínio não é tocado, e uma configuração que não passa no teste é desfeita.
configure_domain() {
  if ! sudo -n true 2>/dev/null; then echo "AVISO: sem sudo sem senha — domínio $DOMAIN não configurado no proxy da VPS."; return 0; fi
  if [ -f /etc/caddy/Caddyfile ] && command -v caddy >/dev/null; then
    grep -q "$DOMAIN" /etc/caddy/Caddyfile && { echo "Domínio $DOMAIN já está no Caddy."; return 0; }
    log "Configurando $DOMAIN no Caddy"
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.antes-$PROJECT
    printf '\n%s {\n\trequest_body {\n\t\tmax_size 300MB\n\t}\n\treverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$PORT" | sudo tee -a /etc/caddy/Caddyfile >/dev/null
    if sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
      sudo systemctl reload caddy && echo "Caddy: $DOMAIN -> 127.0.0.1:$PORT (HTTPS automático)."
    else
      sudo cp /etc/caddy/Caddyfile.antes-$PROJECT /etc/caddy/Caddyfile
      echo "AVISO: a configuração do Caddy não passou na validação — desfeita."
    fi
    return 0
  fi
  if ! command -v nginx >/dev/null; then echo "AVISO: nem nginx nem Caddy na VPS — domínio $DOMAIN não configurado."; return 0; fi
  if sudo grep -rqs "server_name[^;]*\b$DOMAIN\b" /etc/nginx/; then
    echo "Domínio $DOMAIN já está no nginx."
    # Site criado aqui e ainda sem certificado (o DNS não apontava para a VPS antes): tenta o HTTPS de novo.
    if sudo grep -qs "Criado pelo deploy automático" "/etc/nginx/sites-available/$PROJECT" "/etc/nginx/conf.d/$PROJECT.conf" \
      && ! sudo test -d "/etc/letsencrypt/live/$DOMAIN" && command -v certbot >/dev/null; then
      issue_certificate
    fi
    return 0
  fi
  log "Configurando $DOMAIN no nginx"
  local conf
  if [ -d /etc/nginx/sites-available ]; then conf="/etc/nginx/sites-available/$PROJECT"; else conf="/etc/nginx/conf.d/$PROJECT.conf"; fi
  sudo tee "$conf" >/dev/null <<NGINX
# Criado pelo deploy automático ($PROJECT). O HTTPS é adicionado pelo certbot.
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 300m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
  [ -d /etc/nginx/sites-enabled ] && sudo ln -sf "$conf" "/etc/nginx/sites-enabled/$PROJECT"
  if ! sudo nginx -t >/dev/null 2>&1; then
    sudo rm -f "$conf" "/etc/nginx/sites-enabled/$PROJECT"
    echo "AVISO: a configuração do nginx não passou no teste — desfeita."
    return 0
  fi
  sudo systemctl reload nginx
  echo "nginx: $DOMAIN -> 127.0.0.1:$PORT"
  if command -v certbot >/dev/null; then issue_certificate; else echo "AVISO: certbot não instalado — $DOMAIN responde só em HTTP."; fi
}

issue_certificate() {
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    && echo "HTTPS ativo em https://$DOMAIN" \
    || echo "AVISO: o certificado HTTPS não saiu agora (o DNS de $DOMAIN já aponta para a VPS?). O próximo deploy tenta de novo."
}

main() {
  PROJECT="$1"   # pasta em $HOME: whatsatendende | whatsunivida | whatsimagem
  BRANCH="$2"    # branch que a VPS segue
  PORT="$3"      # porta do container web no host (8080 | 8086 | 8087)
  SHA="$4"       # commit exato que passou nos testes
  DOMAIN="${5:-}" # domínio público (opcional): configura o proxy HTTPS da VPS se ainda não houver
  KEEP_BACKUPS=7
  HEALTH_TIMEOUT=300
  AI_MODEL="qwen2.5:3b"

  log() { printf '\n=== %s ===\n' "$*"; }

  exec 9>/tmp/vps-deploy.lock
  log "Aguardando outro deploy terminar (se houver)"
  flock 9

  # git com o token temporário do job (repositório privado); sem token, git normal.
  git_auth() {
    if [ -n "${GH_TOKEN:-}" ]; then
      git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)" "$@"
    else
      git "$@"
    fi
  }

  if [ ! -d "$HOME/$PROJECT" ]; then
    [ -n "${REPO_URL:-}" ] || { echo "A pasta $HOME/$PROJECT não existe e o REPO_URL não foi informado — nada foi alterado."; exit 1; }
    log "Primeira instalação de $PROJECT em $HOME/$PROJECT"
    command -v docker >/dev/null && docker compose version >/dev/null || { echo "Docker/Docker Compose não estão instalados na VPS — nada foi alterado."; exit 1; }
    git_auth clone --branch "$BRANCH" "$REPO_URL" "$HOME/$PROJECT"
    (
      umask 077
      {
        echo "# Criado pelo deploy automático na primeira instalação ($(date '+%Y-%m-%d %H:%M')). FAÇA BACKUP DESTE ARQUIVO:"
        echo "# sem ele os logins caem e as senhas guardadas no sistema não podem ser lidas."
        echo "JWT_ACCESS_SECRET=$(openssl rand -hex 32)"
        echo "JWT_REFRESH_SECRET=$(openssl rand -hex 32)"
        echo "SETTINGS_ENCRYPTION_KEY=$(openssl rand -hex 32)"
        echo "WHATSAPP_PROVIDER=baileys"
        [ -n "$DOMAIN" ] && echo "WEB_APP_URL=https://$DOMAIN"
      } > "$HOME/$PROJECT/.env"
    )
  elif [ ! -d "$HOME/$PROJECT/.git" ] || [ ! -f "$HOME/$PROJECT/.env" ]; then
    echo "A pasta $HOME/$PROJECT existe, mas sem o clone do repositório ou sem o .env — confira à mão (um .env novo trocaria os segredos do sistema). Nada foi alterado."
    exit 1
  fi
  cd "$HOME/$PROJECT"
  PREV_SHA=$(git rev-parse HEAD)
  log "Commit em produção antes: $(git log -1 --oneline)"

  git_auth fetch origin "$BRANCH"
  if ! git merge-base --is-ancestor "$SHA" "origin/$BRANCH"; then
    echo "O commit $SHA não está na branch $BRANCH — nada foi alterado."
    exit 1
  fi
  if [ "$(git rev-parse "origin/$BRANCH")" != "$SHA" ]; then
    echo "Já existe um commit mais novo em $BRANCH; este deploy é pulado (o deploy do commit novo vem em seguida)."
    exit 0
  fi

  # 1) Backup antes de qualquer mudança.
  TS=$(date +%Y%m%d-%H%M%S)
  BK="$HOME/backups-auto/$PROJECT/$TS"
  mkdir -p "$BK"
  echo "$PREV_SHA" > "$BK/commit-hash.txt"
  git log -1 --oneline > "$BK/commit.txt"
  cp .env "$BK/.env.backup"
  if docker compose ps --status running --services | grep -qx postgres; then
    # Um Postgres que acabou de reiniciar ainda não aceita conexões: espera até 60 s.
    for _ in $(seq 1 30); do
      docker compose exec -T postgres pg_isready -U whatsatendende >/dev/null 2>&1 && break
      sleep 2
    done
    # Sem backup do banco, não se mexe em nada: o erro para o deploy aqui, com o sistema intacto.
    if ! docker compose exec -T postgres pg_dump -U whatsatendende --clean --if-exists whatsatendende | gzip > "$BK/banco.sql.gz"; then
      rm -rf "$BK"
      echo "Falha no backup do banco — deploy cancelado, nada foi alterado."
      exit 1
    fi
    log "Backup do banco salvo em $BK ($(du -h "$BK/banco.sql.gz" | cut -f1))"
    # As conexões (sessões do WhatsApp) também: se algo der errado, voltam sem ler o QR Code de novo. Pequeno, e
    # nunca para o deploy — o banco acima é o que não pode faltar.
    if docker compose ps --status running --services | grep -qx api \
      && docker compose exec -T api tar czf - -C /data whatsapp-sessions > "$BK/sessoes-whatsapp.tar.gz" 2>/dev/null \
      && gzip -t "$BK/sessoes-whatsapp.tar.gz" 2>/dev/null; then
      echo "Sessões do WhatsApp (conexões) salvas ($(du -h "$BK/sessoes-whatsapp.tar.gz" | cut -f1))"
    else
      rm -f "$BK/sessoes-whatsapp.tar.gz"
      echo "AVISO: não deu para salvar as sessões do WhatsApp agora (a API não está no ar?) — o deploy segue."
    fi
  else
    echo "Postgres não está rodando — backup do banco pulado (primeiro deploy?)."
  fi
  ls -1d "$HOME/backups-auto/$PROJECT"/*/ 2>/dev/null | sort | head -n -"$KEEP_BACKUPS" | xargs -r rm -rf

  # 2) Guarda as imagens atuais para poder voltar.
  mapfile -t IMAGES < <(docker compose config --images | grep "^${PROJECT}-" || true)
  for img in "${IMAGES[@]}"; do
    if docker image inspect "$img" >/dev/null 2>&1; then docker tag "$img" "${img%%:*}:rollback"; fi
  done

  rollback() {
    log "FALHOU — voltando para a versão anterior ($PREV_SHA)"
    git reset --hard "$PREV_SHA"
    for img in "${IMAGES[@]}"; do
      if docker image inspect "${img%%:*}:rollback" >/dev/null 2>&1; then docker tag "${img%%:*}:rollback" "$img"; fi
    done
    docker compose up -d --remove-orphans || true
    docker compose ps
    echo "O banco NÃO foi restaurado automaticamente. Se a falha veio de uma migração, o backup está em $BK."
    exit 1
  }

  # 3) Código novo.
  git checkout -B "$BRANCH" "origin/$BRANCH"
  git reset --hard "$SHA"
  log "Commit novo: $(git log -1 --oneline)"

  # 4) Para, reconstrói e sobe (down antes do build: libera RAM — ver gerenciador-vps.bat).
  log "Parando containers para liberar RAM"
  docker compose down
  log "Reconstruindo (o sistema fica fora do ar durante o build)"
  # O Docker Hub limita downloads (429 Too Many Requests): tenta de novo antes de desistir.
  for try in 1 2 3; do
    docker compose build && break
    [ "$try" = 3 ] && rollback
    echo "Build falhou (tentativa $try de 3) — nova tentativa em 60 s"; sleep 60
  done
  docker compose up -d --remove-orphans || rollback

  # 5) Saúde: a API responde pelo nginx do container web (as migrações rodam antes da API subir).
  log "Aguardando o sistema responder em http://127.0.0.1:$PORT/api/health"
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  until curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
    if [ $SECONDS -ge $deadline ]; then
      docker compose logs --tail 80 api || true
      rollback
    fi
    sleep 5
  done

  # Instalação feita por este script e ainda sem administrador (vale também se a primeira tentativa falhou no meio).
  NEW_ADMIN=0
  if grep -q "Criado pelo deploy automático" .env && [ ! -f CREDENCIAIS-INICIAIS.txt ]; then first_admin; fi
  [ -n "$DOMAIN" ] && configure_domain

  docker image prune -f >/dev/null
  docker image rm erikvl87/languagetool:latest >/dev/null 2>&1 || true
  # Cache de build com mais de 7 dias (chegou a 64 GB): o build seguinte continua rápido com o cache recente.
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  log "OK — no ar com $(git log -1 --oneline)"
  docker compose ps

  # IA local (Assistente Virtual), compartilhada pelos dois sistemas. Nunca derruba o deploy: sem ela, o
  # assistente só passa as conversas para a fila.
  if [ -f infrastructure/ia-local/docker-compose.yml ]; then
    log "IA local (Ollama + $AI_MODEL e transcrição Whisper large-v3-turbo)"
    if docker compose -p ia-local -f infrastructure/ia-local/docker-compose.yml up -d --build --remove-orphans; then
      if docker compose -p ia-local -f infrastructure/ia-local/docker-compose.yml exec -T ollama ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$AI_MODEL"; then
        echo "Modelo $AI_MODEL já está baixado."
      else
        echo "Baixando o modelo $AI_MODEL (só na primeira vez, ~2 GB)..."
        docker compose -p ia-local -f infrastructure/ia-local/docker-compose.yml exec -T ollama ollama pull "$AI_MODEL" >/dev/null \
          && echo "Modelo baixado." || echo "AVISO: não deu para baixar o modelo agora; o próximo deploy tenta de novo."
      fi
    else
      echo "AVISO: a IA local não subiu; os sistemas seguem no ar normalmente."
    fi
  fi

  if [ "$NEW_ADMIN" = 1 ]; then
    log "PRIMEIRO ACESSO"
    cat "$HOME/$PROJECT/CREDENCIAIS-INICIAIS.txt"
  fi

  log "Servidor"
  uname -m
  nproc
  free -h
  df -h / | tail -1
}

main "$@" </dev/null
