#!/usr/bin/env bash
# Install the `alloy` command onto PATH for this user.
# Prefer ~/.local/bin (XDG) which is usually already on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_SRC="$ROOT/bin/alloy.mjs"

if [[ ! -f "$BIN_SRC" ]]; then
  echo "error: missing $BIN_SRC" >&2
  exit 1
fi

chmod +x "$BIN_SRC"

# Ensure deps (Pi lives in node_modules)
if [[ ! -d "$ROOT/node_modules/@earendil-works/pi-coding-agent" ]]; then
  echo "Installing npm dependencies…"
  (cd "$ROOT" && npm install)
fi

TARGET_DIR="${ALLOY_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$TARGET_DIR"
TARGET="$TARGET_DIR/alloy"

# Wrapper so we always launch via node with absolute paths (works even if
# the shebang env lookup is odd under nvm).
cat > "$TARGET" <<EOF
#!/usr/bin/env bash
exec node "$BIN_SRC" "\$@"
EOF
chmod +x "$TARGET"

echo "Installed: $TARGET"
echo "→ runs:    node $BIN_SRC"

# PATH check
case ":$PATH:" in
  *":$TARGET_DIR:"*) 
    echo "PATH already includes $TARGET_DIR"
    ;;
  *)
    echo ""
    echo "Add this to your shell rc (~/.bashrc or ~/.zshrc), then open a new terminal:"
    echo "  export PATH=\"$TARGET_DIR:\$PATH\""
    # Try to append once if bashrc exists and line missing
    RC="${HOME}/.bashrc"
    if [[ -f "$RC" ]] && ! grep -qF "$TARGET_DIR" "$RC" 2>/dev/null; then
      echo "" >> "$RC"
      echo "# Alloy CLI" >> "$RC"
      echo "export PATH=\"$TARGET_DIR:\$PATH\"" >> "$RC"
      echo "Appended PATH line to $RC — run: source $RC"
    fi
    ;;
esac

export PATH="$TARGET_DIR:$PATH"
hash -r 2>/dev/null || true
if command -v alloy >/dev/null 2>&1; then
  echo "OK: $(command -v alloy)"
  alloy --help 2>&1 | head -3 || true
else
  echo "alloy still not on PATH in this shell. Run:"
  echo "  export PATH=\"$TARGET_DIR:\$PATH\" && hash -r && which alloy"
fi
