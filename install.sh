#!/usr/bin/env bash
# Alloy one-shot installer for Linux and macOS.
#
# Alloy is a generic harness. The default ALLOY_REPO below is only the current
# upstream hosting location — override freely for forks, mirrors, or a future
# public remote. Prefer cloning yourself, then running this script from the tree:
#
#   git clone <your-alloy-remote> ~/dev/alloy && bash ~/dev/alloy/install.sh
#
# Or (if the raw install.sh URL is published and reachable):
#
#   curl -fsSL <raw-url-to-install.sh> | bash
#
# Environment (optional):
#   ALLOY_DIR         Install location          (default: ~/dev/alloy)
#   ALLOY_REPO        Git remote (SSH)          (default: current upstream SSH URL)
#   ALLOY_REPO_HTTPS  Git remote (HTTPS)        (default: current upstream HTTPS URL)
#   ALLOY_BRANCH      Branch to use             (default: main)
#   ALLOY_NODE_MIN    Minimum Node major.minor  (default: 22.19 — Pi requirement)
#
set -euo pipefail

ALLOY_DIR="${ALLOY_DIR:-$HOME/dev/alloy}"
# Defaults = current upstream only; not a product dependency on any org stack.
ALLOY_REPO="${ALLOY_REPO:-git@gitlab.com:kylaira/infrastructure/alloy.git}"
ALLOY_REPO_HTTPS="${ALLOY_REPO_HTTPS:-https://gitlab.com/kylaira/infrastructure/alloy.git}"
ALLOY_BRANCH="${ALLOY_BRANCH:-main}"
ALLOY_NODE_MIN="${ALLOY_NODE_MIN:-22.19}"
log()  { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
err()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# OS check
# ---------------------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Linux|Darwin) ;;
  *) err "Unsupported OS: $OS (Linux and macOS only for now)" ;;
esac

# ---------------------------------------------------------------------------
# Prerequisites: git, node, npm
# ---------------------------------------------------------------------------
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || return 1
}

if ! need_cmd git; then
  err "git is required. Install git, then re-run this installer."
fi

node_meets_min() {
  # Compare installed Node to ALLOY_NODE_MIN (major or major.minor)
  node -e "
    const need = process.argv[1].split('.').map(Number);
    const have = process.versions.node.split('.').map(Number);
    const ok =
      have[0] > need[0] ||
      (have[0] === need[0] && (need[1] == null || have[1] > need[1] ||
        (have[1] === need[1] && (need[2] == null || have[2] >= (need[2] || 0)))));
    process.exit(ok ? 0 : 1);
  " "$ALLOY_NODE_MIN" 2>/dev/null
}

ensure_node() {
  if need_cmd node && need_cmd npm && node_meets_min; then
    log "Node $(node -v) / npm $(npm -v)"
    return 0
  fi

  if need_cmd node; then
    warn "Node $(node -v) is older than v${ALLOY_NODE_MIN}. Trying nvm upgrade path…"
  fi

  # Try loading nvm if present but not in PATH yet
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if need_cmd nvm || type nvm >/dev/null 2>&1; then
      nvm install 22 >/dev/null
      nvm use 22 >/dev/null
    fi
  fi

  if need_cmd node && need_cmd npm && node_meets_min; then
    log "Node $(node -v) / npm $(npm -v)"
    return 0
  fi

  err "Node.js ${ALLOY_NODE_MIN}+ is required (Pi coding-agent engines).
  Install options:
    • nvm:  https://github.com/nvm-sh/nvm
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            nvm install 22
            nvm use 22
    • Or install Node 22 LTS from https://nodejs.org/
  Then re-run this installer."
}

ensure_node

