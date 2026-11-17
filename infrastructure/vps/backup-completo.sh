#!/usr/bin/env bash
# Backup COMPLETO de um sistema da VPS, pronto para levar a OUTRO servidor.
#
# Roda NA VPS (o sistema continua no ar durante o backup):
#
#   bash infrastructure/vps/backup-completo.sh <pasta> [usuario@servidor:/caminho/destino]
#
#   <pasta>    pasta do sistema em $HOME: whatsatendende | whatsunivida | whatsimagem
#   destino    opcional: copia o backup para outro servidor por SSH (rsync, ou scp se
#              não houver rsync) e confere lá a integridade (sha256) de cada arquivo.
#              Chave SSH: variável BACKUP_SSH_KEY (padrão: a chave padrão do usuário).
#
# Gera ~/backups-completos/<pasta>/AAAAMMDD-HHMMSS/ com:
#   banco.sql.gz        pg_dump do Postgres (com --clean: recria tudo ao restaurar)
#   arquivos.tar.gz     volumes da API: uploads (fotos, anexos, boletos) e sessões do WhatsApp
#   downloads.tar.gz    volume do app Android (.apk), se existir
#   env.backup          o .env (segredos JWT e SETTINGS_ENCRYPTION_KEY — SEM ELE as senhas
#                       guardadas no sistema não podem ser lidas e os logins caem)
#   commit-hash.txt     commit exato do código (a restauração usa a MESMA versão)
#   repo-url.txt        de onde clonar o código no servidor novo
#   SHA256SUMS          conferência de integridade de todos os arquivos acima
#
# Ficam os KEEP_BACKUPS (padrão 5) mais recentes. Para restaurar: restaurar-backup.sh.
set -eEuo pipefail

main() {
  PROJECT="${1:-}"
  DEST="${2:-}"
  KEEP="${KEEP_BACKUPS:-5}"
  [ -n "$PROJECT" ] || { echo "Uso: $0 <pasta> [usuario@servidor:/caminho]"; exit 1; }
  DIR="$HOME/$PROJECT"
  [ -d "$DIR/.git" ] || { echo "Pasta $DIR não encontrada (ou não é um clone do repositório)."; exit 1; }
  cd "$DIR"
  [ -f .env ] || { echo "Falta $DIR/.env — sem ele o backup não serve para restaurar."; exit 1; }
  docker compose ps --status running --services | grep -qx postgres || { echo "O Postgres de $PROJECT não está rodando — suba o sistema antes (docker compose up -d)."; exit 1; }

  TS=$(date +%Y%m%d-%H%M%S)
  BK="$HOME/backups-completos/$PROJECT/$TS"
  mkdir -p "$BK"
  chmod 700 "$HOME/backups-completos" "$BK"
  trap 'echo "FALHOU — backup incompleto apagado."; rm -rf "$BK"' ERR

  echo "=== Backup de $PROJECT em $BK"
  git rev-parse HEAD > "$BK/commit-hash.txt"
  git log -1 --oneline > "$BK/commit.txt"
  git remote get-url origin > "$BK/repo-url.txt"
  cp .env "$BK/env.backup"
  chmod 600 "$BK/env.backup"

  echo "--- Banco (pg_dump)"
  docker compose exec -T postgres pg_dump -U whatsatendende --clean --if-exists whatsatendende | gzip > "$BK/banco.sql.gz"
  # Um dump que parou no meio não tem a linha final — não é aceito.
  gzip -dc "$BK/banco.sql.gz" | tail -n 5 | grep -q "PostgreSQL database dump complete" \
    || { echo "O dump do banco está incompleto."; false; }

  echo "--- Arquivos e sessões do WhatsApp (volumes da API)"
  docker compose exec -T api tar czf - -C /data uploads whatsapp-sessions > "$BK/arquivos.tar.gz"
  gzip -t "$BK/arquivos.tar.gz"

  if docker compose ps --status running --services | grep -qx web; then
    echo "--- App Android (.apk)"
    docker compose exec -T web tar czf - -C /usr/share/nginx downloads > "$BK/downloads.tar.gz"
    gzip -t "$BK/downloads.tar.gz"
  fi

  (cd "$BK" && sha256sum banco.sql.gz arquivos.tar.gz env.backup commit-hash.txt repo-url.txt $( [ -f downloads.tar.gz ] && echo downloads.tar.gz ) > SHA256SUMS)
  trap - ERR
  echo "=== Backup pronto ($(du -sh "$BK" | cut -f1)): $BK"
  ls -lh "$BK"

  ls -1d "$HOME/backups-completos/$PROJECT"/*/ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf

  if [ -n "$DEST" ]; then
    echo "=== Copiando para $DEST"
    SSH_OPTS=(-o ServerAliveInterval=30 -o ConnectTimeout=30)
    [ -n "${BACKUP_SSH_KEY:-}" ] && SSH_OPTS+=(-i "$BACKUP_SSH_KEY")
    REMOTE_HOST="${DEST%%:*}"
    REMOTE_DIR="${DEST#*:}/$PROJECT/$TS"
    ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"
    if command -v rsync >/dev/null && ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "command -v rsync" >/dev/null; then
      rsync -a --partial -e "ssh ${SSH_OPTS[*]}" "$BK/" "$REMOTE_HOST:$REMOTE_DIR/"
    else
      scp "${SSH_OPTS[@]}" "$BK"/* "$REMOTE_HOST:$REMOTE_DIR/"
    fi
    ssh "${SSH_OPTS[@]}" "$REMOTE_HOST" "cd '$REMOTE_DIR' && sha256sum -c --quiet SHA256SUMS" \
      || { echo "A cópia no servidor de destino NÃO confere — repita o envio."; exit 1; }
    echo "=== Cópia conferida em $REMOTE_HOST:$REMOTE_DIR"
  fi
}

main "$@" </dev/null
