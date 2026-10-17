/**
 * Control & sensors › SCADA & devices › Command log (/sensor/commands).
 *
 * WHAT: everything the platform sent to the field — who asked, what, when and
 * what the device replied — read-only. The recorded sources come first, each
 * from the query that already holds it:
 *   - drive commands      → vfdCommandAuditLog (one drive at a time)
 *   - feeding sends       → feedingParameters (send status, sentAt, author)
 *   - program deployments → deploymentHistory (every edge device)
 * The single cross-device record and the lock list that Architecture §11
 * describes do not exist in sensor-service yet; they render as labelled
 * sample data through MockPreview (SENSOR-MEDIUM-185) and nowhere else.
 *
 * WHO: tenant admins and module managers — the route (Module.tsx) wraps the
 * page in RequireRole MODULE_MANAGER (hierarchy-aware) and the console nav
 * lists it for those roles only, because the drive trail and the deployment
 * history are served only to them (vfdCommandAuditLog, deploymentHistory:
 * TENANT_ADMIN / MODULE_MANAGER). A module user is never offered a page whose
 * records would all fail to load.
 *
 * The heading row carries no eyebrow: inside the console the header already
 * names the workspace and area above the page's h1 (ConsoleHeading).
 */
import React from 'react';
import { PageHeader, useI18n } from '@aquaculture/shared-ui';

import { CommandLocksPreview } from './CommandLocksPreview';
import { DeploymentsSection } from './DeploymentsSection';
import { FeedingSendsSection } from './FeedingSendsSection';
import { UnifiedLogPreview } from './UnifiedLogPreview';
import { VfdCommandSection } from './VfdCommandSection';

export function CommandLogPage(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="sd-page sd-stack">
      <PageHeader title={t('sensorCommands.title')} description={t('sensorCommands.description')} />
      <VfdCommandSection />
      <FeedingSendsSection />
      <DeploymentsSection />
      <UnifiedLogPreview />
      <CommandLocksPreview />
    </div>
  );
}

export default CommandLogPage;
