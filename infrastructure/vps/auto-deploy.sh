#!/usr/bin/env bash
# Deploy automático na VPS — roda NA VPS, enviado pelo GitHub Actions
# (.github/workflows/deploy.yml) por SSH depois que os testes passaram:
#
#   ssh ... "bash -s -- <pasta> <branch> <porta-web> <commit>" < auto-deploy.sh
#
# Faz o mesmo que a opção "Atualizar" do gerenciador-vps.bat, com três
# proteções a mais:
#   - uma trava (flock) para dois sistemas nunca construírem ao mesmo tempo:
#     a VPS tem pouca RAM e o build do front disputa memória;
#   - backup do banco (pg_dump) + .env + commit antes de mexer em qualquer
#     coisa, em ~/backups-auto/<pasta>/AAAAMMDD-HHMMSS (ficam os 7 últimos);
#   - verificação de saúde (/api/health pela porta do site) depois de subir.
#     Se o build falhar ou o sistema não responder, volta sozinho para as
#     imagens e o commit anteriores e o job termina em erro.
set -euo pipefail

# O script chega pela entrada padrão (bash -s); tudo fica dentro de main() e roda com a entrada em /dev/null,
# senão um "docker compose exec" leria o resto do próprio script e o deploy pararia no meio, sem erro.
main() {
  PROJECT="$1"   # pasta em $HOME: whatsatendende | whatsunivida
  BRANCH="$2"    # branch que a VPS segue
  PORT="$3"      # porta do container web no host (8080 | 8086)
  SHA="$4"       # commit exato que passou nos testes
  KEEP_BACKUPS=7
  HEALTH_TIMEOUT=300
  AI_MODEL="qwen2.5:3b"

  log() { printf '\n=== %s ===\n' "$*"; }

  exec 9>/tmp/vps-deploy.lock
  log "Aguardando outro deploy terminar (se houver)"
  flock 9

  cd "$HOME/$PROJECT"
  PREV_SHA=$(git rev-parse HEAD)
  log "Commit em produção antes: $(git log -1 --oneline)"

  git fetch origin "$BRANCH"
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
  docker compose build || rollback
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

  docker image prune -f >/dev/null
  docker image rm erikvl87/languagetool:latest >/dev/null 2>&1 || true
  # Cache de build com mais de 7 dias (chegou a 64 GB): o build seguinte continua rápido com o cache recente.
  docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
  log "OK — no ar com $(git log -1 --oneline)"
  docker compose ps

  # IA local (Assistente Virtual), compartilhada pelos dois sistemas. Nunca derruba o deploy: sem ela, o
  # assistente só passa as conversas para a fila.
  if [ -f infrastructure/ia-local/docker-compose.yml ]; then
    log "IA local (Ollama + $AI_MODEL)"
    if docker compose -p ia-local -f infrastructure/ia-local/docker-compose.yml up -d --remove-orphans; then
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

  log "Servidor"
  uname -m
  nproc
  free -h
  df -h / | tail -1
}

main "$@" </dev/null
