#!/usr/bin/env bash
# Restaura um backup feito por backup-completo.sh — no mesmo servidor ou num servidor NOVO.
#
#   bash restaurar-backup.sh <pasta-do-backup> <pasta>
#
#   <pasta-do-backup>  a pasta AAAAMMDD-HHMMSS gerada pelo backup-completo.sh
#   <pasta>            pasta do sistema em $HOME: whatsatendende | whatsunivida | whatsimagem
#
# No servidor novo basta Docker + Docker Compose + git (e acesso ao repositório): se
# $HOME/<pasta> não existir, o código é clonado (endereço em repo-url.txt). Em qualquer
# caso o código volta para o MESMO commit do backup — banco e código ficam na mesma versão.
# Depois é só atualizar normalmente (git pull / deploy automático), que aplica as migrações.
#
# ATENÇÃO: substitui banco, arquivos, sessões do WhatsApp e .env da <pasta> pelos do backup.
# Para confirmar sem pergunta (uso em script): CONFIRMAR=RESTAURAR bash restaurar-backup.sh ...
#
# Mesmo servidor ou não: NUNCA deixe dois servidores no ar com as mesmas sessões do WhatsApp
# ao mesmo tempo — desligue o antigo (docker compose down) antes de subir o novo.
set -eEuo pipefail

main() {
  BK="${1:-}"
  PROJECT="${2:-}"
  [ -n "$BK" ] && [ -n "$PROJECT" ] || { echo "Uso: $0 <pasta-do-backup> <pasta>"; exit 1; }
  BK=$(cd "$BK" && pwd)
  DIR="$HOME/$PROJECT"
  HEALTH_TIMEOUT=600

  echo "=== Conferindo o backup $BK"
  for f in banco.sql.gz arquivos.tar.gz env.backup commit-hash.txt repo-url.txt SHA256SUMS; do
    [ -f "$BK/$f" ] || { echo "Falta $f no backup — nada foi alterado."; exit 1; }
  done
  (cd "$BK" && sha256sum -c --quiet SHA256SUMS) || { echo "O backup está corrompido (SHA256SUMS não confere) — nada foi alterado."; exit 1; }
  gzip -dc "$BK/banco.sql.gz" | tail -n 5 | grep -q "PostgreSQL database dump complete" || { echo "Dump do banco incompleto — nada foi alterado."; exit 1; }
  SHA=$(cat "$BK/commit-hash.txt")
  echo "Backup do commit $SHA ($(cat "$BK/commit.txt" 2>/dev/null || true))"

  if [ "${CONFIRMAR:-}" != "RESTAURAR" ]; then
    printf 'Isto SUBSTITUI banco, arquivos, sessões e .env de %s. Digite RESTAURAR para continuar: ' "$DIR"
    read -r answer </dev/tty
    [ "$answer" = "RESTAURAR" ] || { echo "Cancelado — nada foi alterado."; exit 1; }
  fi

  if [ ! -d "$DIR/.git" ]; then
    echo "=== Clonando o código em $DIR"
    git clone "$(cat "$BK/repo-url.txt")" "$DIR"
  fi
  cd "$DIR"
  git fetch origin || echo "AVISO: não deu para buscar o repositório; usando o que já está na pasta."
  git cat-file -e "$SHA^{commit}" 2>/dev/null || { echo "O commit $SHA não existe neste clone — nada foi alterado."; exit 1; }

  # O .env vem antes do "down": numa pasta recém-clonada o compose nem lê o projeto sem ele.
  [ -f .env ] && cp .env ".env.antes-da-restauracao-$(date +%Y%m%d-%H%M%S)"
  cp "$BK/env.backup" .env
  chmod 600 .env
  echo "=== Parando o sistema"
  docker compose down || true
  git checkout -q -B "restaurado-$(date +%Y%m%d-%H%M%S)" "$SHA"

  echo "=== Banco"
  docker compose up -d postgres
  for _ in $(seq 1 60); do
    docker compose exec -T postgres pg_isready -U whatsatendende >/dev/null 2>&1 && break
    sleep 2
  done
  gzip -dc "$BK/banco.sql.gz" | docker compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U whatsatendende -d whatsatendende >/dev/null

  echo "=== Imagens (build)"
  # O Docker Hub limita downloads (429 Too Many Requests): tenta de novo antes de desistir.
  for try in 1 2 3; do
    docker compose build && break
    [ "$try" = 3 ] && { echo "O build falhou 3 vezes. Banco e .env já restaurados; rode de novo este script."; exit 1; }
    echo "Build falhou (tentativa $try de 3) — nova tentativa em 60 s"; sleep 60
  done

  echo "=== Arquivos e sessões do WhatsApp"
  docker compose run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /data/uploads/* /data/whatsapp-sessions/* && tar xzf - -C /data' < "$BK/arquivos.tar.gz"
  if [ -f "$BK/downloads.tar.gz" ]; then
    docker compose run --rm --no-deps -T --entrypoint sh web -c 'rm -rf /usr/share/nginx/downloads/* && tar xzf - -C /usr/share/nginx' < "$BK/downloads.tar.gz"
  fi

  echo "=== Subindo o sistema"
  docker compose up -d --remove-orphans
  PORT=$(docker compose port web 80 | awk -F: '{print $NF}')
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  until curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; do
    if [ $SECONDS -ge $deadline ]; then
      docker compose logs --tail 80 api || true
      echo "O sistema não respondeu em http://127.0.0.1:$PORT/api/health — veja o log acima."
      exit 1
    fi
    sleep 5
  done
  echo "=== OK — $PROJECT restaurado do backup $(basename "$BK") e no ar na porta $PORT"
  echo "O código ficou no commit do backup (branch restaurado-*). Para voltar a seguir a main:"
  echo "  cd $DIR && git checkout main && git pull   (e rebuild/deploy normal)"
  docker compose ps
}

main "$@"
