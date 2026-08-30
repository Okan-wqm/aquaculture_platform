#!/usr/bin/env bash
# Verify backup/PITR authority from immutable GitHub Actions artifacts and
# Cosign v3 Rekor bundles. DigitalOcean Spaces is checked only as a
# content-addressed audit mirror and never acts as the closure authority.

set +x
set -euo pipefail
umask 077

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
: "${GH_TOKEN:?GH_TOKEN required}"
: "${SPACES_ENDPOINT:?SPACES_ENDPOINT required}"
: "${EVIDENCE_SPACES_BUCKET:?EVIDENCE_SPACES_BUCKET required}"
: "${AWS_ACCESS_KEY_ID:?read-only evidence mirror access key required}"
: "${AWS_SECRET_ACCESS_KEY:?read-only evidence mirror secret required}"
: "${AWS_REGION:?AWS_REGION required}"
: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION required}"
: "${CLOSURE_MAIN_SHA:?CLOSURE_MAIN_SHA required}"

EVIDENCE_OUTPUT_DIR="${EVIDENCE_OUTPUT_DIR:-walg-verified-evidence}"
MAX_HISTORY_RUNS="${MAX_HISTORY_RUNS:-30}"
MAX_BACKUP_EVIDENCE_AGE_SECONDS="${MAX_BACKUP_EVIDENCE_AGE_SECONDS:-345600}"
MAX_PITR_EVIDENCE_AGE_SECONDS="${MAX_PITR_EVIDENCE_AGE_SECONDS:-86400}"
API_VERSION='2022-11-28'
COSIGN_ISSUER='https://token.actions.githubusercontent.com'
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
for command_name in aws base64 cmp cosign curl date gh jq node sha256sum unzip; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "FATAL: ${command_name} is required." >&2
    exit 2
  }
done
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

TMP_DIR=$(mktemp -d -t aqua-walg-github-evidence-XXXXXX)
cleanup() {
  rm -rf -- "${TMP_DIR}"
}
trap cleanup EXIT

gh_api() {
  gh api \
    -H 'Accept: application/vnd.github+json' \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "$@"
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

mirror_verify() {
  local file=$1
  local sha key mirror
  sha=$(sha256sum "${file}" | awk '{print $1}')
  key="wal-g-evidence/v2/sha256/${sha}/$(basename "${file}")"
  mirror="${TMP_DIR}/mirror-${sha}"
  aws s3api get-object \
    --bucket "${EVIDENCE_SPACES_BUCKET}" \
    --key "${key}" \
    --endpoint-url "${SPACES_ENDPOINT}" \
    "${mirror}" >/dev/null
  if ! cmp -s "${file}" "${mirror}"; then
    echo "FATAL: signed artifact and content-addressed mirror differ: ${key}" >&2
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
  cosign verify-blob \
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
  local run_id attempt main_sha event_name artifact_name artifact_json artifact_count
  local artifact_id artifact_digest artifact_zip actual_digest extract_dir entries allowed entry

  run_id=$(jq -er '.id | tostring' "${run_json}")
  attempt=$(jq -er '.run_attempt | tostring' "${run_json}")
  main_sha=$(jq -er '.head_sha' "${run_json}")
  event_name=$(jq -er '.event' "${run_json}")
  artifact_name="walg-evidence-v2-${workflow_file}-${run_id}-${attempt}"
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
    '.artifacts[0]
      | .name == $name
        and .expired == false
        and .workflow_run.id == $run_id
        and .workflow_run.head_branch == "main"
        and .workflow_run.head_sha == $sha
        and (.digest | test("^sha256:[0-9a-f]{64}$"))' \
    "${artifact_json}" >/dev/null || {
      echo "FATAL: artifact identity/digest contract failed for ${artifact_name}." >&2
      exit 1
    }

  artifact_id=$(jq -er '.artifacts[0].id | tostring' "${artifact_json}")
  artifact_digest=$(jq -er '.artifacts[0].digest' "${artifact_json}")
  artifact_zip="${TMP_DIR}/${artifact_name}.zip"
  curl --fail --silent --show-error --location \
    -H 'Accept: application/vnd.github+json' \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "X-GitHub-Api-Version: ${API_VERSION}" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/artifacts/${artifact_id}/zip" \
    --output "${artifact_zip}"
  actual_digest="sha256:$(sha256sum "${artifact_zip}" | awk '{print $1}')"
  if [ "${actual_digest}" != "${artifact_digest}" ]; then
    echo "FATAL: downloaded artifact digest mismatch for ${artifact_name}." >&2
    exit 1
  fi

  entries="${TMP_DIR}/${artifact_name}.entries"
  unzip -Z1 "${artifact_zip}" | sort > "${entries}"
  if [ "$(wc -l < "${entries}")" -lt 2 ] || [ "$(sort -u "${entries}" | wc -l)" -ne "$(wc -l < "${entries}")" ]; then
    echo "FATAL: artifact has missing or duplicate archive members: ${artifact_name}." >&2
    exit 1
  fi
  while IFS= read -r entry; do
    case "${entry}" in
      run-record.json|run-record.sigstore.json|evidence-attestation.json|evidence-attestation.sigstore.json) ;;
      *) echo "FATAL: unsafe or unexpected artifact member: ${entry}" >&2; exit 1 ;;
    esac
  done < "${entries}"

  extract_dir="${TMP_DIR}/extracted-${workflow_file}-${run_id}-${attempt}"
  mkdir -m 0700 "${extract_dir}"
  while IFS= read -r allowed; do
    unzip -p "${artifact_zip}" "${allowed}" > "${extract_dir}/${allowed}"
    chmod 0600 "${extract_dir}/${allowed}"
  done < "${entries}"

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

  while IFS= read -r allowed; do
    mirror_verify "${extract_dir}/${allowed}"
  done < "${entries}"
  DOWNLOADED_ARTIFACT_DIR="${extract_dir}"
}

