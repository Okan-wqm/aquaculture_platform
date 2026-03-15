# Aquaculture Platform - Backend/Frontend Gap Analysis Report
## Enterprise-Scale Full System Audit | 2026-03-15

---

## Executive Summary

| Metric | Count |
|--------|-------|
| Total backend endpoints/operations | ~550+ |
| Backend operations with no frontend | **~350+** |
| Frontend calls to non-existent backends | **~80+** |
| Schema/path/method mismatches | **~40+** |
| Pages using 100% mock data | **~10+** |
| Dead code services | **1** (config-service) |
| Critical runtime-broken features | **~15** |

---

## P0 - CRITICAL (Runtime Broken)

### 1. Auth: Forgot/Reset Password Broken
- **Shell** calls `POST /api/auth/forgot-password` and `POST /api/auth/reset-password` (REST)
- **Backend** only has GraphQL mutations `forgotPassword` and `resetPassword`
- No REST endpoint exists at these paths
- **Impact:** Password recovery completely non-functional
- **Files:** `web/shell/src/pages/LoginPage.tsx` (lines 457, 593)

### 2. Auth: User Edit/Delete Broken
- Frontend calls `updateTenantUser` and `deleteTenantUser` mutations
- Backend has neither mutation
- Backend only has `deactivateTenantUser` and `activateTenantUser`
- **Impact:** Cannot edit or delete users in tenant-admin
- **Files:** `web/modules/tenant-admin/src/pages/TenantUsers.tsx` (lines 167-184)

### 3. Auth: MFA Login Flow Missing
- Backend returns `mfaRequired: true` with `mfaToken` for MFA-enabled users
- Shell login handler does not check for or handle this response
- No MFA challenge screen exists
- **Impact:** MFA-enabled users cannot log in on web

### 4. Auth: TenantRole Parameter Mismatches
- Frontend sends `tenantRole(id: $id)`, backend expects `tenantRole(roleId: $roleId)`
- Frontend uses `isSystemRole`, backend uses `isSystem`
- Frontend uses `displayName`, backend uses `name`
- **Impact:** Role management broken

### 5. Billing: tenantBilling Query Missing
- `web/modules/tenant-admin/src/hooks/useTenantBilling.ts` calls `tenantBilling` GraphQL query
- This query does not exist in any backend service
- **Impact:** Entire tenant billing page shows GraphQL error

### 6. Sensor: latestReadingsBatch Missing
- Dashboard widgets call `latestReadingsBatch(sensorIds: [ID!]!)`
- Backend only has `latestReading(sensorId: ID!)` for single sensor
- **Impact:** Dashboard sensor widgets broken
- **Files:** `web/modules/sensor-module/src/hooks/useSensorReadings.ts`, `useWidgetData.ts`

### 7. Sensor: VFD 6 Schema Mismatches
- `vfdDevices` returns flat array, frontend expects paginated wrapper
- `registerVfdDevice` returns VfdDevice, frontend expects result wrapper with success/error
- `testVfdConnection` takes `id: ID!`, frontend sends `TestVfdConnectionInput`
- `vfdReadingStats` takes `from/to: Date!`, frontend sends `period: String!`
- `readVfdParameters` takes only deviceId, frontend sends extra parameters array
- `vfdStats` query doesn't exist in backend
- **Impact:** VFD device management completely broken

### 8. Farm: 14 Missing FeedingProgram Mutations
- `completeFeedingProgram`, `cancelFeedingProgram`, `addTanksToProgram`, `reactivateTankInProgram`,
  `assignTemperatureSensor`, `transitionTankFeed`, `recordBulkFeeding`, `recalculateDailyPlan`,
  `addFeedAssignment`, `updateFeedAssignment`, `removeFeedAssignment`, `updateFCRTable`,
  `cloneFeedingProgram`, `updateProgramSettings`
- **Impact:** Feeding program management partially broken

### 9. Farm: 4 FeedingProgram Signature Mismatches
- `UpdateFeedingProgram($id, $input)` → backend takes `input` only
- `PauseFeedingProgram($id, $reason)` → backend takes `$id` only
- `RemoveTankFromProgram($feedingProgramTankId, $reason)` → backend takes `RemoveTankFromProgramInput`
- `GenerateDailyPlan($input)` → backend takes `$programId + $date`
- **Impact:** These operations fail at runtime

### 10. Alert: Dashboard Navigation 404
- Dashboard "View All Alerts" navigates to `/alerts`
- No route exists at `/alerts` (sensor module alerts at `/sensor/alerts`)
- **Impact:** Clicking "View All Alerts" shows 404

### 11. Alert: Severity Case Mismatch
- Frontend filters by `'CRITICAL'`, `'HIGH'` (uppercase)
- Backend AlertSeverity enum uses `'critical'`, `'high'` (lowercase)
- **Impact:** Dashboard severity counters always show 0

### 12. Admin: 35+ API Path/Method/Body Mismatches
- Analytics: 4 frontend calls to non-existent endpoints
- Database: 12 frontend calls marked TODO
- Security: 11 path/method mismatches
- Impersonation: 4 path mismatches
- Settings/System: 9 mismatches
- Support: 2 method mismatches
- Email Templates: 2 mismatches
- **Impact:** Various admin panel features broken

### 13. HR: Performance Mutations Unguarded
- Performance module has no backend resolver
- Queries are `enabled: false` but mutations are NOT disabled
- **Impact:** Performance page mutations throw GraphQL errors

