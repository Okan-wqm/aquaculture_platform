#!/usr/bin/env bash
# Resolve a declared DR capability against what the runtime actually proves, and
# emit the verdict a scheduled lane acts on.
#
# The distinction this exists to preserve: "production never deployed this" and
# "production deployed this and it just broke" are different emergencies, and a
# monitor that renders them identically is not a monitor. The declared state
# comes from .github/manifests/dr-activation.json; the observed state comes from
# the lane's own probe. This script is the only place the two are combined.
#
# Inputs:  DR_CAPABILITY   key in the manifest's `capabilities` object
#          DR_OBSERVED     present | absent | indeterminate
# Outputs: `dr_verdict=<verdict>` on stdout, plus GITHUB_OUTPUT when set.
# Exit:    0 when the lane should continue, 1 when the lane must fail.

set +x
set -euo pipefail

: "${DR_CAPABILITY:?DR_CAPABILITY required}"
: "${DR_OBSERVED:?DR_OBSERVED required}"

MANIFEST_PATH="${DR_MANIFEST_PATH:-.github/manifests/dr-activation.json}"

die() {
  printf '::error::%s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || die 'jq is required to read the DR activation manifest.'
[ -r "${MANIFEST_PATH}" ] || die "DR activation manifest is unreadable: ${MANIFEST_PATH}"

capability=$(jq -e --arg key "${DR_CAPABILITY}" '.capabilities[$key]' "${MANIFEST_PATH}" 2>/dev/null) || \
  die "DR capability '${DR_CAPABILITY}' is not declared in ${MANIFEST_PATH}."

declared=$(printf '%s' "${capability}" | jq -r '.state')
unlock_phase=$(printf '%s' "${capability}" | jq -r '.unlockPhase')
finding=$(printf '%s' "${capability}" | jq -r '.finding')
why=$(printf '%s' "${capability}" | jq -r '.whyNotActivated')

case "${declared}" in
  active | not-activated) ;;
  *) die "DR capability '${DR_CAPABILITY}' has an unknown declared state: ${declared}" ;;
esac

emit() {
  printf 'dr_verdict=%s\n' "$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'dr_verdict=%s\n' "$1" >> "${GITHUB_OUTPUT}"
  fi
}

summarize() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '%s\n' "$1" >> "${GITHUB_STEP_SUMMARY}"
}

case "${declared}/${DR_OBSERVED}" in
  not-activated/absent)
    emit 'inactive-as-declared'
    printf '::warning::PRODUCTION HAS NO %s. This lane is inactive by design pending %s (%s); it is NOT asserting that production is protected.\n' \
      "${DR_CAPABILITY}" "${unlock_phase}" "${finding}"
    summarize "## DR capability \`${DR_CAPABILITY}\`: NOT ACTIVATED"
    summarize ""
    summarize "This run did **not** verify that production is protected, because the capability has never been deployed."
    summarize ""
    summarize "- ${why}"
    summarize "- Unlocked by plan phase **${unlock_phase}**"
    summarize "- Tracked as **${finding}**"
    summarize ""
    summarize "This lane starts enforcing automatically the moment the runtime proves the capability is live."
    exit 0
    ;;
  not-activated/present)
    summarize "## DR activation drift: \`${DR_CAPABILITY}\`"
    summarize ""
    summarize "The runtime proves this capability is LIVE, but the manifest still declares it \`not-activated\` — so this lane has been skipping the checks that protect it."
    die "DR activation drift: '${DR_CAPABILITY}' is live in production but ${MANIFEST_PATH} declares it not-activated, so this lane has NOT been enforcing it. Set the declared state to 'active'."
    ;;
  active/present)
    emit 'active'
    exit 0
    ;;
  active/absent)
    summarize "## DR capability \`${DR_CAPABILITY}\` has disappeared"
    summarize ""
    summarize "The manifest declares this capability **active**, but the runtime no longer carries it. Production protection has regressed."
    die "DR capability '${DR_CAPABILITY}' is declared active but the production runtime no longer proves it. Production protection has regressed."
    ;;
  */indeterminate)
    die "Could not observe DR capability '${DR_CAPABILITY}' in production. Absence of evidence is not evidence of absence; this lane fails closed rather than guess."
    ;;
  *)
    die "Unsupported observation '${DR_OBSERVED}' for DR capability '${DR_CAPABILITY}'."
    ;;
esac
