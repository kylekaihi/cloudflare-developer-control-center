#!/usr/bin/env bash
set -euo pipefail

COMMAND="${1:-}"
if [[ -z "$COMMAND" ]]; then
  echo "Usage: $0 install|upgrade|healthcheck|rollback [--source DIR] [--env-source FILE]" >&2
  exit 64
fi
shift

SOURCE_DIR=""
ENV_SOURCE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE_DIR="${2:-}"; shift 2 ;;
    --env-source) ENV_SOURCE="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done

ROOT_PREFIX="${DCC_ROOT_PREFIX:-}"
APP_ROOT="${ROOT_PREFIX}/opt/developer-control-center"
RELEASES_DIR="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/status-api"
PREVIOUS_LINK="${APP_ROOT}/status-api.previous"
ENV_DIR="${ROOT_PREFIX}/etc/developer-control-center"
ENV_FILE="${ENV_DIR}/status-api.env"
UNIT_FILE="${ROOT_PREFIX}/etc/systemd/system/developer-control-center-status.service"
CONTROL_UNIT_FILE="${ROOT_PREFIX}/etc/systemd/system/developer-control-center-control.service"
SYSTEMCTL="${DCC_SYSTEMCTL:-systemctl}"
CURL="${DCC_CURL:-curl}"
NODE="${DCC_NODE:-node}"

if [[ -z "$ROOT_PREFIX" && "$(id -u)" -ne 0 ]]; then
  echo "Run as root (or set DCC_ROOT_PREFIX for an isolated test root)." >&2
  exit 77
fi

install_release() {
  require_source
  "$NODE" --check "${SOURCE_DIR}/server.mjs" >/dev/null
  "$NODE" --check "${SOURCE_DIR}/control-server.mjs" >/dev/null
  validate_environment_source

  local release_id release_dir old_current environment_input
  local changed="false"
  environment_input="$(environment_source_path)"
  release_id="$(release_hash "$environment_input")"
  release_dir="${RELEASES_DIR}/${release_id}"
  old_current="$(resolved_link "$CURRENT_LINK")"

  install -d -m 0755 "$APP_ROOT" "$RELEASES_DIR" "$(dirname "$UNIT_FILE")"
  install -d -m 0700 "$ENV_DIR"
  if [[ ! -d "$release_dir" ]]; then
    install -d -m 0755 "$release_dir"
    install -m 0644 "${SOURCE_DIR}/server.mjs" "${release_dir}/server.mjs"
    install -m 0644 "${SOURCE_DIR}/security.mjs" "${release_dir}/security.mjs"
    install -m 0644 "${SOURCE_DIR}/system-info.mjs" "${release_dir}/system-info.mjs"
    install -m 0644 "${SOURCE_DIR}/control-server.mjs" "${release_dir}/control-server.mjs"
    install -m 0644 "${SOURCE_DIR}/package.json" "${release_dir}/package.json"
    install -m 0644 "${SOURCE_DIR}/developer-control-center-status.service" "${release_dir}/developer-control-center-status.service"
    install -m 0644 "${SOURCE_DIR}/developer-control-center-control.service" "${release_dir}/developer-control-center-control.service"
    install -m 0600 "$environment_input" "${release_dir}/status-api.env"
  fi

  if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
    local legacy_dir
    legacy_dir="${RELEASES_DIR}/legacy-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$CURRENT_LINK" "$legacy_dir"
    install -m 0600 "$environment_input" "${legacy_dir}/status-api.env"
    old_current="$legacy_dir"
    echo "Preserved legacy installation at: $legacy_dir"
  fi

  validate_installed_environment "${release_dir}/status-api.env"
  install -m 0644 "${release_dir}/developer-control-center-status.service" "$UNIT_FILE"
  install -m 0644 "${release_dir}/developer-control-center-control.service" "$CONTROL_UNIT_FILE"

  if [[ "$old_current" != "$release_dir" ]]; then
    if [[ -n "$old_current" && -d "$old_current" ]]; then
      ln -sfn "$old_current" "$PREVIOUS_LINK"
    fi
    ln -sfn "$release_dir" "$CURRENT_LINK"
    changed="true"
  fi
  ln -sfn "${CURRENT_LINK}/status-api.env" "$ENV_FILE"

  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" enable developer-control-center-status.service >/dev/null
  "$SYSTEMCTL" enable developer-control-center-control.service >/dev/null
  "$SYSTEMCTL" restart developer-control-center-status.service
  "$SYSTEMCTL" restart developer-control-center-control.service
  if ! healthcheck; then
    echo "New release failed health checks." >&2
    if [[ -n "$old_current" && -d "$old_current" ]]; then
      ln -sfn "$old_current" "$CURRENT_LINK"
      if [[ -f "${old_current}/developer-control-center-status.service" ]]; then
        install -m 0644 "${old_current}/developer-control-center-status.service" "$UNIT_FILE"
        "$SYSTEMCTL" daemon-reload || true
      fi
      "$SYSTEMCTL" restart developer-control-center-status.service || true
      restore_control_unit "$old_current"
      healthcheck || true
      echo "Previous release restored: $old_current" >&2
    fi
    exit 1
  fi
  if [[ "$changed" == "true" ]]; then
    echo "status-api release active: $release_id"
  else
    echo "status-api release unchanged: $release_id"
  fi
}

