/**
 * The inbox's access-request item, as sample data (RBAC-MEDIUM-020): no
 * service records a member's request for a capability or a site, so the item
 * renders only through MockPreview, beside the notice naming the finding, and
 * only to a viewer who reviews roles (roles:view). The figures are the Tenant
 * Console D6 design's.
 */
import { definePreviewData } from '@aquaculture/shared-ui';

import type { AccessRequestSample } from '../model/accessRequests';

export const ACCESS_REQUESTS_PREVIEW = definePreviewData(
  {
    finding: 'RBAC-MEDIUM-020',
    reasonKey: 'dashboard.inbox.access.previewReason',
    needs:
      'auth-service access requests (requester, capability or site, status) and a query of the requests a viewer may approve',
  },
  {
    count: 2,
    names: 'Can Öztürk, Okan Polat',
    capability: 'Storage & stock',
    site: 'Bodrum Hatchery',
  } satisfies AccessRequestSample,
);
