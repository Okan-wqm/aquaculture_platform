#!/bin/bash
# Execute a prepared stdin payload with the runner's system OpenSSH client.
# The private key is materialized only in an ephemeral mode-0700 directory,
# the server key must match a protected SHA256 fingerprint, and neither the
# key nor payload is placed on the ssh command line.

set +x
set -euo pipefail
umask 077

readonly SYSTEM_PATH=/usr/bin:/bin
export PATH="${SYSTEM_PATH}"
unset BASH_ENV ENV CDPATH GLOBIGNORE SSH_AUTH_SOCK

readonly AWK_BIN=/usr/bin/awk
readonly CAT_BIN=/usr/bin/cat
readonly CHMOD_BIN=/usr/bin/chmod
readonly ENV_BIN=/usr/bin/env
readonly HEAD_BIN=/usr/bin/head
readonly MKTEMP_BIN=/usr/bin/mktemp
readonly READLINK_BIN=/usr/bin/readlink
readonly RM_BIN=/usr/bin/rm
readonly SSH_BIN=/usr/bin/ssh
readonly SSH_KEYGEN_BIN=/usr/bin/ssh-keygen
readonly SSH_KEYSCAN_BIN=/usr/bin/ssh-keyscan
readonly STAT_BIN=/usr/bin/stat
readonly TIMEOUT_BIN=/usr/bin/timeout

