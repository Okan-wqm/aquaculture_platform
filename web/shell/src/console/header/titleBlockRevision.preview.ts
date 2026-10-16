/**
 * The title block's sheet revision — preview data (FE-LOW-338).
 *
 * WHY a preview: the design's title block shows a revision, but no console
 * page has a revision concept and no service stores one. Okan's decision
 * (2026-10-16): an absent backend gets a labelled preview through the typed
 * path, so the cell renders this sample only inside MockPreview, beside its
 * MOCK chip. When FE-LOW-338 is resolved, web-preview-data-path.spec.ts fails
 * until this file is replaced by the real revision.
 */
import { definePreviewData } from '@aquaculture/shared-ui';

export const TITLE_BLOCK_REVISION_PREVIEW = definePreviewData(
  {
    finding: 'FE-LOW-338',
    reasonKey: 'console.titleBlock.revisionPreviewReason',
    needs:
      'a revision record per console page (page id, revision, changed at) — no service stores one',
  },
  'C',
);
