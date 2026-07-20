#!/usr/bin/env bash
# Verify backup/PITR authority from immutable GitHub Actions artifacts and
# Cosign v3 Rekor bundles, then stage the exact verified file set for the
# separately credentialed read-only audit-mirror verifier.

set +x
set -euo pipefail
umask 077

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
: "${GH_TOKEN:?GH_TOKEN required}"
: "${CLOSURE_MAIN_SHA:?CLOSURE_MAIN_SHA required}"

for forbidden_credential in \
  AWS_ACCESS_KEY_ID \
  AWS_SECRET_ACCESS_KEY \
  AWS_SESSION_TOKEN \
  AWS_REGION \
  AWS_DEFAULT_REGION \
  SPACES_ENDPOINT \
  EVIDENCE_SPACES_BUCKET; do
  if [ "${!forbidden_credential+x}" = x ]; then
    echo "FATAL: GitHub evidence verifier refuses co-resident credential ${forbidden_credential}." >&2
    exit 2
  fi
done

EVIDENCE_OUTPUT_DIR="${EVIDENCE_OUTPUT_DIR:-walg-verified-evidence}"
MAX_HISTORY_RUNS="${MAX_HISTORY_RUNS:-30}"
MAX_BACKUP_EVIDENCE_AGE_SECONDS="${MAX_BACKUP_EVIDENCE_AGE_SECONDS:-345600}"
MAX_PITR_EVIDENCE_AGE_SECONDS="${MAX_PITR_EVIDENCE_AGE_SECONDS:-86400}"
MAX_STAGED_MIRROR_FILES=65
MAX_STAGED_MIRROR_BYTES=122683392
MAX_STAGED_MANIFEST_BYTES=32768
API_VERSION='2022-11-28'
COSIGN_ISSUER='https://token.actions.githubusercontent.com'
EXPECTED_COSIGN_SHA256='c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74'
DR_CONTRACT_MANIFEST='.github/manifests/postgres-dr-contract.sha256'

if [[ ! "${MAX_HISTORY_RUNS}" =~ ^[1-9][0-9]*$ ]] || [ "${MAX_HISTORY_RUNS}" -gt 100 ]; then
  echo 'FATAL: MAX_HISTORY_RUNS must be an integer in [1,100].' >&2
  exit 2
