#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PLUGIN_SLUG="httpssCssZssZsgithubsDscomsZsfan249720142-droidsZsagy-quotasDswezterm"

AGY_PLUGIN_SRC="${SCRIPT_DIR}/agy-plugin"
AGY_PLUGIN_DST="${HOME}/.gemini/config/plugins/agy-quota-wezterm-bridge"

WEZTERM_PLUGINS_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/wezterm/plugins"
WEZTERM_PLUGIN_SRC="${SCRIPT_DIR}"
WEZTERM_PLUGIN_DST="${WEZTERM_PLUGINS_DIR}/${PLUGIN_SLUG}"

SETTINGS_JSON="${HOME}/.gemini/antigravity-cli/settings.json"

usage() {
  cat <<'EOF'
Usage: install.sh [--uninstall] [-h|--help]

Install (default) or uninstall local symlinks for agy-quota.wezterm:
  1. agy-plugin -> ~/.gemini/config/plugins/agy-quota-wezterm-bridge
  2. repo root  -> ~/.local/share/wezterm/plugins/httpssCssZssZsgithubsDscomsZsfan249720142-droidsZsagy-quotasDswezterm

This script never modifies ~/.gemini/antigravity-cli/settings.json (statusLine remains untouched).
EOF
}

link_idempotent() {
  local src="$1"
  local dst="$2"

  if [[ ! -e "$src" ]]; then
    echo "[ERROR] Source path does not exist: $src" >&2
    return 1
  fi

  mkdir -p "$(dirname "$dst")"

  if [[ -L "$dst" ]]; then
    local cur_target real_src real_dst
    cur_target="$(readlink "$dst")"
    real_src="$(readlink -f "$src" 2>/dev/null || printf '%s' "$src")"
    real_dst="$(readlink -f "$dst" 2>/dev/null || printf '%s' "$cur_target")"
    if [[ "$cur_target" == "$src" || "$real_dst" == "$real_src" ]]; then
      echo "[OK] Already linked: $dst -> $cur_target"
      return 0
    fi
    ln -sfn "$src" "$dst"
    echo "[UPDATED] Relinked: $dst -> $src (was $cur_target)"
    return 0
  fi

  if [[ -e "$dst" ]]; then
    echo "[ERROR] Refusing to overwrite existing non-symlink path: $dst" >&2
    return 1
  fi

  ln -s "$src" "$dst"
  echo "[OK] Linked: $dst -> $src"
}

unlink_idempotent() {
  local src="$1"
  local dst="$2"

  if [[ -L "$dst" ]]; then
    local cur_target real_src real_dst
    cur_target="$(readlink "$dst")"
    real_src="$(readlink -f "$src" 2>/dev/null || printf '%s' "$src")"
    real_dst="$(readlink -f "$dst" 2>/dev/null || printf '%s' "$cur_target")"
    if [[ "$cur_target" == "$src" || "$real_dst" == "$real_src" ]]; then
      rm -f "$dst"
      echo "[OK] Removed symlink: $dst"
    else
      echo "[WARN] Skipping $dst (points to $cur_target, expected $src)"
    fi
    return 0
  fi

  if [[ -e "$dst" ]]; then
    echo "[WARN] Skipping non-symlink path: $dst"
    return 0
  fi

  echo "[OK] Already absent: $dst"
}

find_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  if [[ -x "${HOME}/.local/bin/${name}" ]]; then
    printf '%s\n' "${HOME}/.local/bin/${name}"
    return 0
  fi
  return 1
}

verify_settings_json_readonly() {
  if [[ ! -f "$SETTINGS_JSON" ]]; then
    echo "[INFO] ${SETTINGS_JSON} not found (not created or modified)."
    return 0
  fi

  local node_bin=""
  local status_line_state="unknown"
  if node_bin="$(find_bin node 2>/dev/null)"; then
    status_line_state="$("$node_bin" -e '
      const fs = require("fs");
      try {
        const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        if (Object.prototype.hasOwnProperty.call(data, "statusLine")) {
          const val = data.statusLine;
          const kind = val === null ? "null" : typeof val;
          console.log("present (" + kind + ")");
        } else {
          console.log("absent");
        }
      } catch (e) {
        console.log("unreadable");
      }
    ' "$SETTINGS_JSON")"
  elif grep -q '"statusLine"' "$SETTINGS_JSON" 2>/dev/null; then
    status_line_state="present"
  else
    status_line_state="absent"
  fi

  echo "[OK] settings.json verified read-only (never modified): ${SETTINGS_JSON}"
  echo "     statusLine state: ${status_line_state} (coexistence preserved)"
}

check_environment() {
  local node_bin="" wezterm_bin="" agy_bin=""
  if node_bin="$(find_bin node 2>/dev/null)"; then
    echo "[OK] node: ${node_bin} ($("$node_bin" --version 2>/dev/null || echo 'unknown'))"
  else
    echo "[WARN] node not found in PATH or ~/.local/bin"
  fi

  if wezterm_bin="$(find_bin wezterm 2>/dev/null)"; then
    echo "[OK] wezterm: ${wezterm_bin} ($("$wezterm_bin" --version 2>/dev/null || echo 'unknown'))"
  else
    echo "[WARN] wezterm not found in PATH or ~/.local/bin"
  fi

  if agy_bin="$(find_bin agy 2>/dev/null)"; then
    echo "[OK] agy: ${agy_bin}"
    if "$agy_bin" plugin list 2>/dev/null | grep -q "agy-quota-wezterm-bridge"; then
      echo "[OK] agy plugin list detected: agy-quota-wezterm-bridge"
    else
      echo "[INFO] Run '${agy_bin} plugin list' to confirm plugin registration."
    fi
  else
    echo "[WARN] agy CLI not found in PATH or ~/.local/bin"
  fi
}

main() {
  local mode="install"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --uninstall)
        mode="uninstall"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "[ERROR] Unknown option: $1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  if [[ "$mode" == "uninstall" ]]; then
    echo "=== Uninstalling agy-quota.wezterm symlinks ==="
    unlink_idempotent "$AGY_PLUGIN_SRC" "$AGY_PLUGIN_DST"
    unlink_idempotent "$WEZTERM_PLUGIN_SRC" "$WEZTERM_PLUGIN_DST"
    verify_settings_json_readonly
    echo "=== Uninstall complete ==="
    return 0
  fi

  echo "=== Installing agy-quota.wezterm ==="
  link_idempotent "$AGY_PLUGIN_SRC" "$AGY_PLUGIN_DST"
  link_idempotent "$WEZTERM_PLUGIN_SRC" "$WEZTERM_PLUGIN_DST"
  verify_settings_json_readonly
  check_environment
  echo "=== Install complete ==="
}

main "$@"
