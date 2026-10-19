#!/usr/bin/env bash
#
# Vendor contracts/suderra-edge into a Suderra-OS checkout and write its pin
# (ADR-048 DEC-25).
#
#   scripts/edge/vendor-contracts-to-suderra-os.sh <path-to-Suderra-OS-checkout>
#
# The copy is taken from the last commit that changed contracts/suderra-edge
# (git archive), never from the working tree, so the pinned source_commit
# holds exactly the vendored bytes. The script refuses to run while that
# directory has uncommitted or untracked changes, or while any version's
# SHA256SUMS disagrees with its files. It then replaces
# <Suderra-OS>/contracts/suderra-edge/ wholesale, writes
# <Suderra-OS>/contracts/suderra-edge.digest, and runs the Suderra-OS side
# check (tests/image-contracts/contracts-vendor-digest-test.sh) against the
# result. Committing in Suderra-OS stays a separate, reviewed step.
set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_PATH="contracts/suderra-edge"
SOURCE_REPO="Okan-wqm/aquaculture_platform"

if [ "$#" -ne 1 ]; then
    echo "usage: $0 <path-to-Suderra-OS-checkout>" >&2
    exit 2
fi
DEST_ROOT="$(cd -- "$1" && pwd)"
if [ ! -f "${DEST_ROOT}/ci/build-matrix.yml" ] || [ ! -d "${DEST_ROOT}/tests/image-contracts" ]; then
    echo "ERROR: ${DEST_ROOT} is not a Suderra-OS checkout" >&2
    exit 2
fi

if ! git -C "${REPO_ROOT}" diff --quiet HEAD -- "${SOURCE_PATH}" \
    || [ -n "$(git -C "${REPO_ROOT}" ls-files --others --exclude-standard -- "${SOURCE_PATH}")" ]; then
    echo "ERROR: ${SOURCE_PATH} has uncommitted changes; commit them first so the pin names real bytes" >&2
    exit 1
fi
SOURCE_COMMIT="$(git -C "${REPO_ROOT}" log -1 --format=%H -- "${SOURCE_PATH}")"
if [ -z "${SOURCE_COMMIT}" ]; then
    echo "ERROR: ${SOURCE_PATH} has no commit" >&2
    exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT
git -C "${REPO_ROOT}" archive --format=tar "${SOURCE_COMMIT}" -- "${SOURCE_PATH}" | tar -x -C "${STAGE}"
STAGED="${STAGE}/${SOURCE_PATH}"

PIN_LINES=()
for version_dir in "${STAGED}"/v*/; do
    version_dir="${version_dir%/}"
    version="$(basename -- "${version_dir}")"
    (
        cd -- "${version_dir}"
        sha256sum --check --strict --quiet SHA256SUMS
        listed="$(cut -d' ' -f3- SHA256SUMS)"
        present="$(find . -type f ! -path ./SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort)"
        if [ "${listed}" != "${present}" ]; then
            echo "ERROR: ${version}/SHA256SUMS does not list exactly the files of ${version}/" >&2
            exit 1
        fi
    )
    contract_version="$(tr -d '\n' < "${version_dir}/VERSION")"
    case "${contract_version}" in
        "${version#v}".*) ;;
        *)
            echo "ERROR: ${version}/VERSION ${contract_version} does not match its directory" >&2
            exit 1
            ;;
    esac
    PIN_LINES+=("${version}_version=${contract_version}")
    PIN_LINES+=("${version}_sha256sums_sha256=$(sha256sum "${version_dir}/SHA256SUMS" | cut -d' ' -f1)")
done
if [ "${#PIN_LINES[@]}" -eq 0 ]; then
    echo "ERROR: ${SOURCE_PATH} has no v<N>/ directory" >&2
    exit 1
fi

rm -rf "${DEST_ROOT:?}/${SOURCE_PATH}"
mkdir -p "$(dirname -- "${DEST_ROOT}/${SOURCE_PATH}")"
cp -R "${STAGED}" "${DEST_ROOT}/${SOURCE_PATH}"
{
    echo "# Vendored copy of ${SOURCE_REPO} ${SOURCE_PATH} (ADR-048 DEC-25)."
    echo "# Do not edit the vendored tree or this file: change the contract in"
    echo "# ${SOURCE_REPO} and run scripts/edge/vendor-contracts-to-suderra-os.sh there."
    echo "source_repo=${SOURCE_REPO}"
    echo "source_path=${SOURCE_PATH}"
    echo "source_commit=${SOURCE_COMMIT}"
    printf '%s\n' "${PIN_LINES[@]}"
} > "${DEST_ROOT}/${SOURCE_PATH}.digest"

bash "${DEST_ROOT}/tests/image-contracts/contracts-vendor-digest-test.sh"
echo "vendored ${SOURCE_PATH} at ${SOURCE_COMMIT} into ${DEST_ROOT}"
