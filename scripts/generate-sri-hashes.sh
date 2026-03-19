#!/usr/bin/env bash
# =============================================================================
# SRI Hash Generator for Module Federation Remote Entries
#
# SH-SEC-04 / D14-SC-01: Generates SHA-384 integrity hashes for all MFE
# remoteEntry.js files and writes them to the shell app's generated directory.
#
# Usage:
#   ./scripts/generate-sri-hashes.sh [--base-dir <project-root>]
#
# Prerequisites:
#   - All MFE modules must be built (dist/ directories must exist)
#   - openssl must be available
#
# Output:
#   web/shell/src/generated/remoteHashes.json
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BASE_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
OUTPUT_DIR="${BASE_DIR}/web/shell/src/generated"
OUTPUT_FILE="${OUTPUT_DIR}/remoteHashes.json"

# Module names and their dist paths (relative to BASE_DIR)
# Order: module-name -> path-to-remoteEntry.js relative to dist
declare -A MODULES=(
  ["dashboard"]="web/modules/dashboard/dist/assets/remoteEntry.js"
  ["farm-module"]="web/modules/farm-module/dist/assets/remoteEntry.js"
  ["sensor-module"]="web/modules/sensor-module/dist/assets/remoteEntry.js"
  ["admin-panel"]="web/modules/admin-panel/dist/assets/remoteEntry.js"
  ["hr-module"]="web/modules/hr-module/dist/assets/remoteEntry.js"
  ["hydroponics-module"]="web/modules/hydroponics-module/dist/assets/remoteEntry.js"
  ["tenant-admin"]="web/modules/tenant-admin/dist/assets/remoteEntry.js"
)

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------

generate_sha384() {
  local file="$1"
  # Generate SHA-384 hash in SRI format: sha384-<base64>
  local hash
  hash=$(openssl dgst -sha384 -binary "$file" | openssl base64 -A)
  echo "sha384-${hash}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo "=== SRI Hash Generation (SH-SEC-04) ==="
echo "Base directory: ${BASE_DIR}"
echo ""

# Ensure output directory exists
mkdir -p "${OUTPUT_DIR}"

# Track results
found_count=0
missing_count=0
missing_modules=""

# Start JSON output
json_content="{"
first=true

for module in $(echo "${!MODULES[@]}" | tr ' ' '\n' | sort); do
  entry_path="${BASE_DIR}/${MODULES[$module]}"
  # The URL path that the shell app uses to load this remote entry
  url_path="/remotes/${module}/assets/remoteEntry.js"

  if [ -f "$entry_path" ]; then
    hash=$(generate_sha384 "$entry_path")
    found_count=$((found_count + 1))
    echo "  [OK] ${module}: ${hash}"

    if [ "$first" = true ]; then
      first=false
    else
      json_content+=","
    fi
    json_content+=$'\n'"  \"${module}\": \"${hash}\""
  else
    missing_count=$((missing_count + 1))
    missing_modules="${missing_modules} ${module}"
    echo "  [SKIP] ${module}: remoteEntry.js not found at ${entry_path}"
  fi
done

json_content+=$'\n'"}"

# Write JSON file
echo "${json_content}" > "${OUTPUT_FILE}"

echo ""
echo "=== Results ==="
echo "  Hashes generated: ${found_count}"
echo "  Modules skipped:  ${missing_count}${missing_modules:+ (${missing_modules})}"
echo "  Output:           ${OUTPUT_FILE}"

# Exit with error if NO modules were found (likely a build issue)
if [ "$found_count" -eq 0 ]; then
  echo ""
  echo "ERROR: No remoteEntry.js files found. Ensure MFE modules are built before running this script."
  exit 1
fi

echo ""
echo "SRI hash generation complete."
