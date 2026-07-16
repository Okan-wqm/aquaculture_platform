#!/bin/bash -p
# Install the attestation-only protected backup SSH login boundary.
#
# This script intentionally grants no backup, PITR, Docker, or sudo execution
# authority. It installs three key-isolated accounts whose static ELF login
# shell can only emit a digest-bound attestation. The later execution cutover
# is a separate fail-closed ceremony.

case $- in
  *p*) ;;
  *)
    printf 'FATAL: invoke this root provisioner directly or with /bin/bash -p.\n' >&2
    exit 2
    ;;
esac

set +x
set -euo pipefail
umask 077
unset BASH_ENV ENV CDPATH GLOBIGNORE
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C

BROKER_INSTALL_PATH=/usr/local/sbin/aqua-protected-ssh-broker
CONFIG_ROOT=/etc/aqua-protected-ssh
AUTHORIZED_KEYS_DIR=${CONFIG_ROOT}/authorized_keys
MAINTENANCE_DROPIN_PATH=/etc/ssh/sshd_config.d/89-aqua-protected-backup-maintenance.conf
SSHD_DROPIN_PATH=/etc/ssh/sshd_config.d/90-aqua-protected-backup.conf
HOME_ROOT=/var/lib/aqua-protected-ssh
LOCK_ROOT=/run/aqua-protected-ssh-provision
LOCK_PATH=${LOCK_ROOT}/provision.lock

# Ubuntu/OpenSSH treats a leading '!' as an inaccessible account. The invalid
# non-hash value recommended by sshd(8) disables password verification without
# blocking the account's explicitly constrained public-key authentication.
PASSWORD_SENTINEL='NP'

ACCOUNTS=(aqua-backup aqua-pitr aqua-wal-freshness)
TOKENS=(aqua-backup-v1 aqua-pitr-v1 aqua-wal-freshness-v1)
TARGETS=("${BROKER_INSTALL_PATH}" "${MAINTENANCE_DROPIN_PATH}" "${SSHD_DROPIN_PATH}")
for account in "${ACCOUNTS[@]}"; do
  TARGETS+=("${AUTHORIZED_KEYS_DIR}/${account}")
done

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

WORK_ROOT=
INPUT_ROOT=
STAGING_ROOT=
ROLLBACK_ROOT=
MUTATION_STARTED=false
COMMITTED=false
SSHD_POLICY_MUTATED=false
NEW_ACCOUNTS=()
NEW_GROUPS=()
CREATED_DIRECTORIES=()
PASSWORD_CHANGED_ACCOUNTS=()
declare -A ORIGINAL_PASSWORD_HASH=()
declare -A ORIGINAL_PASSWORD_LAST_CHANGE=()
LOCK_ROOT_CREATED=false
LOCK_FILE_CREATED=false

