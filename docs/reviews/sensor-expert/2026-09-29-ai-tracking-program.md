# Sensor data reachable for farm evaluation — sensor-expert, 2026-09-29

Raised in the 2026-09-29 adversarial review of the ai-service program plan (automatic tasks,
tracking agents, AI configuration). Four reviewers (alert-engine, AI safety, farm domain,
architecture) attacked plan rev 2 against origin/main `dae95efb3`; the main session re-verified the
load-bearing claims in code, and ALERT-CRITICAL-004 on the live database. MT-HIGH-064 and
MT-MEDIUM-065 come from the PR-T1 audit. Each finding names the plan PR that closes it; "owner
decision" entries need a product decision before any code.

## SENSOR-MEDIUM-130

There is no sensor time-series read path for farm or AI, so water tracking sees only manual spot
tests and never the night DO minimum.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0c.
- **Evidence:** `infrastructure/nats/services.yaml:394` — request.sensor.verifyDeviceOwnership is
  the only sensor request subject.
- **Rule:** Sensor data reachable for evaluation.

Closed by plan PR-C0c.

## SENSOR-MEDIUM-131

Probe calibration due dates live only in sensor-service and never reach tasks or AI.

- **Severity:** MEDIUM. **Deadline:** 2026-11-30. **Closes in:** plan PR-C0c.
- **Evidence:** `apps/sensor-service/src/database/entities/sensor-data-channel.entity.ts:287` —
  next_calibration_due.
- **Rule:** Calibration visibility.

Closed by plan PR-C0c (listCalibrationDue) + PR-B1a-2 (CALIBRATION_DUE rule).
