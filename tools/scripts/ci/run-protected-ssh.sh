#!/usr/bin/env bash
# Execute a prepared stdin payload with the runner's system OpenSSH client.
# The private key is materialized only in an ephemeral mode-0700 directory,
# the server key must match a protected SHA256 fingerprint, and neither the
# key nor payload is placed on the ssh command line.

set +x
set -euo pipefail
umask 077

: "${DROPLET_HOST:?DROPLET_HOST required}"
: "${DROPLET_USER:?DROPLET_USER required}"
: "${DROPLET_SSH_KEY:?DROPLET_SSH_KEY required}"
: "${DROPLET_SSH_FINGERPRINT:?DROPLET_SSH_FINGERPRINT required}"
: "${SSH_PAYLOAD_PATH:?SSH_PAYLOAD_PATH required}"
: "${SSH_STDOUT_PATH:?SSH_STDOUT_PATH required}"

DROPLET_PORT="${DROPLET_PORT:-22}"
SSH_COMMAND_TIMEOUT_SECONDS="${SSH_COMMAND_TIMEOUT_SECONDS:-5400}"

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

[[ "${DROPLET_HOST}" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$ ]] || \
  die 'DROPLET_HOST must be a DNS name or IPv4 address without shell metacharacters.'
[[ "${DROPLET_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || \
  die 'DROPLET_USER is not a safe system account name.'
[[ "${DROPLET_PORT}" =~ ^[1-9][0-9]{0,4}$ ]] && \
  [ "${DROPLET_PORT}" -le 65535 ] || die 'DROPLET_PORT is invalid.'
[[ "${SSH_COMMAND_TIMEOUT_SECONDS}" =~ ^[1-9][0-9]*$ ]] && \
  [ "${SSH_COMMAND_TIMEOUT_SECONDS}" -le 7200 ] || die 'SSH command timeout is invalid.'
[[ "${DROPLET_SSH_FINGERPRINT}" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || \
  die 'DROPLET_SSH_FINGERPRINT must be a canonical SHA256 host-key fingerprint.'
if [ ! -f "${SSH_PAYLOAD_PATH}" ] || [ -L "${SSH_PAYLOAD_PATH}" ]; then
  die 'SSH_PAYLOAD_PATH must be a regular non-symlink file.'
fi
if [ -e "${SSH_STDOUT_PATH}" ] || [ -L "${SSH_STDOUT_PATH}" ]; then
  die 'SSH_STDOUT_PATH must not already exist.'
fi
for required_command in awk chmod mktemp ssh ssh-keygen ssh-keyscan timeout; do
  command -v "${required_command}" >/dev/null 2>&1 || die "${required_command} is required."
done

SSH_RUNTIME_DIR=$(mktemp -d -t aqua-protected-ssh-XXXXXX)
cleanup() {
  status=$?
  trap - EXIT
  cleanup_status=0
  if ! rm -rf -- "${SSH_RUNTIME_DIR}" || [ -e "${SSH_RUNTIME_DIR}" ]; then
    printf 'FATAL: protected SSH runtime cleanup failed.\n' >&2
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
printf '%s\n' "${DROPLET_SSH_KEY}" > "${KEY_PATH}"
chmod 0600 "${KEY_PATH}"
unset DROPLET_SSH_KEY

if ! ssh-keyscan -T 15 -p "${DROPLET_PORT}" "${DROPLET_HOST}" \
  > "${CANDIDATE_HOST_KEYS}" 2>/dev/null; then
  die 'ssh-keyscan could not retrieve the protected host key.'
fi
: > "${KNOWN_HOSTS_PATH}"
while IFS= read -r candidate_key; do
  [ -n "${candidate_key}" ] || continue
  candidate_fingerprint=$(
    printf '%s\n' "${candidate_key}" | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }'
  )
  if [ "${candidate_fingerprint}" = "${DROPLET_SSH_FINGERPRINT}" ]; then
    printf '%s\n' "${candidate_key}" >> "${KNOWN_HOSTS_PATH}"
  fi
done < "${CANDIDATE_HOST_KEYS}"
if [ "$(wc -l < "${KNOWN_HOSTS_PATH}")" -ne 1 ]; then
  die 'protected SSH host fingerprint did not match exactly one advertised host key.'
fi
chmod 0600 "${KNOWN_HOSTS_PATH}"
unset DROPLET_SSH_FINGERPRINT candidate_fingerprint

env -i \
  PATH="${PATH}" \
  HOME=/nonexistent \
  LC_ALL=C \
  timeout --foreground --kill-after=30s "${SSH_COMMAND_TIMEOUT_SECONDS}s" \
    ssh \
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
        < "${SSH_PAYLOAD_PATH}" > "${SSH_STDOUT_PATH}"
