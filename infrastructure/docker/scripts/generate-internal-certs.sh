#!/bin/bash
# =============================================================================
# Internal TLS Certificate Generator — Aquaculture Platform
# Usage: ./generate-internal-certs.sh [--renew-leaves|--rotate-ca]
# Output: ${DEPLOY_CERTS_DIR:-./certs}/{ca,nats,redis,postgres}/
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Production executes this tracked script from a read-only exact-SHA bundle,
# while certificate state remains in the persistent host secret store. Local
# and staging callers keep the historical repository-relative default.
if [ -n "${DEPLOY_CERTS_DIR:-}" ]; then
  if [ -n "${CERTS_DIR:-}" ] && [ "${CERTS_DIR}" != "${DEPLOY_CERTS_DIR}" ]; then
    echo "error: CERTS_DIR cannot override DEPLOY_CERTS_DIR" >&2
    exit 2
  fi
  CERTS_DIR="${DEPLOY_CERTS_DIR}"
else
  CERTS_DIR="${CERTS_DIR:-${REPO_ROOT}/certs}"
fi
case "${CERTS_DIR}" in
  /*) ;;
  *) echo "error: CERTS_DIR must resolve to an absolute path" >&2; exit 2 ;;
esac
# Renewal modes (INFRA-CRITICAL-233). Expiry is a reason to issue new leaves,
# never a reason to replace the trust root: an application rollout leaves the
# NATS broker and PostgreSQL running on the CA they started with, so a leaf
# signed by any other CA splits every restarted service from them.
#   (no option)     issue only what is missing; validate everything kept. Once
#                   any managed leaf is inside LEAF_RENEWAL_WINDOW_DAYS of expiry,
#                   renew every leaf as --renew-leaves does. Every deploy path
#                   runs this and passes no option: the renewal decision lives
#                   here, beside the managed set it reads.
#   --renew-leaves  issue every server and client leaf again under the existing
#                   CA, which must be present and valid; it never mints one.
#   --rotate-ca     replace the CA and every leaf. An operator ceremony: every
#                   consumer, infrastructure included, must be recreated after it,
#                   so no deploy path passes it.
# Except under --rotate-ca, nothing is issued until the store proves it was
# issued under the CA in ca/ (require_store_issued_under_kept_ca), and a CA is
# minted only into a store that holds no identity issued under another.
# Any other argument is refused, so a stale caller fails instead of guessing.
# Every asset below is written to a staged file in its own directory and
# published by rename after cryptographic validation.
RENEW_LEAVES=false
ROTATE_CA=false
case "$#:${1:-}" in
  0:) ;;
  1:--renew-leaves) RENEW_LEAVES=true ;;
  1:--rotate-ca) RENEW_LEAVES=true; ROTATE_CA=true ;;
  *)
    echo "error: usage: generate-internal-certs.sh [--renew-leaves|--rotate-ca]" >&2
    exit 2
    ;;
esac
LEAF_VALIDITY_DAYS=365
LEAF_RENEWAL_WINDOW_DAYS=30
# The managed server sets, one row each: name|CN|subjectAltName|private-key mode.
# Directory preparation, issuance and the continuity and expiry checks all
# iterate this table, and load_server_set is the only reader of a row: it
# refuses a name the table does not hold, so no server set or file can be
# issued without also being checked.
MANAGED_SERVER_SETS=(
  'nats|nats|DNS:nats,DNS:aqua-nats,DNS:localhost|0644'
  'redis|redis|DNS:redis,DNS:aqua-redis,DNS:localhost|0644'
  'postgres|postgres|DNS:postgres,DNS:aqua-postgres,DNS:localhost|0600'
)
# Looks the named set up in MANAGED_SERVER_SETS and sets SERVER_SET_CN,
# SERVER_SET_SAN, SERVER_SET_KEY_MODE and the set's paths (SERVER_SET_DIR,
# SERVER_SET_KEY, SERVER_SET_CERT, SERVER_SET_CA): the one place a server set's
# files are spelled; even the PostgreSQL aliases name them through it. Any
# other name ends the run before a file is touched.
load_server_set() {
  local row name
  for row in "${MANAGED_SERVER_SETS[@]}"; do
    IFS='|' read -r name SERVER_SET_CN SERVER_SET_SAN SERVER_SET_KEY_MODE <<< "${row}"
    if [ "${name}" = "$1" ]; then
      SERVER_SET_DIR="${CERTS_DIR}/${name}"
      SERVER_SET_KEY="${SERVER_SET_DIR}/${name}-key.pem"
      SERVER_SET_CERT="${SERVER_SET_DIR}/${name}-cert.pem"
      SERVER_SET_CA="${SERVER_SET_DIR}/ca-cert.pem"
      return 0
    fi
  done
  echo "error: not a managed server set: $1 (every server set is a row of MANAGED_SERVER_SETS)" >&2
  exit 1
}
declare -a MANAGED_LEAF_CERTS=()
declare -a MANAGED_LEAF_KEYS=()
declare -a MANAGED_LEAF_PURPOSES=()
declare -a MANAGED_LEAF_LABELS=()
GENERATED_STAGE=''
declare -a GENERATED_STAGE_PATHS=()
declare -a GENERATED_STAGE_DIRECTORIES=()

cleanup_generated_stages() {
  local path directory
  for path in "${GENERATED_STAGE_PATHS[@]}"; do
    if [ -e "${path}" ] || [ -L "${path}" ]; then
      rm -f -- "${path}"
    fi
  done
  for directory in "${GENERATED_STAGE_DIRECTORIES[@]}"; do
    if [ -d "${directory}" ] && [ ! -L "${directory}" ]; then
      rm -f -- "${directory}/alias"
      rmdir -- "${directory}" 2>/dev/null || true
    elif [ -L "${directory}" ]; then
      rm -f -- "${directory}"
    fi
  done
}
trap cleanup_generated_stages EXIT

create_stage_file() {
  GENERATED_STAGE=$(mktemp "$1")
  GENERATED_STAGE_PATHS+=("${GENERATED_STAGE}")
}

create_stage_directory() {
  GENERATED_STAGE=$(mktemp -d "$1")
  GENERATED_STAGE_DIRECTORIES+=("${GENERATED_STAGE}")
}

certificate_store_error() {
  echo "error: unsafe certificate identity store: $*" >&2
  return 1
}

path_exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

prepare_certificate_directories() {
  /usr/bin/python3 - "${CERTS_DIR}" "${CERTIFICATE_OWNER_UID}" "$@" <<'PY'
import os
import stat
import sys

cert_root = sys.argv[1]
expected_uid = int(sys.argv[2])
targets = sys.argv[3:]


def fail(message: str) -> None:
    raise SystemExit(f"error: unsafe certificate identity store: {message}")


def split_absolute(path: str) -> list[str]:
    if (
        not path.startswith("/")
        or path == "/"
        or path.endswith("/")
        or "//" in path
    ):
        fail(f"path is not a canonical absolute directory: {path}")
    parts = path[1:].split("/")
    if any(part in {"", ".", ".."} for part in parts):
        fail(f"path contains a non-canonical component: {path}")
    return parts


root_parts = split_absolute(cert_root)
root_prefix = cert_root + "/"
for target in targets:
    split_absolute(target)
    if target != cert_root and not target.startswith(root_prefix):
        fail(f"managed directory escapes DEPLOY_CERTS_DIR: {target}")


def validate_open_directory(fd: int, path: str, inside_store: bool) -> None:
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        fail(f"path component is not a directory: {path}")
    mode = stat.S_IMODE(info.st_mode)
    if inside_store:
        if info.st_uid != expected_uid:
            fail(
                f"certificate directory owner {info.st_uid} does not match "
                f"deploy uid {expected_uid}: {path}"
            )
        if mode == 0o755:
            # The historical generator created identity-store directories as
            # 0755. It is non-writable by peers and is the only state that can
            # be converged safely; fchmod keeps the operation bound to the
            # already-open nofollow descriptor.
            os.fchmod(fd, 0o700)
            mode = stat.S_IMODE(os.fstat(fd).st_mode)
        if mode != 0o700:
            fail(
                f"certificate directory mode {mode:o} is neither canonical "
                f"0700 nor safe legacy 0755: {path}"
            )
        return

    if info.st_uid not in {0, expected_uid}:
        fail(f"ancestor owner {info.st_uid} is not root or deploy uid: {path}")
    if mode & 0o022:
        sticky_root_directory = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
        if not sticky_root_directory:
            fail(f"ancestor has unsafe writable mode {mode:o}: {path}")


open_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
for target in targets:
    parts = split_absolute(target)
    current_fd = os.open("/", open_flags)
    try:
        validate_open_directory(current_fd, "/", False)
        current_parts: list[str] = []
        for component in parts:
            current_parts.append(component)
            current_path = "/" + "/".join(current_parts)
            inside_store = current_path == cert_root or current_path.startswith(root_prefix)
            try:
                child_fd = os.open(component, open_flags, dir_fd=current_fd)
            except FileNotFoundError:
                if not inside_store:
                    fail(f"ancestor directory is missing: {current_path}")
                try:
                    os.mkdir(component, 0o700, dir_fd=current_fd)
                    child_fd = os.open(component, open_flags, dir_fd=current_fd)
                except OSError as error:
                    fail(f"could not create real certificate directory {current_path}: {error}")
            except OSError as error:
                fail(f"symlink or non-directory ancestor rejected at {current_path}: {error}")
            os.close(current_fd)
            current_fd = child_fd
            validate_open_directory(current_fd, current_path, inside_store)
    finally:
        os.close(current_fd)
PY
}

assert_certificate_directory() {
  local path="$1" label="$2" actual_uid actual_mode

  if [ -L "${path}" ] || [ ! -d "${path}" ]; then
    certificate_store_error "${label} is not a real directory: ${path}"
    return
  fi
  actual_uid=$(stat -c '%u' -- "${path}")
  actual_mode=$(stat -c '%a' -- "${path}")
  if [ "${actual_uid}:${actual_mode}" != "${CERTIFICATE_OWNER_UID}:700" ]; then
    certificate_store_error \
      "${label} ownership/mode changed after descriptor validation: ${path}"
    return
  fi
}

validate_existing_certificate_asset() {
  local path="$1" expected_mode="$2" label="$3"
  local actual_uid actual_mode actual_links

  if [ -L "${path}" ] || [ ! -f "${path}" ]; then
    certificate_store_error "${label} is not a regular non-symlink file: ${path}"
    return
  fi
  if [ ! -s "${path}" ]; then
    certificate_store_error "${label} is empty: ${path}"
    return
  fi
  actual_uid=$(stat -c '%u' -- "${path}")
  actual_mode=$(stat -c '%a' -- "${path}")
  actual_links=$(stat -c '%h' -- "${path}")
  if [ "${actual_uid}" != "${CERTIFICATE_OWNER_UID}" ]; then
    certificate_store_error \
      "${label} owner ${actual_uid} does not match deploy uid ${CERTIFICATE_OWNER_UID}: ${path}"
    return
  fi
  if [ "${actual_links}" != 1 ]; then
    certificate_store_error "${label} must have exactly one hard link: ${path}"
    return
  fi
  if [ "${actual_mode}" != "${expected_mode#0}" ]; then
    certificate_store_error \
      "${label} mode ${actual_mode} does not match ${expected_mode#0}: ${path}"
    return
  fi
}

certificate_subject() {
  local path="$1" label="$2" subject

  if ! subject=$(openssl x509 -in "${path}" -noout -subject -nameopt RFC2253 2>/dev/null); then
    certificate_store_error "${label} is not a parseable X.509 certificate: ${path}"
    return
  fi
  subject=${subject#subject=}
  while [[ "${subject}" == ' '* ]]; do
    subject=${subject# }
  done
  printf '%s\n' "${subject}"
}

public_key_digest_from_private_key() {
  local path="$1" label="$2" digest

  if ! digest=$(
    openssl pkey -in "${path}" -pubout -outform DER 2>/dev/null |
      openssl dgst -sha256 -r 2>/dev/null |
      /usr/bin/awk '{ print $1 }'
  ); then
    certificate_store_error "${label} is not a parseable private key: ${path}"
    return
  fi
  if [[ ! "${digest}" =~ ^[0-9a-f]{64}$ ]]; then
    certificate_store_error "${label} did not produce one SHA-256 public-key digest: ${path}"
    return
  fi
  printf '%s\n' "${digest}"
}

public_key_digest_from_certificate() {
  local path="$1" label="$2" digest

  if ! digest=$(
    openssl x509 -in "${path}" -pubkey -noout 2>/dev/null |
      openssl pkey -pubin -outform DER 2>/dev/null |
      openssl dgst -sha256 -r 2>/dev/null |
      /usr/bin/awk '{ print $1 }'
  ); then
    certificate_store_error "${label} has no parseable certificate public key: ${path}"
    return
  fi
  if [[ ! "${digest}" =~ ^[0-9a-f]{64}$ ]]; then
    certificate_store_error "${label} did not produce one SHA-256 certificate-key digest: ${path}"
    return
  fi
  printf '%s\n' "${digest}"
}

validate_certificate_key_pair() {
  local key_path="$1" cert_path="$2" expected_subject="$3" ca_path="$4"
  local purpose="$5" label="$6" actual_subject key_digest cert_digest

  if ! actual_subject=$(certificate_subject "${cert_path}" "${label} certificate"); then
    return 1
  fi
  if [ "${actual_subject}" != "${expected_subject}" ]; then
    certificate_store_error \
      "${label} certificate subject '${actual_subject}' does not match '${expected_subject}': ${cert_path}"
    return
  fi
  if ! key_digest=$(public_key_digest_from_private_key "${key_path}" "${label} private key"); then
    return 1
  fi
  if ! cert_digest=$(public_key_digest_from_certificate "${cert_path}" "${label} certificate"); then
    return 1
  fi
  if [ "${key_digest}" != "${cert_digest}" ]; then
    certificate_store_error "${label} certificate and private key do not match"
    return
  fi
  if ! openssl verify \
    -CAfile "${ca_path}" \
    -no-CApath \
    -no-CAstore \
    -purpose "${purpose}" \
    "${cert_path}" >/dev/null 2>&1; then
    certificate_store_error "${label} certificate is not signed by the canonical CA"
    return
  fi
}

validate_certificate_authority() {
  local key_path="$1" cert_path="$2" label="$3"
  local actual_subject key_digest cert_digest

  if ! actual_subject=$(certificate_subject "${cert_path}" "${label} certificate"); then
    return 1
  fi
  if [ "${actual_subject}" != 'CN=Aquaculture Internal CA' ]; then
    certificate_store_error \
      "${label} certificate subject '${actual_subject}' does not match 'CN=Aquaculture Internal CA': ${cert_path}"
    return
  fi
  if ! key_digest=$(public_key_digest_from_private_key "${key_path}" "${label} private key"); then
    return 1
  fi
  if ! cert_digest=$(public_key_digest_from_certificate "${cert_path}" "${label} certificate"); then
    return 1
  fi
  if [ "${key_digest}" != "${cert_digest}" ]; then
    certificate_store_error "${label} certificate and private key do not match"
    return
  fi
  if ! openssl verify \
    -CAfile "${cert_path}" \
    -no-CApath \
    -no-CAstore \
    -check_ss_sig \
    "${cert_path}" >/dev/null 2>&1; then
    certificate_store_error "${label} certificate is not a valid self-signed trust anchor"
    return
  fi
}

validate_canonical_ca_copy() {
  local path="$1" label="$2"

  if ! cmp -s -- "${CERTS_DIR}/ca/ca-cert.pem" "${path}"; then
    certificate_store_error "${label} does not exactly match the canonical CA certificate: ${path}"
    return
  fi
}

certificate_set_has_any_path() {
  local path
  for path in "$@"; do
    if path_exists "${path}"; then
      return 0
    fi
  done
  return 1
}

CERTIFICATE_OWNER_UID=$(id -u)
if [[ ! "${CERTIFICATE_OWNER_UID}" =~ ^[0-9]+$ ]]; then
  certificate_store_error 'could not determine the deploy uid'
  exit 1
fi
declare -a CERTIFICATE_DIRECTORIES=("${CERTS_DIR}" "${CERTS_DIR}/ca")
for server_set in "${MANAGED_SERVER_SETS[@]}"; do
  load_server_set "${server_set%%|*}"
  CERTIFICATE_DIRECTORIES+=("${SERVER_SET_DIR}")
done
CERTIFICATE_DIRECTORIES+=("${CERTS_DIR}/nats/clients")
prepare_certificate_directories "${CERTIFICATE_DIRECTORIES[@]}"
assert_certificate_directory "${CERTS_DIR}" 'DEPLOY_CERTS_DIR'

validate_existing_server_set() {
  local name="$1"

  load_server_set "${name}"
  validate_existing_certificate_asset \
    "${SERVER_SET_KEY}" "${SERVER_SET_KEY_MODE}" "${name} server private key"
  validate_existing_certificate_asset \
    "${SERVER_SET_CERT}" 0644 "${name} server certificate"
  validate_existing_certificate_asset \
    "${SERVER_SET_CA}" 0644 "${name} server CA certificate"
  validate_canonical_ca_copy "${SERVER_SET_CA}" "${name} server CA certificate"
  validate_certificate_key_pair \
    "${SERVER_SET_KEY}" \
    "${SERVER_SET_CERT}" \
    "O=Aquaculture Platform,CN=${SERVER_SET_CN}" \
    "${CERTS_DIR}/ca/ca-cert.pem" \
    sslserver \
    "${name} server"
}

validate_existing_client_set() {
  local key_path="$1" cert_path="$2" expected_subject="$3" label="$4"

  validate_existing_certificate_asset "${key_path}" 0644 "${label} private key"
  validate_existing_certificate_asset "${cert_path}" 0644 "${label} certificate"
  validate_certificate_key_pair \
    "${key_path}" \
    "${cert_path}" \
    "${expected_subject}" \
    "${CERTS_DIR}/ca/ca-cert.pem" \
    sslclient \
    "${label}"
}

add_managed_leaf() {
  MANAGED_LEAF_CERTS+=("$1")
  MANAGED_LEAF_KEYS+=("$2")
  MANAGED_LEAF_PURPOSES+=("$3")
  MANAGED_LEAF_LABELS+=("$4")
}

store_holds_issued_identity() {
  local index server_set
  for index in "${!MANAGED_LEAF_CERTS[@]}"; do
    if path_exists "${MANAGED_LEAF_CERTS[index]}" || path_exists "${MANAGED_LEAF_KEYS[index]}"; then
      return 0
    fi
  done
  for server_set in "${MANAGED_SERVER_SETS[@]}"; do
    load_server_set "${server_set%%|*}"
    if path_exists "${SERVER_SET_CA}"; then
      return 0
    fi
  done
  return 1
}

# INFRA-CRITICAL-233: a running consumer holds the root its CA copy is and its
# leaf chains to. Issuing under ca/ is safe only when the store shows that root
# and no other, so this runs before anything is published, and a refusal leaves
# every file as it was. Time is not checked: an expired leaf still names the
# root it was issued under.
require_store_issued_under_kept_ca() {
  local index server_set name path label

  for server_set in "${MANAGED_SERVER_SETS[@]}"; do
    name=${server_set%%|*}
    load_server_set "${name}"
    path=${SERVER_SET_CA}
    if path_exists "${path}"; then
      if [ -L "${path}" ] || [ ! -f "${path}" ]; then
        certificate_store_error "${name} server CA certificate is not a regular non-symlink file: ${path}"
        return 1
      fi
      validate_canonical_ca_copy "${path}" "${name} server CA certificate" || return 1
    fi
  done
  for index in "${!MANAGED_LEAF_CERTS[@]}"; do
    path=${MANAGED_LEAF_CERTS[index]}
    label="${MANAGED_LEAF_LABELS[index]} certificate"
    if ! path_exists "${path}"; then
      continue
    fi
    if [ -L "${path}" ] || [ ! -f "${path}" ]; then
      certificate_store_error "${label} is not a regular non-symlink file: ${path}"
      return 1
    fi
    certificate_subject "${path}" "${label}" >/dev/null || return 1
    if ! openssl verify \
      -CAfile "${CERTS_DIR}/ca/ca-cert.pem" \
      -no-CApath \
      -no-CAstore \
      -no_check_time \
      -purpose "${MANAGED_LEAF_PURPOSES[index]}" \
      "${path}" >/dev/null 2>&1; then
      certificate_store_error \
        "${label} was not issued under the kept certificate authority; restore ca/ or replace every identity with --rotate-ca: ${path}"
      return 1
    fi
  done
}

# Prints the label of the first managed leaf inside the renewal window. Runs
# after require_store_issued_under_kept_ca, so every present leaf parses.
first_leaf_due_for_renewal() {
  local index

  for index in "${!MANAGED_LEAF_CERTS[@]}"; do
    if path_exists "${MANAGED_LEAF_CERTS[index]}" && ! openssl x509 \
      -in "${MANAGED_LEAF_CERTS[index]}" \
      -noout \
      -checkend "$((LEAF_RENEWAL_WINDOW_DAYS * 86400))" >/dev/null 2>&1; then
      printf '%s\n' "${MANAGED_LEAF_LABELS[index]}"
      return 0
    fi
  done
  return 1
}

# A leaf that outlives its CA fails every handshake on the CA's notAfter, so no
# leaf is issued under a CA that expires first.
require_ca_outlives_new_leaf() {
  if ! openssl x509 \
    -in "${CERTS_DIR}/ca/ca-cert.pem" \
    -noout \
    -checkend "$((LEAF_VALIDITY_DAYS * 86400))" >/dev/null 2>&1; then
    certificate_store_error \
      "the certificate authority expires before a new ${LEAF_VALIDITY_DAYS}-day leaf would; replace it with --rotate-ca"
    return 1
  fi
}

# Seconds since the epoch at which a certificate stops being valid.
certificate_expiry_epoch() {
  local path="$1" label="$2" not_after

  if ! not_after=$(openssl x509 -in "${path}" -noout -enddate 2>/dev/null); then
    certificate_store_error "${label} has no parseable expiry: ${path}"
    return 1
  fi
  if ! date -u -d "${not_after#notAfter=}" +%s 2>/dev/null; then
    certificate_store_error "${label} expiry '${not_after}' is not a date: ${path}"
    return 1
  fi
}

# Every run that completes states when the earliest managed leaf stops
# verifying and whether the CA can still sign its renewal, so the countdown to a
# renewal (and to the --rotate-ca a CA near its end needs) is in every deploy
# log, not only in the run that acts. A leaf stops verifying at the earlier of
# its own notAfter and its CA's. The renewal starts LEAF_RENEWAL_WINDOW_DAYS
# before the leaf's notAfter, and require_ca_outlives_new_leaf refuses it from
# LEAF_VALIDITY_DAYS before the CA's, so each line is computed from those dates.
report_identity_lifetimes() {
  local index epoch earliest_epoch='' earliest_label='' ca_epoch now
  local last_issue_epoch renewal_epoch renewal leaf_line

  now=$(date -u +%s)
  for index in "${!MANAGED_LEAF_CERTS[@]}"; do
    epoch=$(certificate_expiry_epoch \
      "${MANAGED_LEAF_CERTS[index]}" "${MANAGED_LEAF_LABELS[index]} certificate") || return 1
    if [ -z "${earliest_epoch}" ] || [ "${epoch}" -lt "${earliest_epoch}" ]; then
      earliest_epoch=${epoch}
      earliest_label=${MANAGED_LEAF_LABELS[index]}
    fi
  done
  ca_epoch=$(certificate_expiry_epoch \
    "${CERTS_DIR}/ca/ca-cert.pem" 'certificate authority certificate') || return 1
  last_issue_epoch=$((ca_epoch - LEAF_VALIDITY_DAYS * 86400))
  renewal_epoch=$((earliest_epoch - LEAF_RENEWAL_WINDOW_DAYS * 86400))
  if [ "${renewal_epoch}" -lt "${last_issue_epoch}" ]; then
    renewal="every leaf renews once one is inside ${LEAF_RENEWAL_WINDOW_DAYS} days"
  else
    renewal="its renewal, due from $(date -u -d "@${renewal_epoch}" +%F), falls after the CA's last issuing date and will be refused"
  fi
  leaf_line="earliest leaf: ${earliest_label} certificate, notAfter $(date -u -d "@${earliest_epoch}" +%F)"
  if [ "${ca_epoch}" -lt "${earliest_epoch}" ]; then
    leaf_line+=", but the CA expires first: every leaf stops verifying on $(date -u -d "@${ca_epoch}" +%F) ($(((ca_epoch - now) / 86400)) days left; ${renewal})"
  else
    leaf_line+=" ($(((earliest_epoch - now) / 86400)) days left; ${renewal})"
  fi
  echo "  [expiry] ${leaf_line}"
  if [ "${last_issue_epoch}" -gt "${now}" ]; then
    echo "  [expiry] CA: notAfter $(date -u -d "@${ca_epoch}" +%F) ($(((ca_epoch - now) / 86400)) days left); last date a new leaf can be issued: $(date -u -d "@${last_issue_epoch}" +%F); replace it with --rotate-ca before then"
  else
    echo "  [expiry] CA: notAfter $(date -u -d "@${ca_epoch}" +%F) ($(((ca_epoch - now) / 86400)) days left); it can sign no ${LEAF_VALIDITY_DAYS}-day leaf since $(date -u -d "@${last_issue_epoch}" +%F), so every renewal and new identity is refused: run --rotate-ca now"
  fi
}

require_safe_generation_target() {
  local path="$1" label="$2" actual_uid actual_links

  if ! path_exists "${path}"; then
    return 0
  fi
  if [ -L "${path}" ] || [ ! -f "${path}" ]; then
    certificate_store_error "${label} replacement target is not a regular non-symlink file: ${path}"
    return
  fi
  actual_uid=$(stat -c '%u' -- "${path}")
  actual_links=$(stat -c '%h' -- "${path}")
  if [ "${actual_uid}" != "${CERTIFICATE_OWNER_UID}" ] || [ "${actual_links}" != 1 ]; then
    certificate_store_error "${label} replacement target has unsafe ownership or links: ${path}"
    return
  fi
}

new_certificate_serial() {
  local serial

  serial=$(/usr/bin/od -An -N16 -tx1 /dev/urandom | /usr/bin/tr -d ' \n')
  if [[ ! "${serial}" =~ ^[0-9a-f]{32}$ ]]; then
    certificate_store_error 'could not generate a certificate serial'
    return
  fi
  printf '%s\n' "${serial}"
}

# Publishes DESTINATION as a relative alias of TARGET, a file in the same
# directory that must already be a regular non-symlink file.
publish_postgres_alias() {
  local target="$1" destination="$2" stage_directory stage_alias
  local alias_uid alias_links

  if [ -L "${destination%/*}/${target}" ] || [ ! -f "${destination%/*}/${target}" ]; then
    certificate_store_error "PostgreSQL alias target is not a regular non-symlink file: ${destination%/*}/${target}"
    return
  fi
  create_stage_directory "${destination%/*}/.postgres-alias.XXXXXX"
  stage_directory=${GENERATED_STAGE}
  stage_alias="${stage_directory}/alias"
  ln -s -- "${target}" "${stage_alias}"
  if [ ! -L "${stage_alias}" ] || [ "$(readlink -- "${stage_alias}")" != "${target}" ]; then
    certificate_store_error "could not stage PostgreSQL alias ${destination}"
    return
  fi
  alias_uid=$(stat -c '%u' -- "${stage_alias}")
  alias_links=$(stat -c '%h' -- "${stage_alias}")
  if [ "${alias_uid}:${alias_links}" != "${CERTIFICATE_OWNER_UID}:1" ]; then
    certificate_store_error "staged PostgreSQL alias has unsafe ownership or links: ${destination}"
    return
  fi

  # -T is load-bearing: if a hostile pre-existing destination is a directory,
  # fail instead of following it and creating an alias inside that directory.
  # Replacing a symlink or hard link updates only the directory entry and never
  # opens or mutates its target inode.
  mv -fT -- "${stage_alias}" "${destination}"
  if [ ! -L "${destination}" ] || [ "$(readlink -- "${destination}")" != "${target}" ]; then
    certificate_store_error "published PostgreSQL alias is invalid: ${destination}"
    return
  fi
  alias_uid=$(stat -c '%u' -- "${destination}")
  alias_links=$(stat -c '%h' -- "${destination}")
  if [ "${alias_uid}:${alias_links}" != "${CERTIFICATE_OWNER_UID}:1" ]; then
    certificate_store_error "published PostgreSQL alias has unsafe ownership or links: ${destination}"
    return
  fi
  rmdir -- "${stage_directory}"
}

# Issues, or validates and keeps, the named set of MANAGED_SERVER_SETS; every
# value it issues from is read from that row. Each staged file sits beside the
# path it is published to, so publication is a rename.
generate_server_cert() {
  local name="$1" cn san key_mode dir key_path cert_path ca_path
  local key_stage csr_stage cert_stage ca_stage cert_serial
  load_server_set "${name}"
  cn=${SERVER_SET_CN}
  san=${SERVER_SET_SAN}
  key_mode=${SERVER_SET_KEY_MODE}
  case "${key_mode}" in
    0600|0644) ;;
    *) echo "error: invalid private-key mode for ${name}: ${key_mode}" >&2; exit 1 ;;
  esac
  dir=${SERVER_SET_DIR}
  key_path=${SERVER_SET_KEY}
  cert_path=${SERVER_SET_CERT}
  ca_path=${SERVER_SET_CA}
  assert_certificate_directory "${dir}" "${name} server directory"
  if [ "$RENEW_LEAVES" = false ] && certificate_set_has_any_path \
    "${key_path}" "${cert_path}" "${ca_path}"; then
    validate_existing_server_set "${name}"
    echo "  [skip] ${name}"
    return
  fi
  require_ca_outlives_new_leaf
  require_safe_generation_target "${key_path}" "${name} server private key"
  require_safe_generation_target "${cert_path}" "${name} server certificate"
  require_safe_generation_target "${ca_path}" "${name} server CA certificate"
  create_stage_file "${key_path%/*}/.${key_path##*/}.XXXXXX"
  key_stage=${GENERATED_STAGE}
  create_stage_file "${cert_path%/*}/.${name}.csr.XXXXXX"
  csr_stage=${GENERATED_STAGE}
  create_stage_file "${cert_path%/*}/.${cert_path##*/}.XXXXXX"
  cert_stage=${GENERATED_STAGE}
  create_stage_file "${ca_path%/*}/.${ca_path##*/}.XXXXXX"
  ca_stage=${GENERATED_STAGE}
  cert_serial=$(new_certificate_serial)

  openssl genrsa -out "${key_stage}" 2048 2>/dev/null
  openssl req -new -key "${key_stage}" -out "${csr_stage}" \
    -subj "/CN=${cn}/O=Aquaculture Platform" -addext "subjectAltName=${san}" 2>/dev/null
  openssl x509 -req -days "${LEAF_VALIDITY_DAYS}" -in "${csr_stage}" \
    -CA "${CERTS_DIR}/ca/ca-cert.pem" -CAkey "${CERTS_DIR}/ca/ca-key.pem" \
    -set_serial "0x${cert_serial}" -out "${cert_stage}" -copy_extensions copyall 2>/dev/null
  cp --no-preserve=mode,ownership -- "${CERTS_DIR}/ca/ca-cert.pem" "${ca_stage}"
  # Redis and NATS consume their source keys directly as non-root users. The
  # PostgreSQL key is different: a root entrypoint copies it into a postgres-
  # owned tmpfs, so its persistent source must remain root-only.
  chmod "${key_mode}" "${key_stage}"
  chmod 0644 "${cert_stage}" "${ca_stage}"
  validate_existing_certificate_asset "${key_stage}" "${key_mode}" "staged ${name} server private key"
  validate_existing_certificate_asset "${cert_stage}" 0644 "staged ${name} server certificate"
  validate_existing_certificate_asset "${ca_stage}" 0644 "staged ${name} server CA certificate"
  validate_canonical_ca_copy "${ca_stage}" "staged ${name} server CA certificate"
  validate_certificate_key_pair \
    "${key_stage}" \
    "${cert_stage}" \
    "O=Aquaculture Platform,CN=${cn}" \
    "${CERTS_DIR}/ca/ca-cert.pem" \
    sslserver \
    "staged ${name} server"
  # The private key is the set's commit member: publish it only after the
  # certificate and CA copy are fully staged and cryptographically validated.
  # The deploy path never recreates a consumer until this script succeeds, so
  # an interrupted publication cannot expose a usable mixed identity.
  mv -fT -- "${cert_stage}" "${cert_path}"
  mv -fT -- "${ca_stage}" "${ca_path}"
  mv -fT -- "${key_stage}" "${key_path}"
  echo "  [done] ${name} (CN=${cn})"
}

