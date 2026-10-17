/**
 * The company dashboard's announcement notice for a member, as sample data
 * (RBAC-MEDIUM-021): myAnnouncements is gated to tenant admins, so a member's
 * announcements have no source the member may read, and this notice renders
 * only through MockPreview beside the notice naming the finding. The backend
 * gate is not widened here. The sample is the Tenant Console D6 design's
 * maintenance announcement.
 */
import { definePreviewData } from '@aquaculture/shared-ui';

import type { AnnouncementSample } from './announcementSample';

export const MEMBER_ANNOUNCEMENTS_PREVIEW = definePreviewData(
  {
    finding: 'RBAC-MEDIUM-021',
    reasonKey: 'tenant.memberHome.announcements.previewReason',
    needs: 'auth-service announcements readable by every member, scoped to the caller',
  },
  {
    title: 'Platform maintenance on 18 Oct, 02:00–04:00 UTC',
    content:
      'The console is read-only during the window. Edge devices keep buffering readings locally.',
  } satisfies AnnouncementSample,
);
