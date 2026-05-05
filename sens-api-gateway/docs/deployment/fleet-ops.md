# Fleet Operations Runbook

**Audience:** Fleet operator — the person or small team driving multi-device rollouts, config changes, and firmware updates across an installed base.
**Prerequisites:**
- Cohort catalogue: every device has a known `device_id`, `device_code`, `tenant_id`, hardware profile, and Cargo-feature baseline.
- Cloud tenant-admin has `device:update` + `device:config:write` permissions for the full fleet.
- A documented rollout SLO: target crash-rate, telemetry-lag, alert-storm thresholds used to gate-promote between cohorts.

**Duration:** 2–24 h depending on cohort size and soak duration.
**Blast radius:** fleet-wide if unguarded; per-cohort when the staged rollout below is followed.
**Safety:** every cohort promotion includes a pre-flight health gate. A failing gate halts promotion — it does not auto-rollback already-updated devices; that is a deliberate operator decision via `ota-firmware-update.md` Rollback.

---

## Cohort Model

Three-cohort staged rollout, per release engineering practice:

| Cohort | Size | Purpose | Soak duration |
|--------|------|---------|---------------|
| Canary | 1 device | Smoke under real load | ≥ 24 h |
| Early Access | 10 % of fleet | Statistical detection of low-frequency regressions | ≥ 72 h |
| Wide | 100 % | Full rollout | continuous |

Promotion between cohorts is **operator-gated**, not time-gated. Time is a necessary condition, not a sufficient one.

## Health Gate Thresholds

Gate inputs are cloud-side telemetry aggregates over the soak window, scoped to the currently-upgrading cohort:

| Metric | Gate threshold |
|--------|----------------|
| Agent crash rate (restart events / device / hour) | ≤ 1 |
| Telemetry lag p95 | ≤ 2 × baseline |
| Alert storm rate (alerts / device / hour) | ≤ 1.5 × baseline |
| MQTT reconnect rate | ≤ 1.2 × baseline |
| `/health` 5xx rate | 0 |
| Journal ERROR rate | ≤ 1.5 × baseline |

Baseline = the 7-day median before the rollout started. Any metric breaching the gate halts promotion.

---

## Step 1 — Prepare the cohort manifest

**Do:** emit a cohort manifest (YAML or CSV) from the cloud fleet inventory, one row per device:

```csv
device_id,device_code,tenant_id,hardware_profile,cargo_features,current_version,target_version,cohort
00000000-...,RPI-001,tenant-xyz,rpi4-4gb,"gpio,health",1.6.0,1.6.1,canary
00000000-...,RPI-002,tenant-xyz,rpi4-4gb,"gpio,health",1.6.0,1.6.1,early
...
```

**Expect:** every device is in exactly one cohort; no devices with mismatched `current_version` inside the same cohort (heterogeneity muddies the gate signal).

**Verify:** run a sanity query against the manifest — e.g. `awk -F, '{print $8}' manifest.csv | sort | uniq -c`.

**On failure:** heterogeneous cohort → regenerate the manifest with stricter grouping. Do not run a rollout against mixed-version cohorts; gate signal will be ambiguous.

---

## Step 2 — Pre-rollout baseline snapshot

**Do:** record the baseline metrics for the fleet before any change.

```bash
# Example — cloud-side PromQL snapshot query:
promtool query range \
    --start=-7d --end=now --step=1h \
    'rate(suderra_agent_restart_total[1h])'
# Store results as baseline-<release>.json
```

**Expect:** baseline JSON written; operator eyeballs for anomalies before taking it as the reference.

**Verify:** gate-threshold calculator reads the baseline correctly.

**On failure:** baseline contains an existing regression → fix that first; do not start a rollout on a degraded fleet.

---

## Step 3 — Promote to Canary

**Do:** issue the update command to the single canary device through the approved channel:

- For config changes: MQTT SIGHUP command → `src/main.rs:795-876` handles the reload.
- For firmware update: run `ota-firmware-update.md` on the device.

```bash
# Config change example — operator on the device or via cloud-signed MQTT cmd:
sudo systemctl reload suderra-agent
```

**Expect:** the canary device absorbs the change within one minute; no crash-loop.

