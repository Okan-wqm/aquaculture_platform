# Reference roles

`apps/farm-service/src/fx-gate.ts` — CI gate scans every entry.

**Dosyalar:**

- `apps/farm-service/src/fx-api-key.service.ts` — YENİ
- `apps/farm-service/src/fx-erasure.interface.ts` (NEW) -- define the handler
- `apps/farm-service/src/fx-dsr.service.ts` (new — orchestrates Art 15/17)

Add one versioned catalog, proposed at
`apps/farm-service/src/fx-catalog.yaml`, with a strict schema.

Önerilen yön, `apps/farm-service/src/fx-module` altında bir modül
kurmaktır.

- Agent spec: `apps/farm-service/src/fx-cost.yml` — file does not exist.
- Scan scope: excluding `node_modules`, `apps/farm-service/fx-report`.

- **Files to change:**
  - `apps/farm-service/src/fx-icon.ts`
  - `apps/farm-service/src/fx-config.service.ts`

## Evidence

- `apps/farm-service/src/fx-config.service.ts:349-358` — writes no audit row.

**Files:**

- Create: `apps/farm-service/src/fx-harness-new.sh`
- Modify: `apps/farm-service/src/fx-harness.sh`
