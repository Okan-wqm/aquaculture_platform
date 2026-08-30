#!/usr/bin/env bash
# Rebuild the immutable signed-evidence transfer artifact in a job that has
# GitHub read authority but no OIDC, production secrets, or mirror write key.

set +x
set -euo pipefail
umask 077

: "${GH_TOKEN:?GH_TOKEN required}"
: "${EVIDENCE_WORKFLOW_FILE:?EVIDENCE_WORKFLOW_FILE required}"
: "${EVIDENCE_WORKFLOW_NAME:?EVIDENCE_WORKFLOW_NAME required}"
: "${EVIDENCE_JOB_RESULT:?EVIDENCE_JOB_RESULT required}"
: "${EVIDENCE_RUN_MODE:?EVIDENCE_RUN_MODE required}"
: "${SIGNED_RUN_RECORD_HEX:?SIGNED_RUN_RECORD_HEX required}"
: "${SIGNED_RUN_BUNDLE_HEX:?SIGNED_RUN_BUNDLE_HEX required}"
: "${SIGNED_EVIDENCE_ATTESTATION_HEX+x}"
: "${SIGNED_EVIDENCE_BUNDLE_HEX+x}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
: "${GITHUB_REF:?GITHUB_REF required}"
: "${GITHUB_REF_PROTECTED:?GITHUB_REF_PROTECTED required}"
: "${GITHUB_SHA:?GITHUB_SHA required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT required}"
: "${GITHUB_EVENT_NAME:?GITHUB_EVENT_NAME required}"

case "${EVIDENCE_WORKFLOW_FILE}" in
  backup-production.yml)
    [ "${EVIDENCE_WORKFLOW_NAME}" = 'Backup - Production Postgres' ] || exit 2
    RAW_EVIDENCE_FILE=base-backup.json
    EVIDENCE_PRODUCING_MODE=full_backup
    ;;
  pitr-restore-production.yml)
    [ "${EVIDENCE_WORKFLOW_NAME}" = 'PITR Restore - Production Postgres' ] || exit 2
    RAW_EVIDENCE_FILE=timestamp-pitr.json
    EVIDENCE_PRODUCING_MODE=timestamp_pitr
    ;;
  *)
    printf 'FATAL: unsupported evidence workflow: %s\n' "${EVIDENCE_WORKFLOW_FILE}" >&2
    exit 2
    ;;
esac

case "${EVIDENCE_JOB_RESULT}" in
  success | failure | cancelled | skipped) ;;
  *) printf 'FATAL: invalid producer job result.\n' >&2; exit 2 ;;
esac

github_token_material=${GH_TOKEN}
unset GH_TOKEN GITHUB_TOKEN ACTIONS_RUNTIME_TOKEN

assert_exact_current_main() {
  local remote_main_sha
  remote_main_sha="$(GH_TOKEN="${github_token_material}" gh api \
    "repos/${GITHUB_REPOSITORY}/git/ref/heads/main" \
    --jq '.object.sha')" || return
  [[ "${remote_main_sha}" =~ ^[0-9a-f]{40}$ ]] || return
  [ "${remote_main_sha}" = "${GITHUB_SHA}" ]
}

[ "${GITHUB_REF}" = 'refs/heads/main' ]
[ "${GITHUB_REF_PROTECTED}" = 'true' ]
[[ "${GITHUB_RUN_ID}" =~ ^[1-9][0-9]*$ ]]
[[ "${GITHUB_RUN_ATTEMPT}" =~ ^[1-9][0-9]*$ ]]
assert_exact_current_main

[ ! -e evidence-artifact ] && [ ! -L evidence-artifact ]
mkdir -m 0700 evidence-artifact
python3 - evidence-artifact <<'PY'
import os
import re
import sys

destination = sys.argv[1]
specs = (
    ('SIGNED_RUN_RECORD_HEX', 'run-record.json', 16384, True),
    ('SIGNED_RUN_BUNDLE_HEX', 'run-record.sigstore.json', 49152, True),
    ('SIGNED_EVIDENCE_ATTESTATION_HEX', 'evidence-attestation.json', 16384, False),
    ('SIGNED_EVIDENCE_BUNDLE_HEX', 'evidence-attestation.sigstore.json', 49152, False),
)
optional_presence = []
for variable, filename, max_bytes, required in specs:
    value = os.environ.get(variable, '')
    present = bool(value)
    if required and not present:
        raise SystemExit(f'{variable} is required')
    if not required:
        optional_presence.append(present)
    if not present:
        continue
    if (
        len(value) % 2 != 0
        or len(value) > max_bytes * 2
        or re.fullmatch(r'[0-9a-f]+', value) is None
    ):
        raise SystemExit(f'{variable} is not bounded canonical lowercase hex')
    payload = bytes.fromhex(value)
    if not payload or len(payload) > max_bytes:
        raise SystemExit(f'{variable} decoded length is invalid')
    path = os.path.join(destination, filename)
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o400,
    )
    with os.fdopen(descriptor, 'wb') as output:
        output.write(payload)
