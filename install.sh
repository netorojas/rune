#!/usr/bin/env bash
# Instala o Rune como serviço de usuário no macOS (launchd). Sem sudo, sem cópia do código:
# o serviço aponta para este clone, então `git pull && ./install.sh` atualiza tudo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.netorojas.rune"
UID_NUM="$(id -u)"
PY="${RUNE_PYTHON:-$(command -v python3 || true)}"
AI_USAGE_HOME="${AI_USAGE_HOME:-$HOME/.ai-usage}"
PORT="${RUNE_PORT:-8770}"
LOGS="${RUNE_LOGS:-$HOME/Library/Logs/Rune}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

usage() {
  cat <<'USAGE'
Uso: ./install.sh [--print-plist | --uninstall]

  (sem argumento)  instala ou reinstala o serviço e sobe o painel
  --print-plist    imprime o launchd plist gerado, sem instalar nada
  --uninstall      remove o serviço (dados, logs e o clone continuam intactos)

Variáveis: RUNE_PORT (8770), AI_USAGE_HOME (~/.ai-usage), RUNE_PYTHON (python3 do PATH),
RUNE_LOGS (~/Library/Logs/Rune).
USAGE
}

die() { printf 'rune: %s\n' "$1" >&2; exit 1; }

check_port() {
  case "$1" in
    ''|*[!0-9]*) die "RUNE_PORT precisa ser um número entre 1 e 65535 (recebi '$1')" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || die "RUNE_PORT fora da faixa 1-65535"
}

render_plist() {
  [ -n "$PY" ] || die "python3 não encontrado no PATH"
  [ -f "$HERE/server.py" ] || die "server.py não está em $HERE"
  check_port "$PORT"
  "$PY" - "$LABEL" "$HERE" "$PY" "$AI_USAGE_HOME" "$PORT" "$LOGS" <<'PY'
import plistlib
import sys

label, base, python, ai_usage, port, logs = sys.argv[1:7]
plist = {
    "Label": label,
    "ProgramArguments": [python, f"{base}/server.py"],
    "WorkingDirectory": base,
    "EnvironmentVariables": {
        "AI_USAGE_HOME": ai_usage,
        "RUNE_PORT": port,
        "RUNE_NO_OPEN": "1",
        "PYTHONUNBUFFERED": "1",
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "StandardOutPath": f"{logs}/rune.out.log",
    "StandardErrorPath": f"{logs}/rune.err.log",
}
sys.stdout.buffer.write(plistlib.dumps(plist, fmt=plistlib.FMT_XML, sort_keys=False))
PY
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  --print-plist) render_plist; exit 0 ;;
  --uninstall)
    [ "$(uname -s)" = "Darwin" ] || die "o serviço launchd só existe no macOS"
    launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "rune: serviço removido. Dados, logs e o clone continuam intactos."
    exit 0
    ;;
  "") ;;
  *) usage; exit 2 ;;
esac

[ "$(uname -s)" = "Darwin" ] || die "use ./run.sh fora do macOS; o instalador launchd é exclusivo do macOS"
[ -n "$PY" ] || die "python3 não encontrado no PATH"
[ -f "$HERE/server.py" ] || die "server.py não está em $HERE"
check_port "$PORT"

LOADED=0
launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 && LOADED=1
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && [ "$LOADED" = 0 ]; then
  die "já existe um Rune rodando fora do launchd na porta $PORT. Encerre esse processo e rode de novo."
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOGS" "$AI_USAGE_HOME"
chmod 700 "$AI_USAGE_HOME" "$LOGS" 2>/dev/null || true
if [ ! -f "$AI_USAGE_HOME/config.json" ] && [ -f "$HERE/collector/config.example.json" ]; then
  cp "$HERE/collector/config.example.json" "$AI_USAGE_HOME/config.json"
  chmod 600 "$AI_USAGE_HOME/config.json"
fi

# Coleta inicial para o painel não abrir vazio; falha não impede o serviço de subir.
if [ -f "$HERE/collector/collect.py" ]; then
  AI_USAGE_HOME="$AI_USAGE_HOME" "$PY" "$HERE/collector/collect.py" --quiet \
    || echo "rune: primeira coleta falhou; o painel abre com os dados disponíveis" >&2
fi

TMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/rune-plist.XXXXXX")"
trap 'rm -f "$TMP_PLIST"' EXIT
render_plist > "$TMP_PLIST"
chmod 644 "$TMP_PLIST"
mv "$TMP_PLIST" "$PLIST"

# Remove a versão anterior antes de registrar a nova (idempotente).
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
if ! launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
  launchctl load -w "$PLIST"
fi

URL="http://127.0.0.1:$PORT/"
for _ in $(seq 1 40); do
  curl -fsS "${URL}api/health" >/dev/null 2>&1 && break
  sleep 0.25
done
if ! curl -fsS "${URL}api/health" >/dev/null 2>&1; then
  die "o serviço foi registrado, mas o painel não respondeu em 10s. Veja $LOGS/rune.err.log"
fi

cat <<EOF
rune: painel no ar em $URL
  inicia no login · reinicia se cair · logs em $LOGS
  atualizar: git pull && ./install.sh
  desinstalar: ./install.sh --uninstall
EOF
