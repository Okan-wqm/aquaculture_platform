#!/usr/bin/env bash
# Resolve a chart's declared subchart dependencies, tolerating a transient
# registry failure without tolerating a real one.
#
# WHY THIS IS A FILE AND NOT A `run:` BLOCK. Retry logic that lives inline in
# YAML can only be checked by asserting that the words "attempt" and "sleep"
# appear in it — which a loop that never increments its counter also satisfies.
# As a script it is executable against a stub `helm`, so the tests assert what
# it DOES: how many times it calls the resolver, that it stops, and that it
# still fails when the failure is real. That is the difference between a gate
# that reads the code and a gate that runs it.
#
# Contract:
#   $1                CHART_DIR       chart directory containing Chart.yaml
#   $ATTEMPTS         total attempts before failing (default 3)
#   $BACKOFF_SECONDS  wait before attempt 2; doubles each time (default 5)
#
# Exit 0 on a resolved chart, 1 on a missing Chart.yaml or on exhausting the
# attempts. The last attempt's own resolver output is left on the log above the
# final error, so a transient that outlasted us reads differently from a chart
# that was never going to resolve.
set -euo pipefail

chart_dir="${1:?chart directory required}"
attempts="${ATTEMPTS:-3}"
wait_seconds="${BACKOFF_SECONDS:-5}"

if [ ! -f "${chart_dir}/Chart.yaml" ]; then
  echo "::error::No Chart.yaml under '${chart_dir}'; nothing to resolve." >&2
  exit 1
fi

if [ "${attempts}" -lt 1 ]; then
  # A zero-attempt configuration would "succeed" by never asking, which is the
  # one outcome worse than either failing or retrying.
  echo "::error::attempts must be at least 1; got '${attempts}'." >&2
  exit 1
fi

attempt=1
while true; do
  if helm dependency update "${chart_dir}"; then
    if [ "${attempt}" -gt 1 ]; then
      # Surfaced, never silent. A retry that leaves no trace turns a registry
      # that is degrading into a registry that looks healthy, and the first
      # anyone learns of it is the day it exhausts the attempts. Counting the
      # warnings is how "flaky" becomes a number.
      echo "::warning::helm dependency update for '${chart_dir}' succeeded on attempt ${attempt}/${attempts}; earlier attempts failed."
    fi
    echo "OK: resolved ${chart_dir} dependencies on attempt ${attempt}/${attempts}"
    exit 0
  fi

  if [ "${attempt}" -ge "${attempts}" ]; then
    echo "::error::helm dependency update for '${chart_dir}' failed on all ${attempts} attempts. See the resolver output above for the upstream error." >&2
    exit 1
  fi

  echo "::warning::helm dependency update for '${chart_dir}' failed on attempt ${attempt}/${attempts}; retrying in ${wait_seconds}s."
  sleep "${wait_seconds}"
  attempt=$((attempt + 1))
  wait_seconds=$((wait_seconds * 2))
done