# SECURITY (HIGH-002 / V4): per-service mTLS client certs.
# nats-tls-enabled.conf runs with `verify_and_map: true` — NATS maps the
# client cert's CN to the matching `users[*].user` entry in nats.conf.
# CN values MUST therefore match the per-service NATS user names exactly:
# auth_service, farm_service, sensor_service, gateway_service, etc.
# A per-service cert + per-service NATS user means a compromised service's
# cert grants ONLY that service's pub/sub permissions — cert rotation is
# also identity rotation, atomically.
generate_per_service_client_cert() {
  local svc_user="$1"  # must match nats.conf users[*].user value exactly
  local out_dir="${CERTS_DIR}/nats/clients"
  local key_path="${out_dir}/${svc_user}-key.pem"
  local cert_path="${out_dir}/${svc_user}-cert.pem"
  local key_stage csr_stage cert_stage cert_serial
  if [[ ! "${svc_user}" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
    certificate_store_error "invalid NATS service certificate identity: ${svc_user}"
    return
  fi
  assert_certificate_directory "${CERTS_DIR}/nats" 'NATS certificate directory'
  assert_certificate_directory "${out_dir}" 'NATS client identity directory'
  if [ "$RENEW_LEAVES" = false ] && certificate_set_has_any_path "${key_path}" "${cert_path}"; then
    validate_existing_client_set \
      "${key_path}" "${cert_path}" "CN=${svc_user}" "${svc_user} client"
    echo "  [skip] ${svc_user} client"
    return
  fi
  require_ca_outlives_new_leaf
  require_safe_generation_target "${key_path}" "${svc_user} client private key"
  require_safe_generation_target "${cert_path}" "${svc_user} client certificate"
  create_stage_file "${out_dir}/.${svc_user}-key.pem.XXXXXX"
  key_stage=${GENERATED_STAGE}
  create_stage_file "${out_dir}/.${svc_user}.csr.XXXXXX"
  csr_stage=${GENERATED_STAGE}
  create_stage_file "${out_dir}/.${svc_user}-cert.pem.XXXXXX"
  cert_stage=${GENERATED_STAGE}
  cert_serial=$(new_certificate_serial)

  openssl genrsa -out "${key_stage}" 2048 2>/dev/null
  # NATS 2.10 verify_and_map uses DistinguishedNameMatch which compares the
  # FULL Subject DN against the user name. Adding /O=... makes the DN
  # "CN=farm_service,O=Aquaculture Platform" which doesn't match the nats.conf
  # user entry "farm_service". CN-only ensures DN == CN == nats.conf user.
  openssl req -new -key "${key_stage}" \
    -out "${csr_stage}" \
    -subj "/CN=${svc_user}" 2>/dev/null
  openssl x509 -req -days "${LEAF_VALIDITY_DAYS}" -in "${csr_stage}" \
    -CA "${CERTS_DIR}/ca/ca-cert.pem" -CAkey "${CERTS_DIR}/ca/ca-key.pem" \
    -set_serial "0x${cert_serial}" -out "${cert_stage}" 2>/dev/null
  chmod 0644 "${key_stage}" "${cert_stage}"
  validate_existing_certificate_asset "${key_stage}" 0644 "staged ${svc_user} client private key"
  validate_existing_certificate_asset "${cert_stage}" 0644 "staged ${svc_user} client certificate"
  validate_certificate_key_pair \
    "${key_stage}" \
    "${cert_stage}" \
    "CN=${svc_user}" \
    "${CERTS_DIR}/ca/ca-cert.pem" \
    sslclient \
    "staged ${svc_user} client"
  # Publish the private key last; it is the usable-identity commit member.
  mv -fT -- "${cert_stage}" "${cert_path}"
  mv -fT -- "${key_stage}" "${key_path}"
  echo "  [done] ${svc_user} client (CN=${svc_user})"
}

echo "=== Generating Internal TLS Certificates ==="

# Per-service mTLS client certs (V4 / verify_and_map identity model).
# CN must match the user name in nats.conf authorization{} block.
#
# SSoT: the service list is DERIVED at runtime from
# infrastructure/nats/services.yaml. DO NOT hand-edit a list here — editing
# services.yaml is the single correct way to add/remove a service cert.
# ADR-015 + BACKLOG-NATS-002: mirrors the pattern used by
# scripts/nats/generate-nats-conf.py so cert CNs and nats.conf users[]
# cannot drift apart.
#
# We use `python3 -c` + PyYAML (same toolchain the sibling generator uses)
# rather than `yq` — Python + PyYAML is preinstalled on GitHub Actions
# ubuntu-latest runners and every supported dev environment, eliminating
# an extra tool dependency. The inline script prints one service name per
# line on stdout, and errors (missing file, malformed YAML, missing
# `services` key, empty list) exit non-zero so `set -e` aborts this script
# — there is NO silent fallback to a hardcoded list.
#
# CI structural guard (.github/workflows/ci-affected.yml Phase A3):
#   grep -q 'python3.*yaml\.safe_load' on this file
# is asserted on every PR. The single-line `python3 -c` invocation below
# co-locates `python3` and `yaml.safe_load` on one physical line so the
# guard reliably catches a regression that re-introduces a hardcoded list.
# Refactors that split the parsing across multiple lines or hide it in a
# heredoc will fail the structural assertion — that is the intended trip
# wire, not a bug to work around.
SERVICES_YAML="${REPO_ROOT}/infrastructure/nats/services.yaml"
if [ ! -f "$SERVICES_YAML" ]; then
  echo "error: ${SERVICES_YAML} not found — cannot derive per-service cert CN list" >&2
  exit 1
fi
# WHY (single-line form) — keeps `python3` and `yaml.safe_load` on one
# physical line for the CI structural assertion above. Validation
# preserved: dict at top level, non-empty `services` list, unique entries,
# and every `name` is a path-safe certificate CN. The compound assertions raise on
# any structural violation, which exits non-zero and (with `set -e`)
# aborts the shell script — NO silent fallback to a hardcoded list.
# WHAT — reads $SERVICES_YAML, validates structure, prints one CN per line
# on stdout, captured into $SERVICE_NAMES for the iteration loop. Uses
# `;` to chain simple statements and a generator-expression `print` so
# the whole pipeline fits in a single -c argument with no heredoc.
SERVICE_NAMES=$(python3 -c "import re, sys, yaml; d = yaml.safe_load(open(sys.argv[1])); assert isinstance(d, dict) and isinstance(d.get('services'), list) and d['services'] and all(isinstance(s, dict) and isinstance(s.get('name'), str) and re.fullmatch(r'[A-Za-z0-9_-]+', s['name']) for s in d['services']), f'malformed services.yaml: {sys.argv[1]} — expected a non-empty service list with path-safe certificate CNs'; names = [s['name'] for s in d['services']]; assert len(names) == len(set(names)), 'duplicate NATS certificate CN'; print('\n'.join(names))" "$SERVICES_YAML")
if [ -z "$SERVICE_NAMES" ]; then
  echo "error: no service names extracted from ${SERVICES_YAML}" >&2
  exit 1
fi
for server_set in "${MANAGED_SERVER_SETS[@]}"; do
  load_server_set "${server_set%%|*}"
  add_managed_leaf "${SERVER_SET_CERT}" "${SERVER_SET_KEY}" sslserver "${server_set%%|*} server"
done
while IFS= read -r svc; do
  [ -n "$svc" ] || continue
  add_managed_leaf \
    "${CERTS_DIR}/nats/clients/${svc}-cert.pem" "${CERTS_DIR}/nats/clients/${svc}-key.pem" \
    sslclient "${svc} client"
done <<< "$SERVICE_NAMES"

CA_DIR="${CERTS_DIR}/ca"
assert_certificate_directory "${CA_DIR}" 'certificate authority directory'
if [ "$ROTATE_CA" = false ] && certificate_set_has_any_path \
  "${CA_DIR}/ca-key.pem" "${CA_DIR}/ca-cert.pem"; then
  validate_existing_certificate_asset "${CA_DIR}/ca-key.pem" 0600 'certificate authority private key'
  validate_existing_certificate_asset "${CA_DIR}/ca-cert.pem" 0644 'certificate authority certificate'
  validate_certificate_authority \
    "${CA_DIR}/ca-key.pem" "${CA_DIR}/ca-cert.pem" 'certificate authority'
  echo "  [skip] CA"
elif [ "$RENEW_LEAVES" = true ] && [ "$ROTATE_CA" = false ]; then
  # Minting a CA here would hand renewed leaves a root no running consumer holds.
  certificate_store_error 'leaf renewal requires an existing validated certificate authority'
  exit 1
elif [ "$ROTATE_CA" = false ] && store_holds_issued_identity; then
  # The consumers still hold the lost CA: a new one published as canonical
  # would refuse every later run against them, and a renewal under it would
  # split each restarted service from them.
  certificate_store_error \
    'the certificate authority is missing but identities issued under one remain; restore ca/ from backup, or replace every identity with --rotate-ca'
  exit 1
else
  require_safe_generation_target "${CA_DIR}/ca-key.pem" 'certificate authority private key'
  require_safe_generation_target "${CA_DIR}/ca-cert.pem" 'certificate authority certificate'
  create_stage_file "${CA_DIR}/.ca-key.pem.XXXXXX"
  CA_KEY_STAGE=${GENERATED_STAGE}
  create_stage_file "${CA_DIR}/.ca-cert.pem.XXXXXX"
  CA_CERT_STAGE=${GENERATED_STAGE}
  openssl genrsa -out "${CA_KEY_STAGE}" 4096 2>/dev/null
  openssl req -new -x509 -days 3650 -key "${CA_KEY_STAGE}" \
    -out "${CA_CERT_STAGE}" -subj "/CN=Aquaculture Internal CA" 2>/dev/null
  chmod 0600 "${CA_KEY_STAGE}"
  chmod 0644 "${CA_CERT_STAGE}"
  validate_existing_certificate_asset "${CA_KEY_STAGE}" 0600 'staged certificate authority private key'
  validate_existing_certificate_asset "${CA_CERT_STAGE}" 0644 'staged certificate authority certificate'
  validate_certificate_authority \
    "${CA_KEY_STAGE}" "${CA_CERT_STAGE}" 'staged certificate authority'
  mv -fT -- "${CA_KEY_STAGE}" "${CA_DIR}/ca-key.pem"
  mv -fT -- "${CA_CERT_STAGE}" "${CA_DIR}/ca-cert.pem"
  echo "  [done] CA (10-year)"
fi
if [ "$ROTATE_CA" = false ]; then
  require_store_issued_under_kept_ca
  if [ "$RENEW_LEAVES" = false ] && due_leaf=$(first_leaf_due_for_renewal); then
    echo "  [renew] ${due_leaf} certificate expires within ${LEAF_RENEWAL_WINDOW_DAYS} days: renewing every leaf under the kept CA"
    RENEW_LEAVES=true
  fi
fi
for server_set in "${MANAGED_SERVER_SETS[@]}"; do
  generate_server_cert "${server_set%%|*}"
done

# Per-service mTLS client certs, one per name derived above from services.yaml.
# One name per line, read without word-splitting or glob expansion: the CN list
# is validated above, and the safe read loop is what nats-invariants pins so a
# later edit cannot quietly reintroduce `for x in $unquoted`.
while IFS= read -r svc; do
  [ -n "$svc" ] || continue
  generate_per_service_client_cert "$svc"
done <<< "$SERVICE_NAMES"

# PostgreSQL expects server.crt, server.key and root.crt. They are published as
# aliases of the postgres row's own files, read from load_server_set, by
# same-directory atomic rename. Canonical production Compose mounts the regular
# source files directly, but these aliases remain for local entrypoints and
# must never follow a hostile target.
load_server_set postgres
publish_postgres_alias "${SERVER_SET_CERT##*/}" "${SERVER_SET_DIR}/server.crt"
publish_postgres_alias "${SERVER_SET_KEY##*/}" "${SERVER_SET_DIR}/server.key"
publish_postgres_alias "${SERVER_SET_CA##*/}" "${SERVER_SET_DIR}/root.crt"
echo "  [done] PostgreSQL symlinks (server.crt → ${SERVER_SET_CERT##*/})"

report_identity_lifetimes

echo "=== Done ==="