### 14. HR: Attendance/Certification Mismatches
- `createAttendanceRecord` → backend has `createManualAttendance` (different name)
- `approveAttendanceRecords(ids)` → backend has `approveAttendance(id, notes)` (different signature)
- Certification mutations use `{ input: ... }` wrapper, backend uses individual args
- **Impact:** Attendance and certification operations fail

---

## P1 - HIGH (Major Feature Gaps)

### 15. Alert Rule CRUD UI
- Backend: 5 GraphQL operations (get, list, create, update, delete)
- Frontend: Zero management UI
- Users cannot configure alert thresholds or notification channels

### 16. Alert Incident Management UI
- Backend: Full lifecycle (8 statuses, assignment, investigation, timeline, comments, linking)
- Frontend: Only shows AlertHistory (simple log), not AlertIncident entities

### 17. Sensor PLC Control UI
- Backend: ~30 operations (connections, feeding params, alarms, telemetry)
- Frontend: Zero UI - biggest single feature gap

### 18. Auth GDPR Consent Management
- Backend: 8 operations (consent status, history, record, withdraw, admin queries)
- Frontend: Zero - no consent banner, no privacy settings

### 19. Billing Payment Management
- Backend: Full CRUD via GraphQL (record, refund, query)
- Frontend: Zero payment UI

### 20. Farm HarvestPlans Wiring
- Backend: 16 operations (full CRUD + workflow)
- Frontend: 2500+ line UI exists, but ALL 10 handlers are TODO comments

### 21. Farm Growth Module
- Backend: 8 operations (measurement, analysis, history)
- Frontend: GrowthTab.tsx exists, no useGrowth hook

### 22. Auth Desktop WebAuthn
- Backend: 7 operations
- Frontend: Only AquaMobil has implementation, shell has zero

### 23. Desktop Notification Center
- Backend: notification-service GraphQL (myNotifications, unreadCount, markRead)
- Shell: Bell icon exists, onClick is empty `// TODO`

### 24. Auth Settings/Profile Page
- Shell route: `<Route path="/settings/*" element={<div>Settings (TODO)</div>} />`
- No profile editing, password change, MFA management, consent management

---

## P2 - MEDIUM

### 25. HR Performance Backend Resolver
- Frontend UI scaffolded (29 operations), all disabled
- Backend needs resolver with performance reviews, goals, KPIs

### 26. HR Aquaculture Mutations
- Backend aquaculture resolver is query-only (zero mutations)
- Frontend defines work area/rotation CRUD + safety training mutations

### 27. Billing Metered Dashboard
- Full metered billing engine hidden from frontend
- Usage tracking, aggregation, invoice preview, tax, currency - all internal only

### 28. Admin Tenant Config Sub-resources
- 30+ backend endpoints for granular config (user-limits, storage, API, webhooks, domain, branding, security, notifications, features, data-retention)
- Frontend only calls top-level GET/PUT

### 29. Farm Reports Backend Connection
- 8 report tabs use 100% mock data
- Backend has submission mutations for all report types

### 30. Farm Feeding Records/Inventory UI
- Backend: 11 operations (feeding record CRUD, feed inventory)
- Frontend: Zero UI (uses feeding program approach only)

### 31. Farm Work Order Lifecycle
- Backend: 7 workflow mutations (submit, approve, start, verify, cancel, hold, resume)
- Frontend: Only covers list, create, update, complete, delete

### 32. Billing Custom Plan Workflow
- Backend: Full lifecycle (submit, approve, reject, activate, clone, delete, list)
- Frontend: Only create form exists

### 33. Alert Escalation Policy Management
- Backend: Full service (CRUD, on-call, suppression windows, clone)
- No GraphQL resolver exposed, no frontend UI

---

## P3 - LOW

### 34. Config Service Integration/Deprecation
- Runs as separate service, registered in gateway
- Zero consumers (frontend or backend)
- Admin-api-service has separate parallel config system
- Decision needed: integrate or remove

### 35. Hydroponics Backend + Frontend Connection
- Frontend makes 0 API calls, all data in localStorage/React state
- Backend has entity but no mutations
- hydroponicsStatus query never called

### 36. Dashboard Analytics Real Data
- Analytics page shows 100% hardcoded mock data
- Backend services have harvest stats, growth analysis, feeding analytics

### 37. Notification Preferences Per-User
- No per-user notification channel preference entity
- Tenant-admin section disabled with "coming soon"

### 38. Dashboard Placeholder Widgets
- RASFlowDiagram: "Veri baglantisi kurulacak"
- ProductionChart: "Veri baglantisi kurulacak"
- productionTons KPI: hardcoded 0
- "Rapor Indir" buttons: no onClick

### 39. Observability/Event Store Admin Pages
- Admin nav items exist for Performance and Error Tracking
- No corresponding page components
- Backend has REST endpoints (traces, metrics, event stats)

### 40. Convenience Queries
- chemicalsByType, feedsByPelletSize, feedsForSpecies, suppliersByType, etc.
- Backend shortcuts that could improve UI filtering performance

---

## Architectural Issues

| # | Issue | Description |
|---|-------|-------------|
| 1 | Dual Config System | config-service (GraphQL) vs admin-api-service (REST) - zero integration |
| 2 | Dual Support/Messaging | auth-service (GraphQL) vs admin-api-service (REST) - frontend uses REST only |
| 3 | Dual Feeding System | feeding.resolver (ad-hoc) vs feeding-program.resolver (structured) |
| 4 | Dual Tank System | tank.resolver vs equipment.resolver - frontend uses equipment only |
| 5 | GraphQL/REST Confusion | Shell calls REST for auth features that are GraphQL-only |

---

*Generated by 10 parallel enterprise analysis agents | 2026-03-15*
