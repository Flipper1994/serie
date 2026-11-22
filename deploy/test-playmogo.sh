#!/usr/bin/env bash
# Live-Test gegen den laufenden Dienst, ohne Token oder Medienadressen auszugeben.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${API_TOKEN:-}" ]; then
  ENV_DATEI=${SERIEN_ENV_DATEI:-/etc/serien-katalog.env}
  [ -r "$ENV_DATEI" ] || { echo 'API_TOKEN setzen oder als root ausführen, um die Dienstkonfiguration zu lesen.' >&2; exit 1; }
  set -a
  # Die vom Administrator verwaltete Konfiguration enthält KEY=VALUE-Zeilen.
  . "$ENV_DATEI"
  set +a
fi
: "${API_TOKEN:?API_TOKEN fehlt}"
export API_TOKEN
TEST_HOST=${HOST:-127.0.0.1}
[ "$TEST_HOST" != 0.0.0.0 ] || TEST_HOST=127.0.0.1
export TEST_BASIS=${TEST_BASIS:-http://$TEST_HOST:${PORT:-8080}/}
export TEST_ERWARTE_MP4=${TEST_ERWARTE_MP4:-1}
NODE=$(command -v node)
cd "$ROOT"
if [ "$(id -u)" = 0 ]; then
  SERIEN_HOME=$(getent passwd serie | cut -d: -f6)
  [ -n "$SERIEN_HOME" ] || { echo 'Dienstbenutzer serie fehlt' >&2; exit 1; }
  exec runuser -u serie --preserve-environment -- env HOME="$SERIEN_HOME" "$NODE" scripts/test-link-e2e.js "${1:-https://playmogo.com/d/onlyy2irbz99}"
fi
exec "$NODE" scripts/test-link-e2e.js "${1:-https://playmogo.com/d/onlyy2irbz99}"
