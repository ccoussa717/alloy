#!/usr/bin/env bash
# Install Alloy, bundled Pi, and a supported Node.js runtime on Linux or macOS.
set -euo pipefail

ALLOY_NODE_MIN="22.19"
ALLOY_NODE_VERSION="22.19.0"
ALLOY_REF="${ALLOY_REF:-main}"
ALLOY_PREFIX="${ALLOY_PREFIX:-$HOME/.local}"
ALLOY_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/alloy"
ALLOY_APP_ROOT="$ALLOY_DATA_HOME/app"
ALLOY_NODE_ROOT=""
ALLOY_REPOSITORY="ccoussa717/alloy"
ALLOY_SOURCE_URL=""
ENV_FILE="$HOME/.config/alloy/env"

NODE_TEMP_DIR=""
SOURCE_TEMP_DIR=""
INSTALL_COMMITTED=0
APP_TRANSACTION=0
APP_HAD_PREVIOUS=0
BIN_TRANSACTION=0
BIN_HAD_PREVIOUS=0
ENV_TRANSACTION=0
ENV_HAD_PREVIOUS=0
NODE_TRANSACTION=0
NODE_HAD_PREVIOUS=0
PREVIOUS_APP=""
PREVIOUS_BIN=""
PREVIOUS_ENV=""
STAGED_APP=""
NODE_STAGED=""
NODE_PREVIOUS=""
TEMP_BIN=""
TEMP_ENV=""
LOCK_DIR="$HOME/.config/alloy/install.lock"
LOCK_HELD=0
CLEANUP_FAILED=0

log() { printf '==> %s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; exit 1; }
exists_or_link() { [[ -e "$1" || -L "$1" ]]; }
cleanup_try() {
  "$@" || {
    printf 'warning: installer cleanup failed: %s\n' "$*" >&2
    CLEANUP_FAILED=1
  }
}
cleanup() {
  local original_status=$?
  trap - EXIT
  set +e
  if [[ "$INSTALL_COMMITTED" -eq 0 ]]; then
    if [[ "$ENV_TRANSACTION" -eq 1 ]] && exists_or_link "$PREVIOUS_ENV"; then
      cleanup_try rm -f "$ENV_FILE"
      cleanup_try mv "$PREVIOUS_ENV" "$ENV_FILE"
    elif [[ "$ENV_TRANSACTION" -eq 1 && "$ENV_HAD_PREVIOUS" -eq 0 ]]; then
      cleanup_try rm -f "$ENV_FILE"
    fi
    if [[ "$BIN_TRANSACTION" -eq 1 ]] && exists_or_link "$PREVIOUS_BIN"; then
      cleanup_try rm -f "$ALLOY_PREFIX/bin/alloy"
      cleanup_try mv "$PREVIOUS_BIN" "$ALLOY_PREFIX/bin/alloy"
    elif [[ "$BIN_TRANSACTION" -eq 1 && "$BIN_HAD_PREVIOUS" -eq 0 ]]; then
      cleanup_try rm -f "$ALLOY_PREFIX/bin/alloy"
    fi
    if [[ "$APP_TRANSACTION" -eq 1 && -e "$PREVIOUS_APP" ]]; then
      cleanup_try rm -rf "$ALLOY_APP_ROOT"
      cleanup_try mv "$PREVIOUS_APP" "$ALLOY_APP_ROOT"
    elif [[ "$APP_TRANSACTION" -eq 1 && "$APP_HAD_PREVIOUS" -eq 0 ]]; then
      cleanup_try rm -rf "$ALLOY_APP_ROOT"
    fi
  else
    [[ -z "$PREVIOUS_APP" || ! -e "$PREVIOUS_APP" ]] || cleanup_try rm -rf "$PREVIOUS_APP"
    [[ -z "$PREVIOUS_BIN" ]] || ! exists_or_link "$PREVIOUS_BIN" || cleanup_try rm -f "$PREVIOUS_BIN"
    [[ -z "$PREVIOUS_ENV" ]] || ! exists_or_link "$PREVIOUS_ENV" || cleanup_try rm -f "$PREVIOUS_ENV"
  fi
  if [[ "$INSTALL_COMMITTED" -eq 0 ]]; then
    if [[ "$NODE_TRANSACTION" -eq 1 && -e "$NODE_PREVIOUS" ]]; then
      cleanup_try rm -rf "$ALLOY_NODE_ROOT"
      cleanup_try mv "$NODE_PREVIOUS" "$ALLOY_NODE_ROOT"
    elif [[ "$NODE_TRANSACTION" -eq 1 && "$NODE_HAD_PREVIOUS" -eq 0 ]]; then
      cleanup_try rm -rf "$ALLOY_NODE_ROOT"
    fi
  else
    [[ -z "$NODE_PREVIOUS" || ! -e "$NODE_PREVIOUS" ]] || cleanup_try rm -rf "$NODE_PREVIOUS"
  fi
  [[ -z "$TEMP_BIN" || ! -e "$TEMP_BIN" ]] || cleanup_try rm -f "$TEMP_BIN"
  [[ -z "$TEMP_ENV" || ! -e "$TEMP_ENV" ]] || cleanup_try rm -f "$TEMP_ENV"
  [[ -z "$STAGED_APP" || ! -e "$STAGED_APP" ]] || cleanup_try rm -rf "$STAGED_APP"
  [[ -z "$NODE_STAGED" || ! -e "$NODE_STAGED" ]] || cleanup_try rm -rf "$NODE_STAGED"
  [[ -z "$NODE_TEMP_DIR" || ! -d "$NODE_TEMP_DIR" ]] || cleanup_try rm -rf "$NODE_TEMP_DIR"
  [[ -z "$SOURCE_TEMP_DIR" || ! -d "$SOURCE_TEMP_DIR" ]] || cleanup_try rm -rf "$SOURCE_TEMP_DIR"
  if [[ "$LOCK_HELD" -eq 1 ]]; then
    cleanup_try rm -f "$LOCK_DIR/pid"
    cleanup_try rmdir "$LOCK_DIR"
  fi
  if [[ "$original_status" -ne 0 ]]; then
    exit "$original_status"
  fi
  [[ "$CLEANUP_FAILED" -eq 0 ]] || exit 1
  exit 0
}
trap cleanup EXIT

case "$(uname -s 2>/dev/null || true)" in
  Linux|Darwin) ;;
  *) err "Alloy currently supports Linux and macOS" ;;
