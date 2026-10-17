/**
 * Preview path (FE-MEDIUM-337) — labelled sample data for a view whose backend
 * does not exist yet. `definePreviewData` in a `*.preview.ts` file, rendered
 * only through `MockPreview`; see previewData.ts for the contract and
 * tests/invariants/web-preview-data-path.spec.ts for what the build enforces.
 */
export { definePreviewData, MockPreview } from './previewData';
export type { MockPreviewProps, PreviewData, PreviewFindingId, PreviewSource } from './previewData';