rollback() {
  local original_status=$1
  local rollback_failed=0
  local account directory original_hash original_last_change state target target_index

  trap - EXIT HUP INT TERM
  set +e

  if [ "${MUTATION_STARTED}" = true ] && [ "${COMMITTED}" != true ]; then
    for target_index in "${!TARGETS[@]}"; do
      target=${TARGETS[${target_index}]}
      if ! rm -f -- "${target}.new" "${target}.rollback"; then
        printf 'FATAL: rollback could not remove candidate file: %s\n' "${target}" >&2
        rollback_failed=1
      fi
      state=$(<"${ROLLBACK_ROOT}/${target_index}.state")
      if [ "${state}" = present ]; then
        if ! cp -a -- "${ROLLBACK_ROOT}/${target_index}.file" "${target}.rollback" ||
          ! mv -fT -- "${target}.rollback" "${target}"; then
          printf 'FATAL: rollback could not restore protected file: %s\n' "${target}" >&2
          rollback_failed=1
        fi
      elif ! rm -f -- "${target}"; then
        printf 'FATAL: rollback could not remove new protected file: %s\n' "${target}" >&2
        rollback_failed=1
      fi
    done

    for account in "${PASSWORD_CHANGED_ACCOUNTS[@]}"; do
      original_hash=${ORIGINAL_PASSWORD_HASH[${account}]}
      original_last_change=${ORIGINAL_PASSWORD_LAST_CHANGE[${account}]}
      if ! usermod --password "${original_hash}" "${account}"; then
        printf 'FATAL: rollback could not restore password state: %s\n' "${account}" >&2
        rollback_failed=1
      fi
      if ! chage --lastday "${original_last_change}" "${account}"; then
        printf 'FATAL: rollback could not restore password age: %s\n' "${account}" >&2
        rollback_failed=1
      fi
    done

    for ((target_index = ${#NEW_ACCOUNTS[@]} - 1; target_index >= 0; target_index--)); do
      account=${NEW_ACCOUNTS[${target_index}]}
      if getent passwd "${account}" >/dev/null 2>&1 && ! userdel "${account}"; then
        printf 'FATAL: rollback could not remove new account: %s\n' "${account}" >&2
        rollback_failed=1
      fi
    done
    for ((target_index = ${#NEW_GROUPS[@]} - 1; target_index >= 0; target_index--)); do
      account=${NEW_GROUPS[${target_index}]}
      if getent group "${account}" >/dev/null 2>&1 && ! groupdel "${account}"; then
        printf 'FATAL: rollback could not remove new group: %s\n' "${account}" >&2
        rollback_failed=1
      fi
    done
    for ((target_index = ${#CREATED_DIRECTORIES[@]} - 1; target_index >= 0; target_index--)); do
      directory=${CREATED_DIRECTORIES[${target_index}]}
      if [ -e "${directory}" ] && ! rmdir -- "${directory}"; then
        printf 'FATAL: rollback could not remove new protected directory: %s\n' "${directory}" >&2
        rollback_failed=1
      fi
    done

    if [ "${SSHD_POLICY_MUTATED}" = true ]; then
      if ! sshd -t; then
        printf 'FATAL: rollback left sshd configuration invalid.\n' >&2
        rollback_failed=1
      elif ! env -i PATH="${PATH}" LC_ALL=C systemctl reload ssh; then
        printf 'FATAL: rollback could not reload the restored sshd configuration.\n' >&2
        rollback_failed=1
      fi
    fi
  fi

  if [ -n "${WORK_ROOT}" ] && [ -e "${WORK_ROOT}" ] && ! rm -rf -- "${WORK_ROOT}"; then
    printf 'FATAL: could not remove protected provisioner work directory.\n' >&2
    rollback_failed=1
  fi
  if [ "${LOCK_FILE_CREATED}" = true ] && [ -e "${LOCK_PATH}" ] && ! rm -f -- "${LOCK_PATH}"; then
    printf 'FATAL: could not remove the provisioner lock file.\n' >&2
    rollback_failed=1
  fi
  if [ "${LOCK_ROOT_CREATED}" = true ] && [ -e "${LOCK_ROOT}" ] && ! rmdir -- "${LOCK_ROOT}"; then
    printf 'FATAL: could not remove the provisioner lock directory.\n' >&2
    rollback_failed=1
  fi
  exec 9>&-

  if [ "${rollback_failed}" -ne 0 ]; then
    exit 125
  fi
  if [ "${original_status}" -eq 0 ]; then
    exit 1
  fi
  exit "${original_status}"
}

# The cleanup/rollback trap is active before the first provisioner work path exists.
trap 'rollback $?' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$#" -eq 0 ] || die 'This command accepts no positional arguments; use the documented environment inputs.'
[ "${EUID}" -eq 0 ] || die 'The protected SSH broker provisioner must run as root.'

: "${BROKER_BINARY_PATH:?BROKER_BINARY_PATH is required}"
: "${EXPECTED_BROKER_SHA256:?EXPECTED_BROKER_SHA256 is required}"
: "${BACKUP_PUBLIC_KEY_PATH:?BACKUP_PUBLIC_KEY_PATH is required}"
: "${PITR_PUBLIC_KEY_PATH:?PITR_PUBLIC_KEY_PATH is required}"
: "${WAL_FRESHNESS_PUBLIC_KEY_PATH:?WAL_FRESHNESS_PUBLIC_KEY_PATH is required}"

# The five documented inputs remain shell-local. Child processes receive only
# the fixed execution locale and PATH, so systemd/chroot controls, loader
# controls, shell startup variables, and unrelated operator secrets cannot
# change the provisioner's command semantics.
while IFS= read -r inherited_name; do
  case "${inherited_name}" in
    PATH | LC_ALL) ;;
    *) export -n "${inherited_name}" 2>/dev/null || die "Could not sanitize inherited environment: ${inherited_name}" ;;
  esac
done < <(compgen -e)
export PATH LC_ALL

for required_command in \
  awk cat chage chmod cmp cp cut dirname env flock getent grep groupdel id install mkdir mktemp \
  mv od passwd readelf readlink rm rmdir sha256sum ssh-keygen sshd stat sync systemctl \
  tr useradd userdel usermod; do
  command -v "${required_command}" >/dev/null 2>&1 || die "${required_command} is required."
done

[[ "${EXPECTED_BROKER_SHA256}" =~ ^[0-9a-f]{64}$ ]] || \
  die 'EXPECTED_BROKER_SHA256 must be a lowercase SHA-256 digest.'

assert_root_owned_boundary() {
  [ "$#" -eq 1 ] || die 'Internal ownership validation error.'
  local mode path=$1
  [ ! -L "${path}" ] || die "Protected path must not be a symlink: ${path}"
  [ "$(stat -c '%u' -- "${path}")" -eq 0 ] || die "Protected path is not root-owned: ${path}"
  mode=$(stat -c '%a' -- "${path}")
  if (( (8#${mode} & 8#022) != 0 )); then
    die "Protected path is group/world writable: ${path}"
  fi
}

assert_secure_absolute_input() {
  [ "$#" -eq 2 ] || die 'Internal input validation error.'
  local canonical current label=$1 path=$2
  case "${path}" in
    /*) ;;
    *) die "${label} must be an absolute path." ;;
  esac
  case "${path}" in
    *$'\n'* | *$'\r'*) die "${label} contains a control character." ;;
  esac
  [ -f "${path}" ] && [ ! -L "${path}" ] || \
    die "${label} must be a regular non-symlink file."
  canonical=$(readlink -e -- "${path}") || die "${label} cannot be resolved."
  [ "${canonical}" = "${path}" ] || \
    die "${label} must use one canonical path with no symlink ancestor."

  current=${path}
  while :; do
    [ -e "${current}" ] && [ ! -L "${current}" ] || \
      die "${label} has an unsafe ancestor: ${current}"
    assert_root_owned_boundary "${current}"
    [ "${current}" = / ] && break
    current=$(dirname -- "${current}")
  done
}

assert_safe_existing_file() {
  [ "$#" -eq 2 ] || die 'Internal target validation error.'
  local expected_mode=$2 path=$1
  if [ -e "${path}" ] || [ -L "${path}" ]; then
    [ -f "${path}" ] && [ ! -L "${path}" ] || \
      die "Existing protected target is not a regular file: ${path}"
    assert_root_owned_boundary "${path}"
    [ "$(stat -c '%a' -- "${path}")" = "${expected_mode}" ] || \
      die "Existing protected target mode drifted: ${path}"
  fi
}

assert_safe_existing_directory() {
  [ "$#" -eq 1 ] || die 'Internal directory validation error.'
  local path=$1
  if [ -e "${path}" ] || [ -L "${path}" ]; then
    [ -d "${path}" ] && [ ! -L "${path}" ] || \
      die "Existing broker directory is unsafe: ${path}"
    assert_root_owned_boundary "${path}"
    [ "$(stat -c '%a' -- "${path}")" = '755' ] || \
      die "Existing broker directory mode drifted: ${path}"
  fi
}

lookup_local_account_record() {
  [ "$#" -eq 3 ] || die 'Internal local-account lookup error.'
  local account=$1 expected_fields=$2 path=$3
  awk -F: -v account="${account}" -v expected_fields="${expected_fields}" '
    $1 == account {
      if (NF != expected_fields || ++matches != 1) {
        exit 2
      }
      record = $0
    }
    END {
      if (matches == 1) {
        print record
      }
    }
  ' "${path}"
}

effective_policy_denies_account() {
  [ "$#" -eq 2 ] || die 'Internal effective-policy validation error.'
  local account=$1 effective=$2
  printf '%s\n' "${effective}" | awk -v account="${account}" '
    $1 == "denyusers" {
      for (field = 2; field <= NF; field++) {
        if ($field == account) {
          found = 1
        }
      }
    }
    END { exit found ? 0 : 1 }
  '
}

create_protected_directory() {
  [ "$#" -eq 1 ] || die 'Internal directory creation error.'
  local path=$1
  if [ ! -e "${path}" ]; then
    mkdir --mode=0755 -- "${path}"
    CREATED_DIRECTORIES+=("${path}")
  fi
}

assert_secure_absolute_input BROKER_BINARY_PATH "${BROKER_BINARY_PATH}"
assert_secure_absolute_input BACKUP_PUBLIC_KEY_PATH "${BACKUP_PUBLIC_KEY_PATH}"
assert_secure_absolute_input PITR_PUBLIC_KEY_PATH "${PITR_PUBLIC_KEY_PATH}"
assert_secure_absolute_input WAL_FRESHNESS_PUBLIC_KEY_PATH "${WAL_FRESHNESS_PUBLIC_KEY_PATH}"

for parent in /run /usr /usr/local /usr/local/sbin /etc /etc/ssh /etc/ssh/sshd_config.d /var /var/lib /var/tmp; do
  [ -d "${parent}" ] && [ ! -L "${parent}" ] || die "Required parent is unsafe: ${parent}"
  if [ "${parent}" != /var/tmp ]; then
    assert_root_owned_boundary "${parent}"
  else
    [ "$(stat -c '%u' -- "${parent}")" -eq 0 ] || die '/var/tmp is not root-owned.'
    [ "$(stat -c '%a' -- "${parent}")" = '1777' ] || die '/var/tmp must be root-owned mode 1777.'
  fi
done
for local_authority in /etc/passwd /etc/group /etc/shadow; do
  [ -f "${local_authority}" ] && [ ! -L "${local_authority}" ] || \
    die "Local account authority is unsafe: ${local_authority}"
  assert_root_owned_boundary "${local_authority}"
done

if [ ! -e "${LOCK_ROOT}" ]; then
  mkdir --mode=0700 -- "${LOCK_ROOT}"
  LOCK_ROOT_CREATED=true
fi
[ -d "${LOCK_ROOT}" ] && [ ! -L "${LOCK_ROOT}" ] || die 'Provisioner lock directory is unsafe.'
assert_root_owned_boundary "${LOCK_ROOT}"
[ "$(stat -c '%a' -- "${LOCK_ROOT}")" = '700' ] || die 'Provisioner lock directory mode drifted.'
if [ -e "${LOCK_PATH}" ] || [ -L "${LOCK_PATH}" ]; then
  [ -f "${LOCK_PATH}" ] && [ ! -L "${LOCK_PATH}" ] || die 'Provisioner lock file is unsafe.'
  assert_root_owned_boundary "${LOCK_PATH}"
  [ "$(stat -c '%a' -- "${LOCK_PATH}")" = '600' ] || die 'Provisioner lock file mode drifted.'
else
  LOCK_FILE_CREATED=true
fi
exec 9>>"${LOCK_PATH}"
[ -f "${LOCK_PATH}" ] && [ ! -L "${LOCK_PATH}" ] || die 'Provisioner lock file creation failed closed.'
assert_root_owned_boundary "${LOCK_PATH}"
[ "$(stat -c '%a' -- "${LOCK_PATH}")" = '600' ] || die 'Provisioner lock file creation used an unsafe mode.'
flock -n 9 || die 'Another protected SSH broker provisioner is running.'

WORK_ROOT=$(mktemp -d -p /var/tmp aqua-protected-ssh-provision.XXXXXX)
[ -d "${WORK_ROOT}" ] && [ ! -L "${WORK_ROOT}" ] || die 'Could not create a safe provisioner work directory.'
[ "$(stat -c '%u' -- "${WORK_ROOT}")" -eq 0 ] || die 'Provisioner work directory is not root-owned.'
[ "$(stat -c '%a' -- "${WORK_ROOT}")" = '700' ] || die 'Provisioner work directory mode is unsafe.'
INPUT_ROOT=${WORK_ROOT}/inputs
STAGING_ROOT=${WORK_ROOT}/staging
ROLLBACK_ROOT=${WORK_ROOT}/rollback
install -d -o root -g root -m 0700 "${INPUT_ROOT}" "${STAGING_ROOT}" "${ROLLBACK_ROOT}"

# Each external input crosses the trust boundary exactly once. All validation,
# staging, and installation below uses only these root-owned immutable snapshots.
install -o root -g root -m 0500 -- "${BROKER_BINARY_PATH}" "${INPUT_ROOT}/broker"
install -o root -g root -m 0400 -- "${BACKUP_PUBLIC_KEY_PATH}" "${INPUT_ROOT}/backup.pub"
install -o root -g root -m 0400 -- "${PITR_PUBLIC_KEY_PATH}" "${INPUT_ROOT}/pitr.pub"
install -o root -g root -m 0400 -- "${WAL_FRESHNESS_PUBLIC_KEY_PATH}" "${INPUT_ROOT}/wal-freshness.pub"
sync -f "${INPUT_ROOT}"

BROKER_SNAPSHOT=${INPUT_ROOT}/broker
PUBLIC_KEY_PATHS=(
  "${INPUT_ROOT}/backup.pub"
  "${INPUT_ROOT}/pitr.pub"
  "${INPUT_ROOT}/wal-freshness.pub"
)
for snapshot in "${BROKER_SNAPSHOT}" "${PUBLIC_KEY_PATHS[@]}"; do
  [ -f "${snapshot}" ] && [ ! -L "${snapshot}" ] || die 'An input snapshot is not a regular file.'
  [ "$(stat -c '%u:%g' -- "${snapshot}")" = '0:0' ] || die 'An input snapshot is not root-owned.'
done
[ "$(stat -c '%a' -- "${BROKER_SNAPSHOT}")" = '500' ] || die 'Broker snapshot mode is unsafe.'
for snapshot in "${PUBLIC_KEY_PATHS[@]}"; do
  [ "$(stat -c '%a' -- "${snapshot}")" = '400' ] || die 'Public-key snapshot mode is unsafe.'
done

BROKER_SHA256=$(sha256sum --binary "${BROKER_SNAPSHOT}" | awk 'NR == 1 {print $1}')
[ "${BROKER_SHA256}" = "${EXPECTED_BROKER_SHA256}" ] || \
  die 'Broker snapshot does not match EXPECTED_BROKER_SHA256.'
ELF_MAGIC=$(od -An -tx1 -N4 -- "${BROKER_SNAPSHOT}" | awk '{$1=$1; print}' | tr -d ' ')
[ "${ELF_MAGIC}" = '7f454c46' ] || die 'Broker snapshot is not an ELF executable.'
PROGRAM_HEADERS=$(readelf -l -- "${BROKER_SNAPSHOT}") || die 'readelf could not inspect the broker snapshot.'
case "${PROGRAM_HEADERS}" in
  *INTERP*) die 'Broker snapshot is dynamically linked; a static ELF is required.' ;;
esac
DYNAMIC_SECTION=$(readelf -d -- "${BROKER_SNAPSHOT}") || \
  die 'readelf could not inspect the broker snapshot dynamic section.'
case "${DYNAMIC_SECTION}" in
  *'(NEEDED)'*) die 'Broker snapshot depends on a shared object.' ;;
esac

CANONICAL_PUBLIC_KEYS=()
PUBLIC_KEY_FINGERPRINTS=()
for index in "${!PUBLIC_KEY_PATHS[@]}"; do
  key_path=${PUBLIC_KEY_PATHS[${index}]}
  line_count=$(awk 'NF > 0 {count++} END {print count + 0}' "${key_path}")
  [ "${line_count}" -eq 1 ] || die 'Each broker public-key snapshot must contain exactly one non-empty key.'
  key_type=$(awk 'NF > 0 {print $1}' "${key_path}")
  key_body=$(awk 'NF > 0 {print $2}' "${key_path}")
  field_count=$(awk 'NF > 0 {print NF}' "${key_path}")
  [ "${key_type}" = 'ssh-ed25519' ] || die 'Broker public keys must use Ed25519.'
  [ "${field_count}" -ge 2 ] && [ "${field_count}" -le 3 ] || \
    die 'Broker public-key snapshots must not contain options or additional fields.'
  [[ "${key_body}" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || die 'Broker public-key encoding is invalid.'
  canonical_key="${key_type} ${key_body}"
  fingerprint=$(printf '%s\n' "${canonical_key}" | ssh-keygen -lf - -E sha256 | awk 'NR == 1 {print $2}')
  [[ "${fingerprint}" =~ ^SHA256:[A-Za-z0-9+/]{43}$ ]] || \
    die 'Broker public-key fingerprint is not canonical.'
  CANONICAL_PUBLIC_KEYS+=("${canonical_key}")
  PUBLIC_KEY_FINGERPRINTS+=("${fingerprint}")
done

for left in "${!PUBLIC_KEY_FINGERPRINTS[@]}"; do
  for right in "${!PUBLIC_KEY_FINGERPRINTS[@]}"; do
    [ "${left}" -ge "${right}" ] && continue
    [ "${PUBLIC_KEY_FINGERPRINTS[${left}]}" != "${PUBLIC_KEY_FINGERPRINTS[${right}]}" ] || \
      die 'Broker operation public keys must have pairwise-distinct fingerprints.'
  done
done

[ ! -e /etc/ssh/sshrc ] && [ ! -L /etc/ssh/sshrc ] || \
  die '/etc/ssh/sshrc is forbidden because it executes before the protected login shell.'
[ ! -e "${MAINTENANCE_DROPIN_PATH}" ] && [ ! -L "${MAINTENANCE_DROPIN_PATH}" ] || \
  die "Reserved protected-account maintenance policy already exists: ${MAINTENANCE_DROPIN_PATH}"

assert_safe_existing_file "${BROKER_INSTALL_PATH}" 755
assert_safe_existing_file "${SSHD_DROPIN_PATH}" 644
for account in "${ACCOUNTS[@]}"; do
  assert_safe_existing_file "${AUTHORIZED_KEYS_DIR}/${account}" 644
done
for directory in "${CONFIG_ROOT}" "${AUTHORIZED_KEYS_DIR}" "${HOME_ROOT}"; do
  assert_safe_existing_directory "${directory}"
done

for account in "${ACCOUNTS[@]}"; do
  home_path=${HOME_ROOT}/${account}
  assert_safe_existing_directory "${home_path}"
  resolved_passwd_record=$(getent passwd "${account}" || true)
  resolved_group_record=$(getent group "${account}" || true)
  resolved_shadow_record=$(getent shadow "${account}" || true)
  passwd_record=$(lookup_local_account_record "${account}" 7 /etc/passwd) || \
    die "Local passwd authority is ambiguous or malformed: ${account}"
  group_record=$(lookup_local_account_record "${account}" 4 /etc/group) || \
    die "Local group authority is ambiguous or malformed: ${account}"
  shadow_record=$(lookup_local_account_record "${account}" 9 /etc/shadow) || \
    die "Local shadow authority is ambiguous or malformed: ${account}"
  if [ -n "${passwd_record}" ]; then
    [ -n "${group_record}" ] || die "Existing broker account has no private primary group: ${account}"
    [ -n "${shadow_record}" ] || die "Existing broker account has no local shadow record: ${account}"
    [ "${resolved_passwd_record}" = "${passwd_record}" ] && \
      [ "${resolved_group_record}" = "${group_record}" ] && \
      [ "${resolved_shadow_record}" = "${shadow_record}" ] || \
      die "NSS masks the local broker account authority: ${account}"
    record_user=$(printf '%s\n' "${passwd_record}" | cut -d: -f1)
    record_uid=$(printf '%s\n' "${passwd_record}" | cut -d: -f3)
    record_gid=$(printf '%s\n' "${passwd_record}" | cut -d: -f4)
    record_home=$(printf '%s\n' "${passwd_record}" | cut -d: -f6)
    record_shell=$(printf '%s\n' "${passwd_record}" | cut -d: -f7)
    group_gid=$(printf '%s\n' "${group_record}" | cut -d: -f3)
    group_members=$(printf '%s\n' "${group_record}" | cut -d: -f4)
    [ "${record_user}" = "${account}" ] && [ "${record_uid}" -ne 0 ] || \
      die "Existing broker account identity drifted: ${account}"
    [ "$(awk -F: -v uid="${record_uid}" '$3 == uid {count++} END {print count + 0}' /etc/passwd)" -eq 1 ] || \
      die "Existing broker account UID is not unique in local passwd: ${account}"
    [ "$(awk -F: -v gid="${record_gid}" '$3 == gid {count++} END {print count + 0}' /etc/group)" -eq 1 ] || \
      die "Existing broker account GID is not unique in local group: ${account}"
    [ "$(awk -F: -v gid="${record_gid}" '$4 == gid {count++} END {print count + 0}' /etc/passwd)" -eq 1 ] || \
      die "Existing broker account primary GID is shared in local passwd: ${account}"
    [ "${record_gid}" = "${group_gid}" ] && [ "$(id -gn "${account}")" = "${account}" ] || \
      die "Existing broker account primary group drifted: ${account}"
    [ -z "${group_members}" ] && [ "$(id -nG "${account}")" = "${account}" ] || \
      die "Existing broker account has supplementary groups: ${account}"
    [ "${record_home}" = "${home_path}" ] || die "Existing broker account home drifted: ${account}"
    [ "${record_shell}" = "${BROKER_INSTALL_PATH}" ] || \
      die "Existing broker account shell drifted: ${account}"

    shadow_hash=$(printf '%s\n' "${shadow_record}" | cut -d: -f2)
    shadow_last_change=$(printf '%s\n' "${shadow_record}" | cut -d: -f3)
    shadow_inactive=$(printf '%s\n' "${shadow_record}" | cut -d: -f7)
    shadow_expire=$(printf '%s\n' "${shadow_record}" | cut -d: -f8)
    [[ "${shadow_last_change}" =~ ^-?[0-9]+$ ]] || \
      die "Existing broker account password-age state is invalid: ${account}"
    case "${shadow_inactive}" in ''|-1) ;; *) die "Existing broker account has an inactivity expiry: ${account}" ;; esac
    case "${shadow_expire}" in ''|-1) ;; *) die "Existing broker account has an account expiry: ${account}" ;; esac
    if [ "${shadow_hash}" != "${PASSWORD_SENTINEL}" ]; then
      ORIGINAL_PASSWORD_HASH[${account}]=${shadow_hash}
      ORIGINAL_PASSWORD_LAST_CHANGE[${account}]=${shadow_last_change}
    fi
  elif [ -n "${group_record}" ] || [ -n "${shadow_record}" ]; then
    die "Broker group or shadow record exists without its protected account: ${account}"
  elif [ -n "${resolved_passwd_record}" ] || [ -n "${resolved_group_record}" ]; then
    die "A non-local NSS identity collides with the protected broker account: ${account}"
  fi
done

for target_index in "${!TARGETS[@]}"; do
  target=${TARGETS[${target_index}]}
  if [ -e "${target}" ]; then
    printf 'present\n' > "${ROLLBACK_ROOT}/${target_index}.state"
    cp -a -- "${target}" "${ROLLBACK_ROOT}/${target_index}.file"
  else
    printf 'absent\n' > "${ROLLBACK_ROOT}/${target_index}.state"
  fi
done
sync -f "${ROLLBACK_ROOT}"

install -o root -g root -m 0755 "${BROKER_SNAPSHOT}" "${STAGING_ROOT}/broker"
for index in "${!ACCOUNTS[@]}"; do
  printf 'restrict,no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty,no-user-rc,command="%s" %s\n' \
    "${TOKENS[${index}]}" "${CANONICAL_PUBLIC_KEYS[${index}]}" \
    > "${STAGING_ROOT}/${ACCOUNTS[${index}]}.authorized_keys"
  chmod 0644 "${STAGING_ROOT}/${ACCOUNTS[${index}]}.authorized_keys"
done

cat > "${STAGING_ROOT}/sshd-dropin.conf" <<'AQUA_SSHD_POLICY'
PermitUserEnvironment no
Match User aqua-backup,aqua-pitr,aqua-wal-freshness
    ForceCommand none
    ChrootDirectory none
    AuthorizedKeysFile /etc/aqua-protected-ssh/authorized_keys/%u
    AuthorizedKeysCommand none
    AuthorizedPrincipalsCommand none
    AuthorizedPrincipalsFile none
    TrustedUserCAKeys none
    AuthenticationMethods publickey
    PubkeyAuthentication yes
    HostbasedAuthentication no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    GSSAPIAuthentication no
    PermitUserRC no
    DisableForwarding yes
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitTTY no
    MaxSessions 1
Match all
AQUA_SSHD_POLICY
chmod 0644 "${STAGING_ROOT}/sshd-dropin.conf"

cat > "${STAGING_ROOT}/sshd-maintenance.conf" <<'AQUA_SSHD_MAINTENANCE'
DenyUsers aqua-backup aqua-pitr aqua-wal-freshness
AQUA_SSHD_MAINTENANCE
chmod 0644 "${STAGING_ROOT}/sshd-maintenance.conf"

MUTATION_STARTED=true
install -o root -g root -m 0644 \
  "${STAGING_ROOT}/sshd-maintenance.conf" "${MAINTENANCE_DROPIN_PATH}.new"
sync -f "${MAINTENANCE_DROPIN_PATH}.new"
mv -fT -- "${MAINTENANCE_DROPIN_PATH}.new" "${MAINTENANCE_DROPIN_PATH}"
SSHD_POLICY_MUTATED=true

sshd -t || die 'Protected-account maintenance policy failed sshd -t.'
for account in "${ACCOUNTS[@]}"; do
  effective=$(sshd -T -C "user=${account},host=localhost,addr=127.0.0.1") || \
    die "Could not resolve maintenance sshd policy for ${account}."
  effective_policy_denies_account "${account}" "${effective}" || \
    die "Maintenance sshd policy does not deny ${account}."
done
env -i PATH="${PATH}" LC_ALL=C systemctl reload ssh || \
  die 'Could not reload ssh after activating the protected-account maintenance barrier.'

create_protected_directory "${CONFIG_ROOT}"
create_protected_directory "${AUTHORIZED_KEYS_DIR}"
create_protected_directory "${HOME_ROOT}"

install -o root -g root -m 0755 "${STAGING_ROOT}/broker" "${BROKER_INSTALL_PATH}.new"
sync -f "${BROKER_INSTALL_PATH}.new"
mv -fT -- "${BROKER_INSTALL_PATH}.new" "${BROKER_INSTALL_PATH}"

for account in "${ACCOUNTS[@]}"; do
  home_path=${HOME_ROOT}/${account}
  if ! getent passwd "${account}" >/dev/null; then
    NEW_ACCOUNTS+=("${account}")
    NEW_GROUPS+=("${account}")
    useradd --system --user-group --home-dir "${home_path}" --no-create-home \
      --shell "${BROKER_INSTALL_PATH}" --password "${PASSWORD_SENTINEL}" \
      --expiredate -1 --inactive -1 "${account}"
  elif [ "${ORIGINAL_PASSWORD_HASH[${account}]+present}" = present ]; then
    PASSWORD_CHANGED_ACCOUNTS+=("${account}")
    usermod --password "${PASSWORD_SENTINEL}" "${account}"
  fi
  create_protected_directory "${home_path}"
done

for index in "${!ACCOUNTS[@]}"; do
  target=${AUTHORIZED_KEYS_DIR}/${ACCOUNTS[${index}]}
  install -o root -g root -m 0644 \
    "${STAGING_ROOT}/${ACCOUNTS[${index}]}.authorized_keys" "${target}.new"
  sync -f "${target}.new"
  mv -fT -- "${target}.new" "${target}"
done
install -o root -g root -m 0644 "${STAGING_ROOT}/sshd-dropin.conf" "${SSHD_DROPIN_PATH}.new"
sync -f "${SSHD_DROPIN_PATH}.new"
mv -fT -- "${SSHD_DROPIN_PATH}.new" "${SSHD_DROPIN_PATH}"

rm -f -- "${MAINTENANCE_DROPIN_PATH}"
sync -f /etc/ssh/sshd_config.d

sshd -t || die 'Candidate protected SSH configuration failed sshd -t.'
for account in "${ACCOUNTS[@]}"; do
  effective=$(sshd -T -C "user=${account},host=localhost,addr=127.0.0.1") || \
    die "Could not resolve effective sshd policy for ${account}."
  if effective_policy_denies_account "${account}" "${effective}"; then
    die "Final sshd policy still denies protected account: ${account}"
  fi
  for expected in \
    'forcecommand none' \
    'chrootdirectory none' \
    'authorizedkeysfile /etc/aqua-protected-ssh/authorized_keys/%u' \
    'authorizedkeyscommand none' \
    'authorizedprincipalscommand none' \
    'authorizedprincipalsfile none' \
    'trustedusercakeys none' \
    'authenticationmethods publickey' \
    'pubkeyauthentication yes' \
    'hostbasedauthentication no' \
    'passwordauthentication no' \
    'kbdinteractiveauthentication no' \
    'gssapiauthentication no' \
    'permituserenvironment no' \
    'permituserrc no' \
    'disableforwarding yes' \
    'allowagentforwarding no' \
    'allowtcpforwarding no' \
    'x11forwarding no' \
    'permittunnel no' \
    'permittty no' \
    'maxsessions 1'; do
    printf '%s\n' "${effective}" | grep -Fqx -- "${expected}" || \
      die "Effective sshd policy for ${account} omitted: ${expected}"
  done
  home_path=${HOME_ROOT}/${account}
  passwd_record=$(lookup_local_account_record "${account}" 7 /etc/passwd) || \
    die "Activated local passwd authority is ambiguous or malformed: ${account}"
  group_record=$(lookup_local_account_record "${account}" 4 /etc/group) || \
    die "Activated local group authority is ambiguous or malformed: ${account}"
  shadow_record=$(lookup_local_account_record "${account}" 9 /etc/shadow) || \
    die "Activated local shadow authority is ambiguous or malformed: ${account}"
  [ -n "${passwd_record}" ] && [ -n "${group_record}" ] && [ -n "${shadow_record}" ] || \
    die "Activated broker account is not wholly local: ${account}"
  [ "$(getent passwd "${account}" || true)" = "${passwd_record}" ] && \
    [ "$(getent group "${account}" || true)" = "${group_record}" ] && \
    [ "$(getent shadow "${account}" || true)" = "${shadow_record}" ] || \
    die "NSS masks the activated broker account authority: ${account}"
  record_user=$(printf '%s\n' "${passwd_record}" | cut -d: -f1)
  record_uid=$(printf '%s\n' "${passwd_record}" | cut -d: -f3)
  record_gid=$(printf '%s\n' "${passwd_record}" | cut -d: -f4)
  record_home=$(printf '%s\n' "${passwd_record}" | cut -d: -f6)
  record_shell=$(printf '%s\n' "${passwd_record}" | cut -d: -f7)
  group_gid=$(printf '%s\n' "${group_record}" | cut -d: -f3)
  group_members=$(printf '%s\n' "${group_record}" | cut -d: -f4)
  [ "${record_user}" = "${account}" ] && [ "${record_uid}" -ne 0 ] && \
    [ "${record_gid}" = "${group_gid}" ] && [ "${record_home}" = "${home_path}" ] && \
    [ "${record_shell}" = "${BROKER_INSTALL_PATH}" ] && [ -z "${group_members}" ] || \
    die "Activated broker account identity drifted: ${account}"
  [ "$(awk -F: -v uid="${record_uid}" '$3 == uid {count++} END {print count + 0}' /etc/passwd)" -eq 1 ] || \
    die "Activated broker account UID is not unique in local passwd: ${account}"
  [ "$(awk -F: -v gid="${record_gid}" '$3 == gid {count++} END {print count + 0}' /etc/group)" -eq 1 ] || \
    die "Activated broker account GID is not unique in local group: ${account}"
  [ "$(awk -F: -v gid="${record_gid}" '$4 == gid {count++} END {print count + 0}' /etc/passwd)" -eq 1 ] || \
    die "Activated broker account primary GID is shared in local passwd: ${account}"
  [ "$(id -gn "${account}")" = "${account}" ] && [ "$(id -nG "${account}")" = "${account}" ] || \
    die "Broker account gained an unauthorized group: ${account}"
  shadow_hash=$(printf '%s\n' "${shadow_record}" | cut -d: -f2)
  [ "${shadow_hash}" = "${PASSWORD_SENTINEL}" ] || \
    die "Broker account password sentinel drifted: ${account}"
  password_state=$(passwd -S "${account}" | awk 'NR == 1 {print $2}')
  case "${password_state}" in P|PS) ;; *) die "Broker account is invalid for public-key SSH: ${account}" ;; esac
done

[ "$(stat -c '%u:%g:%a' -- "${BROKER_INSTALL_PATH}")" = '0:0:755' ] || \
  die 'Installed broker ownership or mode drifted.'
[ "$(sha256sum --binary "${BROKER_INSTALL_PATH}" | awk 'NR == 1 {print $1}')" = "${BROKER_SHA256}" ] || \
  die 'Installed broker digest drifted after activation.'
for index in "${!ACCOUNTS[@]}"; do
  target=${AUTHORIZED_KEYS_DIR}/${ACCOUNTS[${index}]}
  [ "$(stat -c '%u:%g:%a' -- "${target}")" = '0:0:644' ] || \
    die "Installed authorized-key ownership or mode drifted: ${ACCOUNTS[${index}]}"
  cmp --silent "${STAGING_ROOT}/${ACCOUNTS[${index}]}.authorized_keys" "${target}" || \
    die "Installed authorized-key policy drifted: ${ACCOUNTS[${index}]}"
done

env -i PATH="${PATH}" LC_ALL=C systemctl reload ssh || \
  die 'Could not reload ssh after protected broker validation.'
COMMITTED=true
if ! rm -rf -- "${WORK_ROOT}"; then
  die 'Could not remove protected provisioner work directory after commit.'
fi
WORK_ROOT=
if [ "${LOCK_FILE_CREATED}" = true ]; then
  rm -f -- "${LOCK_PATH}"
fi
if [ "${LOCK_ROOT_CREATED}" = true ]; then
  rmdir -- "${LOCK_ROOT}"
fi
exec 9>&-
trap - EXIT HUP INT TERM

printf 'BROKER_BINARY_SHA256=%s\n' "${BROKER_SHA256}"
printf 'BACKUP_BROKER_SSH_KEY_FINGERPRINT=%s\n' "${PUBLIC_KEY_FINGERPRINTS[0]}"
printf 'PITR_BROKER_SSH_KEY_FINGERPRINT=%s\n' "${PUBLIC_KEY_FINGERPRINTS[1]}"
printf 'WAL_FRESHNESS_BROKER_SSH_KEY_FINGERPRINT=%s\n' "${PUBLIC_KEY_FINGERPRINTS[2]}"
printf 'Protected SSH broker substrate installed; execution cutover remains disabled.\n'
