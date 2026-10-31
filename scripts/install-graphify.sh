#!/usr/bin/env sh
# Installs Graphify into ./.venv so the live "import a GitHub repo" feature works on the server.
# Runs automatically after `npm install`. Never fails the install: built-in repos work without it.
cd "$(dirname "$0")/.." || exit 0

if [ -x .venv/bin/graphify ]; then echo "[graphify] already installed in .venv"; exit 0; fi

PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)' 2>/dev/null; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "[graphify] Python 3.10+ not found. Skipping. Built-in repos still work; live import needs Python."
  exit 0
fi

echo "[graphify] using $PY ($($PY --version 2>&1))"
if "$PY" -m venv .venv 2>/dev/null && .venv/bin/python -m pip install -q --upgrade pip && .venv/bin/python -m pip install -q graphifyy; then
  echo "[graphify] installed: $(.venv/bin/graphify --help >/dev/null 2>&1 && echo ok)"
  exit 0
fi

echo "[graphify] venv failed, trying pip --user"
rm -rf .venv
"$PY" -m pip install -q --user graphifyy 2>/dev/null || "$PY" -m pip install -q --user --break-system-packages graphifyy 2>/dev/null \
  && echo "[graphify] installed to ~/.local/bin" \
  || echo "[graphify] could not install. Live import disabled; built-in repos still work."
exit 0
