#!/usr/bin/env bash
#
# run-web.sh - jalankan UI web + API LK21 dengan satu perintah.
#
# Menyiapkan: .env (bila belum ada), Redis, opsional sidecar cloudscraper,
# lalu menjalankan API. UI tersedia di http://localhost:<PORT>.
#
# Pemakaian:
#   ./run-web.sh                 # mode dev (tsx watch)
#   ./run-web.sh --prod          # build lalu jalankan hasil build
#   ./run-web.sh --cloudscraper  # sekalian jalankan sidecar Python
#   WITH_CLOUDSCRAPER=1 ./run-web.sh
#
set -euo pipefail

cd "$(dirname "$0")"

MODE="dev"
WITH_CLOUDSCRAPER="${WITH_CLOUDSCRAPER:-0}"
RUN_DIR=".run"
REDIS_PORT="${REDIS_PORT:-6379}"

for arg in "$@"; do
  case "$arg" in
    --prod) MODE="prod" ;;
    -c|--cloudscraper) WITH_CLOUDSCRAPER="1" ;;
    -h|--help)
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0
      ;;
    *) printf 'Opsi tidak dikenal: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;32m[run-web]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[run-web]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[run-web]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js tidak ditemukan. Install dulu (mis. pkg install nodejs)."
command -v npm  >/dev/null 2>&1 || die "npm tidak ditemukan."

[ -d node_modules ] || { log "Menjalankan npm install..."; npm install; }
[ -f .env ] || { cp .env.example .env; log "Membuat .env dari .env.example"; }
mkdir -p "$RUN_DIR"

if [ -z "${PORT:-}" ]; then
  PORT="$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1)"
  PORT="${PORT:-3000}"
fi
export PORT

# --- Redis ----------------------------------------------------------------
redis_up() {
  command -v redis-cli >/dev/null 2>&1 && redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1
}

if redis_up; then
  log "Redis sudah jalan di port $REDIS_PORT"
elif command -v redis-server >/dev/null 2>&1; then
  log "Menjalankan Redis di port $REDIS_PORT"
  redis-server --port "$REDIS_PORT" --save "" --appendonly no --daemonize yes
  for _ in 1 2 3 4 5; do redis_up && break; sleep 1; done
  redis_up || die "Redis gagal start; cek log redis-server."
else
  die "redis-server tidak ditemukan. Install dulu (mis. pkg install redis)."
fi

# --- Sidecar cloudscraper (opsional) --------------------------------------
SIDECAR_PID=""
if [ "$WITH_CLOUDSCRAPER" = "1" ]; then
  if command -v python3 >/dev/null 2>&1; then
    log "Menjalankan sidecar cloudscraper (log: $RUN_DIR/cloudscraper.log)"
    python3 services/cloudscraper/main.py >"$RUN_DIR/cloudscraper.log" 2>&1 &
    SIDECAR_PID=$!
  else
    warn "python3 tidak ditemukan; sidecar cloudscraper dilewati."
  fi
fi

# --- API ------------------------------------------------------------------
cleanup() {
  [ -n "$SIDECAR_PID" ] && kill "$SIDECAR_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$MODE" = "prod" ]; then
  log "Build produksi..."
  npm run build
  API_CMD=(npm run start:api)
else
  API_CMD=(npm run dev:api)
fi

log "UI web: http://localhost:$PORT   (health: /v1/health)"
log "Tekan Ctrl+C untuk berhenti."

"${API_CMD[@]}" &
API_PID=$!
wait "$API_PID"
