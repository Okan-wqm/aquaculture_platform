#!/usr/bin/env bash
# Compare the GitHub/Cosign-verified closure file set with the read-only,
# content-addressed DigitalOcean Spaces audit mirror. This process never
# receives GitHub credentials or performs GitHub API calls.

set +x
set -euo pipefail
umask 077

: "${SPACES_ENDPOINT:?SPACES_ENDPOINT required}"
: "${EVIDENCE_SPACES_BUCKET:?EVIDENCE_SPACES_BUCKET required}"
: "${EXPECTED_EVIDENCE_MANIFEST_SHA256:?verified evidence manifest digest required}"
: "${AWS_ACCESS_KEY_ID:?read-only evidence mirror access key required}"
: "${AWS_SECRET_ACCESS_KEY:?read-only evidence mirror secret required}"
: "${AWS_REGION:?AWS_REGION required}"
: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION required}"

for forbidden_credential in \
  GH_TOKEN \
  GITHUB_TOKEN \
  AWS_SESSION_TOKEN \
  ACTIONS_RUNTIME_TOKEN \
  ACTIONS_RUNTIME_URL \
  ACTIONS_RESULTS_URL \
  ACTIONS_CACHE_URL \
  ACTIONS_ID_TOKEN_REQUEST_TOKEN \
  ACTIONS_ID_TOKEN_REQUEST_URL \
  GITHUB_ENV \
  GITHUB_OUTPUT \
  GITHUB_PATH \
  GITHUB_STATE \
  GITHUB_STEP_SUMMARY; do
  if [ "${!forbidden_credential+x}" = x ]; then
    echo "FATAL: evidence mirror verifier refuses co-resident credential ${forbidden_credential}." >&2
    exit 2
  fi
done

EVIDENCE_INPUT_DIR="${EVIDENCE_INPUT_DIR:-walg-verified-evidence}"
MAX_STAGED_MIRROR_FILES=65
MAX_STAGED_MIRROR_BYTES=122683392
MAX_STAGED_MANIFEST_BYTES=32768
MAX_VERSION_SNAPSHOT_BYTES=65536

for command_name in aws cmp head jq python3 stat; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "FATAL: ${command_name} is required." >&2
    exit 2
  }
done
if [ ! -d "${EVIDENCE_INPUT_DIR}" ] || [ -L "${EVIDENCE_INPUT_DIR}" ]; then
  echo 'FATAL: verified evidence staging root must be a non-symlink directory.' >&2
  exit 2
fi

spaces_endpoint_coordinate=${SPACES_ENDPOINT}
evidence_bucket_coordinate=${EVIDENCE_SPACES_BUCKET}
evidence_access_key_material=${AWS_ACCESS_KEY_ID}
evidence_secret_key_material=${AWS_SECRET_ACCESS_KEY}
evidence_region_coordinate=${AWS_REGION}
evidence_default_region_coordinate=${AWS_DEFAULT_REGION}
unset SPACES_ENDPOINT EVIDENCE_SPACES_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
unset AWS_REGION AWS_DEFAULT_REGION

run_readonly_aws() {
  AWS_ACCESS_KEY_ID="${evidence_access_key_material}" \
    AWS_SECRET_ACCESS_KEY="${evidence_secret_key_material}" \
    AWS_REGION="${evidence_region_coordinate}" \
    AWS_DEFAULT_REGION="${evidence_default_region_coordinate}" \
    AWS_EC2_METADATA_DISABLED=true \
    AWS_PAGER='' \
    AWS_CLI_AUTO_PROMPT=off \
    aws "$@"
}

TMP_DIR=$(mktemp -d -t aqua-walg-evidence-mirror-XXXXXX)
cleanup() {
  rm -rf -- "${TMP_DIR}"
}
trap cleanup EXIT

