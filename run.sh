#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${RUNE_PORT:-8770}"
export AI_USAGE_HOME="${AI_USAGE_HOME:-$PWD/.rune-data}"
mkdir -p "$AI_USAGE_HOME"
chmod 700 "$AI_USAGE_HOME" 2>/dev/null || true

if [ ! -f "$AI_USAGE_HOME/config.json" ] && [ -f collector/config.example.json ]; then
  cp collector/config.example.json "$AI_USAGE_HOME/config.json"
  chmod 600 "$AI_USAGE_HOME/config.json"
fi

if [ -f collector/collect.py ]; then
  python3 collector/collect.py --quiet || echo "rune: primeira coleta falhou; o painel abre com os dados disponíveis" >&2
fi

python3 server.py &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT INT TERM

URL="http://127.0.0.1:${PORT}/"
for _ in $(seq 1 40); do
  if curl -fsS "${URL}api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

if [ -z "${RUNE_NO_OPEN:-}" ]; then
  if command -v open >/dev/null 2>&1; then
    open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL"
  else
    echo "Rune Live em $URL"
  fi
fi

wait "$PID"