if len(set(optional_presence)) != 1:
    raise SystemExit('evidence attestation and bundle must be present or absent together')
PY

test -z "$(find evidence-artifact -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
COSIGN_PATH="$(command -v cosign)"
test -f "${COSIGN_PATH}"
test ! -L "${COSIGN_PATH}"
test "$(sha256sum "${COSIGN_PATH}" | awk '{print $1}')" = \
  'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74'
ATTESTATION_TOOL=tools/scripts/database/walg-evidence-attestation.mjs
EVALUATOR_TOOL=tools/scripts/database/evaluate-walg-evidence.mjs
test -f "${ATTESTATION_TOOL}"
test ! -L "${ATTESTATION_TOOL}"
test "$(sha256sum "${ATTESTATION_TOOL}" | awk '{print $1}')" = \
  '13e901b60be9b306d225c0a45fab3337b84f0b73c7056b96c110e3f0a1362a46'
test -f "${EVALUATOR_TOOL}"
test ! -L "${EVALUATOR_TOOL}"
test "$(sha256sum "${EVALUATOR_TOOL}" | awk '{print $1}')" = \
  '4ffc7a7455b806ffe81975fce8bc877c2dacfdf3e522fb17f322077208a41650'
node --check "${ATTESTATION_TOOL}"
node --check "${EVALUATOR_TOOL}"

node "${ATTESTATION_TOOL}" verify-local-run \
  --run-record evidence-artifact/run-record.json \
  --workflow "${EVIDENCE_WORKFLOW_FILE}" \
  --workflow-name "${EVIDENCE_WORKFLOW_NAME}" \
  --repository "${GITHUB_REPOSITORY}" \
  --ref "${GITHUB_REF}" \
  --sha "${GITHUB_SHA}" \
  --run-id "${GITHUB_RUN_ID}" \
  --run-attempt "${GITHUB_RUN_ATTEMPT}" \
  --event-name "${GITHUB_EVENT_NAME}" \
  --job-result "${EVIDENCE_JOB_RESULT}" \
  --mode "${EVIDENCE_RUN_MODE}" >/dev/null

IDENTITY="https://github.com/${GITHUB_REPOSITORY}/.github/workflows/${EVIDENCE_WORKFLOW_FILE}@refs/heads/main"
cosign verify-blob \
  --bundle evidence-artifact/run-record.sigstore.json \
  --certificate-identity "${IDENTITY}" \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --certificate-github-workflow-repository "${GITHUB_REPOSITORY}" \
  --certificate-github-workflow-ref 'refs/heads/main' \
  --certificate-github-workflow-sha "${GITHUB_SHA}" \
  --certificate-github-workflow-trigger "${GITHUB_EVENT_NAME}" \
  --certificate-github-workflow-name "${EVIDENCE_WORKFLOW_NAME}" \
  evidence-artifact/run-record.json >/dev/null

