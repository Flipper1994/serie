#!/usr/bin/env bash
# Richtet den Serien-Katalog-Dienst auf einem Debian/Ubuntu-Server ein.
#
# Aufruf (als root, aus dem geklonten Repo):
#   bash deploy/install.sh                 nur lokal erreichbar (127.0.0.1)
#   bash deploy/install.sh --oeffentlich   von außen erreichbar (0.0.0.0, ohne TLS)
#
# Das Skript kann wiederholt werden; ein vorhandenes Token bleibt erhalten.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen (sudo bash deploy/install.sh)." >&2; exit 1; }

ORDNER=$(cd "$(dirname "$0")/.." && pwd)
ENV_DATEI=/etc/serien-katalog.env
HOST_WERT=127.0.0.1
[ "${1:-}" = "--oeffentlich" ] && HOST_WERT=0.0.0.0

NODE=$(command -v node || true)
if [ -z "$NODE" ] || [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "Node ab Version 18 wird gebraucht (gefunden: ${NODE:-nichts}). Bitte zuerst installieren." >&2
  exit 1
fi

id serie >/dev/null 2>&1 || useradd --system --create-home serie
chown -R serie: "$ORDNER"
cd "$ORDNER"

als_serie() { runuser -u serie -- env HOME="$(getent passwd serie | cut -d: -f6)" "$@"; }
als_serie npm install --no-save playwright
npx playwright install-deps chromium
als_serie npx playwright install chromium

if [ ! -f "$ENV_DATEI" ]; then
  (umask 077; echo "API_TOKEN=$(openssl rand -hex 32)" > "$ENV_DATEI")
fi
sed -i '/^HOST=/d' "$ENV_DATEI"
echo "HOST=$HOST_WERT" >> "$ENV_DATEI"

sed -e "s|/opt/serie|$ORDNER|" -e "s|/usr/bin/node|$NODE|" deploy/serien-katalog.service \
  > /etc/systemd/system/serien-katalog.service
systemctl daemon-reload
systemctl enable serien-katalog
systemctl restart serien-katalog

PORT_WERT=$(sed -n 's/^PORT=//p' "$ENV_DATEI"); PORT_WERT=${PORT_WERT:-8080}
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fs "http://127.0.0.1:$PORT_WERT/health" >/dev/null && break
  sleep 1
done
curl -fs "http://127.0.0.1:$PORT_WERT/health" >/dev/null || {
  echo "Der Dienst antwortet nicht. Siehe: journalctl -u serien-katalog -n 50" >&2; exit 1; }

ADRESSE=127.0.0.1
[ "$HOST_WERT" = 0.0.0.0 ] && ADRESSE=$(hostname -I | awk '{print $1}')
TOKEN=$(sed -n 's/^API_TOKEN=//p' "$ENV_DATEI")
echo
echo "Der Dienst läuft."
echo "URL:   http://$ADRESSE:$PORT_WERT/katalog?serie=furious&staffel=1&folge=6"
echo "Token: $TOKEN"
echo "Test:  curl -H \"Authorization: Bearer $TOKEN\" \"http://$ADRESSE:$PORT_WERT/katalog?serie=furious&staffel=1&folge=6\""
