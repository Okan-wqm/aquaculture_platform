#!/usr/bin/env bash
# =============================================================================
# check-codegen.sh -- GraphQL codegen validation for NestJS v11 migration
#
# Detects GraphQL schema changes caused by @nestjs/graphql v13 migration by
# running graphql-codegen and comparing the generated TypeScript types against
# the previous snapshot.  If the generated types change, frontend code may
# break and the migration phase should be reviewed before proceeding.
#
# Usage:
#   ./scripts/v11-upgrade/check-codegen.sh
#   ./scripts/v11-upgrade/check-codegen.sh --schema-only   # only check schema files
#   ./scripts/v11-upgrade/check-codegen.sh --verbose        # show full diff output
#
# Requirements: bash 4+, node/npm (with graphql-codegen installed), diff
# Target: DigitalOcean droplet (Ubuntu)
# Ref: ADR-013 (codegen:check after each phase)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Color output helpers (consistent with verify-phase.sh)
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

pass()   { echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail()   { echo -e "  ${RED}[FAIL]${NC} $1"; }
warn()   { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info()   { echo -e "  ${CYAN}[INFO]${NC} $1"; }
header() { echo -e "\n${BOLD}=== $1 ===${NC}"; }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Resolve project root from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Codegen config file (TypeScript)
CODEGEN_CONFIG="${PROJECT_ROOT}/codegen.ts"

# Generated types output path (must match codegen.ts generates key)
GENERATED_TYPES="${PROJECT_ROOT}/web/shared-ui/src/generated/graphql-types.ts"

# Temporary snapshot location (survives only for this run)
SNAPSHOT_DIR="$(mktemp -d)"
SNAPSHOT_BEFORE="${SNAPSHOT_DIR}/graphql-types-before.ts"
DIFF_OUTPUT="${SNAPSHOT_DIR}/codegen-diff.txt"
trap 'rm -rf "${SNAPSHOT_DIR}"' EXIT

# Schema files referenced in codegen.ts (ADR-013 scope: 8 services)
# These must match the 'schema' array in codegen.ts exactly.
SCHEMA_FILES=(
  "dist/graphql/subgraphs/farm.graphql"
  "apps/sensor-service/schema.graphql"
  "apps/hr-service/schema.graphql"
  "apps/auth-service/schema.graphql"
  "apps/billing-service/schema.graphql"
  "apps/config-service/schema.graphql"
  "apps/hydroponics-service/schema.graphql"
  "apps/alert-engine/schema.graphql"
)

# Exit code tracking
EXIT_CODE=0

# CLI flags
SCHEMA_ONLY=false
VERBOSE=false

# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --schema-only)
      SCHEMA_ONLY=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--schema-only] [--verbose]"
      echo ""
      echo "Options:"
      echo "  --schema-only   Only verify schema files exist (skip codegen run)"
      echo "  --verbose       Show full diff output instead of summary"
      exit 0
      ;;
    *)
      echo -e "${RED}Error: Unknown argument: $1${NC}" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo -e "${BOLD}GraphQL Codegen Validation (ADR-013)${NC}"
echo -e "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo -e "Project root: ${PROJECT_ROOT}"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Verify codegen configuration exists
# ---------------------------------------------------------------------------
header "Step 1: Codegen Configuration"

if [[ -f "${CODEGEN_CONFIG}" ]]; then
  pass "codegen.ts exists at ${CODEGEN_CONFIG}"
else
  fail "codegen.ts NOT found at ${CODEGEN_CONFIG}"
  echo -e "\n${RED}Cannot proceed without codegen configuration.${NC}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Verify all schema files exist
# ---------------------------------------------------------------------------
header "Step 2: Schema File Existence (${#SCHEMA_FILES[@]} services)"

MISSING_SCHEMAS=0
PRESENT_SCHEMAS=0

for schema_path in "${SCHEMA_FILES[@]}"; do
  full_path="${PROJECT_ROOT}/${schema_path}"
  if [[ -f "${full_path}" ]]; then
    # Report file size as a sanity check (empty schema = likely problem)
    file_size=$(stat -c%s "${full_path}" 2>/dev/null || stat -f%z "${full_path}" 2>/dev/null || echo "0")
    if [[ "${file_size}" -lt 10 ]]; then
      warn "${schema_path} exists but appears empty (${file_size} bytes)"
    else
      pass "${schema_path} (${file_size} bytes)"
    fi
    PRESENT_SCHEMAS=$((PRESENT_SCHEMAS + 1))
  else
    fail "${schema_path} NOT found"
    MISSING_SCHEMAS=$((MISSING_SCHEMAS + 1))
  fi