fi
if [[ ! "${CLOSURE_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'FATAL: CLOSURE_MAIN_SHA must be a lowercase 40-character Git SHA.' >&2
  exit 2
fi
for age_limit in "${MAX_BACKUP_EVIDENCE_AGE_SECONDS}" "${MAX_PITR_EVIDENCE_AGE_SECONDS}"; do
  if [[ ! "${age_limit}" =~ ^[1-9][0-9]*$ ]] || [ "${age_limit}" -gt 2592000 ]; then
    echo 'FATAL: evidence age limits must be integers in [1,2592000].' >&2
    exit 2
  fi
done

github_token_material=${GH_TOKEN}
unset GH_TOKEN

for command_name in awk cmp curl date find gh grep install jq node python3 sed sha256sum sort stat wc; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "FATAL: ${command_name} is required." >&2
    exit 2
  }
done
COSIGN_BIN=$(command -v cosign) || {
  echo 'FATAL: cosign is required.' >&2
  exit 2
}
if [[ "${COSIGN_BIN}" != /* ]] || [ ! -f "${COSIGN_BIN}" ] || [ ! -x "${COSIGN_BIN}" ] || \
   [ "$(sha256sum "${COSIGN_BIN}" | awk '{print $1}')" != "${EXPECTED_COSIGN_SHA256}" ]; then
  echo 'FATAL: installed cosign is not the pinned v3.0.6 Linux amd64 binary.' >&2
  exit 2
fi
readonly COSIGN_BIN
if [ ! -f "${DR_CONTRACT_MANIFEST}" ] || [ -L "${DR_CONTRACT_MANIFEST}" ]; then
  echo 'FATAL: PostgreSQL DR contract manifest must be a regular non-symlink file.' >&2
  exit 2
fi
EXPECTED_DR_CONTRACT_PATHS=$(printf '%s\n' \
  infrastructure/docker/Dockerfile.postgres-walg \
  infrastructure/docker/scripts/postgres-ssl-entrypoint.sh \
  infrastructure/docker/scripts/postgres-walg-healthcheck.sh \
  infrastructure/docker/scripts/walg-archive-command.sh \
  infrastructure/docker/scripts/walg-load-secrets.sh \
  infrastructure/docker/scripts/walg-restore-command.sh \
  infrastructure/docker/scripts/walg-runtime-command.sh)
CANONICAL_DR_CONTRACT_LINE_RE='^[0-9a-f]{64}  [A-Za-z0-9._/-]+$'
ACTUAL_DR_CONTRACT_PATHS=
while IFS= read -r DR_CONTRACT_LINE; do
  if [[ ! "${DR_CONTRACT_LINE}" =~ ${CANONICAL_DR_CONTRACT_LINE_RE} ]]; then
    echo 'FATAL: PostgreSQL DR contract manifest line is not canonical.' >&2
    exit 2
  fi
  DR_CONTRACT_PATH=${DR_CONTRACT_LINE#*  }
  if [ ! -f "${DR_CONTRACT_PATH}" ] || [ -L "${DR_CONTRACT_PATH}" ]; then
    echo "FATAL: PostgreSQL DR contract input is unsafe: ${DR_CONTRACT_PATH}." >&2
    exit 2
  fi
  ACTUAL_DR_CONTRACT_PATHS+="${DR_CONTRACT_PATH}"$'\n'
done < "${DR_CONTRACT_MANIFEST}"
ACTUAL_DR_CONTRACT_PATHS=${ACTUAL_DR_CONTRACT_PATHS%$'\n'}
if [ "${ACTUAL_DR_CONTRACT_PATHS}" != "${EXPECTED_DR_CONTRACT_PATHS}" ]; then
  echo 'FATAL: PostgreSQL DR contract path set or order is invalid.' >&2
  exit 2
fi
sha256sum --strict --check "${DR_CONTRACT_MANIFEST}" >/dev/null
EXPECTED_POSTGRES_DR_CONTRACT_SHA256=$(sha256sum "${DR_CONTRACT_MANIFEST}" | awk '{print $1}')
if [[ ! "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'FATAL: PostgreSQL DR contract manifest digest is invalid.' >&2
  exit 2
fi
if [ -e "${EVIDENCE_OUTPUT_DIR}" ]; then
  echo "FATAL: refusing to overwrite evidence output directory: ${EVIDENCE_OUTPUT_DIR}" >&2
  exit 2
fi
mkdir -m 0700 "${EVIDENCE_OUTPUT_DIR}"
mkdir -m 0700 "${EVIDENCE_OUTPUT_DIR}/objects"

TMP_DIR=$(mktemp -d -t aqua-walg-github-evidence-XXXXXX)
EVALUATION_OUTPUT_DIR="${TMP_DIR}/evaluation"
STAGED_MANIFEST_INPUT="${TMP_DIR}/mirror-manifest.unsorted"
mkdir -m 0700 "${EVALUATION_OUTPUT_DIR}"
: > "${STAGED_MANIFEST_INPUT}"
chmod 0600 "${STAGED_MANIFEST_INPUT}"
cleanup() {
  rm -rf -- "${TMP_DIR}"
}
trap cleanup EXIT

gh_api() {
  GH_TOKEN="${github_token_material}" gh api \
    -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "$@"
}

assert_exact_current_main() {
  local remote_main_sha
  remote_main_sha=$(gh_api "/repos/${GITHUB_REPOSITORY}/git/ref/heads/main" --jq '.object.sha') || return
  [[ "${remote_main_sha}" =~ ^[0-9a-f]{40}$ ]] || return
  [ "${remote_main_sha}" = "${CLOSURE_MAIN_SHA}" ]
}

assert_exact_current_main || {
  echo 'FATAL: closure SHA is not the exact current protected main SHA.' >&2
  exit 1
}

declare -A VERIFIED_SOURCE_IMAGE_AUTHORITIES=()
assert_source_image_authority() {
  local evidence_file=$1
  local source_revision source_contract evidence_main authority_key comparison

  source_revision=$(jq -er '.source_image_revision' "${evidence_file}")
  source_contract=$(jq -er '.source_postgres_dr_contract_sha256' "${evidence_file}")
  evidence_main=$(jq -er '.main_sha' "${evidence_file}")
  if [[ ! "${source_revision}" =~ ^[0-9a-f]{40}$ ]] || \
     [ "${source_revision}" = '0000000000000000000000000000000000000000' ] || \
     [ "${source_contract}" != "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}" ]; then
    echo 'FATAL: evidence source image lacks the current protected DR contract.' >&2
    exit 1
  fi
  authority_key="${source_revision}:${evidence_main}"
  if [ -n "${VERIFIED_SOURCE_IMAGE_AUTHORITIES[${authority_key}]:-}" ]; then
    return
  fi

  comparison="${TMP_DIR}/source-image-compare-${source_revision}-${evidence_main}.json"
  gh_api "/repos/${GITHUB_REPOSITORY}/compare/${source_revision}...${evidence_main}" \
    > "${comparison}"
  if ! jq -e --arg source "${source_revision}" '
    (.status == "ahead" or .status == "identical") and
    .base_commit.sha == $source and
    .merge_base_commit.sha == $source and
    .behind_by == 0
  ' "${comparison}" >/dev/null; then
    echo "FATAL: source image revision is not an ancestor of closure main: ${source_revision}." >&2
    exit 1
  fi
  VERIFIED_SOURCE_IMAGE_AUTHORITIES["${authority_key}"]=1
}

assert_current_run_authority() {
  local run_json=$1
  local max_age_seconds=$2
  local run_sha completed_at completed_epoch now_epoch age_seconds

  run_sha=$(jq -er '.head_sha' "${run_json}")
  completed_at=$(jq -er '.updated_at' "${run_json}")
  completed_epoch=$(date -u -d "${completed_at}" +%s)
  now_epoch=$(date -u +%s)
  age_seconds=$(( now_epoch - completed_epoch ))
  if [ "${age_seconds}" -lt 0 ] || [ "${age_seconds}" -gt "${max_age_seconds}" ]; then
    echo "FATAL: evidence run ${run_sha} is outside the accepted freshness window." >&2
    exit 1
  fi

  if [ "${run_sha}" != "${CLOSURE_MAIN_SHA}" ]; then
    echo "FATAL: evidence SHA ${run_sha} is not the exact current closure SHA ${CLOSURE_MAIN_SHA}." >&2
    exit 1
  fi
}

stage_verified_file() {
  local source_file=$1
  local file_name source_bytes sha object_dir object_path

  if [ ! -f "${source_file}" ] || [ -L "${source_file}" ]; then
    echo "FATAL: refusing to stage an unsafe verified evidence file: ${source_file}." >&2
    exit 1
  fi
  file_name=$(basename "${source_file}")
  case "${file_name}" in
    base-backup.json|timestamp-pitr.json|evidence-attestation.json|evidence-attestation.sigstore.json|run-record.json|run-record.sigstore.json) ;;
    *)
      echo "FATAL: verified evidence file has an unsupported basename: ${file_name}." >&2
      exit 1
      ;;
  esac
  source_bytes=$(stat -c '%s' "${source_file}")
  if [[ ! "${source_bytes}" =~ ^[1-9][0-9]*$ ]] || [ "${source_bytes}" -gt 8388608 ]; then
    echo "FATAL: verified evidence file exceeds its staging bound: ${file_name}." >&2
    exit 1
  fi
  sha=$(sha256sum "${source_file}" | awk '{print $1}')
  if [[ ! "${sha}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "FATAL: verified evidence digest is invalid: ${file_name}." >&2
    exit 1
  fi
  object_dir="${EVIDENCE_OUTPUT_DIR}/objects/${sha}"
  object_path="${object_dir}/${file_name}"
  if [ ! -e "${object_dir}" ]; then
    mkdir -m 0700 "${object_dir}"
  elif [ ! -d "${object_dir}" ] || [ -L "${object_dir}" ]; then
    echo "FATAL: content-addressed staging directory is unsafe: ${object_dir}." >&2
    exit 1
  fi
  if [ -e "${object_path}" ] || [ -L "${object_path}" ]; then
    if [ ! -f "${object_path}" ] || [ -L "${object_path}" ] || \
       ! cmp -s "${source_file}" "${object_path}"; then
      echo "FATAL: content-addressed staging collision: ${object_path}." >&2
      exit 1
    fi
  else
    install -m 0400 -- "${source_file}" "${object_path}"
    if [ -L "${object_path}" ] || ! cmp -s "${source_file}" "${object_path}"; then
      echo "FATAL: staged evidence bytes changed during installation: ${object_path}." >&2
      exit 1
    fi
  fi
  printf '%s  objects/%s/%s\n' "${sha}" "${sha}" "${file_name}" \
    >> "${STAGED_MANIFEST_INPUT}"
}

finalize_staged_manifest() {
  local manifest_path line_count manifest_bytes staged_bytes actual_paths expected_paths
  manifest_path="${EVIDENCE_OUTPUT_DIR}/mirror-manifest.sha256"
  LC_ALL=C sort -u "${STAGED_MANIFEST_INPUT}" > "${manifest_path}"
  chmod 0400 "${manifest_path}"
  line_count=$(wc -l < "${manifest_path}")
  manifest_bytes=$(stat -c '%s' "${manifest_path}")
  if [ "${line_count}" -lt 1 ] || [ "${line_count}" -gt "${MAX_STAGED_MIRROR_FILES}" ] || \
     [ "${manifest_bytes}" -lt 1 ] || [ "${manifest_bytes}" -gt "${MAX_STAGED_MANIFEST_BYTES}" ]; then
    echo 'FATAL: staged evidence manifest exceeds its file-count or byte bound.' >&2
    exit 1
  fi
  if ! awk '
    BEGIN { previous = "" }
    !/^[0-9a-f]{64}  objects\/[0-9a-f]{64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ { exit 1 }
    {
      sha = substr($0, 1, 64)
      path_sha = substr($0, 75, 64)
      if (sha != path_sha || (previous != "" && previous >= $0)) exit 1
      previous = $0
    }
    END { if (NR < 1) exit 1 }
  ' "${manifest_path}"; then
    echo 'FATAL: staged evidence manifest is not canonical.' >&2
    exit 1
  fi
  (
    cd "${EVIDENCE_OUTPUT_DIR}"
    sha256sum --strict --check mirror-manifest.sha256 >/dev/null
  )
  actual_paths="${TMP_DIR}/staged-actual-paths"
  expected_paths="${TMP_DIR}/staged-expected-paths"
  find "${EVIDENCE_OUTPUT_DIR}/objects" -mindepth 2 -maxdepth 2 -type f -printf '%P\n' \
    | LC_ALL=C sort > "${actual_paths}"
  sed -n 's/^[0-9a-f]\{64\}  objects\///p' "${manifest_path}" > "${expected_paths}"
  if ! cmp -s "${actual_paths}" "${expected_paths}" || \
     find "${EVIDENCE_OUTPUT_DIR}" -type l -print -quit | grep -q . || \
     find "${EVIDENCE_OUTPUT_DIR}/objects" -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
    echo 'FATAL: staged evidence tree does not exactly match its manifest.' >&2
    exit 1
  fi
  staged_bytes=$(find "${EVIDENCE_OUTPUT_DIR}/objects" -type f -printf '%s\n' \
    | awk '{ total += $1 } END { print total + 0 }')
  if [ "${staged_bytes}" -gt "${MAX_STAGED_MIRROR_BYTES}" ]; then
    echo 'FATAL: staged evidence tree exceeds its aggregate byte bound.' >&2
    exit 1
  fi
}

verify_cosign_record() {
  local record=$1
  local bundle=$2
  local workflow_file=$3
  local workflow_name=$4
  local main_sha=$5
  local event_name=$6
  local identity
  identity="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/${workflow_file}@refs/heads/main"
  "${COSIGN_BIN}" verify-blob \
    --bundle "${bundle}" \
    --certificate-identity "${identity}" \
    --certificate-oidc-issuer "${COSIGN_ISSUER}" \
    --certificate-github-workflow-name "${workflow_name}" \
    --certificate-github-workflow-ref 'refs/heads/main' \
    --certificate-github-workflow-repository "${GITHUB_REPOSITORY}" \
    --certificate-github-workflow-sha "${main_sha}" \
    --certificate-github-workflow-trigger "${event_name}" \
    "${record}" >/dev/null
}

download_attempt_artifact() {
  local workflow_file=$1
  local workflow_name=$2
  local run_json=$3
  local workflow_json=$4
  local run_id attempt main_sha event_name run_started_at run_updated_at artifact_name artifact_json artifact_count
  local artifact_id artifact_digest artifact_bytes artifact_zip actual_digest extract_dir allowed raw_evidence_file

  run_id=$(jq -er '.id | tostring' "${run_json}")
  attempt=$(jq -er '.run_attempt | tostring' "${run_json}")
  main_sha=$(jq -er '.head_sha' "${run_json}")
  event_name=$(jq -er '.event' "${run_json}")
  run_started_at=$(jq -er '.run_started_at' "${run_json}")
  run_updated_at=$(jq -er '.updated_at' "${run_json}")
  artifact_name="walg-evidence-v3-${workflow_file}-${run_id}-${attempt}"
  artifact_json="${TMP_DIR}/artifact-${workflow_file}-${run_id}-${attempt}.json"
  gh_api "/repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}/artifacts?name=${artifact_name}&per_page=100" \
    > "${artifact_json}"
  artifact_count=$(jq -er '.total_count' "${artifact_json}")
  if [ "${artifact_count}" != '1' ]; then
    echo "FATAL: expected exactly one immutable artifact ${artifact_name}; observed ${artifact_count}." >&2
    exit 1
  fi
  jq -e \
    --arg name "${artifact_name}" \
    --argjson run_id "${run_id}" \
    --arg sha "${main_sha}" \
    --arg run_started_at "${run_started_at}" \
    --arg run_updated_at "${run_updated_at}" \
    '.artifacts[0]
      | .name == $name
        and .expired == false
        and .workflow_run.id == $run_id
        and .workflow_run.head_branch == "main"
        and .workflow_run.head_sha == $sha
        and .created_at >= $run_started_at
        and .created_at <= $run_updated_at
        and (.size_in_bytes > 0 and .size_in_bytes <= 10485760)
        and (.digest | test("^sha256:[0-9a-f]{64}$"))' \
    "${artifact_json}" >/dev/null || {
      echo "FATAL: artifact identity/digest contract failed for ${artifact_name}." >&2
      exit 1
    }

  artifact_id=$(jq -er '.artifacts[0].id | tostring' "${artifact_json}")
  artifact_digest=$(jq -er '.artifacts[0].digest' "${artifact_json}")
  artifact_bytes=$(jq -er '.artifacts[0].size_in_bytes | tostring' "${artifact_json}")
  artifact_zip="${TMP_DIR}/${artifact_name}.zip"
  assert_exact_current_main || {
    echo 'FATAL: main advanced before the signed artifact download boundary.' >&2
    exit 1
  }
  curl --fail --silent --show-error --location --max-filesize 10485760 \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer ${github_token_material}" \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip" \
    --output "${artifact_zip}"
  actual_digest="sha256:$(sha256sum "${artifact_zip}" | awk '{print $1}')"
  if [ "$(stat -c '%s' "${artifact_zip}")" != "${artifact_bytes}" ] || \
     [ "${actual_digest}" != "${artifact_digest}" ]; then
    echo "FATAL: downloaded artifact digest mismatch for ${artifact_name}." >&2
    exit 1
  fi
  if [ "$(stat -c '%s' "${artifact_zip}")" -gt 10485760 ]; then
    echo "FATAL: signed evidence artifact exceeds its archive bound: ${artifact_name}." >&2
    exit 1
  fi
  case "${workflow_file}" in
    backup-production.yml) raw_evidence_file=base-backup.json ;;
    pitr-restore-production.yml) raw_evidence_file=timestamp-pitr.json ;;
    *) echo "FATAL: unsupported evidence workflow: ${workflow_file}." >&2; exit 1 ;;
  esac

  extract_dir="${TMP_DIR}/extracted-${workflow_file}-${run_id}-${attempt}"
  python3 - "${artifact_zip}" "${extract_dir}" "${raw_evidence_file}" <<'PY'
import os
import stat
import sys
import zipfile

archive_path, destination, raw_evidence_file = sys.argv[1:]
minimal = {'run-record.json', 'run-record.sigstore.json'}
full = minimal | {
    raw_evidence_file,
    'evidence-attestation.json',
    'evidence-attestation.sigstore.json',
}
limits = {
    raw_evidence_file: 8388608,
    'evidence-attestation.json': 262144,
    'evidence-attestation.sigstore.json': 262144,
    'run-record.json': 262144,
    'run-record.sigstore.json': 262144,
}
with zipfile.ZipFile(archive_path, 'r') as archive:
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    if len(names) != len(set(names)) or set(names) not in (minimal, full):
        raise SystemExit('signed evidence artifact has an unexpected or duplicate file set')
    total_expanded = 0
    for entry in entries:
        name = entry.filename
        if (
            entry.is_dir()
            or name != os.path.basename(name)
            or '/' in name
            or '\\' in name
            or stat.S_ISLNK(entry.external_attr >> 16)
            or entry.file_size <= 0
            or entry.file_size > limits[name]
        ):
            raise SystemExit(f'unsafe signed evidence artifact entry: {name!r}')
        total_expanded += entry.file_size
    if total_expanded > 9437184:
        raise SystemExit('expanded signed evidence artifact exceeds its bound')
    os.mkdir(destination, 0o700)
    for entry in entries:
        target = os.path.join(destination, entry.filename)
        descriptor = os.open(
            target,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o400,
        )
        written = 0
        with archive.open(entry, 'r') as source, os.fdopen(descriptor, 'wb') as output:
            while True:
                chunk = source.read(65536)
                if not chunk:
                    break
                written += len(chunk)
                if written > limits[entry.filename]:
                    raise SystemExit(f'signed evidence entry exceeded bound: {entry.filename!r}')
                output.write(chunk)
        if written != entry.file_size:
            raise SystemExit(f'signed evidence entry size changed: {entry.filename!r}')
PY

  for allowed in run-record.json run-record.sigstore.json; do
    [ -f "${extract_dir}/${allowed}" ] || {
      echo "FATAL: artifact omits ${allowed}: ${artifact_name}." >&2
      exit 1
    }
  done
  verify_cosign_record \
    "${extract_dir}/run-record.json" \
    "${extract_dir}/run-record.sigstore.json" \
    "${workflow_file}" \
    "${workflow_name}" \
    "${main_sha}" \
    "${event_name}"
  node tools/scripts/database/walg-evidence-attestation.mjs verify-run \
    --run-record "${extract_dir}/run-record.json" \
    --api-run "${run_json}" \
    --api-workflow "${workflow_json}" >/dev/null

  DOWNLOADED_ARTIFACT_DIR="${extract_dir}"
}

extract_signed_evidence() {
  local artifact_dir=$1
  local workflow_file=$2
  local workflow_name=$3
  local run_json=$4
  local workflow_json=$5
  local output=$6
  local main_sha event_name run_id attempt run_started_at run_updated_at raw_file raw_artifact_id raw_artifact_name
  local raw_artifact_digest raw_artifact_created_at raw_artifact_path expected_raw_name raw_metadata raw_zip raw_extract_dir
  local raw_artifact_bytes actual_raw_digest
  for required_file in evidence-attestation.json evidence-attestation.sigstore.json; do
    [ -f "${artifact_dir}/${required_file}" ] || {
      echo "FATAL: successful evidence-producing run omits ${required_file}." >&2
      exit 1
    }
  done
  main_sha=$(jq -er '.head_sha' "${run_json}")
  event_name=$(jq -er '.event' "${run_json}")
  run_id=$(jq -er '.id | tostring' "${run_json}")
  attempt=$(jq -er '.run_attempt | tostring' "${run_json}")
  run_started_at=$(jq -er '.run_started_at' "${run_json}")
  run_updated_at=$(jq -er '.updated_at' "${run_json}")
  case "${workflow_file}" in
    backup-production.yml) raw_file=base-backup.json ;;
    pitr-restore-production.yml) raw_file=timestamp-pitr.json ;;
    *) echo "FATAL: unsupported evidence workflow: ${workflow_file}." >&2; exit 1 ;;
  esac
  [ -f "${artifact_dir}/${raw_file}" ] && [ ! -L "${artifact_dir}/${raw_file}" ] || {
    echo "FATAL: signed artifact omits canonical raw evidence ${raw_file}." >&2
    exit 1
  }
  verify_cosign_record \
    "${artifact_dir}/evidence-attestation.json" \
    "${artifact_dir}/evidence-attestation.sigstore.json" \
    "${workflow_file}" \
    "${workflow_name}" \
    "${main_sha}" \
    "${event_name}"
  raw_artifact_id=$(jq -er '.source_transport.artifact.id | tostring' \
    "${artifact_dir}/evidence-attestation.json")
  raw_artifact_name=$(jq -er '.source_transport.artifact.name' \
    "${artifact_dir}/evidence-attestation.json")
  raw_artifact_digest=$(jq -er '.source_transport.artifact.digest' \
    "${artifact_dir}/evidence-attestation.json")
  raw_artifact_created_at=$(jq -er '.source_transport.artifact.artifact_created_at' \
    "${artifact_dir}/evidence-attestation.json")
  raw_artifact_path=$(jq -er '.source_transport.artifact.path' \
    "${artifact_dir}/evidence-attestation.json")
  expected_raw_name="walg-raw-evidence-v1-${workflow_file}-${run_id}-${attempt}"
  if [[ ! "${raw_artifact_id}" =~ ^[1-9][0-9]*$ ]] || \
     [ "${raw_artifact_name}" != "${expected_raw_name}" ] || \
     [[ ! "${raw_artifact_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
     [[ ! "${raw_artifact_created_at}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || \
     [ "${raw_artifact_path}" != "${raw_file}" ]; then
    echo 'FATAL: signed raw evidence artifact binding is invalid.' >&2
    exit 1
  fi

  raw_metadata="${TMP_DIR}/raw-artifact-${workflow_file}-${run_id}-${attempt}.json"
  gh_api "/repos/${GITHUB_REPOSITORY}/actions/artifacts/${raw_artifact_id}" > "${raw_metadata}"
  jq -e \
    --argjson artifact_id "${raw_artifact_id}" \
    --arg artifact_name "${raw_artifact_name}" \
    --arg artifact_digest "${raw_artifact_digest}" \
    --arg artifact_created_at "${raw_artifact_created_at}" \
    --argjson run_id "${run_id}" \
    --arg main_sha "${main_sha}" \
    --arg run_started_at "${run_started_at}" \
    --arg run_updated_at "${run_updated_at}" '
      .id == $artifact_id
      and .name == $artifact_name
      and .expired == false
      and .digest == $artifact_digest
      and (.size_in_bytes > 0 and .size_in_bytes <= 9437184)
      and .workflow_run.id == $run_id
      and .workflow_run.head_branch == "main"
      and .workflow_run.head_sha == $main_sha
      and .created_at == $artifact_created_at
      and .created_at >= $run_started_at
      and .created_at <= $run_updated_at
    ' "${raw_metadata}" >/dev/null || {
      echo 'FATAL: raw evidence artifact server identity does not match its signed binding.' >&2
      exit 1
    }
  raw_artifact_bytes=$(jq -er '.size_in_bytes | tostring' "${raw_metadata}")
  raw_zip="${TMP_DIR}/${raw_artifact_name}.zip"
  assert_exact_current_main || {
    echo 'FATAL: main advanced before the raw artifact download boundary.' >&2
    exit 1
  }
  curl --fail --silent --show-error --location --max-filesize 9437184 \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer ${github_token_material}" \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${raw_artifact_id}/zip" \
    --output "${raw_zip}"
  actual_raw_digest="sha256:$(sha256sum "${raw_zip}" | awk '{print $1}')"
  if [ "$(stat -c '%s' "${raw_zip}")" != "${raw_artifact_bytes}" ] || \
     [ "${actual_raw_digest}" != "${raw_artifact_digest}" ]; then
    echo 'FATAL: downloaded raw evidence artifact bytes do not match the signed binding.' >&2
    exit 1
  fi
  raw_extract_dir="${TMP_DIR}/raw-${workflow_file}-${run_id}-${attempt}"
  python3 - "${raw_zip}" "${raw_extract_dir}" "${raw_file}" <<'PY'
import os
import stat
import sys
import zipfile

archive_path, destination, expected_name = sys.argv[1:]
with zipfile.ZipFile(archive_path, 'r') as archive:
    entries = archive.infolist()
    if len(entries) != 1 or entries[0].filename != expected_name:
        raise SystemExit('raw evidence artifact has an unexpected file set')
    entry = entries[0]
    if (
        entry.is_dir()
        or expected_name != os.path.basename(expected_name)
        or stat.S_ISLNK(entry.external_attr >> 16)
        or entry.file_size <= 0
        or entry.file_size > 8388608
    ):
        raise SystemExit('raw evidence artifact entry is unsafe')
    os.mkdir(destination, 0o700)
    output_path = os.path.join(destination, expected_name)
    descriptor = os.open(
        output_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o400,
    )
    written = 0
    with archive.open(entry, 'r') as source, os.fdopen(descriptor, 'wb') as output:
        while True:
            chunk = source.read(65536)
            if not chunk:
                break
            written += len(chunk)
            if written > 8388608:
                raise SystemExit('expanded raw evidence exceeds its bound')
            output.write(chunk)
    if written != entry.file_size:
        raise SystemExit('raw evidence entry size changed during extraction')
PY
  if ! cmp -s "${raw_extract_dir}/${raw_file}" "${artifact_dir}/${raw_file}"; then
    echo 'FATAL: signed artifact raw evidence differs from the immutable producer artifact.' >&2
    exit 1
  fi
  node tools/scripts/database/walg-evidence-attestation.mjs extract-evidence \
    --attestation "${artifact_dir}/evidence-attestation.json" \
    --run-record "${artifact_dir}/run-record.json" \
    --api-run "${run_json}" \
    --api-workflow "${workflow_json}" \
    --evidence "${artifact_dir}/${raw_file}" \
    --artifact-id "${raw_artifact_id}" \
    --artifact-name "${raw_artifact_name}" \
    --artifact-digest "${raw_artifact_digest}" \
    --artifact-created-at "${raw_artifact_created_at}" \
    --output "${output}"
  stage_verified_file "${artifact_dir}/run-record.json"
  stage_verified_file "${artifact_dir}/run-record.sigstore.json"
  stage_verified_file "${artifact_dir}/${raw_file}"
  stage_verified_file "${artifact_dir}/evidence-attestation.json"
  stage_verified_file "${artifact_dir}/evidence-attestation.sigstore.json"
}

BACKUP_WORKFLOW_FILE='backup-production.yml'
BACKUP_WORKFLOW_NAME='Backup - Production Postgres'
BACKUP_WORKFLOW_JSON="${TMP_DIR}/backup-workflow.json"
BACKUP_RUNS_JSON="${TMP_DIR}/backup-runs.json"
gh_api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${BACKUP_WORKFLOW_FILE}" > "${BACKUP_WORKFLOW_JSON}"
gh_api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${BACKUP_WORKFLOW_FILE}/runs?branch=main&status=completed&per_page=${MAX_HISTORY_RUNS}" \
  > "${BACKUP_RUNS_JSON}"

BACKUP_COUNT=0
while IFS= read -r RUN_ID; do
  LIST_RUN_JSON="${TMP_DIR}/backup-run-list-${RUN_ID}.json"
  ATTEMPT_RUN_JSON="${TMP_DIR}/backup-run-${RUN_ID}.json"
  jq -e --argjson id "${RUN_ID}" '.workflow_runs[] | select(.id == $id)' "${BACKUP_RUNS_JSON}" \
    > "${LIST_RUN_JSON}"
  ATTEMPT=$(jq -er '.run_attempt | tostring' "${LIST_RUN_JSON}")
  gh_api "/repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}/attempts/${ATTEMPT}" > "${ATTEMPT_RUN_JSON}"
  download_attempt_artifact \
    "${BACKUP_WORKFLOW_FILE}" "${BACKUP_WORKFLOW_NAME}" \
    "${ATTEMPT_RUN_JSON}" "${BACKUP_WORKFLOW_JSON}"
  MODE=$(jq -er '.mode' "${DOWNLOADED_ARTIFACT_DIR}/run-record.json")
  RESULT=$(jq -er '.job_result' "${DOWNLOADED_ARTIFACT_DIR}/run-record.json")
  case "${MODE}" in
    dry_run|bootstrap_only) continue ;;
    full_backup) ;;
    *) echo "FATAL: unexpected backup run mode: ${MODE}" >&2; exit 1 ;;
  esac
  if [ "${RESULT}" != 'success' ]; then
    break
  fi
  assert_current_run_authority "${ATTEMPT_RUN_JSON}" "${MAX_BACKUP_EVIDENCE_AGE_SECONDS}"
  BACKUP_COUNT=$((BACKUP_COUNT + 1))
  extract_signed_evidence \
    "${DOWNLOADED_ARTIFACT_DIR}" \
    "${BACKUP_WORKFLOW_FILE}" "${BACKUP_WORKFLOW_NAME}" \
    "${ATTEMPT_RUN_JSON}" "${BACKUP_WORKFLOW_JSON}" \
    "${EVALUATION_OUTPUT_DIR}/base-${BACKUP_COUNT}.json"
  assert_source_image_authority "${EVALUATION_OUTPUT_DIR}/base-${BACKUP_COUNT}.json"
  if [ "${BACKUP_COUNT}" -eq 3 ]; then
    break
  fi
done < <(jq -er '.workflow_runs[].id | tostring' "${BACKUP_RUNS_JSON}")

if [ "${BACKUP_COUNT}" -ne 3 ]; then
  echo "FATAL: latest uninterrupted full-backup sequence has ${BACKUP_COUNT} success(es); 3 required." >&2
  exit 1
fi

PITR_WORKFLOW_FILE='pitr-restore-production.yml'
PITR_WORKFLOW_NAME='PITR Restore - Production Postgres'
PITR_WORKFLOW_JSON="${TMP_DIR}/pitr-workflow.json"
PITR_RUNS_JSON="${TMP_DIR}/pitr-runs.json"
gh_api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${PITR_WORKFLOW_FILE}" > "${PITR_WORKFLOW_JSON}"
gh_api "/repos/${GITHUB_REPOSITORY}/actions/workflows/${PITR_WORKFLOW_FILE}/runs?branch=main&status=completed&per_page=${MAX_HISTORY_RUNS}" \
  > "${PITR_RUNS_JSON}"

PITR_COUNT=0
while IFS= read -r RUN_ID; do
  LIST_RUN_JSON="${TMP_DIR}/pitr-run-list-${RUN_ID}.json"
  ATTEMPT_RUN_JSON="${TMP_DIR}/pitr-run-${RUN_ID}.json"
  jq -e --argjson id "${RUN_ID}" '.workflow_runs[] | select(.id == $id)' "${PITR_RUNS_JSON}" \
    > "${LIST_RUN_JSON}"
  ATTEMPT=$(jq -er '.run_attempt | tostring' "${LIST_RUN_JSON}")
  gh_api "/repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}/attempts/${ATTEMPT}" > "${ATTEMPT_RUN_JSON}"
  download_attempt_artifact \
    "${PITR_WORKFLOW_FILE}" "${PITR_WORKFLOW_NAME}" \
    "${ATTEMPT_RUN_JSON}" "${PITR_WORKFLOW_JSON}"
  if [ "$(jq -er '.job_result' "${DOWNLOADED_ARTIFACT_DIR}/run-record.json")" != 'success' ]; then
    continue
  fi
  assert_current_run_authority "${ATTEMPT_RUN_JSON}" "${MAX_PITR_EVIDENCE_AGE_SECONDS}"
  PITR_COUNT=$((PITR_COUNT + 1))
  extract_signed_evidence \
    "${DOWNLOADED_ARTIFACT_DIR}" \
    "${PITR_WORKFLOW_FILE}" "${PITR_WORKFLOW_NAME}" \
    "${ATTEMPT_RUN_JSON}" "${PITR_WORKFLOW_JSON}" \
    "${EVALUATION_OUTPUT_DIR}/pitr-${PITR_COUNT}.json"
  assert_source_image_authority "${EVALUATION_OUTPUT_DIR}/pitr-${PITR_COUNT}.json"
  if [ "${PITR_COUNT}" -ge 10 ]; then
    break
  fi
done < <(jq -er '.workflow_runs[].id | tostring' "${PITR_RUNS_JSON}")

if [ "${PITR_COUNT}" -lt 1 ]; then
  echo 'FATAL: no successful signed timestamp-PITR evidence artifact exists.' >&2
  exit 1
fi

assert_exact_current_main || {
  echo 'FATAL: main advanced before WAL-G closure evaluation.' >&2
  exit 1
}
node tools/scripts/database/evaluate-walg-evidence.mjs \
  --evidence-dir "${EVALUATION_OUTPUT_DIR}" \
  --expected-main-sha "${CLOSURE_MAIN_SHA}" \
  --expected-postgres-dr-contract-sha256 "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}"
finalize_staged_manifest
assert_exact_current_main || {
  echo 'FATAL: main advanced while WAL-G closure evidence was being evaluated.' >&2
  exit 1
}