decode_exact_version_id() {
  local encoded_version_id=$1
  local output_path=$2
  python3 - "${encoded_version_id}" "${output_path}" <<'PY'
import base64
import binascii
import os
import sys

encoded, output_path = sys.argv[1:]
try:
    value = base64.b64decode(encoded.encode('ascii'), validate=True)
except (UnicodeEncodeError, binascii.Error, ValueError) as error:
    raise SystemExit('mirror VersionId is not canonical base64') from error
if not 1 <= len(value) <= 1024:
    raise SystemExit('mirror VersionId is outside its S3 byte bound')
if any(byte <= 0x20 or byte == 0x7f for byte in value):
    raise SystemExit('mirror VersionId contains a control or separator byte')
try:
    value.decode('utf-8')
except UnicodeDecodeError as error:
    raise SystemExit('mirror VersionId is not valid UTF-8') from error
descriptor = os.open(
    output_path,
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
    0o600,
)
with os.fdopen(descriptor, 'wb') as output:
    output.write(value)
PY
}

load_exact_mirror_version() {
  local mirror_key=$1
  local snapshot_path=$2
  local snapshot_bytes
  local version_state
  if ! run_readonly_aws s3api list-object-versions \
      --bucket "${evidence_bucket_coordinate}" \
      --prefix "${mirror_key}" \
      --max-keys 2 \
      --no-paginate \
      --endpoint-url "${spaces_endpoint_coordinate}" \
      --output json | head -c "$((MAX_VERSION_SNAPSHOT_BYTES + 1))" > "${snapshot_path}"; then
    echo 'FATAL: bounded evidence mirror version discovery failed.' >&2
    exit 1
  fi
  snapshot_bytes=$(stat -c '%s' "${snapshot_path}")
  if [[ ! "${snapshot_bytes}" =~ ^[1-9][0-9]*$ ]] || \
     [ "${snapshot_bytes}" -gt "${MAX_VERSION_SNAPSHOT_BYTES}" ]; then
    echo 'FATAL: evidence mirror version discovery exceeded its byte bound.' >&2
    exit 1
  fi
  version_state=$(jq -er --arg key "${mirror_key}" '
    if ((.Versions // []) | type) != "array" or
       ((.DeleteMarkers // []) | type) != "array" or
       ((.IsTruncated // false) | type) != "boolean" or
       (.IsTruncated // false) != false or
       (.NextKeyMarker // "") != "" or
       (.NextVersionIdMarker // "") != ""
    then error("version listing is truncated or malformed")
    else .
    end
    | ([.Versions[]? | select(.Key == $key)]) as $versions
    | ([.DeleteMarkers[]? | select(.Key == $key)]) as $deletes
    | [
        ($versions | length),
        ($deletes | length),
        (if ($versions | length) == 1 and
            ($versions[0].VersionId | type) == "string"
         then ($versions[0].VersionId | @base64)
         else "-"
         end),
        ($versions[0].IsLatest // false)
      ]
    | @tsv
  ' "${snapshot_path}")
  IFS=$'\t' read -r version_count delete_count version_id_b64 version_is_latest \
    <<< "${version_state}"
  if [ "${version_count}" != 1 ] || [ "${delete_count}" != 0 ] || \
     [ "${version_id_b64}" = '-' ] || [ "${version_is_latest}" != true ]; then
    echo "FATAL: mirror key must have exactly one live immutable version: ${mirror_key}." >&2
    exit 1
  fi
  version_id_path="${snapshot_path}.version-id"
  decode_exact_version_id "${version_id_b64}" "${version_id_path}"
  version_id=$(<"${version_id_path}")
}

VALIDATED_MANIFEST="${TMP_DIR}/validated-manifest.tsv"
python3 - \
  "${EVIDENCE_INPUT_DIR}" \
  "${MAX_STAGED_MIRROR_FILES}" \
  "${MAX_STAGED_MIRROR_BYTES}" \
  "${MAX_STAGED_MANIFEST_BYTES}" \
  "${EXPECTED_EVIDENCE_MANIFEST_SHA256}" \
  "${VALIDATED_MANIFEST}" <<'PY'
import hashlib
import os
import re
import stat
import sys
from pathlib import Path

(
    root_arg,
    max_files_arg,
    max_bytes_arg,
    max_manifest_arg,
    expected_manifest_sha256,
    output_arg,
) = sys.argv[1:]
root = Path(root_arg)
max_files = int(max_files_arg)
max_bytes = int(max_bytes_arg)
max_manifest_bytes = int(max_manifest_arg)
manifest = root / 'mirror-manifest.sha256'
line_pattern = re.compile(
    r'(?P<sha>[0-9a-f]{64})  objects/(?P<path_sha>[0-9a-f]{64})/'
    r'(?P<name>[A-Za-z0-9][A-Za-z0-9._-]{0,127})'
)
allowed_names = {
    'base-backup.json',
    'timestamp-pitr.json',
    'evidence-attestation.json',
    'evidence-attestation.sigstore.json',
    'run-record.json',
    'run-record.sigstore.json',
}

root_stat = root.lstat()
if not stat.S_ISDIR(root_stat.st_mode) or stat.S_ISLNK(root_stat.st_mode):
    raise SystemExit('verified evidence root is not a safe directory')
manifest_stat = manifest.lstat()
if (
    not stat.S_ISREG(manifest_stat.st_mode)
    or stat.S_ISLNK(manifest_stat.st_mode)
    or manifest_stat.st_nlink != 1
    or manifest_stat.st_size < 1
    or manifest_stat.st_size > max_manifest_bytes
):
    raise SystemExit('mirror manifest is not a bounded regular file')

manifest_bytes = manifest.read_bytes()
if not manifest_bytes.endswith(b'\n') or b'\r' in manifest_bytes or b'\x00' in manifest_bytes:
    raise SystemExit('mirror manifest framing is not canonical')
if (
    re.fullmatch(r'[0-9a-f]{64}', expected_manifest_sha256) is None
    or hashlib.sha256(manifest_bytes).hexdigest() != expected_manifest_sha256
):
    raise SystemExit('mirror manifest differs from the GitHub-verified content binding')
try:
    manifest_text = manifest_bytes.decode('ascii')
except UnicodeDecodeError as error:
    raise SystemExit('mirror manifest must be ASCII') from error
lines = manifest_text[:-1].split('\n')
if not 1 <= len(lines) <= max_files or lines != sorted(set(lines)):
    raise SystemExit('mirror manifest count, order, or uniqueness is invalid')

expected_files = {Path('mirror-manifest.sha256')}
expected_directories = {Path('.'), Path('objects')}
validated = []
aggregate_bytes = 0
for line in lines:
    match = line_pattern.fullmatch(line)
    if (
        match is None
        or match['sha'] != match['path_sha']
        or match['name'] not in allowed_names
    ):
        raise SystemExit('mirror manifest entry is not canonical')
    relative = Path('objects') / match['sha'] / match['name']
    evidence_file = root / relative
    file_stat = evidence_file.lstat()
    if (
        not stat.S_ISREG(file_stat.st_mode)
        or stat.S_ISLNK(file_stat.st_mode)
        or file_stat.st_nlink != 1
        or file_stat.st_size < 1
        or file_stat.st_size > 8388608
    ):
        raise SystemExit(f'unsafe staged evidence object: {relative.as_posix()}')
    digest = hashlib.sha256()
    with evidence_file.open('rb') as source:
        while chunk := source.read(65536):
            digest.update(chunk)
    if digest.hexdigest() != match['sha']:
        raise SystemExit(f'staged evidence digest mismatch: {relative.as_posix()}')
    aggregate_bytes += file_stat.st_size
    if aggregate_bytes > max_bytes:
        raise SystemExit('staged evidence exceeds its aggregate byte bound')
    expected_files.add(relative)
    expected_directories.add(Path('objects') / match['sha'])
    validated.append((match['sha'], file_stat.st_size, match['name']))

actual_files = set()
actual_directories = set()
for current_root, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
    current = Path(current_root)
    relative_root = current.relative_to(root)
    actual_directories.add(relative_root if relative_root.parts else Path('.'))
    for directory_name in directory_names:
        directory = current / directory_name
        directory_stat = directory.lstat()
        if not stat.S_ISDIR(directory_stat.st_mode) or stat.S_ISLNK(directory_stat.st_mode):
            raise SystemExit(f'unsafe staged evidence directory: {directory.relative_to(root)}')
    for file_name in file_names:
        evidence_file = current / file_name
        file_stat = evidence_file.lstat()
        if not stat.S_ISREG(file_stat.st_mode) or stat.S_ISLNK(file_stat.st_mode):
            raise SystemExit(f'unsafe staged evidence node: {evidence_file.relative_to(root)}')
        actual_files.add(evidence_file.relative_to(root))

if actual_files != expected_files or actual_directories != expected_directories:
    raise SystemExit('staged evidence tree does not exactly match its manifest')

output = Path(output_arg)
descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(descriptor, 'w', encoding='ascii', newline='\n') as target:
    for sha, size, name in validated:
        target.write(f'{sha}\t{size}\t{name}\n')
PY

VERSIONING_STATUS=$(run_readonly_aws s3api get-bucket-versioning \
  --bucket "${evidence_bucket_coordinate}" \
  --endpoint-url "${spaces_endpoint_coordinate}" \
  --query Status \
  --output text)
if [ "${VERSIONING_STATUS}" != 'Enabled' ]; then
  echo 'FATAL: signed evidence mirror bucket versioning must be Enabled.' >&2
  exit 1
fi

verified_count=0
while IFS=$'\t' read -r expected_sha expected_bytes file_name; do
  if [[ ! "${expected_sha}" =~ ^[0-9a-f]{64}$ ]] || \
     [[ ! "${expected_bytes}" =~ ^[1-9][0-9]*$ ]] || \
     [ "${expected_bytes}" -gt 8388608 ]; then
    echo 'FATAL: internal validated mirror manifest is malformed.' >&2
    exit 1
  fi
  case "${file_name}" in
    base-backup.json|timestamp-pitr.json|evidence-attestation.json|evidence-attestation.sigstore.json|run-record.json|run-record.sigstore.json) ;;
    *)
      echo 'FATAL: internal validated mirror manifest has an unsupported basename.' >&2
      exit 1
      ;;
  esac
  staged_file="${EVIDENCE_INPUT_DIR}/objects/${expected_sha}/${file_name}"
  mirror_key="wal-g-evidence/v3/sha256/${expected_sha}/${file_name}"
  version_snapshot="${TMP_DIR}/versions-${verified_count}-${expected_sha}.json"
  load_exact_mirror_version "${mirror_key}" "${version_snapshot}"
  verified_version_id=${version_id}
  remote_bytes=$(run_readonly_aws s3api head-object \
    --bucket "${evidence_bucket_coordinate}" \
    --key "${mirror_key}" \
    "--version-id=${verified_version_id}" \
    --endpoint-url "${spaces_endpoint_coordinate}" \
    --query ContentLength \
    --output text)
  if [ "${remote_bytes}" != "${expected_bytes}" ]; then
    echo "FATAL: mirror object size differs from verified evidence: ${mirror_key}." >&2
    exit 1
  fi

  mirror_file="${TMP_DIR}/mirror-${verified_count}-${expected_sha}"
  run_readonly_aws s3api get-object \
    --bucket "${evidence_bucket_coordinate}" \
    --key "${mirror_key}" \
    "--version-id=${verified_version_id}" \
    --endpoint-url "${spaces_endpoint_coordinate}" \
    "${mirror_file}" >/dev/null
  if [ "$(stat -c '%s' "${mirror_file}")" != "${expected_bytes}" ] || \
     ! cmp -s "${staged_file}" "${mirror_file}"; then
    echo "FATAL: content-addressed mirror differs from verified evidence: ${mirror_key}." >&2
    exit 1
  fi
  final_versioning_status=$(run_readonly_aws s3api get-bucket-versioning \
    --bucket "${evidence_bucket_coordinate}" \
    --endpoint-url "${spaces_endpoint_coordinate}" \
    --query Status \
    --output text)
  if [ "${final_versioning_status}" != 'Enabled' ]; then
    echo 'FATAL: evidence mirror bucket versioning changed during verification.' >&2
    exit 1
  fi
  final_version_snapshot="${TMP_DIR}/versions-final-${verified_count}-${expected_sha}.json"
  load_exact_mirror_version "${mirror_key}" "${final_version_snapshot}"
  if [ "${version_id}" != "${verified_version_id}" ]; then
    echo "FATAL: mirror key changed after its pinned verification: ${mirror_key}." >&2
    exit 1
  fi
  verified_count=$((verified_count + 1))
done < "${VALIDATED_MANIFEST}"

if [ "${verified_count}" -lt 1 ] || [ "${verified_count}" -gt "${MAX_STAGED_MIRROR_FILES}" ]; then
  echo 'FATAL: evidence mirror verification count is outside its bound.' >&2
  exit 1
fi
