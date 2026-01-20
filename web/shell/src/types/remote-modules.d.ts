/**
 * Remote Module Type Declarations
 *
 * Module Federation ile yüklenen remote modüller için
 * TypeScript tip tanımlamaları.
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

declare module 'farmModule/FarmList' {
  import { FC } from 'react';
  const FarmList: FC;
  export default FarmList;
}

declare module 'farmModule/FarmDetail' {
  import { FC } from 'react';
  const FarmDetail: FC;
  export default FarmDetail;
}

declare module 'farmModule/SensorDashboard' {
  import { FC } from 'react';
  const SensorDashboard: FC;
  export default SensorDashboard;
}

// ============================================================================
// Process Editor Module
// ============================================================================

declare module 'processEditor/Module' {
  import { FC } from 'react';
  const ProcessEditorModule: FC;
  export default ProcessEditorModule;
}

declare module 'processEditor/ProcessList' {
  import { FC } from 'react';
  const ProcessList: FC;
  export default ProcessList;
}

declare module 'processEditor/ProcessEditor' {
  import { FC } from 'react';
  const ProcessEditor: FC;
  export default ProcessEditor;
}

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
