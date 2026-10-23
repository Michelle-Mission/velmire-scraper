#!/usr/bin/env bash
#
# run-web.sh - jalankan semua service (Redis + cloudscraper + API/UI).
#
# Satu perintah menyalakan seluruh sistem: .env (bila belum ada), Redis,
# sidecar cloudscraper, lalu API. UI tersedia di http://localhost:<PORT>.
#
# Pemakaian:
#   ./run-web.sh          # mode dev (tsx watch)
#   ./run-web.sh --prod   # build lalu jalankan hasil build
#
set -euo pipefail

cd "$(dirname "$0")"

MODE="dev"
RUN_DIR=".run"
REDIS_PORT="${REDIS_PORT:-6379}"

for arg in "$@"; do
  case "$arg" in
    --prod) MODE="prod" ;;
    -h|--help)
      awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
      exit 0
      ;;
    *) printf 'Opsi tidak dikenal: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;32m[run-web]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[run-web]\033[0m %s\n' "$*" >&2; exit 1; }

env_or_file() {
  local value
  value="$(printenv "$1" 2>/dev/null || true)"
  if [ -z "$value" ]; then
    value="$(sed -n "s/^$1=//p" .env 2>/dev/null | tail -1)"
  fi
  printf '%s' "$value"
}

export_env() {
  local value
  value="$(env_or_file "$1")"
  [ -n "$value" ] && export "$1=$value"
  return 0
}

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

# --- Sidecar cloudscraper (selalu jalan) ----------------------------------
SIDECAR_URL="${CLOUDSCRAPER_URL:-$(sed -n 's/^CLOUDSCRAPER_URL=//p' .env 2>/dev/null | tail -1)}"
SIDECAR_URL="${SIDECAR_URL:-http://127.0.0.1:8000}"
SIDECAR_PORT="$(printf '%s' "$SIDECAR_URL" | sed -nE 's#^.*:([0-9]+)/?.*$#\1#p')"
SIDECAR_PORT="${SIDECAR_PORT:-8000}"
export CLOUDSCRAPER_PORT="$SIDECAR_PORT"
export_env CLOUDSCRAPER_ALLOWED_HOSTS
export_env CLOUDSCRAPER_TOKEN
export_env CLOUDSCRAPER_MAX_BYTES
export_env CLOUDSCRAPER_BROWSER
export_env CLOUDSCRAPER_DELAY

cloudscraper_up() {
  python3 - "$SIDECAR_URL/health" <<'PY' >/dev/null 2>&1
import sys, urllib.request
urllib.request.urlopen(sys.argv[1], timeout=2).read()
PY
}

VENV_DIR="$PWD/.venv"
PYTHON_BIN="python3"

# Ubuntu/Debian menolak pip system-wide (PEP 668). Pakai venv bila package
# cloudscraper belum tersedia di Python sistem.
if ! "$PYTHON_BIN" -c "import cloudscraper" >/dev/null 2>&1; then
  if [ ! -x "$VENV_DIR/bin/python" ]; then
    log "Membuat virtualenv Python di $VENV_DIR..."
    "$PYTHON_BIN" -m venv "$VENV_DIR" || die "Gagal membuat virtualenv. Install python3-venv lalu coba lagi."
  fi
  PYTHON_BIN="$VENV_DIR/bin/python"
  if ! "$PYTHON_BIN" -c "import cloudscraper" >/dev/null 2>&1; then
    log "Memasang dependency cloudscraper..."
    "$PYTHON_BIN" -m pip install --disable-pip-version-check -r services/cloudscraper/requirements.txt >/dev/null \
      || die "Gagal memasang dependency cloudscraper."
  fi
fi

SIDECAR_PID=""
if cloudscraper_up; then
  log "Cloudscraper sudah jalan di $SIDECAR_URL"
else
  log "Menjalankan sidecar cloudscraper di port $SIDECAR_PORT (log: $RUN_DIR/cloudscraper.log)"
  "$PYTHON_BIN" services/cloudscraper/main.py >"$RUN_DIR/cloudscraper.log" 2>&1 &
  SIDECAR_PID=$!
  for _ in $(seq 1 30); do
    cloudscraper_up && break
    sleep 0.5
  done
  if ! cloudscraper_up; then
    tail -n 20 "$RUN_DIR/cloudscraper.log" >&2 || true
    die "Cloudscraper gagal start."
  fi
  log "Cloudscraper siap."
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
