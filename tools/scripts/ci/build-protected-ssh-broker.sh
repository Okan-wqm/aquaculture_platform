#!/usr/bin/env bash
# Build and test the std-only protected SSH broker, then atomically install the
# resulting binary at the caller-selected absolute path.

set +x
set -euo pipefail
umask 077

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

[ "$#" -eq 0 ] || die 'This command accepts no positional arguments; set OUTPUT_PATH.'
: "${OUTPUT_PATH:?OUTPUT_PATH is required}"

case "${OUTPUT_PATH}" in
  /*) ;;
  *) die 'OUTPUT_PATH must be absolute.' ;;
esac
case "${OUTPUT_PATH}" in
  *$'\n'* | *$'\r'*) die 'OUTPUT_PATH must not contain control characters.' ;;
esac

for required_command in basename dirname install mktemp mv readelf rm rustc sha256sum; do
  command -v "${required_command}" >/dev/null 2>&1 || die "${required_command} is required."
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR}/../../.." && pwd -P)
SOURCE_PATH="${REPO_ROOT}/tools/backup-ssh-broker/main.rs"

[ -f "${SOURCE_PATH}" ] && [ ! -L "${SOURCE_PATH}" ] || \
  die 'Broker source must be a regular non-symlink file.'

OUTPUT_DIR=$(dirname -- "${OUTPUT_PATH}")
OUTPUT_NAME=$(basename -- "${OUTPUT_PATH}")
[ "${OUTPUT_NAME}" != '/' ] && [ "${OUTPUT_NAME}" != '.' ] && [ "${OUTPUT_NAME}" != '..' ] || \
  die 'OUTPUT_PATH must name a file.'
[ -d "${OUTPUT_DIR}" ] && [ ! -L "${OUTPUT_DIR}" ] || \
  die 'OUTPUT_PATH parent must be an existing non-symlink directory.'
if [ -e "${OUTPUT_PATH}" ] || [ -L "${OUTPUT_PATH}" ]; then
  [ -f "${OUTPUT_PATH}" ] && [ ! -L "${OUTPUT_PATH}" ] || \
    die 'Existing OUTPUT_PATH must be a regular non-symlink file.'
fi
[ "${OUTPUT_PATH}" != "${SOURCE_PATH}" ] || die 'OUTPUT_PATH must not replace the broker source.'

BUILD_DIR=$(mktemp -d -t aqua-protected-ssh-broker-build-XXXXXX)
STAGED_OUTPUT=''
cleanup() {
  status=$?
  trap - EXIT
  if [ -n "${STAGED_OUTPUT}" ]; then
    rm -f -- "${STAGED_OUTPUT}"
  fi
  rm -rf -- "${BUILD_DIR}"
  exit "${status}"
}
trap cleanup EXIT

TEST_BINARY="${BUILD_DIR}/broker-tests"
BUILD_BINARY="${BUILD_DIR}/aqua-protected-ssh-broker"
SOURCE_SNAPSHOT="${BUILD_DIR}/main.rs"

install -m 0600 "${SOURCE_PATH}" "${SOURCE_SNAPSHOT}"
read -r SOURCE_SHA256 _ < <(sha256sum --binary "${SOURCE_SNAPSHOT}")
[[ "${SOURCE_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die 'Broker source sha256 is invalid.'

AQUA_BROKER_SOURCE_SHA256="${SOURCE_SHA256}" rustc \
  --edition=2021 \
  --crate-name aqua_protected_ssh_broker \
  --test \
  -D warnings \
  "${SOURCE_SNAPSHOT}" \
  -o "${TEST_BINARY}"
"${TEST_BINARY}"

AQUA_BROKER_SOURCE_SHA256="${SOURCE_SHA256}" rustc \
  --edition=2021 \
  --crate-name aqua_protected_ssh_broker \
  -D warnings \
  -C opt-level=2 \
  -C overflow-checks=yes \
  -C panic=abort \
  -C target-feature=+crt-static \
  "${SOURCE_SNAPSHOT}" \
  -o "${BUILD_BINARY}"

[ -f "${BUILD_BINARY}" ] && [ ! -L "${BUILD_BINARY}" ] && [ -x "${BUILD_BINARY}" ] || \
  die 'rustc did not produce a regular executable broker.'
PROGRAM_HEADERS=$(readelf -l -- "${BUILD_BINARY}") || die 'readelf could not inspect the broker.'
case "${PROGRAM_HEADERS}" in
  *INTERP*) die 'Release broker must not contain an ELF interpreter segment.' ;;
esac
DYNAMIC_SECTION=$(readelf -d -- "${BUILD_BINARY}") || \
  die 'readelf could not inspect the broker dynamic section.'
case "${DYNAMIC_SECTION}" in
  *'(NEEDED)'*) die 'Release broker must not depend on a shared object.' ;;
esac
read -r BUILT_BINARY_SHA256 _ < <(sha256sum --binary "${BUILD_BINARY}")
[[ "${BUILT_BINARY_SHA256}" =~ ^[0-9a-f]{64}$ ]] || die 'Built broker sha256 is invalid.'

read -r CURRENT_SOURCE_SHA256 _ < <(sha256sum --binary "${SOURCE_PATH}")
[ "${CURRENT_SOURCE_SHA256}" = "${SOURCE_SHA256}" ] || \
  die 'Broker source changed while its attested binary was building.'

STAGED_OUTPUT=$(mktemp "${OUTPUT_DIR}/.${OUTPUT_NAME}.staged.XXXXXX")
install -m 0755 "${BUILD_BINARY}" "${STAGED_OUTPUT}"
[ -f "${STAGED_OUTPUT}" ] && [ ! -L "${STAGED_OUTPUT}" ] && [ -x "${STAGED_OUTPUT}" ] || \
  die 'Staged broker is not a regular executable file.'

if [ -e "${OUTPUT_PATH}" ] || [ -L "${OUTPUT_PATH}" ]; then
  [ -f "${OUTPUT_PATH}" ] && [ ! -L "${OUTPUT_PATH}" ] || \
    die 'OUTPUT_PATH changed to an unsafe file type during the build.'
fi
mv -fT -- "${STAGED_OUTPUT}" "${OUTPUT_PATH}"
STAGED_OUTPUT=''

[ -f "${OUTPUT_PATH}" ] && [ ! -L "${OUTPUT_PATH}" ] && [ -x "${OUTPUT_PATH}" ] || \
  die 'Installed broker is not a regular executable file.'
read -r INSTALLED_BINARY_SHA256 _ < <(sha256sum --binary "${OUTPUT_PATH}")
[ "${INSTALLED_BINARY_SHA256}" = "${BUILT_BINARY_SHA256}" ] || \
  die 'Installed broker sha256 does not match the tested binary.'
printf 'BROKER_SOURCE_SHA256=%s\n' "${SOURCE_SHA256}"
printf 'BROKER_BINARY_SHA256=%s\n' "${BUILT_BINARY_SHA256}"
printf 'Protected SSH broker installed at %s\n' "${OUTPUT_PATH}"