# ---------------------------------------------------------------------------
# Clone or update repo
# ---------------------------------------------------------------------------
clone_or_update() {
  local dir="$1"
  if [[ -d "$dir/.git" ]]; then
    log "Updating existing install at $dir (branch $ALLOY_BRANCH)…"
    git -C "$dir" fetch origin --tags --prune
    # Prefer ff-only onto the requested branch
    if git -C "$dir" rev-parse --verify "origin/$ALLOY_BRANCH" >/dev/null 2>&1; then
      git -C "$dir" checkout "$ALLOY_BRANCH" 2>/dev/null || git -C "$dir" checkout -B "$ALLOY_BRANCH" "origin/$ALLOY_BRANCH"
      # Fast-forward only — never reset --hard (would destroy local work)
      if ! git -C "$dir" pull --ff-only origin "$ALLOY_BRANCH"; then
        warn "git pull --ff-only failed (local commits or dirty tree)."
        warn "Leaving existing checkout unchanged. Resolve manually, then re-run."
        warn "  cd $dir && git status"
      fi
    else
      if ! git -C "$dir" pull --ff-only; then
        warn "git pull failed; using existing tree"
      fi
    fi
    return 0
  fi

  if [[ -e "$dir" && ! -d "$dir/.git" ]]; then
    err "$dir exists but is not an Alloy git checkout. Move it aside or set ALLOY_DIR."
  fi

  log "Cloning $ALLOY_REPO → $dir …"
  mkdir -p "$(dirname "$dir")"
  if git clone --branch "$ALLOY_BRANCH" --single-branch "$ALLOY_REPO" "$dir"; then
    return 0
  fi

  warn "SSH clone failed; trying HTTPS ($ALLOY_REPO_HTTPS)…"
  if git clone --branch "$ALLOY_BRANCH" --single-branch "$ALLOY_REPO_HTTPS" "$dir"; then
    return 0
  fi

  err "Could not clone Alloy repo.
  Ensure git SSH works:  ssh -T git@gitlab.com
  Or set ALLOY_REPO / ALLOY_REPO_HTTPS."
}

clone_or_update "$ALLOY_DIR"
cd "$ALLOY_DIR"

# If install.sh was invoked from an older copy, re-exec from the updated tree
# so we always run the latest install-cli.sh.
SELF_IN_TREE="$ALLOY_DIR/install.sh"
if [[ -f "$SELF_IN_TREE" && -f "$ALLOY_DIR/scripts/install-cli.sh" ]]; then
  :
else
  err "Checkout at $ALLOY_DIR is incomplete (missing install scripts)."
fi

# ---------------------------------------------------------------------------
# npm install + CLI
# ---------------------------------------------------------------------------
log "Installing npm dependencies…"
npm install

if [[ ! -f "$ALLOY_DIR/bin/alloy.mjs" ]]; then
  err "bin/alloy.mjs missing after clone. Repo may be corrupt."
fi

# Guard: restore JS launcher if a previous broken install clobbered it
if head -5 "$ALLOY_DIR/bin/alloy.mjs" | grep -q 'Generated by Alloy install-cli'; then
  warn "bin/alloy.mjs was corrupted; restoring from git…"
  git -C "$ALLOY_DIR" checkout -- bin/alloy.mjs
fi

chmod +x "$ALLOY_DIR/bin/alloy.mjs" "$ALLOY_DIR/scripts/install-cli.sh" 2>/dev/null || true

log "Installing alloy command onto PATH…"
bash "$ALLOY_DIR/scripts/install-cli.sh"

# Ensure current process can see alloy for final check
export PATH="${HOME}/.local/bin:$(dirname "$(command -v node)"):${PATH}"
hash -r 2>/dev/null || true

# ---------------------------------------------------------------------------
# Final verification
# ---------------------------------------------------------------------------
ALLOY_CMD="$(command -v alloy 2>/dev/null || true)"
if [[ -z "$ALLOY_CMD" ]]; then
  # Fall back to explicit paths the CLI installer uses
  for c in \
    "$(dirname "$(command -v node)")/alloy" \
    "$HOME/.local/bin/alloy" \
    "$ALLOY_DIR/bin/alloy.mjs"
  do
    if [[ -x "$c" ]]; then
      ALLOY_CMD="$c"
      break
    fi
  done
fi

[[ -n "${ALLOY_CMD:-}" ]] || err "alloy binary not found after install-cli."

log "Verifying: $ALLOY_CMD --help"
if ! "$ALLOY_CMD" --help >/dev/null 2>&1; then
  warn "alloy --help failed. Trying npm install once more…"
  npm install
  bash "$ALLOY_DIR/scripts/install-cli.sh"
  if ! "$ALLOY_CMD" --help >/dev/null 2>&1; then
    err "alloy installed but failed to start. Check: ls $ALLOY_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
  fi
fi

cat <<EOF

============================================================
  Alloy is ready
============================================================

  Install dir:  $ALLOY_DIR
  Command:      $ALLOY_CMD

  Start:
    alloy

  If a *new* terminal says "command not found":
    source ~/.local/share/alloy/env
    # or open a new login shell (PATH was added to bashrc/profile)

  First-run tips:
    /login          # Claude / Codex
    /login xai      # Grok
    /help
    Shift+Tab       # permission ask-levels
    /effort high    # thinking level

============================================================
EOF
