#!/bin/bash
# Crash-consistent state primitives for provider-console PostgreSQL bootstrap.
# This file is sourced only after its digest has been verified against the
# signed candidate material.

_dr_state_publish() {
  [ "$#" -eq 2 ] || return 64
  local temporary_path=$1
  local state_path=$2
  local state_dir=${state_path%/*}

  chmod 0400 "${temporary_path}" || return
  sync -f "${temporary_path}" || return
  mv -f -- "${temporary_path}" "${state_path}" || return
  sync -f "${state_dir}"
}

_dr_state_render() {
  [ "$#" -eq 10 ] || return 64
  local output_path=$1
  local phase=$2
  local repository=$3
  local main_sha=$4
  local run_id=$5
  local run_attempt=$6
  local image_digest=$7
  local prior_image_id=$8
  local candidate_image_id=$9
  local occurred_at=${10}

  case "${phase}" in
    VERIFYING)
      [ -z "${prior_image_id}" ] && [ -z "${candidate_image_id}" ] || return 65
      ;;
    PREPARED | FORWARD_STARTED | ROLLBACK_STARTED | ROLLED_BACK | COMMITTED | RECOVERY_REQUIRED | FINALIZING | ROLLBACK_FINALIZING)
      [[ "${DR_RECOVERY_POINT_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || return 65
      [[ "${prior_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 65
      [[ "${candidate_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 65
      ;;
    *) return 65 ;;
  esac
  jq --exit-status --null-input --arg occurred_at "${occurred_at}" \
    '($occurred_at | fromdateiso8601 | type) == "number"' >/dev/null || return 65

  jq --sort-keys --null-input \
    --arg phase "${phase}" \
    --arg mode "${DR_BOOTSTRAP_MODE:-healthy_upgrade}" \
    --arg recovery_point_sha256 "${DR_RECOVERY_POINT_SHA256:-}" \
    --arg repository "${repository}" \
    --arg main_sha "${main_sha}" \
    --arg run_id "${run_id}" \
    --arg run_attempt "${run_attempt}" \
    --arg image_digest "${image_digest}" \
    --arg prior_image_id "${prior_image_id}" \
    --arg candidate_image_id "${candidate_image_id}" \
    --arg occurred_at "${occurred_at}" \
    '{
      schema_version: 2,
      mode: $mode,
      recovery_point_sha256: (if $recovery_point_sha256 == "" then null else $recovery_point_sha256 end),
      phase: $phase,
      candidate: {
        repository: $repository,
        main_sha: $main_sha,
        run_id: $run_id,
        run_attempt: $run_attempt,
        image_digest: $image_digest
      },
      prior_image_id: (if $prior_image_id == "" then null else $prior_image_id end),
      candidate_image_id: (
        if $candidate_image_id == "" then null else $candidate_image_id end
      ),
      occurred_at: $occurred_at
    }' > "${output_path}"
}

dr_state_validate_any() {
  [ "$#" -eq 1 ] || return 64
  jq --exit-status '
    type == "object" and
    (if .schema_version == 1 then
      keys == ["candidate", "candidate_image_id", "occurred_at", "phase", "prior_image_id", "schema_version"] and
      (.phase | IN("COMMITTED", "ROLLED_BACK"))
    elif .schema_version == 2 then
      keys == ["candidate", "candidate_image_id", "mode", "occurred_at", "phase", "prior_image_id", "recovery_point_sha256", "schema_version"] and
      (.mode | IN("healthy_upgrade", "degraded_legacy_recovery")) and
      (if .phase == "VERIFYING" then
        (.recovery_point_sha256 == null or (.recovery_point_sha256 | test("^[0-9a-f]{64}$")))
      else (.recovery_point_sha256 | test("^[0-9a-f]{64}$")) end)
    else false end) and
    (.candidate | type) == "object" and
    (.candidate | keys) == [
      "image_digest",
      "main_sha",
      "repository",
      "run_attempt",
      "run_id"
    ] and
    .candidate.repository == "Okan-wqm/aquaculture_platform" and
    (.candidate.main_sha | test("^[0-9a-f]{40}$")) and
    (.candidate.run_id | test("^[1-9][0-9]*$")) and
    (.candidate.run_attempt | test("^[1-9][0-9]*$")) and
    (.candidate.image_digest | test("^sha256:[0-9a-f]{64}$")) and
    (.occurred_at | fromdateiso8601 | type) == "number" and
    if .phase == "VERIFYING" then
      .prior_image_id == null and .candidate_image_id == null
    elif (.phase | IN(
      "PREPARED",
      "FORWARD_STARTED",
      "ROLLBACK_STARTED",
      "ROLLED_BACK",
      "COMMITTED",
      "RECOVERY_REQUIRED",
      "FINALIZING",
      "ROLLBACK_FINALIZING"
    )) then
      (.prior_image_id | type) == "string" and
      (.prior_image_id | test("^sha256:[0-9a-f]{64}$")) and
      (.candidate_image_id | type) == "string" and
      (.candidate_image_id | test("^sha256:[0-9a-f]{64}$"))
    else
      false
    end
  ' "$1" >/dev/null
}

dr_state_validate() {
  [ "$#" -eq 6 ] || return 64
  local state_path=$1
  local repository=$2
  local main_sha=$3
  local run_id=$4
  local run_attempt=$5
  local image_digest=$6

  dr_state_validate_any "${state_path}" || return
  jq --exit-status \
    --arg repository "${repository}" \
    --arg main_sha "${main_sha}" \
    --arg run_id "${run_id}" \
    --arg run_attempt "${run_attempt}" \
    --arg image_digest "${image_digest}" \
    '.candidate == {
      repository: $repository,
      main_sha: $main_sha,
      run_id: $run_id,
      run_attempt: $run_attempt,
      image_digest: $image_digest
    }' "${state_path}" >/dev/null
}

dr_state_initialize() {
  [ "$#" -eq 7 ] || return 64
  local state_path=$1
  local repository=$2
  local main_sha=$3
  local run_id=$4
  local run_attempt=$5
  local image_digest=$6
  local occurred_at=$7
  local state_dir=${state_path%/*}
  local temporary_path

  [ ! -e "${state_path}" ] && [ ! -L "${state_path}" ] || return 65
  [[ "${repository}" == Okan-wqm/aquaculture_platform ]] || return 65
  [[ "${main_sha}" =~ ^[0-9a-f]{40}$ ]] || return 65
  [[ "${run_id}" =~ ^[1-9][0-9]*$ ]] || return 65
  [[ "${run_attempt}" =~ ^[1-9][0-9]*$ ]] || return 65
  [[ "${image_digest}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 65
  temporary_path=$(mktemp --tmpdir="${state_dir}" .phase.XXXXXXXX) || return
  if ! _dr_state_render \
    "${temporary_path}" VERIFYING "${repository}" "${main_sha}" \
    "${run_id}" "${run_attempt}" "${image_digest}" '' '' "${occurred_at}"; then
    rm -f -- "${temporary_path}"
    return 1
  fi
  _dr_state_publish "${temporary_path}" "${state_path}"
}

dr_state_transition() {
  [ "$#" -eq 6 ] || return 64
  local state_path=$1
  local expected_phase=$2
  local next_phase=$3
  local prior_image_id=$4
  local candidate_image_id=$5
  local occurred_at=$6
  local current_prior
  local current_candidate
  local repository
  local main_sha
  local run_id
  local run_attempt
  local image_digest
  local state_dir=${state_path%/*}
  local temporary_path

  dr_state_validate_any "${state_path}" || return 65
  [ "$(dr_state_phase "${state_path}")" = "${expected_phase}" ] || return 65
  case "${expected_phase}:${next_phase}" in
    VERIFYING:PREPARED | PREPARED:FORWARD_STARTED | \
      FORWARD_STARTED:ROLLBACK_STARTED | FORWARD_STARTED:FINALIZING | FINALIZING:COMMITTED | \
      ROLLBACK_STARTED:ROLLBACK_FINALIZING | ROLLBACK_FINALIZING:ROLLED_BACK | ROLLBACK_STARTED:RECOVERY_REQUIRED | \
      FORWARD_STARTED:RECOVERY_REQUIRED | RECOVERY_REQUIRED:ROLLBACK_STARTED) ;;
    *) return 65 ;;
  esac
  [[ "${prior_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 65
  [[ "${candidate_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || return 65

  [ "$(jq -r .schema_version "${state_path}")" = 2 ] || return 65
  current_prior=$(dr_state_prior_image_id "${state_path}") || return
  current_candidate=$(dr_state_candidate_image_id "${state_path}") || return
  if [ "${expected_phase}" != VERIFYING ]; then
    [ "${prior_image_id}" = "${current_prior}" ] || return 65
    [ "${candidate_image_id}" = "${current_candidate}" ] || return 65
  fi

  DR_BOOTSTRAP_MODE=$(jq --raw-output ".mode" "${state_path}") || return
  DR_RECOVERY_POINT_SHA256=$(jq --raw-output ".recovery_point_sha256 // empty" "${state_path}") || return
  repository=$(jq --raw-output '.candidate.repository' "${state_path}") || return
  main_sha=$(jq --raw-output '.candidate.main_sha' "${state_path}") || return
  run_id=$(jq --raw-output '.candidate.run_id' "${state_path}") || return
  run_attempt=$(jq --raw-output '.candidate.run_attempt' "${state_path}") || return
  image_digest=$(jq --raw-output '.candidate.image_digest' "${state_path}") || return
  temporary_path=$(mktemp --tmpdir="${state_dir}" .phase.XXXXXXXX) || return
  if ! _dr_state_render \
    "${temporary_path}" "${next_phase}" "${repository}" "${main_sha}" \
    "${run_id}" "${run_attempt}" "${image_digest}" \
    "${prior_image_id}" "${candidate_image_id}" "${occurred_at}"; then
    rm -f -- "${temporary_path}"
    return 1
  fi
  _dr_state_publish "${temporary_path}" "${state_path}"
}

dr_state_phase() {
  [ "$#" -eq 1 ] || return 64
  jq --raw-output '.phase' "$1"
}

dr_state_prior_image_id() {
  [ "$#" -eq 1 ] || return 64
  jq --raw-output '.prior_image_id // empty' "$1"
}

dr_state_candidate_image_id() {
  [ "$#" -eq 1 ] || return 64
  jq --raw-output '.candidate_image_id // empty' "$1"
}

dr_state_reentry_action() {
  [ "$#" -eq 1 ] || return 64
  case "$1" in
    VERIFYING) printf 'resume-verification' ;;
    PREPARED) printf 'resume-forward' ;;
    FORWARD_STARTED | ROLLBACK_STARTED | RECOVERY_REQUIRED) printf 'recover-exact-prior' ;;
    ROLLED_BACK) printf 'require-new-signed-candidate' ;;
    FINALIZING) printf 'finish-forward' ;;
    ROLLBACK_FINALIZING) printf 'finish-rollback' ;;
    COMMITTED) printf 'verify-committed' ;;
    *) return 65 ;;
  esac
}

# Bind the verified cold-copy and bootable baseline before authorizing a write.
dr_state_bind_recovery() {
  [ "$#" -eq 2 ] || return 64
  local state_path=$1 recovery_path=$2 temporary_path digest
  dr_state_validate_any "${state_path}" || return
  [ "$(dr_state_phase "${state_path}")" = VERIFYING ] || return 65
  digest=$(sha256sum --binary "${recovery_path}" | awk '{print $1}') || return
  temporary_path=$(mktemp --tmpdir="${state_path%/*}" .phase.XXXXXXXX) || return
  jq --arg digest "${digest}" '.recovery_point_sha256 = $digest' "${state_path}" > "${temporary_path}" || return
  _dr_state_publish "${temporary_path}" "${state_path}"
}
