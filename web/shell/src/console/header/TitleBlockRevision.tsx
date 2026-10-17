/**
 * TitleBlockRevision — the content of the title block's "Rev." cell
 * (README §7.4; FE-LOW-338).
 *
 * WHAT: the revision preview rendered through MockPreview's inline variant,
 * so the sample letter always sits beside the MOCK chip that names the
 * missing source and the finding. The shell passes it as TitleBlock's
 * `revision`; shared-ui's TitleBlock stays free of preview data.
 */
import { MockPreview } from '@aquaculture/shared-ui';
import type { ReactElement } from 'react';

import { TITLE_BLOCK_REVISION_PREVIEW } from './titleBlockRevision.preview';

export function TitleBlockRevision(): ReactElement {
  return (
    <MockPreview data={TITLE_BLOCK_REVISION_PREVIEW} variant="inline">
      {(revision) => revision}
    </MockPreview>
  );
}
