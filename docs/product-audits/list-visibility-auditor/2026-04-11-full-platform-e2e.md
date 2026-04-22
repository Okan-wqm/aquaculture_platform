# List Visibility Auditor

Topic: `2026-04-11-full-platform-e2e`

Scope checked:
- Tenant admin user list and pagination
- Tenant database/table detail surfaces
- AquaMobil messaging channel list, search, and unread/badge surfaces
- Post-write refresh behavior through TanStack Query invalidation and local cache state

## Findings

### medium-001: User writes can disappear behind the current page offset

The tenant user flow closes the modal and invalidates `tenantKeys.users()`, but it never resets or clamps the current page after create, update, delete, or deactivate. Because the list query is page-based and the page state is preserved unless a filter changes, a successful write can be acknowledged while the resulting row is not visible on the current page. This is most obvious after creating a user from page 2+ or deleting the last row on the current page, where the UI can land on an empty page even though the record exists on another page.

Root cause:
- Page state is only reset on role/status filter changes, not on mutation success.
- The visible table depends on the current `offset`, so invalidation alone does not guarantee the changed row appears on screen.
- `UserListSection` renders the current page only and has no recovery path when the active page becomes stale after a write.

Evidence:
- [`/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:115`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L115)
- [`/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:141`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L141)
- [`/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:190`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L190)
- [`/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx:204`](/var/aqua-saas/web/modules/tenant-admin/src/pages/TenantUsers.tsx#L204)
- [`/var/aqua-saas/web/modules/tenant-admin/src/components/users/UserListSection.tsx:182`](/var/aqua-saas/web/modules/tenant-admin/src/components/users/UserListSection.tsx#L182)

Cross-domain dependency:
- `data-readback-auditor` for confirming the backend roundtrip is correct while the UI page remains stale.

### medium-002: AquaMobil channel list can keep stale ordering and badges after a write

`useChannels` accumulates paged results in `accumulatedChannelsRef` and returns that ref preferentially over the live query result. When `channelUpdated` or `sendMessage` invalidates `['messaging', 'channels']`, there is no reset/rebase step for the accumulated list. After the user has paged beyond the first slice, the rendered `sortedChannels` can continue to use stale first-page data, so last-message previews, unread counts, and top-of-list ordering can lag behind the actual write.

Root cause:
- The hook merges page responses into a mutable ref instead of deriving the rendered list from the current query cache.
- Invalidations refresh the query key, but they do not clear the accumulated list state.
- The mobile list view renders `sortedChannels` from that accumulated state, so post-write truth depends on cache freshness that is no longer authoritative.

Evidence:
- [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:70`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts#L70)
- [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:103`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts#L103)
- [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:121`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts#L121)
- [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts:135`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useChannels.ts#L135)
- [`/var/aqua-saas/web/apps/aquamobil/src/hooks/useSendMessage.ts:165`](/var/aqua-saas/web/apps/aquamobil/src/hooks/useSendMessage.ts#L165)
- [`/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx:191`](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx#L191)
- [`/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx:203`](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx#L203)
- [`/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx:353`](/var/aqua-saas/web/apps/aquamobil/src/pages/messaging/ChannelListPage.tsx#L353)

Cross-domain dependency:
- `realtime-sync-auditor` for the socket/invalidation path.
- `mobile-app-auditor` for the AquaMobil-specific pagination and offline/list truth model.

## Result

No CRITICAL or HIGH list-visibility defects were confirmed in this pass. The two issues above are medium-severity because the data is likely persisted correctly, but the user-visible list truth can still drift or hide the saved record after a successful write.