esac

case "$ALLOY_REF" in
  *[!A-Za-z0-9._/-]*|*..*|/*|*//*) err "ALLOY_REF contains unsafe characters" ;;
esac

for path in "$ALLOY_PREFIX" "$ALLOY_DATA_HOME" "$ENV_FILE"; do
  case "$path" in
    *$'\n'*|*$'\r'*|*:*) err "Alloy install paths cannot contain colons or newlines" ;;
    /*) ;;
    *) err "Alloy install paths must be absolute" ;;
  esac
done

mkdir -p "$(dirname "$LOCK_DIR")"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  err "another Alloy installer is active; if not, remove stale lock: $LOCK_DIR"
fi
LOCK_HELD=1
printf '%s\n' "$$" > "$LOCK_DIR/pid"

node_supported() {
  command -v node >/dev/null 2>&1 &&
    command -v npm >/dev/null 2>&1 &&
    node -e '
      const need = process.argv[1].split(".").map(Number);
      const have = process.versions.node.split(".").map(Number);
      const ok = have[0] > need[0] ||
        (have[0] === need[0] && have[1] >= need[1]);
      process.exit(ok ? 0 : 1);
    ' "$ALLOY_NODE_MIN" </dev/null
}

sha256() {
  local output
  if [[ "$(uname -s)" == "Darwin" ]] && command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 "$1")"
  elif command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum "$1")"
  elif command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 "$1")"
  else
    err "sha256sum or shasum is required to verify Node.js"
  fi
  printf '%s\n' "${output%% *}"
}

node_artifact() {
  local os arch libc_output
  case "$(uname -s)" in
    Linux)
      os="linux"
      libc_output=""
      if command -v ldd >/dev/null 2>&1; then
        libc_output="$(ldd --version 2>&1 || true)"
      fi
      if [[ -e /etc/alpine-release || "$libc_output" == *musl* ]] ||
        compgen -G '/lib/ld-musl-*.so.1' >/dev/null; then
        err "automatic Node.js bootstrap does not support musl; install Node.js ${ALLOY_NODE_MIN}+ first"
      fi
      ;;
    Darwin) os="darwin" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    armv7l)
      [[ "$os" == "linux" ]] || err "Node.js does not publish macOS armv7 builds"
      arch="armv7l"
      ;;
    *) err "automatic Node.js bootstrap does not support $(uname -m); install Node.js ${ALLOY_NODE_MIN}+ first" ;;
  esac

  NODE_PLATFORM="$os-$arch"
  NODE_ARCHIVE="node-v${ALLOY_NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
  case "$NODE_PLATFORM" in
    linux-x64) NODE_SHA256="d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d" ;;
    linux-arm64) NODE_SHA256="d32817b937219b8f131a28546035183d79e7fd17a86e38ccb8772901a7cd9009" ;;
    linux-armv7l) NODE_SHA256="969037e6da2a710904d121dcb998510bc0d5d4d61d70ce5eb578096cf36c60e8" ;;
    darwin-x64) NODE_SHA256="3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c" ;;
    darwin-arm64) NODE_SHA256="c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d" ;;
  esac
  ALLOY_NODE_ROOT="$ALLOY_DATA_HOME/node-v${ALLOY_NODE_VERSION}-${NODE_PLATFORM}"
}

install_node() {
  node_artifact
  [[ ! -L "$ALLOY_NODE_ROOT" ]] || err "refusing to replace symlink at $ALLOY_NODE_ROOT"
  [[ ! -e "$ALLOY_NODE_ROOT" || -d "$ALLOY_NODE_ROOT" ]] ||
    err "refusing to replace non-directory at $ALLOY_NODE_ROOT"
  if [[ -x "$ALLOY_NODE_ROOT/bin/node" && -x "$ALLOY_NODE_ROOT/bin/npm" ]]; then
    export PATH="$ALLOY_NODE_ROOT/bin:$PATH"
    if node_supported; then
      return
    fi
  fi

  command -v curl >/dev/null 2>&1 || err "curl is required to install Node.js"
  command -v tar >/dev/null 2>&1 || err "tar is required to install Node.js"

  NODE_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alloy-node.XXXXXX")"
  local archive="$NODE_TEMP_DIR/$NODE_ARCHIVE"
  local url="https://nodejs.org/dist/v${ALLOY_NODE_VERSION}/${NODE_ARCHIVE}"

  log "Installing Node.js v${ALLOY_NODE_VERSION} in $ALLOY_NODE_ROOT"
  curl -fsSL --retry 3 -o "$archive" "$url" </dev/null
  [[ "$(sha256 "$archive")" == "$NODE_SHA256" ]] || err "Node.js archive checksum mismatch"
  tar -xzf "$archive" -C "$NODE_TEMP_DIR" </dev/null

  local extracted="$NODE_TEMP_DIR/node-v${ALLOY_NODE_VERSION}-${NODE_PLATFORM}"
  [[ -x "$extracted/bin/node" && -x "$extracted/bin/npm" ]] ||
    err "Node.js archive did not contain the expected runtime"
  "$extracted/bin/node" -e '
    const need = process.argv[1].split(".").map(Number);
    const have = process.versions.node.split(".").map(Number);
    const ok = have[0] > need[0] ||
      (have[0] === need[0] && have[1] >= need[1]);
    process.exit(ok ? 0 : 1);
  ' "$ALLOY_NODE_MIN" </dev/null || err "downloaded Node.js runtime cannot run on this system"

  mkdir -p "$(dirname "$ALLOY_NODE_ROOT")"
  NODE_STAGED="${ALLOY_NODE_ROOT}.new.$$"
  NODE_PREVIOUS="${ALLOY_NODE_ROOT}.previous.$$"
  [[ ! -e "$NODE_STAGED" && ! -e "$NODE_PREVIOUS" ]] || err "stale Node.js installer state exists"
  NODE_HAD_PREVIOUS=0
  [[ ! -e "$ALLOY_NODE_ROOT" ]] || NODE_HAD_PREVIOUS=1
  NODE_TRANSACTION=1
  mv "$extracted" "$NODE_STAGED"
  [[ "$NODE_HAD_PREVIOUS" -eq 0 ]] || mv "$ALLOY_NODE_ROOT" "$NODE_PREVIOUS"
  if ! mv "$NODE_STAGED" "$ALLOY_NODE_ROOT"; then
    [[ ! -e "$NODE_PREVIOUS" ]] || mv "$NODE_PREVIOUS" "$ALLOY_NODE_ROOT"
    err "could not install Node.js in $ALLOY_NODE_ROOT"
  fi

  export PATH="$ALLOY_NODE_ROOT/bin:$PATH"
  node_supported || err "installed Node.js does not satisfy ${ALLOY_NODE_MIN}+"
  log "Installed Node.js v${ALLOY_NODE_VERSION}"
}

if ! node_supported; then
  install_node
fi

command -v curl >/dev/null 2>&1 || err "curl is required to install Alloy"
command -v tar >/dev/null 2>&1 || err "tar is required to install Alloy"

if [[ "$ALLOY_REF" == "main" ]]; then
  log "Resolving Alloy main to one commit"
  ALLOY_REF="$(
    curl -fsSL --retry 3 \
      -H 'Accept: application/vnd.github+json' \
      -H 'User-Agent: alloy-installer' \
      "https://api.github.com/repos/${ALLOY_REPOSITORY}/commits/main" </dev/null |
      node -e '
        const fs = require("node:fs");
        const response = JSON.parse(fs.readFileSync(0, "utf8"));
        if (!/^[0-9a-f]{40}$/.test(response.sha || "")) process.exit(1);
        process.stdout.write(response.sha);
      '
  )" || err "could not resolve Alloy main to a commit"
fi
ALLOY_SOURCE_URL="https://codeload.github.com/${ALLOY_REPOSITORY}/tar.gz/${ALLOY_REF}"

SOURCE_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/alloy-source.XXXXXX")"
SOURCE_ARCHIVE="$SOURCE_TEMP_DIR/alloy-source.tar.gz"
SOURCE_DIR="$SOURCE_TEMP_DIR/source"
mkdir -p "$SOURCE_DIR"

log "Downloading Alloy source ref ${ALLOY_REF}"
curl -fsSL --retry 3 -o "$SOURCE_ARCHIVE" "$ALLOY_SOURCE_URL" </dev/null
tar -xzf "$SOURCE_ARCHIVE" -C "$SOURCE_DIR" --strip-components=1 </dev/null

[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/npm-shrinkwrap.json" ]] ||
  err "Alloy source archive is missing package metadata"
node -e '
  const pkg = require(process.argv[1]);
  const repository = typeof pkg.repository === "string"
    ? pkg.repository
    : pkg.repository?.url;
  const canonical = new Set([
    "git+https://github.com/ccoussa717/alloy.git",
    "https://github.com/ccoussa717/alloy.git",
    "https://github.com/ccoussa717/alloy",
  ]);
  if (pkg.name !== "alloy-agent" || !canonical.has(repository)) process.exit(1);
' "$SOURCE_DIR/package.json" </dev/null || err "Alloy source archive has an unexpected package identity"

for resource in \
  "$SOURCE_DIR/bin/alloy.mjs" \
  "$SOURCE_DIR/extensions/index.ts" \
  "$SOURCE_DIR/themes/alloy-dark.json"; do
  [[ -f "$resource" ]] || err "Alloy source archive is missing required runtime resources"
done
for resource in "$SOURCE_DIR/skills" "$SOURCE_DIR/prompts"; do
  [[ -d "$resource" ]] || err "Alloy source archive is missing required runtime resources"
done

log "Installing exact shrinkwrapped dependencies"
(
  cd "$SOURCE_DIR"
  npm ci --ignore-scripts --no-audit --no-fund </dev/null
)

PI_CLI="$SOURCE_DIR/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
[[ -f "$PI_CLI" ]] || err "npm ci did not install Alloy's bundled Pi runtime"

VERSION_OUTPUT="$(node "$SOURCE_DIR/bin/alloy.mjs" --version </dev/null)"
[[ "$VERSION_OUTPUT" == *$'\nPi    '* && "$VERSION_OUTPUT" != *"(not found"* ]] ||
  err "Alloy could not resolve its bundled Pi runtime"
node "$SOURCE_DIR/bin/alloy.mjs" --list-models </dev/null >/dev/null

shell_quote() {
  local value="$1"
  value=${value//\'/\'\\\'\'}
  printf "'%s'" "$value"
}

ALLOY_BIN="$ALLOY_PREFIX/bin/alloy"
ENV_DIR="$(dirname "$ENV_FILE")"
mkdir -p "$(dirname "$ALLOY_APP_ROOT")" "$ALLOY_PREFIX/bin" "$ENV_DIR"

[[ ! -L "$ALLOY_APP_ROOT" ]] || err "refusing to replace symlink at $ALLOY_APP_ROOT"
[[ ! -e "$ALLOY_APP_ROOT" || -d "$ALLOY_APP_ROOT" ]] ||
  err "refusing to replace non-directory at $ALLOY_APP_ROOT"
[[ ! -L "$ALLOY_BIN" ]] || err "refusing to replace symlink at $ALLOY_BIN"
if [[ -e "$ALLOY_BIN" ]]; then
  grep -Eq "Generated by Alloy (install-cli\.sh|install\.sh)" "$ALLOY_BIN" 2>/dev/null ||
    err "refusing to replace unrelated file at $ALLOY_BIN"
fi
[[ ! -L "$ENV_FILE" ]] || err "refusing to replace symlink at $ENV_FILE"
[[ ! -e "$ENV_FILE" || -f "$ENV_FILE" ]] ||
  err "refusing to replace non-file at $ENV_FILE"

SHELL_FILES=("$HOME/.profile" "$HOME/.bashrc" "${ZDOTDIR:-$HOME}/.zshrc")
[[ ! -f "$HOME/.bash_profile" ]] || SHELL_FILES+=("$HOME/.bash_profile")
[[ ! -f "$HOME/.bash_login" ]] || SHELL_FILES+=("$HOME/.bash_login")

NODE_EXECUTABLE="$(cd "$(dirname "$(command -v node)")" && pwd -P)/$(basename "$(command -v node)")"
TEMP_BIN="$(mktemp "$ALLOY_PREFIX/bin/.alloy.XXXXXX")"
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' '# Generated by Alloy install.sh; do not edit.'
  printf 'exec %s %s "$@"\n' \
    "$(shell_quote "$NODE_EXECUTABLE")" \
    "$(shell_quote "$ALLOY_APP_ROOT/bin/alloy.mjs")"
} > "$TEMP_BIN"
chmod 755 "$TEMP_BIN"

TEMP_ENV="$(mktemp "$ENV_DIR/.env.XXXXXX")"
{
  printf '%s\n' '# Generated by the Alloy installer.'
  printf '%s\n' '_alloy_path_prepend() {'
  printf '%s\n' '  case "$PATH" in "$1"|"$1":*) ;; *) PATH="$1:$PATH" ;; esac'
  printf '%s\n' '}'
  printf '_alloy_path_prepend %s\n' "$(shell_quote "$ALLOY_PREFIX/bin")"
  printf '%s\n' 'export PATH'
  printf '%s\n' 'unset -f _alloy_path_prepend 2>/dev/null || unset _alloy_path_prepend'
} > "$TEMP_ENV"
chmod 600 "$TEMP_ENV"

ensure_shell_env() {
  local file="$1"
  local content=""
  local directory
  local rewritten
  local line="[ -f $(shell_quote "$ENV_FILE") ] && . $(shell_quote "$ENV_FILE")"
  directory="$(dirname "$file")"
  mkdir -p "$directory" || return 1
  [[ ! -L "$file" ]] || return 1
  [[ ! -e "$file" || -f "$file" ]] || return 1
  [[ ! -e "$file" || -w "$file" ]] || return 1

  rewritten="$(mktemp "$directory/.alloy-rc.XXXXXX")" || return 1
  if [[ -f "$file" ]]; then
    cp -p "$file" "$rewritten" || {
      rm -f "$rewritten"
      return 1
    }
    content="$(mktemp "$directory/.alloy-rc-content.XXXXXX")" || {
      rm -f "$rewritten"
      return 1
    }
    awk '
      skip_export {
        skip_export = 0
        if ($0 ~ /^export PATH=/) next
      }
      /^# Alloy CLI .*ensure .*local\/bin/ {
        skip_export = 1
        next
      }
      { print }
    ' "$file" > "$content" || {
      rm -f "$rewritten" "$content"
      return 1
    }
    command cat "$content" > "$rewritten" || {
      rm -f "$rewritten" "$content"
      return 1
    }
    rm -f "$content"
    content=""
  else
    chmod 600 "$rewritten" || {
      rm -f "$rewritten"
      return 1
    }
  fi

  if ! grep -Fqx "$line" "$rewritten" 2>/dev/null; then
    printf '\n%s\n%s\n' '# Alloy CLI' "$line" >> "$rewritten" || {
      rm -f "$rewritten"
      return 1
    }
  fi
  mv -f "$rewritten" "$file" || {
    rm -f "$rewritten"
    return 1
  }
}

STAGED_APP="${ALLOY_APP_ROOT}.new.$$"
PREVIOUS_APP="${ALLOY_APP_ROOT}.previous.$$"
PREVIOUS_BIN="$ALLOY_PREFIX/bin/.alloy.previous.$$"
PREVIOUS_ENV="$ENV_DIR/.env.previous.$$"
[[ ! -e "$STAGED_APP" && ! -e "$PREVIOUS_APP" && ! -e "$PREVIOUS_BIN" && ! -e "$PREVIOUS_ENV" ]] ||
  err "stale Alloy installer state exists"

APP_HAD_PREVIOUS=0
exists_or_link "$ALLOY_APP_ROOT" && APP_HAD_PREVIOUS=1
APP_TRANSACTION=1
mv "$SOURCE_DIR" "$STAGED_APP"
[[ "$APP_HAD_PREVIOUS" -eq 0 ]] || mv "$ALLOY_APP_ROOT" "$PREVIOUS_APP"
if ! mv "$STAGED_APP" "$ALLOY_APP_ROOT"; then
  [[ ! -e "$PREVIOUS_APP" ]] || mv "$PREVIOUS_APP" "$ALLOY_APP_ROOT"
  err "could not install Alloy in $ALLOY_APP_ROOT"
fi

BIN_HAD_PREVIOUS=0
exists_or_link "$ALLOY_BIN" && BIN_HAD_PREVIOUS=1
BIN_TRANSACTION=1
[[ "$BIN_HAD_PREVIOUS" -eq 0 ]] || mv "$ALLOY_BIN" "$PREVIOUS_BIN"
if ! mv "$TEMP_BIN" "$ALLOY_BIN"; then
  exists_or_link "$PREVIOUS_BIN" && mv "$PREVIOUS_BIN" "$ALLOY_BIN"
  err "could not install Alloy command at $ALLOY_BIN"
fi
TEMP_BIN=""

ENV_HAD_PREVIOUS=0
exists_or_link "$ENV_FILE" && ENV_HAD_PREVIOUS=1
ENV_TRANSACTION=1
[[ "$ENV_HAD_PREVIOUS" -eq 0 ]] || mv "$ENV_FILE" "$PREVIOUS_ENV"
if ! mv "$TEMP_ENV" "$ENV_FILE"; then
  exists_or_link "$PREVIOUS_ENV" && mv "$PREVIOUS_ENV" "$ENV_FILE"
  err "could not install Alloy environment at $ENV_FILE"
fi
TEMP_ENV=""

export PATH="$ALLOY_PREFIX/bin:$PATH"
hash -r 2>/dev/null || true
FINAL_VERSION_OUTPUT="$("$ALLOY_BIN" --version </dev/null)"
[[ "$FINAL_VERSION_OUTPUT" == *$'\nPi    '* && "$FINAL_VERSION_OUTPUT" != *"(not found"* ]] ||
  err "installed Alloy command could not resolve bundled Pi"
"$ALLOY_BIN" --list-models </dev/null >/dev/null

INSTALL_COMMITTED=1

for file in "${SHELL_FILES[@]}"; do
  if ! ensure_shell_env "$file"; then
    log "Warning: could not update $file; add $ALLOY_PREFIX/bin to PATH manually"
  fi
done

LEGACY_ENV="$ALLOY_DATA_HOME/env"
if [[ -f "$LEGACY_ENV" && ! -L "$LEGACY_ENV" ]] &&
  grep -q "Generated by Alloy install-cli.sh" "$LEGACY_ENV" 2>/dev/null; then
  rm -f "$LEGACY_ENV"
fi

printf '%s\n' "$FINAL_VERSION_OUTPUT"

log "Alloy is ready at $ALLOY_BIN"
log "Bash/Zsh: restart your shell, then run: alloy"
log "Other shells: add $ALLOY_PREFIX/bin to PATH or run: $ALLOY_BIN"