rollback_release() {
  local current previous
  current="$(resolved_link "$CURRENT_LINK")"
  previous="$(resolved_link "$PREVIOUS_LINK")"
  if [[ -z "$previous" || ! -d "$previous" ]]; then
    echo "No previous status-api release is available." >&2
    exit 69
  fi
  ln -sfn "$previous" "$CURRENT_LINK"
  install -m 0644 "${previous}/developer-control-center-status.service" "$UNIT_FILE"
  restore_control_unit "$previous"
  if [[ -n "$current" && -d "$current" ]]; then
    ln -sfn "$current" "$PREVIOUS_LINK"
  fi
  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" restart developer-control-center-status.service
  if ! healthcheck; then
    if [[ -n "$current" && -d "$current" ]]; then
      ln -sfn "$current" "$CURRENT_LINK"
      install -m 0644 "${current}/developer-control-center-status.service" "$UNIT_FILE"
      "$SYSTEMCTL" daemon-reload || true
      "$SYSTEMCTL" restart developer-control-center-status.service || true
      restore_control_unit "$current"
    fi
    echo "Rollback target failed health checks; original release restored." >&2
    exit 1
  fi
  echo "status-api rolled back to: $(basename "$previous")"
}

healthcheck() {
  if [[ ! -L "$CURRENT_LINK" || ! -f "$ENV_FILE" ]]; then
    echo "status-api is not installed." >&2
    return 1
  fi
  local port control_port body attempt
  port="$(read_env_value STATUS_API_PORT "$ENV_FILE")"
  port="${port:-18787}"
  control_port="$(read_env_value CONTROL_API_PORT "$ENV_FILE")"
  control_port="${control_port:-18788}"
  for attempt in {1..10}; do
    body=""
    if "$SYSTEMCTL" is-active --quiet developer-control-center-status.service \
      && body="$("$CURL" --fail --silent --show-error --max-time 2 "http://127.0.0.1:${port}/healthz" 2>/dev/null)" \
      && [[ "$body" == *'"ok":true'* ]] \
      && "$SYSTEMCTL" is-active --quiet developer-control-center-control.service \
      && body="$("$CURL" --fail --silent --show-error --max-time 2 "http://127.0.0.1:${control_port}/healthz" 2>/dev/null)" \
      && [[ "$body" == *'"ok":true'* ]]; then
      echo "status-api healthy on 127.0.0.1:${port} ($(basename "$(resolved_link "$CURRENT_LINK")"))"
      return 0
    fi
    [[ "$attempt" -eq 10 ]] || sleep 1
  done
  echo "status-api did not become healthy on 127.0.0.1:${port}; last response: ${body:-<empty>}" >&2
  return 1
}

