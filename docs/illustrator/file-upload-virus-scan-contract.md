# File-Upload Virus-Scan Contract Specification

> **Status:** OPEN — design specification only. The implementation
> requires an operational decision on daemon hosting (sidecar / managed
> service / disabled) that this document does NOT make. The contract
> below is the architecturally fixed surface that any chosen implementation
> will plug into.
>
> **Closes (when implemented):** Phase 6.2.2 of the farm-module plan
>
> **Related:** `libs/storage/src/file-upload-security.service.ts:25-30`
> (the existing service's docblock that names the deferred surfaces)

## Why this contract exists

`FileUploadSecurityService` already lands four of six Phase 6.2 surfaces:

  - max file size enforcement (per-document-type + global cap)
  - mime whitelist (per-document-type)
  - magic-byte sniff fallback
  - **EXIF strip** for image uploads (sharp-based, fail-safe)

The two that remain — **ClamAV virus scan** and **orphan cleanup cron** —
diverge in nature: orphan cleanup is already shipped (`StorageOrphanCleanupService`).
That leaves virus scan as the last unwired Phase 6.2 surface.

The implementation is gated on an operational decision (where does the
clamd daemon run? sidecar? managed service?) that an autonomous loop
cannot make. But the **contract** between
`FileUploadSecurityService` and any virus-scan implementation IS
definable, and definable now would let the implementing PR plug in
without re-deriving the integration shape from scratch.

## What this contract specifies

### 1. The `VirusScanProvider` interface

Every implementation (ClamAV, VirusTotal, AWS Macie, no-op for dev)
satisfies this single interface:

```typescript
// libs/storage/src/virus-scan/virus-scan-provider.ts
export interface ScanResult {
  /** True when the scanner did NOT find any signatures. */
  isClean: boolean;
  /** Threat name when isClean=false; null when clean OR scan failed open. */
  threat: string | null;
  /** When the scan completed. */
  scannedAt: Date;
  /**
   * The scanner that produced this result. Lets consumers correlate
   * "this row was scanned by clamd vs that row by VirusTotal" when
   * the implementation changes mid-life.
   */
  scannerName: string;
  /**
   * Scan duration. Operational metric for watchdog dashboards
   * (slow scans → daemon overload signal).
   */
  durationMs: number;
}

export interface VirusScanProvider {
  /**
   * Scan a buffer. Implementations:
   * - MUST return isClean=true OR isClean=false; never throw on a
   *   clean result.
   * - MAY throw on transport errors (daemon unreachable, timeout).
   *   Callers handle the throw via the post-upload async pattern
   *   below — a transport error does NOT block the upload.
   * - MUST be idempotent — same buffer twice returns the same
   *   result.
   * - MUST complete within the configured timeout
   *   (default 30s). The provider is responsible for honouring
   *   timeouts; callers do NOT wrap with their own.
   */
  scan(buffer: Buffer, contentType: string): Promise<ScanResult>;

  /**
   * Health-check for the scanner. Returns true when the scanner is
   * reachable and ready. Used by `/health/ready` to decide whether
   * uploads should proceed (degraded mode: accept upload, mark
   * isInfected=null, scan later when scanner returns).
   */
  isReady(): Promise<boolean>;
}
```

### 2. The async post-upload integration

`FileUploadSecurityService.uploadSecure()` extends with a NON-BLOCKING
post-upload step:

```
preflight → strip EXIF → minio.uploadFile → return UploadResult
                                          ↓
                                          schedules async scan
                                          (resolves after the
                                          response is already
                                          returned to the caller)
```

The async scan SHOULD run on the platform outbox / queue rather
than `setImmediate` so a process restart doesn't lose the scan
job. When the scan completes:

  - **Clean result:** persist `isInfected=false`, `scannedAt=now`,
    `scannerName=<name>` on the file's metadata row. No further
    action.
  - **Infected result:** move the MinIO object to the quarantine
    bucket (configured via `STORAGE_QUARANTINE_BUCKET` env);
    persist `isInfected=true`, `threat=<name>`, `scannedAt=now` on
    the metadata row; emit `FileInfectedEvent` via outbox.
  - **Transport failure (scan threw):** retry with exponential
    backoff up to 3 times; if all retries fail, persist
    `isInfected=null`, `lastScanError=<message>` and emit
    `FileScanFailedEvent` via outbox so an operator dashboard can
    surface the stuck file. The bytes stay in the primary bucket
    (NOT quarantine) — failing closed would block legitimate
    uploads on a daemon outage.

### 3. The `FileInfectedEvent` outbox contract

```typescript
// libs/event-contracts/src/storage-events.ts
export interface FileInfectedEventPayload {
  tenantId: string;
  fileId: string;
  bucket: string;          // ALWAYS the quarantine bucket post-scan
  originalBucket: string;  // Where the file was BEFORE quarantine
  filename: string;
  contentType: string;
  threat: string;
  scannerName: string;
  scannedAt: string;       // ISO-8601
  uploadedBy: string;      // userId; populated from upload metadata
  uploadedAt: string;
  documentType: string;    // e.g. 'TREATMENT_PHOTO', 'MSDS', etc.
}
```

Consumers:

- **Notification service** raises an alert to TENANT_ADMIN +
  whoever uploaded the file ("Upload rejected as infected — your
  attempt at <time> was quarantined").
- **Audit-log service** writes a `FILE_QUARANTINED` row tied to
  the upload's correlationId.
- **Compliance reports** (Mattilsynet, GDPR) include a count of
  quarantined uploads per tenant per quarter.

### 4. The quarantine bucket configuration

```yaml
# .env.example excerpt
STORAGE_QUARANTINE_BUCKET=aqua-quarantine
STORAGE_QUARANTINE_TTL_DAYS=30
```

Quarantine bucket policy:
  - **No presigned URLs.** Quarantine objects MUST NOT be retrievable
    by any tenant-facing path. Only ops-team direct credentials.
  - **30-day TTL** via MinIO lifecycle rule — after 30 days the
    object is hard-deleted. Audit-log row stays forever per the
    compliance retention policy.
  - **Encrypted at rest** — match the primary bucket's KMS settings.

### 5. The DI shape

```typescript
// libs/storage/src/storage.module.ts
StorageModule.forRoot({
  // ... existing options
  virusScanProvider: ClamAVVirusScanProvider,  // or any other impl
});
```

`StorageModule` exports `VirusScanProvider` as an injectable so
`FileUploadSecurityService` consumes it via constructor DI. When
no provider is configured, `FileUploadSecurityService` skips the
post-upload scan with a single startup warn log:

```
[FileUploadSecurityService] No VirusScanProvider configured.
Uploads will not be scanned. Configure one via StorageModule.forRoot()
to close Phase 6.2.2 of the farm-module plan.
```

The startup warn is the ONLY architectural concession to the
"no provider" case. Production deploys MUST configure one; CI /
local dev MAY skip with the warn visible in startup logs. There
is no `NoopProvider` that returns `isClean: true` — that would be
silent security degradation rather than an operationally-visible
warning.

## What this contract does NOT specify

The implementing PR's operational decisions:

  - **clamd hosting** — sidecar vs managed (e.g. AWS GuardDuty
    Malware Protection) vs disabled. The provider abstraction means
    swapping is a config change, not a code change.
  - **Scan budget** — how many scans/sec the platform can sustain.
    Affects parallelism + queue depth.
  - **Retention policy on the metadata** — how long
    `isInfected=null` rows stay before they're either re-scanned
    or marked failed.
  - **Cross-tenant correlation** — should the same threat
    signature on tenant A's file alert tenant B if tenant B has
    similar uploads? Compliance / privacy decision.

These belong in the operations runbook + the compliance review,
NOT in this code contract.

## Architectural decision: rejected alternatives

| Alternative | Why rejected |
|---|---|
| Inline scan inside `uploadSecure()` (synchronous) | A scan can take 10+ seconds for a large PDF. Inline blocks the upload response, hurts UX, and ties the upload's success to the scanner's availability. The async post-upload pattern decouples the two. |
| `NoopVirusScanProvider` as default | Silent security degradation — code that depends on `provider.scan()` for compliance gets a green isClean from a scanner that isn't running. The startup warn pattern surfaces the missing provider operationally. |
| Move quarantine logic into MinIO bucket policy | MinIO can lifecycle-delete but cannot pattern-match "object infected with X". The pattern-matching is the scanner's job; the bucket move is the integration step that follows the scanner's verdict. |

## Acceptance criteria (the implementing PR)

- [ ] `libs/storage/src/virus-scan/virus-scan-provider.ts`
      exports the `VirusScanProvider` interface and `ScanResult` type
      verbatim from this spec.
- [ ] At least one production implementation
      (`ClamAVVirusScanProvider` or chosen alternative) lives under
      `libs/storage/src/virus-scan/` with its own dependency import
      and runtime config.
- [ ] `FileUploadSecurityService.uploadSecure()` extends with the
      async post-upload step described above. Under no scanner
      configuration the existing happy-path is unchanged + the
      startup warn fires once.
- [ ] `libs/event-contracts/src/storage-events.ts` declares the
      `FileInfectedEvent` payload + `FileInfectedEvent` type, plus
      the upcaster scaffold so future v2 evolutions follow the same
      pattern as `sensor-events.ts`.
- [ ] Quarantine bucket env vars added to
      `.env.example` and `infrastructure/docker/` compose files.
- [ ] Tests cover: clean upload, infected upload (object moves to
      quarantine, event fires), transport failure (retry + event),
      no-provider startup (warn fires, uploads still succeed).
- [ ] Closing PR's commit message carries
      `Closes: <farm-modulu-kor-noktalar-dogrulama.md#FILE-VIRUS-SCAN>`
      or whatever finding ID gets registered when this implementation lands.

## Closure path

When the operational decision lands and the implementing PR ships:

1. The implementing PR closes Phase 6.2.2 with the field-resolver code.
2. This document either gets archived as the historical contract
   the implementation honoured, or gets edited inline to record any
   negotiated design changes — same pattern as
   `sensor-tank-federation-contract.md`.
3. A new finding `FILE-VIRUS-SCAN-001` (or similar) registers as
   RESOLVED with the closing commit.
