#!/usr/bin/env bash
# Als Dienstbenutzer ausführen. Keine Änderungen an /etc oder Systempaketen.
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=${ANBIETER_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}
RUNTIME="$ROOT/.anbieter"
command -v xvfb-run >/dev/null || { echo 'xvfb-run wird benötigt' >&2; exit 1; }
mkdir -p "$RUNTIME"
python3 -m venv --without-pip "$RUNTIME/venv"
if ! "$RUNTIME/venv/bin/python" -m pip --version >/dev/null 2>&1; then
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$RUNTIME/get-pip.py"
  "$RUNTIME/venv/bin/python" "$RUNTIME/get-pip.py" --quiet
fi
"$RUNTIME/venv/bin/python" -m pip install --quiet torch==2.15.0+cpu torchvision==0.29.2+cpu --index-url https://download.pytorch.org/whl/cpu
"$RUNTIME/venv/bin/python" -m pip install --quiet camoufox==0.5.9 playwright==1.62.0 ultralytics==8.4.216 selenium opencv-python-headless
projekt() {
  local name=$1 repo=$2 commit=$3
  if [ ! -d "$RUNTIME/$name/.git" ]; then git clone --quiet "$repo" "$RUNTIME/$name"; fi
  git -C "$RUNTIME/$name" checkout --quiet --force "$commit"
}
projekt cf-solver https://github.com/VeyraAgent/cf-solver.git 9582124c39b18a663ab427860103fc76be4d23f2
projekt recaptcha_ia_solver https://github.com/cateyelow/recaptcha_ia_solver.git b8049e7243f6f1e6f7d4c6e9e4eb4befc0eaab21
python3 "$SCRIPT_DIR/patch-anbieter.py" "$RUNTIME"
"$RUNTIME/venv/bin/python" -m camoufox fetch
(cd "$RUNTIME/recaptcha_ia_solver/models"; "$RUNTIME/venv/bin/python" -c 'from ultralytics import YOLO; YOLO("yolov8x-oiv7.pt")')
echo 'Anbieter-Auflösung eingerichtet'