if [ -f evidence-artifact/evidence-attestation.json ]; then
  [ "${EVIDENCE_JOB_RESULT}" = 'success' ]
  [ "${EVIDENCE_RUN_MODE}" = "${EVIDENCE_PRODUCING_MODE}" ]
  cosign verify-blob \
    --bundle evidence-artifact/evidence-attestation.sigstore.json \
    --certificate-identity "${IDENTITY}" \
    --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --certificate-github-workflow-repository "${GITHUB_REPOSITORY}" \
    --certificate-github-workflow-ref 'refs/heads/main' \
    --certificate-github-workflow-sha "${GITHUB_SHA}" \
    --certificate-github-workflow-trigger "${GITHUB_EVENT_NAME}" \
    --certificate-github-workflow-name "${EVIDENCE_WORKFLOW_NAME}" \
    evidence-artifact/evidence-attestation.json >/dev/null

  RAW_BINDING="$(jq -er \
    '[.source_transport.artifact.id, .source_transport.artifact.name, .source_transport.artifact.digest, .source_transport.artifact.artifact_created_at, .source_transport.artifact.path] | @tsv' \
    evidence-artifact/evidence-attestation.json)"
  IFS=$'\t' read -r RAW_ARTIFACT_ID RAW_ARTIFACT_NAME RAW_ARTIFACT_DIGEST \
    RAW_ARTIFACT_CREATED_AT RAW_ARTIFACT_PATH <<< "${RAW_BINDING}"
  [[ "${RAW_ARTIFACT_ID}" =~ ^[1-9][0-9]*$ ]]
  [ "${RAW_ARTIFACT_NAME}" = \
    "walg-raw-evidence-v1-${EVIDENCE_WORKFLOW_FILE}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}" ]
  [[ "${RAW_ARTIFACT_DIGEST}" =~ ^sha256:[0-9a-f]{64}$ ]]
  [ "${RAW_ARTIFACT_PATH}" = "${RAW_EVIDENCE_FILE}" ]

  ATTEMPT_STARTED_AT="$(GH_TOKEN="${github_token_material}" gh api \
    "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}" \
    --jq '.run_started_at')"
  ATTEMPT_STARTED_EPOCH="$(date -u -d "${ATTEMPT_STARTED_AT}" +%s)"
  RAW_METADATA="$(GH_TOKEN="${github_token_material}" gh api \
    "repos/${GITHUB_REPOSITORY}/actions/artifacts/${RAW_ARTIFACT_ID}" \
    --jq '[.id, .name, .expired, .digest, .size_in_bytes, .created_at, .workflow_run.id, .workflow_run.head_branch, .workflow_run.head_sha] | @tsv')"
  IFS=$'\t' read -r OBSERVED_ID OBSERVED_NAME OBSERVED_EXPIRED OBSERVED_DIGEST \
    OBSERVED_BYTES OBSERVED_CREATED_AT OBSERVED_RUN_ID OBSERVED_BRANCH \
    OBSERVED_HEAD_SHA <<< "${RAW_METADATA}"
  [ "${OBSERVED_ID}" = "${RAW_ARTIFACT_ID}" ]
  [ "${OBSERVED_NAME}" = "${RAW_ARTIFACT_NAME}" ]
  [ "${OBSERVED_EXPIRED}" = 'false' ]
  [ "${OBSERVED_DIGEST}" = "${RAW_ARTIFACT_DIGEST}" ]
  [[ "${OBSERVED_BYTES}" =~ ^[1-9][0-9]*$ ]]
  [ "${OBSERVED_BYTES}" -le 9437184 ]
  [ "${OBSERVED_CREATED_AT}" = "${RAW_ARTIFACT_CREATED_AT}" ]
  OBSERVED_CREATED_EPOCH="$(date -u -d "${OBSERVED_CREATED_AT}" +%s)"
  NOW_EPOCH="$(date -u +%s)"
  [ "${OBSERVED_CREATED_EPOCH}" -ge "${ATTEMPT_STARTED_EPOCH}" ]
  [ "${OBSERVED_CREATED_EPOCH}" -le "$((NOW_EPOCH + 60))" ]
  [ "${OBSERVED_RUN_ID}" = "${GITHUB_RUN_ID}" ]
  [ "${OBSERVED_BRANCH}" = 'main' ]
  [ "${OBSERVED_HEAD_SHA}" = "${GITHUB_SHA}" ]

  assert_exact_current_main
  GH_TOKEN="${github_token_material}" gh api \
    "repos/${GITHUB_REPOSITORY}/actions/artifacts/${RAW_ARTIFACT_ID}/zip" \
    | /usr/bin/head -c 9437185 > raw-evidence.zip
  [ "$(stat -c '%s' raw-evidence.zip)" = "${OBSERVED_BYTES}" ]
  [ "sha256:$(sha256sum raw-evidence.zip | awk '{print $1}')" = \
    "${RAW_ARTIFACT_DIGEST}" ]
  python3 - raw-evidence.zip "evidence-artifact/${RAW_EVIDENCE_FILE}" \
    "${RAW_EVIDENCE_FILE}" <<'PY'
import os
import stat
import sys
import zipfile

archive_path, output_path, expected_name = sys.argv[1:]
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
  rm -f raw-evidence.zip
  node "${ATTESTATION_TOOL}" verify-binding \
    --attestation evidence-artifact/evidence-attestation.json \
    --run-record evidence-artifact/run-record.json \
    --evidence "evidence-artifact/${RAW_EVIDENCE_FILE}" \
    --artifact-id "${RAW_ARTIFACT_ID}" \
    --artifact-name "${RAW_ARTIFACT_NAME}" \
    --artifact-digest "${RAW_ARTIFACT_DIGEST}" \
    --artifact-created-at "${RAW_ARTIFACT_CREATED_AT}" >/dev/null
else
  [ ! -e evidence-artifact/evidence-attestation.sigstore.json ]
  if [ "${EVIDENCE_JOB_RESULT}" = 'success' ] && \
     [ "${EVIDENCE_RUN_MODE}" = "${EVIDENCE_PRODUCING_MODE}" ]; then
    printf 'FATAL: successful evidence-producing run omitted its signed attestation.\n' >&2
    exit 1
  fi
fi

test -z "$(find evidence-artifact -mindepth 1 -maxdepth 1 ! -type f -print -quit)"
if [ -f evidence-artifact/evidence-attestation.json ]; then
  [ "$(find evidence-artifact -maxdepth 1 -type f | wc -l)" -eq 5 ]
else
  [ "$(find evidence-artifact -maxdepth 1 -type f | wc -l)" -eq 2 ]
fi
assert_exact_current_main