done

echo ""
info "Schema files: ${PRESENT_SCHEMAS} present, ${MISSING_SCHEMAS} missing"

if [[ "${MISSING_SCHEMAS}" -gt 0 ]]; then
  warn "Missing schema files may be auto-generated at build time by @nestjs/graphql."
  warn "Run 'npm run build' first to generate schema.graphql files, or start the"
  warn "services with DATABASE_SYNC=true so they emit their schemas on boot."
  EXIT_CODE=1
fi

# If --schema-only flag was passed, stop here
if [[ "${SCHEMA_ONLY}" == true ]]; then
  header "RESULT (schema-only mode)"
  if [[ "${MISSING_SCHEMAS}" -eq 0 ]]; then
    echo -e "\n${GREEN}${BOLD}  ALL ${#SCHEMA_FILES[@]} SCHEMA FILES PRESENT${NC}\n"
    exit 0
  else
    echo -e "\n${YELLOW}${BOLD}  ${MISSING_SCHEMAS} SCHEMA FILE(S) MISSING${NC}\n"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Snapshot current generated types (before codegen run)
# ---------------------------------------------------------------------------
header "Step 3: Snapshot Current Generated Types"

if [[ -f "${GENERATED_TYPES}" ]]; then
  cp "${GENERATED_TYPES}" "${SNAPSHOT_BEFORE}"
  before_lines=$(wc -l < "${SNAPSHOT_BEFORE}")
  before_size=$(stat -c%s "${SNAPSHOT_BEFORE}" 2>/dev/null || stat -f%z "${SNAPSHOT_BEFORE}" 2>/dev/null || echo "0")
  pass "Snapshot saved (${before_lines} lines, ${before_size} bytes)"
else
  warn "Generated types file does not exist yet: ${GENERATED_TYPES}"
  info "This is expected on a fresh checkout or before first codegen run."
  info "Codegen will create the file; no diff comparison will be possible."
  # Create an empty snapshot so diff still works
  touch "${SNAPSHOT_BEFORE}"
fi

# ---------------------------------------------------------------------------
# Step 4: Run graphql-codegen
# ---------------------------------------------------------------------------
header "Step 4: Run GraphQL Codegen"

# Verify node and npx are available
if ! command -v npx &>/dev/null; then
  fail "npx not found on PATH. Node.js must be installed."
  exit 1
fi

info "Running: npx graphql-codegen --config codegen.ts"
echo ""

CODEGEN_EXIT=0
CODEGEN_OUTPUT=""

# Run codegen from the project root so relative paths in codegen.ts resolve
CODEGEN_OUTPUT=$(cd "${PROJECT_ROOT}" && npx graphql-codegen --config codegen.ts 2>&1) || CODEGEN_EXIT=$?

if [[ "${CODEGEN_EXIT}" -ne 0 ]]; then
  fail "graphql-codegen exited with code ${CODEGEN_EXIT}"
  echo -e "${DIM}${CODEGEN_OUTPUT}${NC}" | head -30
  echo ""
  warn "Codegen failure may indicate:"
  warn "  - Missing schema files (see Step 2)"
  warn "  - Schema syntax errors introduced by @nestjs/graphql v13"
  warn "  - Missing @graphql-codegen/cli or plugins (run 'npm install')"
  EXIT_CODE=1
else
  pass "graphql-codegen completed successfully"
fi

# Verify the output file was created/updated
if [[ ! -f "${GENERATED_TYPES}" ]]; then
  fail "Expected output file was not created: ${GENERATED_TYPES}"
  echo -e "\n${RED}Cannot proceed with diff comparison.${NC}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 5: Compare generated types (before vs after)
# ---------------------------------------------------------------------------
header "Step 5: Diff Analysis"

