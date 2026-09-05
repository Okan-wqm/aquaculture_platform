#!/usr/bin/env bash
# Assemble a secret-safe stdin payload for the protected production SSH helper.
# The payload carries an exact-SHA runtime bundle, the independently hashed
# host-control executable, a bounded environment allowlist, and argv. Nothing
# is interpolated into executable remote shell syntax.

set +x
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin
export LC_ALL=C
unset BASH_ENV ENV CDPATH GLOBIGNORE GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE GIT_COMMON_DIR

: "${PRODUCTION_HOST_BUNDLE_PATH:?PRODUCTION_HOST_BUNDLE_PATH required}"
: "${PRODUCTION_HOST_BUNDLE_SHA256:?PRODUCTION_HOST_BUNDLE_SHA256 required}"
: "${PRODUCTION_HOST_MAIN_SHA:?PRODUCTION_HOST_MAIN_SHA required}"
: "${PRODUCTION_HOST_REMOTE_MODE:?PRODUCTION_HOST_REMOTE_MODE required}"
: "${PRODUCTION_HOST_REMOTE_ENTRYPOINT:?PRODUCTION_HOST_REMOTE_ENTRYPOINT required}"
: "${PRODUCTION_HOST_REMOTE_ENV_PATH:?PRODUCTION_HOST_REMOTE_ENV_PATH required}"
: "${PRODUCTION_HOST_REMOTE_ARGV_PATH:?PRODUCTION_HOST_REMOTE_ARGV_PATH required}"
: "${SSH_PAYLOAD_PATH:?SSH_PAYLOAD_PATH required}"

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [ -n "${PRODUCTION_HOST_REPO_ROOT:-}" ]; then
  case "${PRODUCTION_HOST_REPO_ROOT}" in
    /*) ;;
    *) die 'PRODUCTION_HOST_REPO_ROOT must be absolute.' ;;
  esac
  [ -d "${PRODUCTION_HOST_REPO_ROOT}" ] && [ ! -L "${PRODUCTION_HOST_REPO_ROOT}" ] || \
    die 'PRODUCTION_HOST_REPO_ROOT must be a real directory.'
  REPO_ROOT=$(cd -- "${PRODUCTION_HOST_REPO_ROOT}" && pwd -P)
  [ "${REPO_ROOT}" = "${PRODUCTION_HOST_REPO_ROOT}" ] || \
    die 'PRODUCTION_HOST_REPO_ROOT must be canonical.'
else
  REPO_ROOT=$(cd -- "${SCRIPT_DIR}/../../.." && pwd -P)
fi
CONTROL_HELPER_PATH=''

require_regular_file() {
  local path="$1"
  local label="$2"

  [ -f "${path}" ] && [ ! -L "${path}" ] || \
    die "${label} must be a regular non-symlink file."
}

[[ "${PRODUCTION_HOST_BUNDLE_PATH}" = /* ]] || die 'bundle path must be absolute.'
[[ "${PRODUCTION_HOST_REMOTE_ENV_PATH}" = /* ]] || die 'remote env path must be absolute.'
[[ "${PRODUCTION_HOST_REMOTE_ARGV_PATH}" = /* ]] || die 'remote argv path must be absolute.'
[[ "${SSH_PAYLOAD_PATH}" = /* ]] || die 'SSH payload path must be absolute.'
[[ "${PRODUCTION_HOST_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || \
  die 'bundle SHA-256 must be lowercase hex.'
[[ "${PRODUCTION_HOST_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]] || \
  die 'main SHA must be lowercase 40-hex.'
case "${PRODUCTION_HOST_REMOTE_MODE}" in
  lock-exec | hydrate-exec | shared-exec) ;;
  *) die 'remote mode must be lock-exec, hydrate-exec, or shared-exec.' ;;
esac
[[ "${PRODUCTION_HOST_REMOTE_ENTRYPOINT}" =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$ ]] || \
  die 'remote entrypoint must be a safe path relative to the published repository.'
case "/${PRODUCTION_HOST_REMOTE_ENTRYPOINT}/" in
  *'/../'* | *'/./'* | *'//'*) die 'remote entrypoint contains an unsafe segment.' ;;
esac
case "${PRODUCTION_HOST_REMOTE_ENTRYPOINT}" in
  scripts/deploy/droplet-capacity.sh | \
    scripts/deploy/droplet-up.sh | \
    scripts/deploy/post-deploy-verify.sh) ;;
  *) die 'remote entrypoint is not an approved production host command.' ;;
esac
case "${PRODUCTION_HOST_REMOTE_ENTRYPOINT}:${PRODUCTION_HOST_REMOTE_MODE}" in
  scripts/deploy/droplet-capacity.sh:lock-exec | \
    scripts/deploy/droplet-capacity.sh:hydrate-exec | \
    scripts/deploy/droplet-up.sh:lock-exec | \
    scripts/deploy/post-deploy-verify.sh:shared-exec) ;;
  *) die 'remote mode is not approved for the selected production host command.' ;;
esac
[ ! -e "${SSH_PAYLOAD_PATH}" ] && [ ! -L "${SSH_PAYLOAD_PATH}" ] || \
  die 'SSH payload output already exists.'

# Transport the host-control helper from the exact commit object, never from
# the mutable runner worktree. The helper is the code that authenticates and
# publishes the bundle on the target, so its bytes must share the same SHA
# authority as the bundle it verifies.
CONTROL_HELPER_PATH=$(mktemp -p "$(dirname -- "${SSH_PAYLOAD_PATH}")" .production-host-control.XXXXXXXX)
cleanup_local_helper() {
  status=$?
  trap - EXIT
  rm -f -- "${CONTROL_HELPER_PATH}"
  exit "${status}"
}
trap cleanup_local_helper EXIT
if ! /usr/bin/env -i \
  PATH=/usr/bin:/bin \
  HOME=/nonexistent \
  LC_ALL=C \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null \
  /usr/bin/git --no-replace-objects -C "${REPO_ROOT}" \
    -c core.hooksPath=/dev/null \
    -c protocol.allow=never \
    show "${PRODUCTION_HOST_MAIN_SHA}:scripts/deploy/production-host-control-plane.sh" \
    > "${CONTROL_HELPER_PATH}"; then
  die 'host-control helper is missing from the exact production SHA.'
fi
chmod 0400 "${CONTROL_HELPER_PATH}"

require_regular_file "${PRODUCTION_HOST_BUNDLE_PATH}" 'runtime bundle'
require_regular_file "${PRODUCTION_HOST_REMOTE_ENV_PATH}" 'remote env manifest'
require_regular_file "${PRODUCTION_HOST_REMOTE_ARGV_PATH}" 'remote argv manifest'
require_regular_file "${CONTROL_HELPER_PATH}" 'host-control helper'

actual_bundle_sha256=$(sha256sum "${PRODUCTION_HOST_BUNDLE_PATH}" | awk 'NR == 1 { print $1 }')
[ "${actual_bundle_sha256}" = "${PRODUCTION_HOST_BUNDLE_SHA256}" ] || \
  die 'runtime bundle digest does not match the requested digest.'
control_helper_sha256=$(sha256sum "${CONTROL_HELPER_PATH}" | awk 'NR == 1 { print $1 }')

declare -A ENV_NAMES_SEEN=()
env_count=0
while IFS=$'\t' read -r name encoded extra || [ -n "${name}${encoded}${extra}" ]; do
  [ -z "${extra}" ] || die 'remote env manifest must contain exactly two tab-separated fields.'
  [[ "${name}" =~ ^[A-Z][A-Z0-9_]*$ ]] || die 'remote env manifest contains an invalid name.'
  [[ "${encoded}" =~ ^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$ ]] || \
    die "remote env value for ${name} is not canonical base64."
  case "${PRODUCTION_HOST_REMOTE_ENTRYPOINT}:${name}" in
    scripts/deploy/droplet-capacity.sh:DEPLOY_SHA | \
      scripts/deploy/droplet-capacity.sh:FULL_DEPLOY | \
      scripts/deploy/droplet-capacity.sh:DEPLOY_SERVICES | \
      scripts/deploy/droplet-up.sh:DEPLOY_SERVICES | \
      scripts/deploy/droplet-up.sh:FULL_DEPLOY | \
      scripts/deploy/droplet-up.sh:DEPLOY_MODE | \
      scripts/deploy/droplet-up.sh:DEPLOY_SHA | \
      scripts/deploy/droplet-up.sh:IMAGE_PREFIX | \
      scripts/deploy/droplet-up.sh:DEPLOY_IMAGE_DIGESTS_B64 | \
      scripts/deploy/droplet-up.sh:GHCR_TOKEN | \
      scripts/deploy/droplet-up.sh:GHCR_ACTOR | \
      scripts/deploy/post-deploy-verify.sh:TARGET_SHA) ;;
    *) die "remote env name is not approved for ${PRODUCTION_HOST_REMOTE_ENTRYPOINT}: ${name}." ;;
  esac
  [[ -z "${ENV_NAMES_SEEN[${name}]+present}" ]] || die "duplicate remote env name: ${name}."
  ENV_NAMES_SEEN["${name}"]=1
  env_count=$((env_count + 1))
  [ "${env_count}" -le 64 ] || die 'remote env manifest exceeds 64 entries.'
done < "${PRODUCTION_HOST_REMOTE_ENV_PATH}"

argv_count=0
while IFS= read -r encoded || [ -n "${encoded}" ]; do
  [[ "${encoded}" =~ ^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$ ]] || \
    die 'remote argv manifest contains non-canonical base64.'
  argv_count=$((argv_count + 1))
  [ "${argv_count}" -le 32 ] || die 'remote argv manifest exceeds 32 arguments.'
done < "${PRODUCTION_HOST_REMOTE_ARGV_PATH}"

{
  cat <<AQUA_REMOTE_PROLOGUE
set +x
set -euo pipefail
umask 077
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
unset BASH_ENV ENV CDPATH GLOBIGNORE PYTHONPATH NODE_OPTIONS
REMOTE_ENTRYPOINT='${PRODUCTION_HOST_REMOTE_ENTRYPOINT}'

die() {
  printf 'FATAL: %s\\n' "\$*" >&2
  exit 2
}

RUNTIME_DIR=\$(/usr/bin/mktemp -d -p /tmp aqua-production-host-XXXXXX)
clear_remote_environment() {
  local remote_name
  if declare -p REMOTE_ENV_NAMES >/dev/null 2>&1; then
    for remote_name in "\${REMOTE_ENV_NAMES[@]}"; do
      unset "\${remote_name}"
    done
  fi
  unset REMOTE_ENV_NAMES REMOTE_ENV_VALUES REMOTE_ENV_NAMES_SEEN REMOTE_ARGV
  unset name encoded extra value value_path
}
cleanup() {
  status=\$?
  trap - EXIT
  cleanup_status=0
  # This is intentionally the first cleanup action: no cleanup child may
  # inherit a credential that was exported solely for the entrypoint hand-off.
  clear_remote_environment
  if ! /usr/bin/rm -rf -- "\${RUNTIME_DIR}" || [ -e "\${RUNTIME_DIR}" ]; then
    printf 'FATAL: production host payload cleanup failed.\\n' >&2
    cleanup_status=1
  fi
  if [ "\${status}" -eq 0 ] && [ "\${cleanup_status}" -ne 0 ]; then
    status=1
  fi
  exit "\${status}"
}
trap cleanup EXIT

CONTROL_HELPER=\${RUNTIME_DIR}/production-host-control-plane.sh
BUNDLE_PATH=\${RUNTIME_DIR}/production-host-runtime.tar.gz
ENV_PATH=\${RUNTIME_DIR}/remote-env.tsv
ARGV_PATH=\${RUNTIME_DIR}/remote-argv.b64

/usr/bin/base64 --decode > "\${CONTROL_HELPER}" <<'AQUA_CONTROL_HELPER_B64'
AQUA_REMOTE_PROLOGUE
  base64 -w0 "${CONTROL_HELPER_PATH}"
  printf '\nAQUA_CONTROL_HELPER_B64\n'
  cat <<AQUA_REMOTE_BUNDLE
/usr/bin/base64 --decode > "\${BUNDLE_PATH}" <<'AQUA_RUNTIME_BUNDLE_B64'
AQUA_REMOTE_BUNDLE
  base64 -w0 "${PRODUCTION_HOST_BUNDLE_PATH}"
  printf '\nAQUA_RUNTIME_BUNDLE_B64\n'
  cat <<AQUA_REMOTE_CONFIG
cat > "\${ENV_PATH}" <<'AQUA_REMOTE_ENV'
AQUA_REMOTE_CONFIG
  cat "${PRODUCTION_HOST_REMOTE_ENV_PATH}"
  printf 'AQUA_REMOTE_ENV\n'
  cat <<AQUA_REMOTE_ARGV
cat > "\${ARGV_PATH}" <<'AQUA_REMOTE_ARGV'
AQUA_REMOTE_ARGV
  cat "${PRODUCTION_HOST_REMOTE_ARGV_PATH}"
  printf 'AQUA_REMOTE_ARGV\n'
  cat <<AQUA_REMOTE_EXEC
chmod 0600 "\${CONTROL_HELPER}" "\${BUNDLE_PATH}" "\${ENV_PATH}" "\${ARGV_PATH}"
[ "\$(/usr/bin/sha256sum "\${CONTROL_HELPER}" | /usr/bin/awk 'NR == 1 { print \$1 }')" = '${control_helper_sha256}' ] || \
  die 'host-control helper digest mismatch after transport.'
[ "\$(/usr/bin/sha256sum "\${BUNDLE_PATH}" | /usr/bin/awk 'NR == 1 { print \$1 }')" = '${PRODUCTION_HOST_BUNDLE_SHA256}' ] || \
  die 'runtime bundle digest mismatch after transport.'

REMOTE_ENV_NAMES=()
declare -A REMOTE_ENV_VALUES=()
declare -A REMOTE_ENV_NAMES_SEEN=()
while IFS=\$(printf '\\t') read -r name encoded extra || [ -n "\${name}\${encoded}\${extra}" ]; do
  [ -z "\${extra}" ] || die 'remote env record has extra fields.'
  [[ "\${name}" =~ ^[A-Z][A-Z0-9_]*\$ ]] || die 'remote env name is invalid.'
  case "\${REMOTE_ENTRYPOINT}:\${name}" in
    scripts/deploy/droplet-capacity.sh:DEPLOY_SHA | \
      scripts/deploy/droplet-capacity.sh:FULL_DEPLOY | \
      scripts/deploy/droplet-capacity.sh:DEPLOY_SERVICES | \
      scripts/deploy/droplet-up.sh:DEPLOY_SERVICES | \
      scripts/deploy/droplet-up.sh:FULL_DEPLOY | \
      scripts/deploy/droplet-up.sh:DEPLOY_MODE | \
      scripts/deploy/droplet-up.sh:DEPLOY_SHA | \
      scripts/deploy/droplet-up.sh:IMAGE_PREFIX | \
      scripts/deploy/droplet-up.sh:DEPLOY_IMAGE_DIGESTS_B64 | \
      scripts/deploy/droplet-up.sh:GHCR_TOKEN | \
      scripts/deploy/droplet-up.sh:GHCR_ACTOR | \
      scripts/deploy/post-deploy-verify.sh:TARGET_SHA) ;;
    *) die "remote env name is not approved for \${REMOTE_ENTRYPOINT}: \${name}." ;;
  esac
  [[ -z "\${REMOTE_ENV_NAMES_SEEN[\${name}]+present}" ]] || \
    die "duplicate remote env name: \${name}."
  REMOTE_ENV_NAMES_SEEN["\${name}"]=1
  value_path=\${RUNTIME_DIR}/value
  printf '%s' "\${encoded}" | /usr/bin/base64 --decode > "\${value_path}" || \
    die "remote env value decode failed for \${name}."
  /usr/bin/python3 - "\${value_path}" <<'PY'
import pathlib
import sys

value = pathlib.Path(sys.argv[1]).read_bytes()
if b"\\x00" in value or b"\\n" in value or b"\\r" in value:
    raise SystemExit(2)
PY
  value=\$(/usr/bin/cat "\${value_path}")
  /usr/bin/rm -f -- "\${value_path}" || die 'remote env value cleanup failed.'
  [ ! -e "\${value_path}" ] && [ ! -L "\${value_path}" ] || \
    die 'remote env value cleanup failed.'
  REMOTE_ENV_NAMES+=("\${name}")
  REMOTE_ENV_VALUES["\${name}"]="\${value}"
done < "\${ENV_PATH}"
/usr/bin/rm -f -- "\${ENV_PATH}" || die 'remote env manifest cleanup failed.'
[ ! -e "\${ENV_PATH}" ] && [ ! -L "\${ENV_PATH}" ] || \
  die 'remote env manifest cleanup failed.'

REMOTE_ARGV=()
while IFS= read -r encoded || [ -n "\${encoded}" ]; do
  value_path=\${RUNTIME_DIR}/argument
  printf '%s' "\${encoded}" | /usr/bin/base64 --decode > "\${value_path}" || \
    die 'remote argument decode failed.'
  /usr/bin/python3 - "\${value_path}" <<'PY'
import pathlib
import sys

value = pathlib.Path(sys.argv[1]).read_bytes()
if b"\\x00" in value or b"\\n" in value or b"\\r" in value:
    raise SystemExit(2)
PY
  value=\$(/usr/bin/cat "\${value_path}")
  /usr/bin/rm -f -- "\${value_path}" || die 'remote argument cleanup failed.'
  [ ! -e "\${value_path}" ] && [ ! -L "\${value_path}" ] || \
    die 'remote argument cleanup failed.'
  REMOTE_ARGV+=("\${value}")
done < "\${ARGV_PATH}"
/usr/bin/rm -f -- "\${ARGV_PATH}" || die 'remote argv manifest cleanup failed.'
[ ! -e "\${ARGV_PATH}" ] && [ ! -L "\${ARGV_PATH}" ] || \
  die 'remote argv manifest cleanup failed.'

# No decoded value is exported while validation or cleanup still has external
# children to execute. Export the bounded allowlist only at the final hand-off;
# droplet-up immediately demotes GHCR_TOKEN before its first external command.
for name in "\${REMOTE_ENV_NAMES[@]}"; do
  value="\${REMOTE_ENV_VALUES[\${name}]}"
  printf -v "\${name}" '%s' "\${value}"
  export "\${name}"
done
unset REMOTE_ENV_VALUES REMOTE_ENV_NAMES_SEEN
unset name encoded extra value value_path

set +e
PRODUCTION_HOST_BUNDLE_PATH="\${BUNDLE_PATH}" \
PRODUCTION_HOST_BUNDLE_SHA256='${PRODUCTION_HOST_BUNDLE_SHA256}' \
PRODUCTION_HOST_MAIN_SHA='${PRODUCTION_HOST_MAIN_SHA}' \
  /bin/bash "\${CONTROL_HELPER}" '${PRODUCTION_HOST_REMOTE_MODE}' -- \
    /bin/bash '${PRODUCTION_HOST_REMOTE_ENTRYPOINT}' "\${REMOTE_ARGV[@]}"
remote_status=\$?
set -e
clear_remote_environment
[ "\${remote_status}" -eq 0 ] || exit "\${remote_status}"
AQUA_REMOTE_EXEC
} > "${SSH_PAYLOAD_PATH}"

chmod 0600 "${SSH_PAYLOAD_PATH}"