require_source() {
  if [[ -z "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
    echo "install/upgrade requires --source DIR." >&2
    exit 66
  fi
  for file in server.mjs security.mjs system-info.mjs control-server.mjs package.json developer-control-center-status.service developer-control-center-control.service; do
    [[ -f "${SOURCE_DIR}/${file}" ]] || { echo "Source is missing ${file}." >&2; exit 66; }
  done
}

validate_environment_source() {
  if [[ -n "$ENV_SOURCE" && ! -f "$ENV_SOURCE" ]]; then
    echo "Environment source does not exist: $ENV_SOURCE" >&2
    exit 66
  fi
}

validate_installed_environment() {
  local environment_file="$1"
  local token control_token port
  token="$(read_env_value STATUS_SERVICE_TOKEN "$environment_file")"
  port="$(read_env_value STATUS_API_PORT "$environment_file")"
  control_token="$(read_env_value VPS_CONTROL_TOKEN "$environment_file")"
  if [[ ${#token} -lt 32 ]]; then
    echo "STATUS_SERVICE_TOKEN in $environment_file must contain at least 32 characters." >&2
    exit 65
  fi
  if [[ ${#control_token} -lt 32 ]]; then
    echo "VPS_CONTROL_TOKEN in $environment_file must contain at least 32 characters." >&2
    exit 65
  fi
  if [[ ! "${port:-18787}" =~ ^[0-9]+$ ]] || (( ${port:-18787} < 1 || ${port:-18787} > 65535 )); then
    echo "STATUS_API_PORT in $ENV_FILE is invalid." >&2
    exit 65
  fi
}

release_hash() {
  local environment_input="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${SOURCE_DIR}/server.mjs" "${SOURCE_DIR}/security.mjs" "${SOURCE_DIR}/system-info.mjs" "${SOURCE_DIR}/control-server.mjs" "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/developer-control-center-status.service" "${SOURCE_DIR}/developer-control-center-control.service" "$environment_input" | awk '{print $1}' | sha256sum | cut -c1-16
  else
    shasum -a 256 "${SOURCE_DIR}/server.mjs" "${SOURCE_DIR}/security.mjs" "${SOURCE_DIR}/system-info.mjs" "${SOURCE_DIR}/control-server.mjs" "${SOURCE_DIR}/package.json" "${SOURCE_DIR}/developer-control-center-status.service" "${SOURCE_DIR}/developer-control-center-control.service" "$environment_input" | awk '{print $1}' | shasum -a 256 | cut -c1-16
  fi
}

restore_control_unit() {
  local release="$1"
  if [[ -f "${release}/developer-control-center-control.service" ]]; then
    install -m 0644 "${release}/developer-control-center-control.service" "$CONTROL_UNIT_FILE"
    "$SYSTEMCTL" daemon-reload || true
    "$SYSTEMCTL" enable developer-control-center-control.service >/dev/null 2>&1 || true
    "$SYSTEMCTL" restart developer-control-center-control.service || true
  else
    "$SYSTEMCTL" disable --now developer-control-center-control.service >/dev/null 2>&1 || true
    rm -f "$CONTROL_UNIT_FILE"
  fi
}

environment_source_path() {
  if [[ -n "$ENV_SOURCE" ]]; then
    printf '%s' "$ENV_SOURCE"
  elif [[ -f "$ENV_FILE" ]]; then
    readlink -f "$ENV_FILE" 2>/dev/null || printf '%s' "$ENV_FILE"
  else
    echo "First install requires --env-source FILE." >&2
    exit 65
  fi
}

resolved_link() {
  local path="$1"
  [[ -L "$path" ]] || return 0
  readlink -f "$path" 2>/dev/null || true
}

read_env_value() {
  local key="$1" file="$2" line
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

case "$COMMAND" in
  install|upgrade) install_release ;;
  healthcheck) healthcheck ;;
  rollback) rollback_release ;;
  *) echo "Unknown command: $COMMAND" >&2; exit 64 ;;
esac