extract_signed_evidence() {
  local artifact_dir=$1
  local workflow_file=$2
  local workflow_name=$3
  local run_json=$4
  local workflow_json=$5
  local output=$6
  local main_sha event_name
  for required_file in evidence-attestation.json evidence-attestation.sigstore.json; do
    [ -f "${artifact_dir}/${required_file}" ] || {
      echo "FATAL: successful evidence-producing run omits ${required_file}." >&2
      exit 1
    }
  done
  main_sha=$(jq -er '.head_sha' "${run_json}")
  event_name=$(jq -er '.event' "${run_json}")
  verify_cosign_record \
    "${artifact_dir}/evidence-attestation.json" \
    "${artifact_dir}/evidence-attestation.sigstore.json" \
    "${workflow_file}" \
    "${workflow_name}" \
    "${main_sha}" \
    "${event_name}"
  node tools/scripts/database/walg-evidence-attestation.mjs extract-evidence \
    --attestation "${artifact_dir}/evidence-attestation.json" \
    --run-record "${artifact_dir}/run-record.json" \
    --api-run "${run_json}" \
    --api-workflow "${workflow_json}" \
    --output "${output}"
}

VERSIONING_STATUS=$(aws s3api get-bucket-versioning \
  --bucket "${EVIDENCE_SPACES_BUCKET}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query Status \
  --output text)
if [ "${VERSIONING_STATUS}" != 'Enabled' ]; then
  echo 'FATAL: signed evidence mirror bucket versioning must be Enabled.' >&2
  exit 1
fi

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
    "${EVIDENCE_OUTPUT_DIR}/base-${BACKUP_COUNT}.json"
  assert_source_image_authority "${EVIDENCE_OUTPUT_DIR}/base-${BACKUP_COUNT}.json"
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
    "${EVIDENCE_OUTPUT_DIR}/pitr-${PITR_COUNT}.json"
  assert_source_image_authority "${EVIDENCE_OUTPUT_DIR}/pitr-${PITR_COUNT}.json"
  if [ "${PITR_COUNT}" -ge 10 ]; then
    break
  fi
done < <(jq -er '.workflow_runs[].id | tostring' "${PITR_RUNS_JSON}")

if [ "${PITR_COUNT}" -lt 1 ]; then
  echo 'FATAL: no successful signed timestamp-PITR evidence artifact exists.' >&2
  exit 1
fi

node tools/scripts/database/evaluate-walg-evidence.mjs \
  --evidence-dir "${EVIDENCE_OUTPUT_DIR}" \
  --expected-main-sha "${CLOSURE_MAIN_SHA}" \
  --expected-postgres-dr-contract-sha256 "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}"
