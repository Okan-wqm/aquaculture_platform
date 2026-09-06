#!/bin/bash
# =============================================================================
# Internal TLS Certificate Generator — Aquaculture Platform
# Usage: ./generate-internal-certs.sh [--renew-leaves|--force]
# Output: ${DEPLOY_CERTS_DIR:-./certs}/{ca,nats,redis,postgres}/
# =============================================================================
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
# Leaf renewal preserves the trust root used by infrastructure containers that
# an application deploy deliberately leaves running. CA rotation is a separate,
# explicit operator operation and cannot be selected by certificate expiry.
FORCE=false
ROTATE_CA=false
RENEW_LEAVES=false
[ "$#" -le 1 ] || { echo "error: expected at most one renewal option" >&2; exit 2; }
case "${1:-}" in
  '') ;;
  --renew-leaves) FORCE=true; RENEW_LEAVES=true ;;
  --force) FORCE=true; ROTATE_CA=true ;;
  *) echo "error: expected --renew-leaves or --force" >&2; exit 2 ;;
esac
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
prepare_certificate_directories \
  "${CERTS_DIR}" \
  "${CERTS_DIR}/ca" \
  "${CERTS_DIR}/nats" \
  "${CERTS_DIR}/nats/clients" \
  "${CERTS_DIR}/redis" \
  "${CERTS_DIR}/postgres"
assert_certificate_directory "${CERTS_DIR}" 'DEPLOY_CERTS_DIR'

validate_existing_server_set() {
  local name="$1" cn="$2" key_mode="$3" dir="$4"

  validate_existing_certificate_asset \
    "${dir}/${name}-key.pem" "${key_mode}" "${name} server private key"
  validate_existing_certificate_asset \
    "${dir}/${name}-cert.pem" 0644 "${name} server certificate"
  validate_existing_certificate_asset \
    "${dir}/ca-cert.pem" 0644 "${name} server CA certificate"
  validate_canonical_ca_copy "${dir}/ca-cert.pem" "${name} server CA certificate"
  validate_certificate_key_pair \
    "${dir}/${name}-key.pem" \
    "${dir}/${name}-cert.pem" \
    "O=Aquaculture Platform,CN=${cn}" \
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

publish_postgres_alias() {
  local target="$1" destination="$2" stage_directory stage_alias
  local alias_uid alias_links

  create_stage_directory "${PG_DIR}/.postgres-alias.XXXXXX"
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

generate_server_cert() {
  local name="$1" cn="$2" san="$3" key_mode="${4:-0644}" dir="${CERTS_DIR}/${1}"
  local key_stage csr_stage cert_stage ca_stage cert_serial
  case "${key_mode}" in
    0600|0644) ;;
    *) echo "error: invalid private-key mode for ${name}: ${key_mode}" >&2; exit 1 ;;
  esac
  assert_certificate_directory "${dir}" "${name} server directory"
  if [ "$FORCE" = false ] && certificate_set_has_any_path \
    "${dir}/${name}-key.pem" "${dir}/${name}-cert.pem" "${dir}/ca-cert.pem"; then
    validate_existing_server_set "${name}" "${cn}" "${key_mode}" "${dir}"
    echo "  [skip] ${name}"
    return
  fi
  require_safe_generation_target "${dir}/${name}-key.pem" "${name} server private key"
  require_safe_generation_target "${dir}/${name}-cert.pem" "${name} server certificate"
  require_safe_generation_target "${dir}/ca-cert.pem" "${name} server CA certificate"
  create_stage_file "${dir}/.${name}-key.pem.XXXXXX"
  key_stage=${GENERATED_STAGE}
  create_stage_file "${dir}/.${name}.csr.XXXXXX"
  csr_stage=${GENERATED_STAGE}
  create_stage_file "${dir}/.${name}-cert.pem.XXXXXX"
  cert_stage=${GENERATED_STAGE}
  create_stage_file "${dir}/.ca-cert.pem.XXXXXX"
  ca_stage=${GENERATED_STAGE}
  cert_serial=$(new_certificate_serial)

  openssl genrsa -out "${key_stage}" 2048 2>/dev/null
  openssl req -new -key "${key_stage}" -out "${csr_stage}" \
    -subj "/CN=${cn}/O=Aquaculture Platform" -addext "subjectAltName=${san}" 2>/dev/null
  openssl x509 -req -days 365 -in "${csr_stage}" \
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
  mv -fT -- "${cert_stage}" "${dir}/${name}-cert.pem"
  mv -fT -- "${ca_stage}" "${dir}/ca-cert.pem"
  mv -fT -- "${key_stage}" "${dir}/${name}-key.pem"
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
  if [ "$FORCE" = false ] && certificate_set_has_any_path "${key_path}" "${cert_path}"; then
    validate_existing_client_set \
      "${key_path}" "${cert_path}" "CN=${svc_user}" "${svc_user} client"
    echo "  [skip] ${svc_user} client"
    return
  fi
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
  openssl x509 -req -days 365 -in "${csr_stage}" \
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
CA_DIR="${CERTS_DIR}/ca"
assert_certificate_directory "${CA_DIR}" 'certificate authority directory'
if [ "$ROTATE_CA" = false ] && certificate_set_has_any_path \
  "${CA_DIR}/ca-key.pem" "${CA_DIR}/ca-cert.pem"; then
  validate_existing_certificate_asset "${CA_DIR}/ca-key.pem" 0600 'certificate authority private key'
  validate_existing_certificate_asset "${CA_DIR}/ca-cert.pem" 0644 'certificate authority certificate'
  validate_certificate_authority \
    "${CA_DIR}/ca-key.pem" "${CA_DIR}/ca-cert.pem" 'certificate authority'
  echo "  [skip] CA"
else
  if [ "$RENEW_LEAVES" = true ]; then
    certificate_store_error 'leaf renewal requires an existing validated certificate authority'
    exit 1
  fi
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
generate_server_cert "nats" "nats" "DNS:nats,DNS:aqua-nats,DNS:localhost"
generate_server_cert "redis" "redis" "DNS:redis,DNS:aqua-redis,DNS:localhost"
generate_server_cert "postgres" "postgres" "DNS:postgres,DNS:aqua-postgres,DNS:localhost" 0600

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
# One name per line, read without word-splitting or glob expansion: the CN list
# is validated above, and the safe read loop is what nats-invariants pins so a
# later edit cannot quietly reintroduce `for x in $unquoted`.
while IFS= read -r svc; do
  [ -n "$svc" ] || continue
  generate_per_service_client_cert "$svc"
done <<< "$SERVICE_NAMES"

# PostgreSQL expects server.crt and server.key (not postgres-cert.pem)
# Publish compatibility aliases by same-directory atomic rename. Canonical
# production Compose mounts the regular source files directly, but these
# aliases remain for local entrypoints and must never follow a hostile target.
PG_DIR="${CERTS_DIR}/postgres"
publish_postgres_alias postgres-cert.pem "${PG_DIR}/server.crt"
publish_postgres_alias postgres-key.pem "${PG_DIR}/server.key"
publish_postgres_alias ca-cert.pem "${PG_DIR}/root.crt"
echo "  [done] PostgreSQL symlinks (server.crt → postgres-cert.pem)"

echo "=== Done ==="