**Verify:** for the canary device only
```bash
# On device:
systemctl show suderra-agent -p NRestarts,ActiveEnterTimestamp
journalctl -u suderra-agent --since "5 min ago" -p err --no-pager | head -5
```
and cloud-side the device's metrics are under baseline.

**On failure:** canary breaches any gate → halt. Run `ota-firmware-update.md` Rollback on the canary. Investigate before proceeding.

---

## Step 4 — Soak the canary (≥ 24 h)

**Do:** let the canary run. Watch the gate metrics each hour. Accept only when all gates stay within threshold for the full window.

**Expect:** flat metrics; no new ERROR-level entries; plant operator reports normal operation.

**Verify:** soak dashboard shows green across the 24 h window.

**On failure:** a gate breach late in the window → treat as if the canary had failed Step 3. Rollback + investigate.

---

## Step 5 — Promote to Early Access (10 %)

**Do:** select the Early Access cohort from the manifest. Issue the change in small staggered waves (e.g. 10 devices every 15 min) to keep reconnect rate within the gate.

**Expect:** cohort metrics track baseline + canary.

**Verify:** gate dashboard aggregates over the Early Access cohort only.

**On failure:** cohort-level gate breach → halt all pending waves; roll back the completed devices via `ota-firmware-update.md` Rollback (run per device or via signed cloud command if the cohort size justifies it).

---

## Step 6 — Soak Early Access (≥ 72 h)

Same discipline as Step 4, wider sample.

**Expect:** no statistically significant deviation from baseline + canary.

**Verify:** daily soak report.

**On failure:** statistically significant deviation → halt; investigate; decide whether to rollback or to fix-forward with a Step-3 canary of the fix.

---

## Step 7 — Promote to Wide (100 %)

**Do:** drive the remaining devices in staggered waves. Maintain the gate dashboard; a gate breach during the Wide phase should trigger an immediate cohort-level halt.

**Expect:** fleet converges on the new version/config within the wave schedule.

**Verify:** `target_version` column matches `current_version` across the manifest.

**On failure:** partial convergence with a stuck subset → treat the stuck devices as Path A / Path D candidates per `disaster-recovery.md`.

---

## Step 8 — Post-rollout retrospective

**Do:** close the rollout ticket with:
- Baseline vs post-rollout comparison.
- Any gate breaches encountered + root cause.
- Owner + deadline for every follow-up work item.

**Expect:** the retrospective lives alongside the cohort manifest in the fleet-rollout archive.

**Verify:** retro is reviewed in the next operator standup.

**On failure:** missing retro → the next rollout starts without lessons learned. Block further rollouts until the retro is filed.

---

## Config-Only Rollouts (SIGHUP-driven)

A config change does not restart the agent. The SIGHUP path (`src/main.rs:795-876`) re-reads `config.yaml`, re-validates it, atomically swaps state under the write lock, and (if `lorawan` is present) restarts the LoRa actor. Actuator outputs under active control retain their state across the reload.

Applicable scenarios: MQTT credential rotation, broker endpoint change, adding/removing Modbus or I2C devices without wiring changes, circuit-breaker threshold tuning.

**Cohort gating is the same as firmware rollouts.** The blast radius of a misconfigured reload can equal or exceed that of a bad binary, because the agent continues running on a broken state model — do not treat config as lower risk.

## Rollback Patterns

| Scenario | Rollback |
|----------|----------|
| Single-device bad update | `ota-firmware-update.md` Rollback |
| Cohort-wide bad update | Loop the above over the cohort; cohort-level signed cloud command where supported |
| Bad config reload | Ops restore `.bak` on each affected device; SIGHUP to reload OLD config (`configuration.md` Rollback) |

## Post-conditions

- All devices in the cohort manifest reflect `target_version` / `target_config`.
- Gate dashboard is green.
- Retrospective filed.

## Appendix: Evidence

- `sens-api-gateway/src/main.rs:795-876` — SIGHUP reload, atomic state swap.
- `sens-api-gateway/src/main.rs:722-730` — FR5 rationale for reload-vs-shutdown.
- `sens-api-gateway/src/config.rs:250-260` — release-build insecure-TLS lockout (ensures rollout doesn't widen attack surface).
- `sens-api-gateway/systemd/suderra-agent.service:38-56` — watchdog interplay with fleet crash rate metric.
