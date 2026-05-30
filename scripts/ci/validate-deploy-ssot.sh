#!/usr/bin/env bash
# Static deployment SSOT checks. These guardrails keep production deploys on
# the GitHub Actions build -> immutable image pull path.

set -euo pipefail

failures=0

fail() {
  echo "::error::$*"
  failures=$((failures + 1))
}

check_no_compose_build() {
  local file="$1"
  if awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]+build:[[:space:]]*/ { print FNR ":" $0 }
  ' "${file}" | while IFS= read -r line; do
    [ -n "${line}" ] || continue
    echo "${file}:${line}"
  done | grep -q .; then
    awk '
      /^[[:space:]]*#/ { next }
      /^[[:space:]]+build:[[:space:]]*/ { print "'"${file}"':" FNR ":" $0 }
    ' "${file}"
    fail "${file} contains service-level build:. Production/staging compose must use registry images only."
  fi
}

check_no_latest_tag_fallback() {
  local file="$1"
  if awk '
    /^[[:space:]]*#/ { next }
    /\$\{TAG:-latest\}/ { print FNR ":" $0 }
  ' "${file}" | grep -q .; then
    awk '
      /^[[:space:]]*#/ { next }
      /\$\{TAG:-latest\}/ { print "'"${file}"':" FNR ":" $0 }
    ' "${file}"
    fail "${file} contains mutable TAG:-latest fallback. Use TAG:?TAG required for deploy images."
  fi
}

check_no_forbidden_deploy_commands() {
  local file="$1"
  local patterns=(
    'docker[[:space:]]+build'
    'docker[[:space:]]+compose[[:space:]]+build'
    'docker-compose[[:space:]]+build'
    'up[[:space:]][^#]*--build'
    'docker[[:space:]]+volume[[:space:]]+prune'
    'docker[[:space:]]+system[[:space:]]+prune[^#]*--volumes'
  )
  local pattern
  for pattern in "${patterns[@]}"; do
    if grep -En "${pattern}" "${file}" >/dev/null 2>&1; then
      grep -En "${pattern}" "${file}"
      fail "${file} contains forbidden deploy command pattern: ${pattern}"
    fi
  done
}

for compose_file in docker-compose.droplet.yml docker-compose.staging.yml; do
  [ -f "${compose_file}" ] || continue
  check_no_compose_build "${compose_file}"
  check_no_latest_tag_fallback "${compose_file}"
done

for script in scripts/deploy/droplet-up.sh scripts/deploy/droplet-capacity.sh scripts/deploy-do.sh; do
  [ -f "${script}" ] || continue
  check_no_forbidden_deploy_commands "${script}"
done

if [ "${failures}" -ne 0 ]; then
  echo "Deploy SSOT validation failed (${failures} issue(s))."
  exit 1
fi

echo "Deploy SSOT validation passed."
