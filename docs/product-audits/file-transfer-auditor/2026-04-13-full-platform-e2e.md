# File Transfer Auditor: 2026-04-13 Full Platform E2E

**Scope:** uploads, attachments, imports, exports, previews, and downloads across AquaMobil, farm, sensor, admin, tenant-admin, hydroponics, and dashboard surfaces.

**Prior cycle:** 2026-04-11 identified 5 findings (HIGH-001 through MEDIUM-005). Commit 79ce984f addressed 12 issues. This cycle re-verifies prior findings and adds new coverage.

---

## Re-verification of Prior Findings

### HIGH-001 (AquaMobil media viewer) -- STILL OPEN
- `useChannelMedia` at [web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L43-L49](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx) remains a hard stub returning `{ media: [], loading: false, error: null }`. The component passes `''` as channelId (line 104). No graphql query wiring has been added. The TODO comment on line 42 confirms this: "Wire to graphqlRequest(GET_ATTACHMENT) when backend is ready." The media viewer is still a dead-end: preview, download, and swipe navigation are all inert.

### HIGH-002 (Chemical document upload/delete non-atomic) -- STILL OPEN
- Upload: [web/modules/farm-module/src/hooks/useChemicals.ts#L549-L617](/var/aqua-saas/web/modules/farm-module/src/hooks/useChemicals.ts) still performs MinIO upload (step 1, line 571) then GraphQL association (step 2, line 588) as two independent network calls. If step 2 fails, the blob is orphaned in MinIO with no cleanup.
- Delete: [web/modules/farm-module/src/hooks/useChemicals.ts#L666-L711](/var/aqua-saas/web/modules/farm-module/src/hooks/useChemicals.ts) deletes the blob first (step 1, line 682), then removes the GraphQL reference (step 2, line 699). If step 2 fails, the chemical entity still references a missing file.

### HIGH-003 (SCADA PDF export structurally invalid) -- STILL OPEN
- [web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx#L49-L142](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx): `buildPdfFromPng` declares `/Filter /FlateDecode` on the image XObject (line 111) but writes raw PNG container bytes without deflate-encoding them. PNG bytes contain a zlib-compressed IDAT chunk, but that is not the same as the PDF stream itself being FlateDecode-compressed. The mismatch means many PDF readers will fail to decode the image XObject, producing a blank page or a render error.

### HIGH-004 (Admin invoice PDF download is a placeholder) -- STILL OPEN
- [web/modules/admin-panel/src/pages/InvoicesPage.tsx#L193-L195](/var/aqua-saas/web/modules/admin-panel/src/pages/InvoicesPage.tsx): `handleDownloadPdf` still only fires `showToast('PDF download is not yet available', 'info')`. No backend endpoint, no blob creation, no file transfer. The UI shows a "Download" action on every invoice row (line 523) and a "Download PDF" button in the detail modal (line 622), both of which are non-functional.

### MEDIUM-005 (Admin invoice CSV export capped to loaded slice) -- STILL OPEN
- [web/modules/admin-panel/src/pages/InvoicesPage.tsx#L85-L94](/var/aqua-saas/web/modules/admin-panel/src/pages/InvoicesPage.tsx): invoices are still fetched with `limit: 100` (line 93). The CSV export at line 223 serializes only the in-memory `invoices` array. There is no server-side export endpoint or pagination walk, so tenants with more than 100 invoices get a silently truncated export.

---

## New Findings

### HIGH-006 -- Chemical document upload passes undefined `url` to GraphQL due to backend/frontend field mismatch
- **File refs:** Backend response: [apps/gateway-api/src/upload/upload.controller.ts#L265-L275](/var/aqua-saas/apps/gateway-api/src/upload/upload.controller.ts) returns `{ path, etag, size, contentType, ... }` (no `url` field). Frontend: [web/modules/farm-module/src/hooks/useChemicals.ts#L596](/var/aqua-saas/web/modules/farm-module/src/hooks/useChemicals.ts) reads `uploadResult.url` which is `undefined`.
- **Root cause:** The `ChemicalDocumentUploadResponse` interface in the backend controller does not include a `url` field -- it returns `path` (the MinIO storage path). But the frontend hook at line 596 passes `url: uploadResult.url` into the `addChemicalDocument` GraphQL mutation. This means the document reference stored in the chemical entity has `url: undefined`. Downstream, any attempt to preview or download the document through the stored `url` will fail because the value was never set.
- **Impact:** Chemical documents upload successfully to MinIO, but the GraphQL reference persisted in the domain model has a null/undefined URL. The document metadata is saved but the file cannot be retrieved via the stored reference. The `useGetDocumentUrl` hook (line 716) provides a separate presigned-URL path that works against `path`, but the `ChemicalDocument.url` field displayed in the UI (from the GraphQL query at line 222-228) is empty.
- **Fix direction:** The backend response should include a `url` field constructed from the storage path (either as a presigned URL or as the raw path for the client to request a presigned URL via the existing endpoint). Alternatively, the frontend should use `uploadResult.path` and call the presigned-url endpoint before populating the GraphQL mutation input.
- **Cross-domain dependency:** `data-readback-auditor`

### HIGH-007 -- Messaging tenant data export is a console.log stub
- **File refs:** [web/modules/admin-panel/src/pages/messaging/MessagingTenantsPage.tsx#L112-L125](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingTenantsPage.tsx)
- **Root cause:** The `handleExport` function only does `console.log('Export requested for tenant:', tenantId)`. The TODO comment at line 114-116 says "Replace with actual admin API call." The UI exposes an "Export" button per tenant row (line 260) that invokes this stub.
- **Impact:** The messaging tenant export action is completely non-functional. No API call, no file generation, no download. The backend `DataExportService` exists and is fully implemented ([apps/messaging-service/src/compliance/services/data-export.service.ts](/var/aqua-saas/apps/messaging-service/src/compliance/services/data-export.service.ts)) with `exportChannel` and `exportTenant` methods that produce CSV/JSON, but the admin UI never calls it.
- **Fix direction:** Wire the `handleExport` function to call the admin API endpoint that invokes the `DataExportService.exportTenant()` method, receive the response data, and trigger a file download.
- **Cross-domain dependency:** `table-grid-auditor`

### HIGH-008 -- Messaging compliance page uses all-zero mock data, no API integration
- **File refs:** [web/modules/admin-panel/src/pages/messaging/MessagingCompliancePage.tsx#L66-L86](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingCompliancePage.tsx)
- **Root cause:** The compliance dashboard is driven by hardcoded `MOCK_STATS` (all zeros), `MOCK_LEGAL_HOLDS` (empty array), `MOCK_EXPORTS` (empty array), `MOCK_RETENTION_BUCKETS`, and `MOCK_DAILY_AUDIT`. The comment on line 66 says "TODO: Replace with admin API calls." No API calls are made anywhere in the page. The `ExportRecord` interface at line 43 has a `downloadUrl` field, but since the array is always empty, no download action is ever possible.
- **Impact:** The entire compliance dashboard surface is display-only with fake zeros. Legal hold data, export history, retention policy counts, and audit entries are all placeholders. Users see a dashboard that appears operational but reflects no real state.
- **Fix direction:** Connect to the compliance endpoints that already exist in the backend messaging service (`DataExportService`, `LegalHoldService`, `ComplianceAuditService`).

### MEDIUM-009 -- Hydroponics ResultTab download/export is a TODO stub
- **File refs:** [web/modules/hydroponics-module/src/pages/solution/tabs/ResultTab.tsx#L51-L53](/var/aqua-saas/web/modules/hydroponics-module/src/pages/solution/tabs/ResultTab.tsx)
- **Root cause:** `handleDownload` is an empty function body with `// TODO: Implement download/export of calculation results.` The UI presumably has a download button that calls this (though the button is in the remainder of the file).
- **Impact:** Users see a download/export action for nutrient solution calculation results, but clicking it does nothing. The calculation data (`NutrientVector`, `FertilizerAmount`) exists in memory but no file is generated.

### MEDIUM-010 -- Tenant audit log CSV export is limited to the current page only
- **File refs:** [web/modules/tenant-admin/src/hooks/useTenantAuditLog.ts#L145-L180](/var/aqua-saas/web/modules/tenant-admin/src/hooks/useTenantAuditLog.ts)
- **Root cause:** The `exportCsv` function exports only `query.data?.data`, which is the current page (default 20 rows per page, line 61). There is no server-side export endpoint or full-fetch query. The code does show a `window.confirm` warning (line 150-155) when `total > entries.length`, which is a partial mitigation, but the user still cannot export the full dataset -- only the visible page.
- **Impact:** For tenants with significant audit history, the CSV export silently caps to 20 records. The warning dialog helps awareness but does not provide a path to complete export.
- **Cross-domain dependency:** `table-grid-auditor`

### MEDIUM-011 -- Messaging audit log CSV export does not escape fields containing commas or quotes
- **File refs:** [web/modules/admin-panel/src/pages/messaging/MessagingAuditPage.tsx#L124-L147](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingAuditPage.tsx)
- **Root cause:** The CSV row generation at lines 129-137 wraps only the `details` field in quotes (line 134: `` `"${e.details.replace(/"/g, '""')}"` ``). Other fields like `tenantName`, `userName`, `action` are joined with comma separators without any escaping. If a tenant name or username contains a comma, quote, or newline, the CSV output will be malformed -- column boundaries shift for the affected rows.
- **Impact:** The generated CSV can be unparseable for rows where audit log fields contain reserved CSV characters. This is a correctness issue in the exported artifact.

### MEDIUM-012 -- Batch document upload response lacks `storageUrl` field, causing DocumentUploadSection to show upload as incomplete
- **File refs:** Backend response: [apps/gateway-api/src/upload/upload.controller.ts#L483-L494](/var/aqua-saas/apps/gateway-api/src/upload/upload.controller.ts). Frontend: [web/modules/farm-module/src/hooks/useFileUpload.ts#L44](/var/aqua-saas/web/modules/farm-module/src/hooks/useFileUpload.ts) `UploadedDocument` interface expects `storageUrl: string`. DocumentUploadSection: [web/modules/farm-module/src/pages/production/components/DocumentUploadSection.tsx#L102-L113](/var/aqua-saas/web/modules/farm-module/src/pages/production/components/DocumentUploadSection.tsx) sets `storageUrl: result.storageUrl`. `toDocumentInput` at line 407: `if (!doc.isUploaded || !doc.storagePath || !doc.storageUrl) return null;`
- **Root cause:** The backend `BatchDocumentUploadResponse` does not return `storagePath` or `storageUrl` -- it returns `path`. The frontend `UploadedDocument` interface expects `storagePath` and `storageUrl`. At line 102-113 of `DocumentUploadSection`, after a successful upload the code sets `storageUrl: result.storageUrl` which resolves to `undefined`. The `toDocumentInput` helper (line 407) guards with `if (!doc.storageUrl) return null`, so the document is filtered out when building the batch creation payload.
- **Impact:** Batch documents are uploaded to MinIO successfully, but because the response field mapping is wrong (`path` vs `storagePath`/`storageUrl`), the documents are silently dropped when the batch is created. The user sees a green checkmark on the upload, then the document does not appear on the created batch.
- **Fix direction:** Either rename the backend response fields to match `storagePath`/`storageUrl`, or update the frontend to map `result.path` to both `storagePath` and `storageUrl` (constructing the URL from the path via the presigned URL endpoint).
- **Cross-domain dependency:** `form-write-auditor`, `data-readback-auditor`

### MEDIUM-013 -- SCADA recipe import silently swallows parse errors
- **File refs:** [web/modules/sensor-module/src/components/scada-builder/RecipePanel.tsx#L176-L202](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/RecipePanel.tsx)
- **Root cause:** The `handleImport` function at line 196 catches all errors with `catch {}` (empty catch block) and the comment says "Silently ignore malformed JSON -- user will see no change." If a user selects a corrupt or wrong-format JSON file, the import produces no feedback at all -- no error toast, no status message.
- **Impact:** Users cannot distinguish between "the file was imported successfully but had zero recipes" and "the file was invalid and nothing happened." This is a silent failure in a file-bearing workflow.

### LOW-014 -- AOI satellite image export downloads a blob URL that may not retain filename on all browsers
- **File refs:** [web/modules/farm-module/src/components/map/AOIAnalysisPanel.tsx#L336-L345](/var/aqua-saas/web/modules/farm-module/src/components/map/AOIAnalysisPanel.tsx)
- **Root cause:** The export creates a link with `link.href = result.imageUrl` (which is a blob: URL created from the Copernicus response) and sets `link.download`. The `result.imageUrl` is created from the fetch response blob without verifying it is actually a valid PNG. If the Copernicus API returns an error (e.g., HTML error page or JSON error), the blob is still saved as a `.png` file.
- **Impact:** Minor. Under error conditions the downloaded file may not be a valid image. Under normal conditions this works correctly.

### LOW-015 -- console.log/console.error usage in file-bearing flows violates codebase rules
- **File refs:** [web/modules/admin-panel/src/pages/messaging/MessagingTenantsPage.tsx#L120](/var/aqua-saas/web/modules/admin-panel/src/pages/messaging/MessagingTenantsPage.tsx) (`console.log`), [web/modules/farm-module/src/components/map/AOIAnalysisPanel.tsx#L315](/var/aqua-saas/web/modules/farm-module/src/components/map/AOIAnalysisPanel.tsx) (`console.error`), [web/modules/farm-module/src/pages/production/components/BatchFormModal.tsx#L308](/var/aqua-saas/web/modules/farm-module/src/pages/production/components/BatchFormModal.tsx) (`console.error`)
- **Root cause:** CLAUDE.md rule: "`console.log` YASAK -- NestJS `Logger` kullan." While these are frontend files (not NestJS), the codebase standard applies platform-wide. These are in file-bearing flows where structured logging or toast notifications should replace raw console output.
- **Impact:** Diagnostic/PII data may leak to browser console; no user feedback on errors.

---

## Working Flows (Verified Correct)

The following file-bearing flows were reviewed and found to be structurally correct:

1. **AquaMobil media upload** (`useMediaUpload`): Two-step presigned upload (GraphQL -> MinIO PUT) with MIME validation, size validation, client-side image compression, progress tracking, and abort support. Returns `storageKey` for message association. Backend `MediaService` validates tenant isolation on storage keys. [web/apps/aquamobil/src/hooks/useMediaUpload.ts](/var/aqua-saas/web/apps/aquamobil/src/hooks/useMediaUpload.ts)

2. **Backend upload controller** (chemical + batch documents): Server-side magic byte validation, filename sanitization (null byte rejection, single-extension extraction), tenant context enforcement, and presigned URL generation with path traversal prevention. [apps/gateway-api/src/upload/upload.controller.ts](/var/aqua-saas/apps/gateway-api/src/upload/upload.controller.ts)

3. **MinIO client service**: Proper `putObject`/`getObject`/`removeObject` wiring, tenant-scoped path generation, presigned URL generation, and content type detection. [libs/storage/src/minio-client.service.ts](/var/aqua-saas/libs/storage/src/minio-client.service.ts)

4. **Messaging data export service** (backend): Streaming cursor for tenant-wide export (avoids OOM), proper CSV escaping, compliance audit logging, legal hold checking. [apps/messaging-service/src/compliance/services/data-export.service.ts](/var/aqua-saas/apps/messaging-service/src/compliance/services/data-export.service.ts)

5. **Backup/restore service**: pg_dump/pg_restore with schema name validation, SHA-256 checksum integrity, scheduled daily/weekly backups, and proper expired backup cleanup. [apps/admin-api-service/src/database-management/services/backup-restore.service.ts](/var/aqua-saas/apps/admin-api-service/src/database-management/services/backup-restore.service.ts)

6. **SCADA CSV tag import/export** (`CsvTagDialog`): Correct CSV generation with field escaping, robust CSV parsing respecting quoted fields, preview before apply, widget ID validation on import. [web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/CsvTagDialog.tsx)

7. **SCADA JSON bundle export** (unified editor): Serialized bundle with size check, download + copy-to-clipboard, preview pane. [web/modules/sensor-module/src/components/unified-editor/json-bundle/ExportDialog.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/unified-editor/json-bundle/ExportDialog.tsx)

8. **SCADA PNG export**: Canvas capture via SVG foreignObject, multi-resolution support, proper blob URL cleanup. [web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx (PNG path)](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx)

9. **Trend chart CSV export**: Correctly formats timestamp + tag values with proper CSV structure. [web/modules/sensor-module/src/components/scada-builder/widget-renderers/trendChartUtils.ts#L97-L112](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/widget-renderers/trendChartUtils.ts)

10. **SCADA recipe JSON import/export**: Export serializes recipes as JSON blob download. Import assigns new IDs to avoid conflicts. (Import error handling is flagged as MEDIUM-013.)

11. **Admin reports API**: Proper endpoint structure for report generation and download URL construction. [web/modules/admin-panel/src/services/api/reports.ts](/var/aqua-saas/web/modules/admin-panel/src/services/api/reports.ts)

12. **Shared FileUpload component**: Correct drag-and-drop, progress tracking, blob URL memory cleanup on unmount, `crypto.randomUUID()` for file IDs. [web/shared-ui/src/components/Form/FileUpload.tsx](/var/aqua-saas/web/shared-ui/src/components/Form/FileUpload.tsx)

13. **Presigned URL endpoint** (backend): URL-decodes before traversal checks (prevents `%2e%2e` bypass), validates `{tenantId}/` prefix, rejects null bytes, normalizes double slashes, enforces 24-hour max expiry. [apps/gateway-api/src/upload/upload.controller.ts#L614-L683](/var/aqua-saas/apps/gateway-api/src/upload/upload.controller.ts)

---

## Summary

| ID | Severity | Surface | Status |
|----|----------|---------|--------|
| HIGH-001 | HIGH | AquaMobil media viewer stub | STILL OPEN (from 04-11) |
| HIGH-002 | HIGH | Chemical doc upload/delete non-atomic | STILL OPEN (from 04-11) |
| HIGH-003 | HIGH | SCADA PDF export invalid | STILL OPEN (from 04-11) |
| HIGH-004 | HIGH | Invoice PDF download placeholder | STILL OPEN (from 04-11) |
| MEDIUM-005 | MEDIUM | Invoice CSV capped to 100 | STILL OPEN (from 04-11) |
| HIGH-006 | HIGH | Chemical doc `url` field mismatch | NEW |
| HIGH-007 | HIGH | Messaging tenant export is console.log stub | NEW |
| HIGH-008 | HIGH | Messaging compliance page all-mock | NEW |
| MEDIUM-009 | MEDIUM | Hydroponics ResultTab download stub | NEW |
| MEDIUM-010 | MEDIUM | Tenant audit log CSV page-only export | NEW |
| MEDIUM-011 | MEDIUM | Messaging audit CSV escaping incomplete | NEW |
| MEDIUM-012 | MEDIUM | Batch doc response field mismatch (storageUrl) | NEW |
| MEDIUM-013 | MEDIUM | Recipe import silent error swallowing | NEW |
| LOW-014 | LOW | AOI export no error-blob validation | NEW |
| LOW-015 | LOW | console.log in file flows | NEW |

**Totals:** 7 HIGH, 6 MEDIUM, 2 LOW (15 findings; 5 carried from prior cycle, 10 new).

---

## Verdict

The platform has a well-designed backend storage layer (MinIO client, presigned URLs with tenant isolation, magic byte validation) and several working client-side export flows (SCADA PNG, CSV tag import/export, JSON bundle). However, the file roundtrip breaks at integration boundaries:

1. **Upload-to-domain association** is non-atomic in multiple flows (chemical docs, batch docs) and has field name mismatches between backend responses and frontend expectations (`path` vs `url`/`storageUrl`), causing uploaded files to be orphaned or silently dropped.

2. **Download/export placeholders** persist in high-visibility surfaces (invoice PDF, messaging tenant export, compliance dashboard, hydroponics results), giving users non-functional file transfer actions.

3. **The AquaMobil media viewer** remains fully inert -- the attachment data source is a hard stub returning empty arrays.

4. **The SCADA PDF export** still has an invalid `/FlateDecode` filter on raw PNG bytes.

The most impactful root-cause fixes would be: (a) aligning the upload response field names between backend and frontend, (b) wiring the messaging tenant export and compliance dashboard to their already-implemented backend services, and (c) implementing the AquaMobil media query.
