# File Transfer Auditor: 2026-04-11 Full Platform E2E

Scope: uploads, attachments, imports, exports, previews, and downloads across AquaMobil, farm, sensor, and admin surfaces.

## Findings

### HIGH-001 - AquaMobil media viewer cannot retrieve or download attachments
- File refs: [web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L39) and [web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/MediaViewerPage.tsx#L97)
- Root cause: `useChannelMedia` is a hard stub that always returns an empty array, and the page invokes it with `''` instead of a real channel id. The route can resolve `attachmentId`, but there is no attachment source to load, so preview/download never reaches a real artifact.
- Impact: AquaMobil attachment and media viewer surfaces are dead-end UI. Users can open the viewer, but there is no file roundtrip, no previewed content, and no download target.
- Cross-domain dependency: `mobile-app-auditor`

### HIGH-002 - Farm chemical document upload/delete is non-atomic and can orphan blobs or dangling references
- File refs: [web/modules/farm-module/src/hooks/useChemicals.ts](/var/aqua-saas/web/modules/farm-module/src/hooks/useChemicals.ts#L549) and [web/modules/farm-module/src/hooks/useChemicals.ts](/var/aqua-saas/web/modules/farm-module/src/hooks/useChemicals.ts#L680)
- Root cause: `useUploadChemicalDocument` does a MinIO upload first, then a separate GraphQL association. If the GraphQL step fails, the uploaded file is left behind with no compensating cleanup. The delete path is the reverse shape: it removes the blob first, then the GraphQL reference, so a later failure leaves the record pointing at a missing file.
- Impact: the file-bearing workflow is not durable end-to-end. Users can get a success on the storage step but no retrievable document in the domain model, or a successful blob delete with a still-linked document reference.
- Cross-domain dependencies: `form-write-auditor`, `data-readback-auditor`

### HIGH-003 - Sensor SCADA PDF export is structurally invalid
- File refs: [web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx#L49) and [web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx](/var/aqua-saas/web/modules/sensor-module/src/components/scada-builder/ExportDialog.tsx#L244)
- Root cause: the PDF path takes the PNG blob bytes from `canvas.toBlob()` and writes them into a PDF image XObject with `/Filter /FlateDecode`. That is not a valid roundtrip for a PNG container stream, so the exported PDF can fail to open or render correctly.
- Impact: the advertised PDF download path does not reliably produce a usable artifact.
- Cross-domain dependency: `chart-widget-auditor`

### HIGH-004 - Admin invoice download action is a placeholder, not a file transfer
- File refs: [web/modules/admin-panel/src/pages/InvoicesPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/InvoicesPage.tsx#L193) and [web/modules/admin-panel/src/pages/InvoicesPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/InvoicesPage.tsx#L523)
- Root cause: `handleDownloadPdf` only emits an info toast saying PDF download is not yet available. The UI exposes a download action, but there is no backend fetch, blob creation, or download URL behind it.
- Impact: the invoice detail and row actions advertise a download surface that cannot return the invoice artifact at all.
- Cross-domain dependency: `table-grid-auditor`

### MEDIUM-005 - Admin invoice CSV export is capped to the loaded slice, not the full invoice set
- File refs: [web/modules/admin-panel/src/pages/InvoicesPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/InvoicesPage.tsx#L85) and [web/modules/admin-panel/src/pages/InvoicesPage.tsx](/var/aqua-saas/web/modules/admin-panel/src/pages/InvoicesPage.tsx#L217)
- Root cause: invoices are fetched with `limit: 100`, and the CSV export serializes only the in-memory `invoices` array. There is no separate export query or pagination walk, so any invoices outside the loaded slice are silently omitted from the file.
- Impact: the generated export can be incomplete for larger tenants or filtered views that do not fit into the loaded client slice.
- Cross-domain dependency: `table-grid-auditor`

## Verdict

The platform has working file-bearing surfaces in a few areas, but the current full-platform pass still has multiple root-cause breaks in the file roundtrip itself: one mobile attachment viewer that cannot load data, one farm upload flow that is not transactional, one invalid sensor PDF export, and broken or partial admin invoice downloads/exports.
