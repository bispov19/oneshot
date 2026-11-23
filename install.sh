#!/usr/bin/env bash
# Instala o OneShot para o usuário atual.
#   ./install.sh          -> link simbólico (desenvolvimento: edições valem após relogar)
#   ./install.sh --copy   -> cópia dos arquivos
#   ./install.sh --pack   -> gera oneshot@vinicius.shell-extension.zip (para o EGO)
set -euo pipefail

UUID="oneshot@vinicius"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

echo "==> Compilando esquema GSettings"
glib-compile-schemas --strict "$SRC/schemas"

case "${1:-}" in
  --pack)
    gnome-extensions pack "$SRC" --force \
      --extra-source=lib --extra-source=prefs --extra-source=icons \
      --extra-source=helpers --extra-source=LICENSE \
      --out-dir="$SRC"
    echo "==> Pacote gerado em $SRC/$UUID.shell-extension.zip"
    exit 0
    ;;
  --copy)
    # Remove uma instalação anterior (link ou cópia) antes de copiar.
    if [ -L "$DEST" ]; then rm -f "$DEST"; elif [ -d "$DEST" ]; then rm -r "$DEST"; fi
    mkdir -p "$DEST"
    cp -r "$SRC"/{metadata.json,extension.js,prefs.js,stylesheet.css,lib,prefs,icons,helpers,schemas,LICENSE} "$DEST"/
    ;;
  *)
    mkdir -p "$(dirname "$DEST")"
    if [ -e "$DEST" ] && [ ! -L "$DEST" ]; then
      echo "Já existe uma instalação copiada em $DEST. Remova-a ou use --copy." >&2
      exit 1
    fi
    ln -sfn "$SRC" "$DEST"
    ;;
esac

echo "==> Instalado em $DEST"
echo "Em Wayland, saia da sessão e entre de novo na primeira instalação."
echo "Depois: gnome-extensions enable $UUID"
