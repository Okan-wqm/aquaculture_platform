#!/usr/bin/env bash
# =============================================================================
# verify-nats-compat.sh -- NATS JetStream health and cross-version compat check
#
# During the NestJS v11 phased rollout (ADR-013), v10 and v11 services coexist
# on the same NATS bus. This script verifies:
#   1. NATS server health and JetStream status
#   2. Stream health (message counts, storage)
#   3. Consumer lag for each service
#   4. Consumer count vs expected baseline
#   5. NAK/redeliver spike detection
#
# Usage:
#   ./scripts/v11-upgrade/verify-nats-compat.sh
#   ./scripts/v11-upgrade/verify-nats-compat.sh --baseline   # save current state as baseline
#   ./scripts/v11-upgrade/verify-nats-compat.sh --compare    # compare against saved baseline
#
# Requirements: bash 4+, curl, jq, docker CLI
# Target: DigitalOcean droplet (Ubuntu + Docker)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Color output helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

pass()   { echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail()   { echo -e "  ${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn()   { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info()   { echo -e "  ${CYAN}[INFO]${NC} $1"; }
header() { echo -e "\n${BOLD}=== $1 ===${NC}"; }

FAILURES=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASELINE_FILE="${SCRIPT_DIR}/.nats-baseline.json"

# ---------------------------------------------------------------------------
# NATS monitoring endpoint -- resolve from container IP
# The monitoring port (8222) is bound to 127.0.0.1 on the droplet, so we
# access it through the container network or via localhost.
# ---------------------------------------------------------------------------
get_nats_url() {
  # First try: direct container IP on Docker network
  local nats_ip
  nats_ip=$(docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' aqua-nats 2>/dev/null || echo "")
  if [[ -n "$nats_ip" ]]; then
    echo "http://${nats_ip}:8222"
    return
  fi
  # Second try: localhost (monitoring port is bound to 127.0.0.1:8222)
  echo "http://127.0.0.1:8222"
}

NATS_URL=""

# Maximum acceptable consumer pending count before flagging as concerning
MAX_CONSUMER_PENDING=1000

# Maximum acceptable redelivery percentage (NAK/redeliver spikes)
MAX_REDELIVER_PERCENT=5

# ---------------------------------------------------------------------------
# Check: NATS server general health
# ---------------------------------------------------------------------------
check_nats_server() {
  header "NATS Server Health"

  NATS_URL=$(get_nats_url)
  info "NATS monitoring URL: $NATS_URL"

  # Check NATS container is running
  local nats_state
  nats_state=$(docker inspect --format='{{.State.Status}}' aqua-nats 2>/dev/null || echo "missing")
  if [[ "$nats_state" != "running" ]]; then
    fail "aqua-nats container is not running (state: $nats_state)"
    return 1
  fi
  pass "aqua-nats container is running"

  # General server info via /varz
  local varz
  varz=$(curl -sf --max-time 5 "${NATS_URL}/varz" 2>/dev/null || echo "")
  if [[ -z "$varz" ]]; then
    fail "NATS /varz endpoint did not respond"
    return 1
  fi

  local server_name version connections
  server_name=$(echo "$varz" | jq -r '.server_name // "unknown"')
  version=$(echo "$varz" | jq -r '.version // "unknown"')
  connections=$(echo "$varz" | jq -r '.connections // 0')

  pass "NATS server responding: $server_name (v$version)"
  info "Active connections: $connections"

  if [[ "$connections" -eq 0 ]]; then
    warn "NATS has 0 active connections -- services may not be connected"
  fi

  # Check memory and CPU
  local mem_bytes
  mem_bytes=$(echo "$varz" | jq -r '.mem // 0')
  local mem_mb=$((mem_bytes / 1048576))
  info "NATS memory usage: ${mem_mb}MB"
}

# ---------------------------------------------------------------------------
# Check: JetStream status
# ---------------------------------------------------------------------------
check_jetstream() {
  header "JetStream Status"

  local jsz
  jsz=$(curl -sf --max-time 5 "${NATS_URL}/jsz" 2>/dev/null || echo "")
  if [[ -z "$jsz" ]]; then
    fail "NATS /jsz endpoint did not respond -- JetStream may be disabled"
    return 1
  fi

  # JetStream account info
  local js_memory js_storage js_streams js_consumers
  js_memory=$(echo "$jsz" | jq -r '.memory // 0')
  js_storage=$(echo "$jsz" | jq -r '.store // 0')
  js_streams=$(echo "$jsz" | jq -r '.streams // 0')
  js_consumers=$(echo "$jsz" | jq -r '.consumers // 0')

  local js_mem_mb=$((js_memory / 1048576))
  local js_store_mb=$((js_storage / 1048576))

  pass "JetStream is enabled"
  info "Memory: ${js_mem_mb}MB, Storage: ${js_store_mb}MB"
  info "Streams: $js_streams, Consumers: $js_consumers"

  if [[ "$js_streams" -eq 0 ]]; then
    warn "No JetStream streams found -- platform may not have initialized streams yet"
  fi
}

# ---------------------------------------------------------------------------
# Check: Individual stream health
# ---------------------------------------------------------------------------
check_streams() {
  header "Stream Health"

  # Get detailed stream info via /jsz?streams=true
  local jsz_streams
  jsz_streams=$(curl -sf --max-time 10 "${NATS_URL}/jsz?streams=true" 2>/dev/null || echo "")
  if [[ -z "$jsz_streams" ]]; then
    warn "Could not retrieve stream details"
    return
  fi

  # Parse account_details -> streams array
  local stream_count
  stream_count=$(echo "$jsz_streams" | jq '[.account_details[]?.stream_detail // [] | length] | add // 0' 2>/dev/null || echo "0")

  if [[ "$stream_count" -eq 0 ]]; then
    # Try alternate JSON path structure
    stream_count=$(echo "$jsz_streams" | jq '.streams // 0' 2>/dev/null || echo "0")
    if [[ "$stream_count" -eq 0 ]]; then
      info "No streams to inspect (stream_count=0)"
      return
    fi
  fi

  # Iterate over account_details and their streams
  echo "$jsz_streams" | jq -r '
    .account_details[]? |
    .stream_detail[]? |
    "\(.name)\t\(.state.messages)\t\(.state.bytes)\t\(.state.consumer_count)\t\(.state.first_seq)\t\(.state.last_seq)"
  ' 2>/dev/null | while IFS=$'\t' read -r name messages bytes consumer_count first_seq last_seq; do
    local bytes_mb=$((bytes / 1048576))
    info "Stream: $name | msgs=$messages | size=${bytes_mb}MB | consumers=$consumer_count | seq=${first_seq}-${last_seq}"

    if [[ "$consumer_count" -eq 0 ]]; then
      warn "Stream '$name' has 0 consumers -- messages may be unprocessed"
    else
      pass "Stream '$name' has $consumer_count active consumer(s)"
    fi
  done
}

# ---------------------------------------------------------------------------
# Check: Consumer lag and health for each stream
# ---------------------------------------------------------------------------
check_consumers() {
  header "Consumer Health & Lag"

  # Get consumer details via /jsz?consumers=true
  local jsz_consumers
  jsz_consumers=$(curl -sf --max-time 10 "${NATS_URL}/jsz?consumers=true" 2>/dev/null || echo "")
  if [[ -z "$jsz_consumers" ]]; then
    warn "Could not retrieve consumer details"
    return
  fi

  # Extract consumer info from the nested structure
  local consumer_data
  consumer_data=$(echo "$jsz_consumers" | jq -r '
    [.account_details[]? |
     .stream_detail[]? |
     . as $stream |
     .consumer_detail[]? |
     {
       stream: $stream.name,
       consumer: .name,
       num_pending: .num_pending,
       num_redelivered: .num_redelivered,
       num_ack_pending: .num_ack_pending,
       delivered_stream_seq: (.delivered.stream_seq // 0),
       delivered_consumer_seq: (.delivered.consumer_seq // 0)
     }] | sort_by(.stream, .consumer)
  ' 2>/dev/null || echo "[]")

  if [[ "$consumer_data" == "[]" || -z "$consumer_data" ]]; then
    info "No consumer details available"
    return
  fi

  local total_consumers=0
  local lagging_consumers=0
  local nak_consumers=0

  echo "$consumer_data" | jq -c '.[]' 2>/dev/null | while IFS= read -r consumer; do
    local stream consumer_name pending redelivered ack_pending
    stream=$(echo "$consumer" | jq -r '.stream')
    consumer_name=$(echo "$consumer" | jq -r '.consumer')
    pending=$(echo "$consumer" | jq -r '.num_pending // 0')
    redelivered=$(echo "$consumer" | jq -r '.num_redelivered // 0')
    ack_pending=$(echo "$consumer" | jq -r '.num_ack_pending // 0')

    total_consumers=$((total_consumers + 1))

    # Report consumer status
    if [[ "$pending" -gt "$MAX_CONSUMER_PENDING" ]]; then
      fail "Consumer $stream/$consumer_name: $pending pending messages (> $MAX_CONSUMER_PENDING threshold)"
      lagging_consumers=$((lagging_consumers + 1))
    else
      info "Consumer $stream/$consumer_name: pending=$pending, ack_pending=$ack_pending, redelivered=$redelivered"
    fi

    # Check for NAK/redeliver spikes
    if [[ "$redelivered" -gt 0 ]]; then
      local delivered_seq
      delivered_seq=$(echo "$consumer" | jq -r '.delivered_consumer_seq // 1')
      if [[ "$delivered_seq" -gt 0 ]]; then
        local redeliver_pct=$((redelivered * 100 / delivered_seq))
        if [[ "$redeliver_pct" -gt "$MAX_REDELIVER_PERCENT" ]]; then
          fail "Consumer $stream/$consumer_name: redeliver rate ${redeliver_pct}% (> ${MAX_REDELIVER_PERCENT}% threshold)"
          nak_consumers=$((nak_consumers + 1))
        fi
      fi
    fi
  done

  # Summary
  if [[ "$lagging_consumers" -gt 0 ]]; then
    warn "$lagging_consumers consumer(s) have high pending message counts"
  fi
  if [[ "$nak_consumers" -gt 0 ]]; then
    warn "$nak_consumers consumer(s) have high NAK/redeliver rates"
  fi
}

# ---------------------------------------------------------------------------
# Check: Connection details (which services are connected)
# ---------------------------------------------------------------------------
check_connections() {
  header "NATS Client Connections"

  local connz
  connz=$(curl -sf --max-time 5 "${NATS_URL}/connz?subs=true" 2>/dev/null || echo "")
  if [[ -z "$connz" ]]; then
    warn "Could not retrieve connection details"
    return
  fi

  local total_conns
  total_conns=$(echo "$connz" | jq '.num_connections // 0' 2>/dev/null || echo "0")
  info "Total NATS connections: $total_conns"

  # List connected clients by name (client name usually = service name)
  echo "$connz" | jq -r '.connections[]? | "\(.name // "unnamed")\t\(.ip)\t\(.lang // "?")\t\(.version // "?")\t\(.subscriptions // 0) subs"' 2>/dev/null | sort | while IFS=$'\t' read -r name ip lang ver subs; do
    info "  Client: $name ($ip) | lang=$lang v=$ver | $subs"
  done

  # Check expected services are connected
  local expected_services="auth-service farm-service sensor-service alert-engine billing-service hr-service hydroponics-service notification-service config-service messaging-service gateway-api admin-api-service observability-service"
  local connected_names
  connected_names=$(echo "$connz" | jq -r '.connections[]?.name // ""' 2>/dev/null | sort -u)

  for svc in $expected_services; do
    if echo "$connected_names" | grep -qi "$svc"; then
      pass "$svc is connected to NATS"
    else
      warn "$svc does NOT appear connected to NATS (may use different client name)"
    fi
  done
}

# ---------------------------------------------------------------------------
# Check: Subscription count per subject (detect missing handlers)
# ---------------------------------------------------------------------------
check_subscriptions() {
  header "NATS Subscription Overview"

  local routez
  routez=$(curl -sf --max-time 5 "${NATS_URL}/routez?subs=true" 2>/dev/null || echo "")

  # Use subsz for subscription details
  local subsz
  subsz=$(curl -sf --max-time 5 "${NATS_URL}/subsz?subs=true&limit=100" 2>/dev/null || echo "")
  if [[ -z "$subsz" ]]; then
    info "Subscription detail endpoint not available"
    return
  fi

  local total_subs
  total_subs=$(echo "$subsz" | jq '.num_subscriptions // 0' 2>/dev/null || echo "0")
  info "Total subscriptions: $total_subs"

  if [[ "$total_subs" -eq 0 ]]; then
    warn "No subscriptions found -- services may not have registered NATS handlers"
  fi
}

# ---------------------------------------------------------------------------
# Baseline: save current NATS state as reference
# ---------------------------------------------------------------------------
save_baseline() {
  header "Saving NATS Baseline"

  NATS_URL=$(get_nats_url)

  local baseline="{}"
  local jsz connz subsz

  jsz=$(curl -sf --max-time 10 "${NATS_URL}/jsz?consumers=true&streams=true" 2>/dev/null || echo "{}")
  connz=$(curl -sf --max-time 5 "${NATS_URL}/connz" 2>/dev/null || echo "{}")
  subsz=$(curl -sf --max-time 5 "${NATS_URL}/subsz" 2>/dev/null || echo "{}")

  baseline=$(jq -n \
    --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --argjson jsz "$jsz" \
    --argjson connz "$connz" \
    --argjson subsz "$subsz" \
    '{timestamp: $ts, jsz: $jsz, connz: $connz, subsz: $subsz}')

  echo "$baseline" > "$BASELINE_FILE"
  pass "Baseline saved to $BASELINE_FILE"
  info "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

  local base_connections base_consumers base_subs
  base_connections=$(echo "$connz" | jq '.num_connections // 0')
  base_consumers=$(echo "$jsz" | jq '.consumers // 0')
  base_subs=$(echo "$subsz" | jq '.num_subscriptions // 0')
  info "Baseline: connections=$base_connections, consumers=$base_consumers, subscriptions=$base_subs"
}

# ---------------------------------------------------------------------------
# Compare: check current state against saved baseline
# ---------------------------------------------------------------------------
compare_baseline() {
  header "Comparing Against Baseline"

  if [[ ! -f "$BASELINE_FILE" ]]; then
    fail "No baseline file found at $BASELINE_FILE"
    info "Run: $0 --baseline  (to save the current state as baseline)"
    return
  fi

  NATS_URL=$(get_nats_url)

  local base_ts
  base_ts=$(jq -r '.timestamp' "$BASELINE_FILE")
  info "Baseline from: $base_ts"

  # Compare connection counts
  local base_conns now_conns
  base_conns=$(jq '.connz.num_connections // 0' "$BASELINE_FILE")
  now_conns=$(curl -sf --max-time 5 "${NATS_URL}/connz" 2>/dev/null | jq '.num_connections // 0' 2>/dev/null || echo "0")

  info "Connections: baseline=$base_conns, current=$now_conns"
  if [[ "$now_conns" -lt "$base_conns" ]]; then
    warn "Connection count dropped from $base_conns to $now_conns (some services may have disconnected)"
  else
    pass "Connection count stable or increased ($base_conns -> $now_conns)"
  fi

  # Compare consumer counts
  local base_consumers now_consumers
  base_consumers=$(jq '.jsz.consumers // 0' "$BASELINE_FILE")
  local now_jsz
  now_jsz=$(curl -sf --max-time 5 "${NATS_URL}/jsz" 2>/dev/null || echo "{}")
  now_consumers=$(echo "$now_jsz" | jq '.consumers // 0')

  info "JetStream consumers: baseline=$base_consumers, current=$now_consumers"
  if [[ "$now_consumers" -lt "$base_consumers" ]]; then
    fail "Consumer count DROPPED from $base_consumers to $now_consumers -- handlers may be missing"
  else
    pass "Consumer count stable or increased ($base_consumers -> $now_consumers)"
  fi

  # Compare subscription counts
  local base_subs now_subs
  base_subs=$(jq '.subsz.num_subscriptions // 0' "$BASELINE_FILE")
  local now_subsz
  now_subsz=$(curl -sf --max-time 5 "${NATS_URL}/subsz" 2>/dev/null || echo "{}")
  now_subs=$(echo "$now_subsz" | jq '.num_subscriptions // 0')

  info "Subscriptions: baseline=$base_subs, current=$now_subs"
  if [[ "$now_subs" -lt "$((base_subs * 80 / 100))" ]]; then
    fail "Subscription count dropped >20% from baseline ($base_subs -> $now_subs)"
  elif [[ "$now_subs" -lt "$base_subs" ]]; then
    warn "Subscription count slightly lower ($base_subs -> $now_subs)"
  else
    pass "Subscription count stable or increased ($base_subs -> $now_subs)"
  fi

  # Compare stream message counts (detect stuck consumers / message buildup)
  local base_streams now_streams
  base_streams=$(jq '[.jsz.account_details[]? | .stream_detail[]? | {name: .name, messages: .state.messages}]' "$BASELINE_FILE" 2>/dev/null || echo "[]")
  now_streams=$(curl -sf --max-time 10 "${NATS_URL}/jsz?streams=true" 2>/dev/null | jq '[.account_details[]? | .stream_detail[]? | {name: .name, messages: .state.messages}]' 2>/dev/null || echo "[]")

  if [[ "$base_streams" != "[]" && "$now_streams" != "[]" ]]; then
    header "Stream Message Count Comparison"
    echo "$base_streams" | jq -r '.[].name' 2>/dev/null | while read -r stream_name; do
      local base_msgs now_msgs
      base_msgs=$(echo "$base_streams" | jq -r ".[] | select(.name == \"$stream_name\") | .messages // 0")
      now_msgs=$(echo "$now_streams" | jq -r ".[] | select(.name == \"$stream_name\") | .messages // 0" 2>/dev/null || echo "0")
      local diff=$((now_msgs - base_msgs))
      if [[ "$diff" -gt 10000 ]]; then
        warn "Stream '$stream_name': messages grew by $diff ($base_msgs -> $now_msgs) -- possible consumer backlog"
      else
        info "Stream '$stream_name': $base_msgs -> $now_msgs (delta: $diff)"
      fi
    done
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
  header "NATS COMPATIBILITY SUMMARY"
  if [[ "$FAILURES" -eq 0 ]]; then
    echo -e "\n${GREEN}${BOLD}  ALL NATS CHECKS PASSED${NC}\n"
  else
    echo -e "\n${RED}${BOLD}  $FAILURES NATS CHECK(S) FAILED${NC}\n"
    echo -e "  Review failures above."
    echo -e "  If consumer counts dropped, NATS event handlers may not have registered"
    echo -e "  correctly under NestJS v11 (see ADR-013 section 4.4 -- scanFromPrototype).\n"
  fi
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
echo -e "${BOLD}NATS JetStream Compatibility Check (ADR-013)${NC}"
echo -e "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

MODE="${1:-check}"

case "$MODE" in
  --baseline|-b)
    save_baseline
    ;;
  --compare|-c)
    check_nats_server
    check_jetstream
    check_streams
    check_consumers
    check_connections
    check_subscriptions
    compare_baseline
    ;;
  check|--check|"")
    check_nats_server
    check_jetstream
    check_streams
    check_consumers
    check_connections
    check_subscriptions
    ;;
  *)
    echo "Usage: $0 [--baseline|--compare|--check]"
    echo "  --baseline  Save current NATS state as reference"
    echo "  --compare   Run checks and compare against saved baseline"
    echo "  --check     Run checks only (default)"
    exit 1
    ;;
esac

print_summary
exit $((FAILURES > 0 ? 1 : 0))