after_lines=$(wc -l < "${GENERATED_TYPES}")
after_size=$(stat -c%s "${GENERATED_TYPES}" 2>/dev/null || stat -f%z "${GENERATED_TYPES}" 2>/dev/null || echo "0")
info "Generated file: ${after_lines} lines, ${after_size} bytes"

# Run diff (suppress exit code 1 which just means "files differ")
DIFF_EXIT=0
diff -u "${SNAPSHOT_BEFORE}" "${GENERATED_TYPES}" > "${DIFF_OUTPUT}" 2>&1 || DIFF_EXIT=$?

if [[ "${DIFF_EXIT}" -eq 0 ]]; then
  # No differences
  echo ""
  pass "Generated types are UNCHANGED -- schema is stable"
  echo ""
else
  # Files differ -- analyze the diff
  ADDED_LINES=$(grep -c '^+[^+]' "${DIFF_OUTPUT}" 2>/dev/null || echo "0")
  REMOVED_LINES=$(grep -c '^-[^-]' "${DIFF_OUTPUT}" 2>/dev/null || echo "0")
  CHANGED_HUNKS=$(grep -c '^@@' "${DIFF_OUTPUT}" 2>/dev/null || echo "0")

  echo ""
  warn "Generated types have CHANGED"
  echo ""
  info "Diff summary:"
  info "  Added lines:   +${ADDED_LINES}"
  info "  Removed lines: -${REMOVED_LINES}"
  info "  Changed hunks: ${CHANGED_HUNKS}"
  echo ""

  # Detect specific categories of changes
  header "Change Classification"

  # New types (export type Foo = ...)
  NEW_TYPES=$(grep '^+export type ' "${DIFF_OUTPUT}" 2>/dev/null | grep -v '^+++' || true)
  if [[ -n "${NEW_TYPES}" ]]; then
    NEW_TYPE_COUNT=$(echo "${NEW_TYPES}" | wc -l)
    warn "New types added (${NEW_TYPE_COUNT}):"
    echo "${NEW_TYPES}" | head -10 | while IFS= read -r line; do
      # Extract the type name from lines like "+export type FooBar = {"
      type_name=$(echo "${line}" | sed 's/^+export type \([^ ]*\).*/\1/')
      echo -e "    ${CYAN}+ ${type_name}${NC}"
    done
    if [[ "${NEW_TYPE_COUNT}" -gt 10 ]]; then
      info "  ... and $((NEW_TYPE_COUNT - 10)) more"
    fi
    echo ""
  fi

  # Removed types
  REMOVED_TYPES=$(grep '^-export type ' "${DIFF_OUTPUT}" 2>/dev/null | grep -v '^---' || true)
  if [[ -n "${REMOVED_TYPES}" ]]; then
    REMOVED_TYPE_COUNT=$(echo "${REMOVED_TYPES}" | wc -l)
    fail "Types removed (${REMOVED_TYPE_COUNT}) -- BREAKING CHANGE:"
    echo "${REMOVED_TYPES}" | head -10 | while IFS= read -r line; do
      type_name=$(echo "${line}" | sed 's/^-export type \([^ ]*\).*/\1/')
      echo -e "    ${RED}- ${type_name}${NC}"
    done
    if [[ "${REMOVED_TYPE_COUNT}" -gt 10 ]]; then
      info "  ... and $((REMOVED_TYPE_COUNT - 10)) more"
    fi
    EXIT_CODE=1
    echo ""
  fi

  # Nullability changes (Maybe<T> / null / undefined patterns)
  NULLABILITY_CHANGES=$(grep -E '^[+-].*(Maybe<|null|undefined|\| null|\?:)' "${DIFF_OUTPUT}" 2>/dev/null | grep -v '^[+-]{3}' || true)
  if [[ -n "${NULLABILITY_CHANGES}" ]]; then
    NULL_CHANGE_COUNT=$(echo "${NULLABILITY_CHANGES}" | wc -l)
    warn "Nullability changes detected (${NULL_CHANGE_COUNT} lines) -- review carefully:"
    echo "${NULLABILITY_CHANGES}" | head -6 | while IFS= read -r line; do
      echo -e "    ${YELLOW}${line}${NC}"
    done
    if [[ "${NULL_CHANGE_COUNT}" -gt 6 ]]; then
      info "  ... and $((NULL_CHANGE_COUNT - 6)) more"
    fi
    echo ""
  fi

  # Enum changes
  ENUM_CHANGES=$(grep -E '^[+-].*=\s*'\''[A-Z_]+'\''' "${DIFF_OUTPUT}" 2>/dev/null | grep -v '^[+-]{3}' || true)
  if [[ -n "${ENUM_CHANGES}" ]]; then
    ENUM_CHANGE_COUNT=$(echo "${ENUM_CHANGES}" | wc -l)
    warn "Enum/literal type changes detected (${ENUM_CHANGE_COUNT} lines):"
    echo "${ENUM_CHANGES}" | head -6 | while IFS= read -r line; do
      echo -e "    ${YELLOW}${line}${NC}"
    done
    if [[ "${ENUM_CHANGE_COUNT}" -gt 6 ]]; then
      info "  ... and $((ENUM_CHANGE_COUNT - 6)) more"
    fi
    echo ""
  fi

  # Scalar mapping changes (DateTime, JSON, etc.)
  SCALAR_CHANGES=$(grep -iE '^[+-].*(Scalars|DateTime|JSON|Float|Int|ID|Boolean)' "${DIFF_OUTPUT}" 2>/dev/null | grep -v '^[+-]{3}' || true)
  if [[ -n "${SCALAR_CHANGES}" ]]; then
    SCALAR_CHANGE_COUNT=$(echo "${SCALAR_CHANGES}" | wc -l)
    warn "Scalar/primitive type changes detected (${SCALAR_CHANGE_COUNT} lines):"
    echo "${SCALAR_CHANGES}" | head -6 | while IFS= read -r line; do
      echo -e "    ${YELLOW}${line}${NC}"
    done
    if [[ "${SCALAR_CHANGE_COUNT}" -gt 6 ]]; then
      info "  ... and $((SCALAR_CHANGE_COUNT - 6)) more"
    fi
    echo ""
  fi

  # Show full diff if --verbose
  if [[ "${VERBOSE}" == true ]]; then
    header "Full Diff Output"
    cat "${DIFF_OUTPUT}"
    echo ""
  else
    info "Run with --verbose to see the full diff output."
    info "Or inspect manually:"
    info "  diff -u ${SNAPSHOT_BEFORE} ${GENERATED_TYPES}"
  fi

  # Save the diff alongside the script for post-mortem analysis
  DIFF_ARCHIVE="${SCRIPT_DIR}/baselines/codegen-diff-$(date -u +%Y%m%d-%H%M%S).diff"
  if mkdir -p "$(dirname "${DIFF_ARCHIVE}")" 2>/dev/null; then
    cp "${DIFF_OUTPUT}" "${DIFF_ARCHIVE}"
    info "Diff saved to: ${DIFF_ARCHIVE}"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Summary
# ---------------------------------------------------------------------------
header "CODEGEN VALIDATION SUMMARY"

echo ""
info "Schema files:    ${PRESENT_SCHEMAS}/${#SCHEMA_FILES[@]} present"
info "Codegen exit:    ${CODEGEN_EXIT}"
info "Types before:    $(wc -l < "${SNAPSHOT_BEFORE}") lines"
info "Types after:     ${after_lines} lines"

if [[ "${DIFF_EXIT}" -eq 0 && "${CODEGEN_EXIT}" -eq 0 && "${MISSING_SCHEMAS}" -eq 0 ]]; then
  echo -e "\n${GREEN}${BOLD}  PASS -- Schema and generated types are stable${NC}\n"
  exit 0
elif [[ "${DIFF_EXIT}" -ne 0 && "${CODEGEN_EXIT}" -eq 0 ]]; then
  echo -e "\n${YELLOW}${BOLD}  WARN -- Generated types changed (review diff above)${NC}"
  echo -e "  ${YELLOW}Frontend code that imports graphql-types.ts may need updating.${NC}"
  echo -e "  ${YELLOW}This is expected during v11 migration phases.${NC}\n"
  exit "${EXIT_CODE}"
else
  echo -e "\n${RED}${BOLD}  FAIL -- Codegen validation encountered errors${NC}"
  echo -e "  ${RED}See details above. Fix issues before proceeding with the migration phase.${NC}\n"
  exit 1
fi
