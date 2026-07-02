/**
 * Remote Module Type Declarations
 *
 * TypeScript type declarations for remote modules loaded via Module Federation.
 */

// ============================================================================
// Dashboard Module
// ============================================================================

declare module 'dashboard/Module' {
  import { FC } from 'react';
  const DashboardModule: FC;
  export default DashboardModule;
}

declare module 'dashboard/DashboardPage' {
  import { FC } from 'react';
  const DashboardPage: FC;
  export default DashboardPage;
}

// ============================================================================
// Farm Module
// ============================================================================

declare module 'farmModule/Module' {
  import { FC } from 'react';
  const FarmModule: FC;
  export default FarmModule;
}

// `farmModule/FarmList` and `farmModule/FarmDetail` declarations removed
// together with their source pages (FarmListPage, FarmDetailPage) in commit
// 67c9c472 ("refactor(farm): remove legacy farm concept from frontend").
// The remote no longer exposes these paths — see web/modules/farm-module/
// vite.config.ts.

// `farmModule/SensorDashboard` declaration removed with its mock-only source
// page (FARM-INT-MEDIUM-003). Live sensor monitoring is exposed by the
// sensor-module remote (`sensorModule/Module`), not farm-module.

// `processEditor/*` declarations removed in C1 PR-1b: there is no
// `process-editor` federation remote — no Nx project, no vite.config remote
// entry, and the shell registers no such remote. These were ghost ambient
// stubs for a remote that was never built. The real process-editor lives as
// an INTERNAL component tree inside sensor-module
// (web/modules/sensor-module/.../components/process-editor/), not a remote.

// ============================================================================
// Admin Panel Module
// ============================================================================

declare module 'adminPanel/Module' {
  import { FC } from 'react';
  const AdminPanelModule: FC;
  export default AdminPanelModule;
}

declare module 'adminPanel/UserManagement' {
  import { FC } from 'react';
  const UserManagement: FC;
  export default UserManagement;
}

declare module 'adminPanel/TenantManagement' {
  import { FC } from 'react';
  const TenantManagement: FC;
  export default TenantManagement;
}

declare module 'adminPanel/SystemSettings' {
  import { FC } from 'react';
  const SystemSettings: FC;
  export default SystemSettings;
}

// ============================================================================
// Tenant Admin Module
// ============================================================================

declare module 'tenantAdmin/Module' {
  import { FC } from 'react';
  const TenantAdminModule: FC;
  export default TenantAdminModule;
}

declare module 'tenantAdmin/TenantDashboard' {
  import { FC } from 'react';
  const TenantDashboard: FC;
  export default TenantDashboard;
}

declare module 'tenantAdmin/TenantUsers' {
  import { FC } from 'react';
  const TenantUsers: FC;
  export default TenantUsers;
}

declare module 'tenantAdmin/TenantModules' {
  import { FC } from 'react';
  const TenantModules: FC;
  export default TenantModules;
}

declare module 'tenantAdmin/TenantSettings' {
  import { FC } from 'react';
  const TenantSettings: FC;
  export default TenantSettings;
}

declare module 'tenantAdmin/TenantDatabase' {
  import { FC } from 'react';
  const TenantDatabase: FC;
  export default TenantDatabase;
}

// ============================================================================
// HR Module
// ============================================================================

declare module 'hrModule/Module' {
  import { FC } from 'react';
  const HRModule: FC;
  export default HRModule;
}

// ============================================================================
// Sensor Module
// ============================================================================

declare module 'sensorModule/Module' {
  import { FC } from 'react';
  const SensorModule: FC;
  export default SensorModule;
}

// ============================================================================
// Hydroponics Module
// ============================================================================

declare module 'hydroponicsModule/Module' {
  import { FC } from 'react';
  const HydroponicsModule: FC;
  export default HydroponicsModule;
}