die() {
  builtin printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

for required_binary in \
  "${AWK_BIN}" "${CAT_BIN}" "${CHMOD_BIN}" "${ENV_BIN}" "${MKTEMP_BIN}" \
  "${HEAD_BIN}" "${READLINK_BIN}" "${RM_BIN}" "${SSH_BIN}" "${SSH_KEYGEN_BIN}" \
  "${SSH_KEYSCAN_BIN}" "${STAT_BIN}" "${TIMEOUT_BIN}"; do
  [ -f "${required_binary}" ] && [ -x "${required_binary}" ] || \
    die "Required fixed system binary is unavailable: ${required_binary}"
done

: "${DROPLET_HOST:?DROPLET_HOST required}"
: "${DROPLET_USER:?DROPLET_USER required}"
: "${SSH_PRIVATE_KEY_FD:?SSH_PRIVATE_KEY_FD required}"
: "${DROPLET_SSH_FINGERPRINT:?DROPLET_SSH_FINGERPRINT required}"
: "${SSH_PAYLOAD_PATH:?SSH_PAYLOAD_PATH required}"
: "${SSH_STDOUT_PATH:?SSH_STDOUT_PATH required}"

DROPLET_PORT="${DROPLET_PORT:-22}"
SSH_COMMAND_TIMEOUT_SECONDS="${SSH_COMMAND_TIMEOUT_SECONDS:-5400}"
SSH_STDOUT_MAX_BYTES="${SSH_STDOUT_MAX_BYTES:-16777216}"

require_canonical_absolute_path() {
  local path_value=$1
  case "${path_value}" in
    / | */ | *//* | *$'\n'* | *$'\r'*) die 'Protected SSH paths must be canonical.' ;;
    /*) ;;
    *) die 'Protected SSH paths must be absolute.' ;;
  esac
  case "/${path_value#/}/" in
    */./* | */../*) die 'Protected SSH paths must not contain dot components.' ;;
  esac
}

path_parent() {
  local path_value=$1
  local parent=${path_value%/*}
  [ -n "${parent}" ] || parent=/
  builtin printf '%s' "${parent}"
}

path_identity() {
  "${STAT_BIN}" --dereference --format='%d:%i' -- "$1"
}

assert_stdout_within_bound() {
  local observed_bytes=$1
  [[ "${observed_bytes}" =~ ^[0-9]+$ ]] || die 'SSH stdout size is invalid.'
  [ "${observed_bytes}" -le "${SSH_STDOUT_MAX_BYTES}" ] || \
    die 'Protected SSH stdout exceeded its streaming byte bound.'
}

require_canonical_parent_directory() {
  local path_value=$1
  local label=$2
  local parent
  local resolved_parent
  parent=$(path_parent "${path_value}")
  [ -d "${parent}" ] && [ ! -L "${parent}" ] || \
    die "${label} parent must be a regular directory path."
  resolved_parent=$("${READLINK_BIN}" -e -- "${parent}") || \
    die "${label} parent cannot be resolved."
  [ "${resolved_parent}" = "${parent}" ] || \
    die "${label} parent must not traverse a symlink."
}

require_regular_file_identity() {
  local path_value=$1
  local expected_identity=$2
  local label=$3
  local actual_identity
  [ -f "${path_value}" ] && [ ! -L "${path_value}" ] || \
    die "${label} must remain a regular non-symlink file."
  actual_identity=$(path_identity "${path_value}") || \
    die "${label} identity cannot be read."
  [ "${actual_identity}" = "${expected_identity}" ] || \
    die "${label} identity changed."
}

require_open_file_identity() {
  local path_value=$1
  local descriptor=$2
  local expected_identity=$3
  local label=$4
  local descriptor_path="/proc/self/fd/${descriptor}"
  require_regular_file_identity "${path_value}" "${expected_identity}" "${label}"
  [ -f "${descriptor_path}" ] || die "${label} descriptor is not a regular file."
  [ "$(path_identity "${descriptor_path}")" = "${expected_identity}" ] || \
    die "${label} descriptor identity changed."
}

require_private_key_descriptor() {
  local descriptor_path="/proc/self/fd/${SSH_PRIVATE_KEY_FD}"
  local descriptor_identity
  local descriptor_links
  local descriptor_mode
  local descriptor_owner
  local descriptor_size

  [ -f "${descriptor_path}" ] || die 'SSH private-key descriptor is not a regular file.'
  descriptor_identity=$(path_identity "${descriptor_path}") || \
    die 'SSH private-key descriptor identity cannot be read.'
  descriptor_owner=$("${STAT_BIN}" --dereference --format='%u' -- "${descriptor_path}") || \
    die 'SSH private-key descriptor owner cannot be read.'
  descriptor_mode=$("${STAT_BIN}" --dereference --format='%a' -- "${descriptor_path}") || \
    die 'SSH private-key descriptor mode cannot be read.'
  descriptor_links=$("${STAT_BIN}" --dereference --format='%h' -- "${descriptor_path}") || \
    die 'SSH private-key descriptor link count cannot be read.'
  descriptor_size=$("${STAT_BIN}" --dereference --format='%s' -- "${descriptor_path}") || \
    die 'SSH private-key descriptor size cannot be read.'
  [ "${descriptor_identity}" = "${SSH_PRIVATE_KEY_FD_ID}" ] || \
    die 'SSH private-key descriptor identity changed.'
  [ "${descriptor_owner}" = "${EUID}" ] || \
    die 'SSH private-key descriptor owner is invalid.'
  [ "${descriptor_mode}" = 600 ] || \
    die 'SSH private-key descriptor mode must be 0600.'
  [ "${descriptor_links}" = 0 ] || \
    die 'SSH private-key descriptor must be unlinked before helper execution.'
  [[ "${descriptor_size}" =~ ^[1-9][0-9]*$ ]] && \
    [ "${descriptor_size}" -le 65536 ] || \
    die 'SSH private-key descriptor size is invalid.'
}

[[ "${SSH_PRIVATE_KEY_FD}" =~ ^([3-9]|[1-9][0-9]{1,2})$ ]] || \
  die 'SSH_PRIVATE_KEY_FD must identify a bounded inherited descriptor.'
SSH_PRIVATE_KEY_FD_ID=$(path_identity "/proc/self/fd/${SSH_PRIVATE_KEY_FD}") || \
  die 'SSH private-key descriptor is unavailable.'
require_private_key_descriptor

[[ "${DROPLET_HOST}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || \
  die 'DROPLET_HOST must be a DNS name or IPv4 address without shell metacharacters.'
[[ "${DROPLET_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || \
  die 'DROPLET_USER is not a safe system account name.'
[[ "${DROPLET_PORT}" =~ ^[1-9][0-9]{0,4}$ ]] && \
  [ "${DROPLET_PORT}" -le 65535 ] || die 'DROPLET_PORT is invalid.'
[[ "${SSH_COMMAND_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]] && \
  [ "${SSH_COMMAND_TIMEOUT_SECONDS}" -le 7200 ] || die 'SSH command timeout is invalid.'
[[ "${SSH_STDOUT_MAX_BYTES}" =~ ^[1-9][0-9]*$ ]] && \
  [ "${SSH_STDOUT_MAX_BYTES}" -le 67108864 ] || die 'SSH stdout bound is invalid.'
[[ "${DROPLET_SSH_FINGERPRINT}" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || \
  die 'DROPLET_SSH_FINGERPRINT must be a canonical SHA256 host-key fingerprint.'

require_canonical_absolute_path "${SSH_PAYLOAD_PATH}"
require_canonical_absolute_path "${SSH_STDOUT_PATH}"
[ "${SSH_PAYLOAD_PATH}" != "${SSH_STDOUT_PATH}" ] || \
  die 'SSH payload and stdout paths must be distinct.'
require_canonical_parent_directory "${SSH_PAYLOAD_PATH}" SSH_PAYLOAD_PATH
require_canonical_parent_directory "${SSH_STDOUT_PATH}" SSH_STDOUT_PATH
[ -f "${SSH_PAYLOAD_PATH}" ] && [ ! -L "${SSH_PAYLOAD_PATH}" ] || \
  die 'SSH_PAYLOAD_PATH must be a regular non-symlink file.'
RESOLVED_PAYLOAD_PATH=$("${READLINK_BIN}" -e -- "${SSH_PAYLOAD_PATH}") || \
  die 'SSH_PAYLOAD_PATH cannot be resolved.'
[ "${RESOLVED_PAYLOAD_PATH}" = "${SSH_PAYLOAD_PATH}" ] || \
  die 'SSH_PAYLOAD_PATH must not traverse a symlink.'
if [ -e "${SSH_STDOUT_PATH}" ] || [ -L "${SSH_STDOUT_PATH}" ]; then
  die 'SSH_STDOUT_PATH must not already exist.'
fi

SSH_PAYLOAD_PATH_ID=$(path_identity "${SSH_PAYLOAD_PATH}") || \
  die 'SSH_PAYLOAD_PATH identity cannot be read.'
SSH_PAYLOAD_FD=
SSH_STDOUT_FD=
if ! exec {SSH_PAYLOAD_FD}< "${SSH_PAYLOAD_PATH}"; then
  die 'SSH_PAYLOAD_PATH could not be opened.'
fi
require_open_file_identity \
  "${SSH_PAYLOAD_PATH}" "${SSH_PAYLOAD_FD}" "${SSH_PAYLOAD_PATH_ID}" SSH_PAYLOAD_PATH

set -o noclobber
if ! exec {SSH_STDOUT_FD}> "${SSH_STDOUT_PATH}"; then
  set +o noclobber
  die 'SSH_STDOUT_PATH could not be created exclusively.'
fi
set +o noclobber
SSH_STDOUT_PATH_ID=$(path_identity "${SSH_STDOUT_PATH}") || \
  die 'SSH_STDOUT_PATH identity cannot be read.'
require_open_file_identity \
  "${SSH_STDOUT_PATH}" "${SSH_STDOUT_FD}" "${SSH_STDOUT_PATH_ID}" SSH_STDOUT_PATH
[ "${SSH_PAYLOAD_PATH_ID}" != "${SSH_STDOUT_PATH_ID}" ] || \
  die 'SSH payload and stdout descriptors must reference distinct files.'

SSH_RUNTIME_DIR=$("${MKTEMP_BIN}" -d /tmp/aqua-protected-ssh.XXXXXXXX) || \
  die 'Protected SSH runtime directory creation failed.'
[ -d "${SSH_RUNTIME_DIR}" ] && [ ! -L "${SSH_RUNTIME_DIR}" ] || \
  die 'Protected SSH runtime path is not a regular directory.'
SSH_RUNTIME_DIR_ID=$(path_identity "${SSH_RUNTIME_DIR}") || \
  die 'Protected SSH runtime directory identity cannot be read.'
SSH_RUNTIME_DIR_FD=
if ! exec {SSH_RUNTIME_DIR_FD}< "${SSH_RUNTIME_DIR}"; then
  if ! "${RM_BIN}" -rf -- "${SSH_RUNTIME_DIR}" || [ -e "${SSH_RUNTIME_DIR}" ]; then
    builtin printf 'FATAL: protected SSH runtime cleanup failed.\n' >&2
  fi
  die 'Protected SSH runtime directory could not be opened.'
fi
[ -d "/proc/self/fd/${SSH_RUNTIME_DIR_FD}" ] && \
  [ "$(path_identity "/proc/self/fd/${SSH_RUNTIME_DIR_FD}")" = "${SSH_RUNTIME_DIR_ID}" ] || \
  die 'Protected SSH runtime directory descriptor identity changed.'

runtime_directory_identity_matches() {
  [ -d "${SSH_RUNTIME_DIR}" ] && [ ! -L "${SSH_RUNTIME_DIR}" ] && \
    [ "$(path_identity "${SSH_RUNTIME_DIR}" 2>/dev/null)" = "${SSH_RUNTIME_DIR_ID}" ] && \
    [ -d "/proc/self/fd/${SSH_RUNTIME_DIR_FD}" ] && \
    [ "$(path_identity "/proc/self/fd/${SSH_RUNTIME_DIR_FD}" 2>/dev/null)" = \
      "${SSH_RUNTIME_DIR_ID}" ]
}

remove_runtime_directory() {
  "${RM_BIN}" -rf -- "$1"
}

runtime_directory_removed_from_namespace() {
  local descriptor_path="/proc/self/fd/${SSH_RUNTIME_DIR_FD}"
  local link_count
  [ ! -e "${SSH_RUNTIME_DIR}" ] && [ ! -L "${SSH_RUNTIME_DIR}" ] || return 1
  [ -d "${descriptor_path}" ] || return 1
  link_count=$("${STAT_BIN}" --dereference --format='%h' -- "${descriptor_path}") || return
  [ "${link_count}" -eq 0 ]
}

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT
  # Close every descriptor carrying secret/payload bytes before cleanup invokes
  # even fixed system binaries. This covers disk-full and materialization
  # failures before the normal close path is reached.
  if [ -n "${SSH_PRIVATE_KEY_FD:-}" ] && \
     [ -e "/proc/self/fd/${SSH_PRIVATE_KEY_FD}" ]; then
    exec {SSH_PRIVATE_KEY_FD}<&-
  fi
  SSH_PRIVATE_KEY_FD=
  unset SSH_PRIVATE_KEY_FD_ID
  if [ -n "${SSH_PAYLOAD_FD:-}" ] && \
     [ -e "/proc/self/fd/${SSH_PAYLOAD_FD}" ]; then
    exec {SSH_PAYLOAD_FD}<&-
  fi
  SSH_PAYLOAD_FD=
  if [ -n "${SSH_STDOUT_FD:-}" ] && \
     [ -e "/proc/self/fd/${SSH_STDOUT_FD}" ]; then
    exec {SSH_STDOUT_FD}>&-
  fi
  SSH_STDOUT_FD=
  if ! runtime_directory_identity_matches; then
    builtin printf 'FATAL: protected SSH runtime directory identity changed.\n' >&2
    cleanup_status=1
  elif ! remove_runtime_directory "${SSH_RUNTIME_DIR}" || \
       ! runtime_directory_removed_from_namespace; then
    builtin printf 'FATAL: protected SSH runtime cleanup failed.\n' >&2
    cleanup_status=1
  fi
  if [ "${status}" -eq 0 ] && [ "${cleanup_status}" -ne 0 ]; then
    status=1
  fi
  exit "${status}"
}
trap cleanup EXIT

KEY_PATH="${SSH_RUNTIME_DIR}/identity"
CANDIDATE_HOST_KEYS="${SSH_RUNTIME_DIR}/host-keys.candidate"
KNOWN_HOSTS_PATH="${SSH_RUNTIME_DIR}/known_hosts"
require_private_key_descriptor
"${CAT_BIN}" -- "/proc/self/fd/${SSH_PRIVATE_KEY_FD}" > "${KEY_PATH}"
"${CHMOD_BIN}" 0600 "${KEY_PATH}"
require_private_key_descriptor
exec {SSH_PRIVATE_KEY_FD}<&-
unset SSH_PRIVATE_KEY_FD SSH_PRIVATE_KEY_FD_ID

if ! "${SSH_KEYSCAN_BIN}" -T 15 -p "${DROPLET_PORT}" -t ed25519 "${DROPLET_HOST}" \
  > "${CANDIDATE_HOST_KEYS}" 2>/dev/null; then
  die 'ssh-keyscan could not retrieve the protected ED25519 host key.'
fi

select_ed25519_host_key() {
  local candidate_key
  local candidate_algorithm
  local candidate_fingerprint
  local matched_host_keys=0
  : > "${KNOWN_HOSTS_PATH}"
  while IFS= read -r candidate_key; do
    [ -n "${candidate_key}" ] || continue
    candidate_algorithm=$(
      builtin printf '%s\n' "${candidate_key}" | \
        "${AWK_BIN}" 'NF == 3 { print $2 }'
    )
    [ "${candidate_algorithm}" = 'ssh-ed25519' ] || continue
    candidate_fingerprint=$(
      builtin printf '%s\n' "${candidate_key}" | \
        "${SSH_KEYGEN_BIN}" -lf - -E sha256 | \
        "${AWK_BIN}" 'NR == 1 { print $2 }'
    )
    if [ "${candidate_fingerprint}" = "${DROPLET_SSH_FINGERPRINT}" ]; then
      builtin printf '%s\n' "${candidate_key}" >> "${KNOWN_HOSTS_PATH}"
      matched_host_keys=$((matched_host_keys + 1))
    fi
  done < "${CANDIDATE_HOST_KEYS}"
  [ "${matched_host_keys}" -eq 1 ] || \
    die 'protected SSH fingerprint did not match exactly one advertised ED25519 host key.'
}

select_ed25519_host_key
"${CHMOD_BIN}" 0600 "${KNOWN_HOSTS_PATH}"
unset DROPLET_SSH_FINGERPRINT

runtime_directory_identity_matches || \
  die 'Protected SSH runtime directory identity changed before execution.'
require_open_file_identity \
  "${SSH_PAYLOAD_PATH}" "${SSH_PAYLOAD_FD}" "${SSH_PAYLOAD_PATH_ID}" SSH_PAYLOAD_PATH
require_open_file_identity \
  "${SSH_STDOUT_PATH}" "${SSH_STDOUT_FD}" "${SSH_STDOUT_PATH_ID}" SSH_STDOUT_PATH

set +e
"${ENV_BIN}" -i \
  PATH="${SYSTEM_PATH}" \
  HOME=/nonexistent \
  LC_ALL=C \
  "${TIMEOUT_BIN}" --foreground --kill-after=30s "${SSH_COMMAND_TIMEOUT_SECONDS}s" \
    "${SSH_BIN}" \
    -F /dev/null \
    -p "${DROPLET_PORT}" \
    -i "${KEY_PATH}" \
    -o BatchMode=yes \
    -o ClearAllForwardings=yes \
    -o ForwardAgent=no \
    -o PasswordAuthentication=no \
    -o KbdInteractiveAuthentication=no \
    -o IdentitiesOnly=yes \
    -o PermitLocalCommand=no \
    -o RequestTTY=no \
    -o StrictHostKeyChecking=yes \
    -o HostKeyAlgorithms=ssh-ed25519 \
    -o UserKnownHostsFile="${KNOWN_HOSTS_PATH}" \
    -o GlobalKnownHostsFile=/dev/null \
    -o UpdateHostKeys=no \
    -o ConnectTimeout=30 \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=4 \
      "${DROPLET_USER}@${DROPLET_HOST}" \
      /usr/bin/env -i \
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        HOME=/nonexistent \
        LC_ALL=C \
        /bin/bash --noprofile --norc -s \
        0<&${SSH_PAYLOAD_FD} | \
  "${HEAD_BIN}" -c "$((SSH_STDOUT_MAX_BYTES + 1))" 1>&${SSH_STDOUT_FD}
pipeline_status=("${PIPESTATUS[@]}")
ssh_status=${pipeline_status[0]}
stdout_limiter_status=${pipeline_status[1]}
set -e

require_open_file_identity \
  "${SSH_PAYLOAD_PATH}" "${SSH_PAYLOAD_FD}" "${SSH_PAYLOAD_PATH_ID}" SSH_PAYLOAD_PATH
require_open_file_identity \
  "${SSH_STDOUT_PATH}" "${SSH_STDOUT_FD}" "${SSH_STDOUT_PATH_ID}" SSH_STDOUT_PATH
runtime_directory_identity_matches || \
  die 'Protected SSH runtime directory identity changed after execution.'
SSH_STDOUT_BYTES=$("${STAT_BIN}" --dereference --format='%s' -- "${SSH_STDOUT_PATH}") || \
  die 'SSH stdout size cannot be read.'
assert_stdout_within_bound "${SSH_STDOUT_BYTES}"
[ "${stdout_limiter_status}" -eq 0 ] || die 'Protected SSH stdout limiter failed.'
exec {SSH_PAYLOAD_FD}<&-
SSH_PAYLOAD_FD=
exec {SSH_STDOUT_FD}>&-
SSH_STDOUT_FD=
[ "${ssh_status}" -eq 0 ] || exit "${ssh_status}"
