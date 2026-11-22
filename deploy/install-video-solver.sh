#!/usr/bin/env bash
# Eigenständiger lokaler Video-Browser; berührt keine anderen Compose-Dienste.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Als root ausführen.' >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_DATEI=${SERIEN_ENV_DATEI:-/etc/serien-katalog.env}
IMAGE=ghcr.io/thephaseless/byparr@sha256:c66fa161187b8fa527bfad7eefa2647ea1c553f77df68cbffd6fe83366d1787b
[ -f "$ENV_DATEI" ] || { echo 'Serien-Dienstkonfiguration fehlt.' >&2; exit 1; }
command -v docker >/dev/null
docker pull "$IMAGE"
# Die nur für den Vergleich erzeugte Instanz verwendet denselben Testport.
docker rm -f serie-probe-video >/dev/null 2>&1 || true
docker rm -f serie-video-browser >/dev/null 2>&1 || true
docker run -d --name serie-video-browser --restart unless-stopped \
  --memory=1536m --cpus=1.5 --shm-size=512m \
  -p 127.0.0.1:18194:8191 \
  -e LOG_LEVEL=warning -e BROWSER_LOCALE=de-DE -e BROWSER_TIMEZONE=Europe/Berlin \
  -e PYTHONPATH=/app -v "$ROOT/deploy:/serie:ro" \
  --health-cmd='curl -fsS http://127.0.0.1:8191/docs >/dev/null' \
  --health-interval=60s --health-timeout=10s --health-start-period=120s \
  --entrypoint tini "$IMAGE" -s -- /app/.venv/bin/python /serie/byparr-video.py >/dev/null
bereit=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:18194/docs >/dev/null; then bereit=1; break; fi
  sleep 2
done
[ "$bereit" = 1 ] || { docker logs --tail 20 serie-video-browser; echo 'Video-Browser startet nicht.' >&2; exit 1; }
umask 077
[ -f "$ENV_DATEI.vor-video-solver" ] || cp -p "$ENV_DATEI" "$ENV_DATEI.vor-video-solver"
sed -i '/^VIDEO_SOLVER_URL=/d' "$ENV_DATEI"
echo 'VIDEO_SOLVER_URL=http://127.0.0.1:18194/' >> "$ENV_DATEI"
systemctl restart serien-katalog
echo 'Gemeinsamer Video-Browser bereit. Live-Test: bash deploy/test-playmogo.sh <URL>'
