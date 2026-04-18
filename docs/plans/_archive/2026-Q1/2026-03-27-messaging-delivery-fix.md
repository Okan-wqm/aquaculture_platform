# Unified Communication Platform — Enterprise Architecture Plan

**Date:** 2026-03-27
**Status:** DRAFT
**Priority:** P0 — Core platform communication infrastructure
**Scope:** Full architectural redesign of superadmin-to-tenant communication

---

## 1. Problem Statement

The platform has **two disconnected messaging implementations** that were built independently:

- **admin-api-service** (REST, `admin` schema) — where superadmin writes
- **auth-service** (GraphQL, `auth` schema) — where tenants read

These are separate database tables in separate PostgreSQL schemas with zero synchronization. Messages sent from the superadmin panel physically cannot appear in tenant panels. This is not a bug — it is an **architectural design gap** that requires a proper bounded context unification.

### Current Architecture (Broken)

```
┌─────────────────────┐     REST      ┌──────────────────────┐
│   Admin Panel       │──────────────▶│  admin-api-service   │
│   (superadmin)      │               │  writes admin.*      │
└─────────────────────┘               └──────────────────────┘
                                              ▼
                                      ┌──────────────────┐
                                      │  admin.messages   │  ◀── data sits here
                                      │  admin.announce.  │
                                      └──────────────────┘

┌─────────────────────┐   GraphQL     ┌──────────────────────┐
│   Tenant Panel      │──────────────▶│  auth-service        │
│   (tenant admin)    │               │  reads auth.*        │
└─────────────────────┘               └──────────────────────┘
                                              ▼
                                      ┌──────────────────┐
                                      │  auth.messages    │  ◀── always empty
                                      │  auth.announce.   │
                                      └──────────────────┘
```

### 12 Secondary Issues Discovered

| # | Issue | File Location |
|---|-------|---------------|
| 1 | Zero NATS event contracts for messaging domain | `libs/event-contracts/src/` |
| 2 | No real-time delivery (no WS/SSE/Subscription) | `gateway-api/websocket/` — sensor-only |
| 3 | BulkMessageModal sends empty payload → backend 400 | `admin-panel/pages/MessagingPage.tsx:667` |
| 4 | Targeted announcements UI has no tenant selector | `admin-panel/pages/AnnouncementsPage.tsx:487` |
| 5 | `matchesTenant()` exists but never called in queries | `auth-service/announcement/entities:190` |
| 6 | MODULE_USER/MODULE_MANAGER blocked from announcements | Resolver: `@TenantAdminOrHigher()` |
| 7 | Shell bell has no MESSAGE/ANNOUNCEMENT route | `shell/components/NotificationPanel.tsx:42` |
| 8 | No dashboard widgets for comm on tenant side | `tenant-admin/pages/TenantDashboard.tsx` |
| 9 | Email on message send = `// TODO` | `admin-api/support/services/messaging.service.ts:261` |
| 10 | `BulkMessageInput` DTO in auth-service = dead code | `auth-service/messaging/dto:59` |
| 11 | NewThreadModal requires manual UUID entry | `admin-panel/pages/MessagingPage.tsx:786` |
| 12 | notification-service not in gateway health check | `gateway-api/health/health.service.ts:71` |

---

## 2. Target Architecture

### 2.1 Design Principles

1. **Single Source of Truth** — One schema, one service owns messaging domain data
2. **CQRS** — Command path (writes) separated from query path (reads) via NATS events
3. **Event-Driven** — All state changes publish domain events for downstream consumers
4. **Tenant Isolation** — Row-level security via `tenantId` + guard chain
5. **Graceful Degradation** — If notification-service is down, messaging still works
6. **Idempotent Operations** — All event handlers use deduplication keys
7. **Audit Trail** — Every message/announcement action is traceable

### 2.2 Bounded Context Ownership

```
┌─────────────────────────────────────────────────────────────────┐
│                    Communication Bounded Context                 │
│                                                                 │
│  Owner: auth-service                                            │
│  Schema: auth                                                   │
│  API: GraphQL (federated via gateway)                           │
│  Tables: message_threads, messages, announcements,              │
│          announcement_acknowledgments                           │
│                                                                 │
│  Aggregates:                                                    │
│    MessageThread (root) → Message[]                             │
│    Announcement (root) → AnnouncementAcknowledgment[]           │
└─────────────────────────────────────────────────────────────────┘
```

**Why auth-service:**
- Already federated in Apollo Gateway (subgraph "auth", port 3001)
- Has `TenantGuard` + `RolesGuard` + `JwtAuthGuard` — full tenant isolation
- Richer entity model: `scope` (PLATFORM/TENANT), `tenantId`, per-user acknowledgments
- Already has `matchesTenant()` targeting logic on Announcement entity
- Tenant-admin frontend already queries auth-service for messaging/announcements

**admin-api-service role:** Delegates to auth-service via GraphQL gateway (same as any other frontend). The REST messaging/announcement endpoints in `support/` module become **deprecated** and eventually removed.

### 2.3 Target Architecture Diagram

```
┌─────────────────┐  GraphQL   ┌───────────────┐  Federation  ┌─────────────────┐
│  Admin Panel    │───────────▶│  Gateway API  │─────────────▶│  auth-service   │
│  (superadmin)   │            │  (Apollo)     │              │  SSOT for comms  │
└─────────────────┘            │               │              │                 │
                               │               │              │  auth.messages  │
┌─────────────────┐  GraphQL   │               │              │  auth.announce. │
│  Tenant Panel   │───────────▶│               │─────────────▶│                 │
│  (tenant admin) │            └───────────────┘              └────────┬────────┘
└─────────────────┘                                                   │
                                                              NATS publish
┌─────────────────┐                                                   │
│  Shell (bell)   │◀─ polls ─┐                                        ▼
└─────────────────┘          │                               ┌────────────────────┐
                             │                               │  NATS Event Bus    │
                    ┌────────┴────────┐                      │                    │
                    │  notification-  │◀──── subscribes ─────│  messaging.*       │
                    │  service        │                      │  announcement.*    │
                    │  (in-app notif) │                      └────────────────────┘
                    └────────┬────────┘
                             │ optional
                             ▼
                    ┌─────────────────┐
                    │  Email (SMTP)   │
                    │  Push (FCM)     │
                    └─────────────────┘
```

---

## 3. Domain Model

### 3.1 Aggregates

```typescript
// ─── MessageThread Aggregate ───
MessageThread {
  id: UUID
  tenantId: UUID                          // required — identifies target tenant
  subject: string
  status: 'open' | 'closed' | 'archived'
  messageCount: number
  unreadCountAdmin: number                // superadmin unread
  unreadCountTenant: number               // tenant unread
  lastMessage: string
  lastMessageAt: DateTime
  lastMessageBy: 'super_admin' | 'tenant_admin'
  createdBy: UUID                         // userId who started the thread
  createdByRole: SenderType
  metadata: JSONB                         // extensible — tags, priority, category
  messages: Message[]
}

Message {
  id: UUID
  threadId: UUID
  senderId: UUID
  senderType: 'super_admin' | 'tenant_admin' | 'system'
  senderName: string
  content: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  isInternal: boolean                     // only visible to superadmin
  attachments: JSONB                      // [{name, url, size, mimeType}]
  readAt: DateTime | null
  createdAt: DateTime
}

// ─── Announcement Aggregate ───
Announcement {
  id: UUID
  title: string
  content: string                         // supports markdown
  type: 'info' | 'warning' | 'critical' | 'maintenance'
  status: 'draft' | 'scheduled' | 'published' | 'expired' | 'cancelled'
  scope: 'PLATFORM' | 'TENANT'
  tenantId: UUID | null                   // null for PLATFORM scope
  isGlobal: boolean                       // true = all tenants
  targetCriteria: AnnouncementTarget | null
  publishAt: DateTime | null
  expiresAt: DateTime | null
  requiresAcknowledgment: boolean
  viewCount: number
  acknowledgmentCount: number
  createdBy: UUID
  createdByName: string
  acknowledgments: AnnouncementAcknowledgment[]
}

AnnouncementTarget {
  tenantIds: UUID[]                       // include list
  excludeTenantIds: UUID[]                // exclude list
  plans: string[]                         // subscription plan filter
  modules: string[]                       // enabled module filter
  regions: string[]                       // geographic filter
  tenantStatuses: string[]                // active, trial, etc.
}

AnnouncementAcknowledgment {
  id: UUID
  announcementId: UUID
  userId: UUID
  userName: string
  tenantId: UUID
  tenantName: string
  viewedAt: DateTime | null
  acknowledgedAt: DateTime | null
}
```

### 3.2 Domain Events (NATS Contracts)

```typescript
// ─── libs/event-contracts/src/messaging-events.ts ───

// Thread lifecycle
interface ThreadCreatedEvent extends BaseEvent {
  type: 'ThreadCreated';
  threadId: string;
  tenantId: string;
  subject: string;
  createdBy: string;
  createdByRole: 'super_admin' | 'tenant_admin';
}

interface ThreadStatusChangedEvent extends BaseEvent {
  type: 'ThreadStatusChanged';
  threadId: string;
  tenantId: string;
  oldStatus: string;
  newStatus: string;
  changedBy: string;
}

// Message lifecycle
interface MessageSentEvent extends BaseEvent {
  type: 'MessageSent';
  messageId: string;
  threadId: string;
  tenantId: string;
  senderId: string;
  senderType: 'super_admin' | 'tenant_admin' | 'system';
  senderName: string;
  isInternal: boolean;
  contentPreview: string;     // first 100 chars for notification
}

interface MessageReadEvent extends BaseEvent {
  type: 'MessageRead';
  threadId: string;
  tenantId: string;
  readBy: string;
  readByRole: string;
  messageIds: string[];
}

// Bulk operations
interface BulkThreadsCreatedEvent extends BaseEvent {
  type: 'BulkThreadsCreated';
  threadIds: string[];
  tenantIds: string[];
  subject: string;
  senderId: string;
  sendEmail: boolean;
}

// Announcement lifecycle
interface AnnouncementPublishedEvent extends BaseEvent {
  type: 'AnnouncementPublished';
  announcementId: string;
  title: string;
  announcementType: 'info' | 'warning' | 'critical' | 'maintenance';
  scope: 'PLATFORM' | 'TENANT';
  isGlobal: boolean;
  targetTenantIds: string[];   // pre-resolved for consumers
  requiresAcknowledgment: boolean;
}

interface AnnouncementExpiredEvent extends BaseEvent {
  type: 'AnnouncementExpired';
  announcementId: string;
  title: string;
}

interface AnnouncementAcknowledgedEvent extends BaseEvent {
  type: 'AnnouncementAcknowledged';
  announcementId: string;
  userId: string;
  tenantId: string;
}
```

### 3.3 NATS Subject Naming

```
messaging.thread.created        → ThreadCreatedEvent
messaging.thread.status         → ThreadStatusChangedEvent
messaging.message.sent          → MessageSentEvent
messaging.message.read          → MessageReadEvent
messaging.bulk.created          → BulkThreadsCreatedEvent
announcement.published          → AnnouncementPublishedEvent
announcement.expired            → AnnouncementExpiredEvent
announcement.acknowledged       → AnnouncementAcknowledgedEvent
```

---

## 4. Implementation Phases

### Phase 1: Single Source of Truth (Day 1-2)

**Objective:** All messaging/announcement writes go to `auth` schema. Both superadmin and tenant panels read from the same source.

#### 1.1 Auth-Service Resolver Enhancements

**File:** `apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts`

Add mutations that the admin panel needs:

```typescript
@Mutation(() => [MessageThread])
@SuperAdminOnly()
async bulkCreateThreads(
  @Args('input') input: BulkCreateThreadsInput,
  @CurrentUser() user: JwtPayload,
): Promise<MessageThread[]> {
  return this.messagingService.bulkCreateThreads(input, user);
}
```

**File:** `apps/auth-service/src/modules/messaging/services/messaging.service.ts`

Add bulk messaging logic (ported from admin-api with improvements):

```typescript
async bulkCreateThreads(input: BulkCreateThreadsInput, user: JwtPayload): Promise<MessageThread[]> {
  const tenantIds = input.tenantIds?.length
    ? input.tenantIds
    : await this.resolveTargetTenants(input.targetCriteria);

  if (!tenantIds.length) throw new BadRequestException('No target tenants resolved');

  const threads: MessageThread[] = [];

  // Batch insert for performance — not sequential per-tenant
  await this.dataSource.transaction(async (manager) => {
    for (const tenantId of tenantIds) {
      const thread = manager.create(MessageThread, {
        tenantId,
        subject: input.subject,
        status: 'open',
        messageCount: 1,
        unreadCountTenant: 1,
        unreadCountAdmin: 0,
        lastMessage: input.content.substring(0, 200),
        lastMessageAt: new Date(),
        lastMessageBy: 'super_admin',
        createdBy: user.sub,
        createdByRole: 'super_admin',
      });
      await manager.save(thread);

      const message = manager.create(Message, {
        threadId: thread.id,
        senderId: user.sub,
        senderType: 'super_admin',
        senderName: user.name || 'Platform Admin',
        content: input.content,
        status: 'sent',
        isInternal: false,
      });
      await manager.save(message);

      threads.push(thread);
    }
  });

  // Publish domain event
  await this.eventBus.publish({
    type: 'BulkThreadsCreated',
    threadIds: threads.map(t => t.id),
    tenantIds,
    subject: input.subject,
    senderId: user.sub,
    sendEmail: input.sendEmail ?? false,
  });

  return threads;
}
```

**File:** `apps/auth-service/src/modules/messaging/dto/messaging.dto.ts`

Activate and enhance the existing `BulkMessageInput`:

```typescript
@InputType()
export class BulkCreateThreadsInput {
  @Field()
  subject: string;

  @Field()
  content: string;

  @Field(() => [String], { nullable: true })
  tenantIds?: string[];

  @Field(() => AnnouncementTargetInput, { nullable: true })
  targetCriteria?: AnnouncementTargetInput;

  @Field({ nullable: true, defaultValue: false })
  sendEmail?: boolean;
}
```

#### 1.2 Admin Panel — GraphQL Migration

**New file:** `web/modules/admin-panel/src/graphql/messaging-operations.ts`

Define all GraphQL operations that the admin panel needs (mirroring the existing REST calls):

```typescript
// Thread operations
export const ADMIN_GET_THREADS = gql`query AdminThreads($status: ThreadStatus, $search: String) { ... }`;
export const ADMIN_GET_THREAD_MESSAGES = gql`query AdminMessages($threadId: ID!) { ... }`;
export const ADMIN_CREATE_THREAD = gql`mutation CreateThread($input: CreateThreadInput!) { ... }`;
export const ADMIN_SEND_MESSAGE = gql`mutation SendMessage($input: SendMessageInput!) { ... }`;
export const ADMIN_BULK_CREATE = gql`mutation BulkCreate($input: BulkCreateThreadsInput!) { ... }`;
export const ADMIN_CLOSE_THREAD = gql`mutation CloseThread($threadId: ID!) { ... }`;
export const ADMIN_REOPEN_THREAD = gql`mutation ReopenThread($threadId: ID!) { ... }`;
export const ADMIN_ARCHIVE_THREAD = gql`mutation ArchiveThread($threadId: ID!) { ... }`;
export const ADMIN_MARK_READ = gql`mutation MarkRead($threadId: ID!) { ... }`;
export const ADMIN_MESSAGING_STATS = gql`query MessagingStats { messagingStats { ... } }`;

// Announcement operations
export const ADMIN_GET_ANNOUNCEMENTS = gql`query Announcements($status: AnnouncementStatus, $type: AnnouncementType) { ... }`;
export const ADMIN_CREATE_ANNOUNCEMENT = gql`mutation CreateAnnouncement($input: CreatePlatformAnnouncementInput!) { ... }`;
export const ADMIN_PUBLISH_ANNOUNCEMENT = gql`mutation Publish($id: ID!) { ... }`;
export const ADMIN_CANCEL_ANNOUNCEMENT = gql`mutation Cancel($id: ID!) { ... }`;
export const ADMIN_DELETE_ANNOUNCEMENT = gql`mutation Delete($id: ID!) { ... }`;
export const ADMIN_ANNOUNCEMENT_STATS = gql`query AnnouncementStats { announcementStats { ... } }`;
export const ADMIN_ANNOUNCEMENT_ACKS = gql`query Acks($id: ID!) { ... }`;
```

**New file:** `web/modules/admin-panel/src/hooks/useMessaging.ts`

TanStack Query hooks wrapping Apollo Client operations:

```typescript
export function useAdminThreads(status?: ThreadStatus, search?: string) { ... }
export function useAdminThreadMessages(threadId: string) { ... }
export function useCreateThread() { ... }
export function useSendMessage() { ... }
export function useBulkCreateThreads() { ... }
export function useAdminAnnouncements(status?, type?) { ... }
export function useCreateAnnouncement() { ... }
export function usePublishAnnouncement() { ... }
```

**Modify:** `web/modules/admin-panel/src/pages/MessagingPage.tsx`
- Replace all `supportApi.createThread()` → `useCreateThread()` mutation
- Replace all `supportApi.sendMessage()` → `useSendMessage()` mutation
- Replace all `supportApi.getMessageThreads()` → `useAdminThreads()` query
- Replace all `supportApi.sendBulkMessage()` → `useBulkCreateThreads()` mutation
- Replace all `supportApi.markAsRead()` → GraphQL mutation
- etc.

**Modify:** `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`
- Same pattern — replace all REST calls with GraphQL hooks

**Apollo Client setup for admin-panel:**

The admin-panel currently has no Apollo Client. Add it:

**New file:** `web/modules/admin-panel/src/providers/ApolloProvider.tsx`

```typescript
const client = new ApolloClient({
  uri: '/graphql',  // gateway endpoint (same nginx proxy)
  cache: new InMemoryCache(),
  headers: { authorization: `Bearer ${getAccessToken()}` },
});
```

#### 1.3 Data Migration

**New file:** `scripts/migrate-messaging-to-auth.sql`

One-time migration of existing data from `admin` schema to `auth` schema:

```sql
BEGIN;

-- Migrate threads with column name mapping
INSERT INTO auth.message_threads (
  id, "tenantId", subject, "lastMessage", "lastMessageAt",
  status, "messageCount", "unreadCountAdmin", "unreadCountTenant",
  "createdBy", "createdAt", "updatedAt"
)
SELECT
  id, "tenantId", subject, "lastMessage", "lastMessageAt",
  CASE
    WHEN "isArchived" = true THEN 'archived'
    WHEN "isClosed" = true THEN 'closed'
    ELSE 'open'
  END,
  "messageCount",
  COALESCE("unreadAdminCount", 0),
  COALESCE("unreadTenantCount", 0),
  "createdBy", "createdAt", "updatedAt"
FROM admin.message_threads
ON CONFLICT (id) DO NOTHING;

-- Migrate messages
INSERT INTO auth.messages (
  id, "threadId", "senderId", "senderType", "senderName",
  content, status, "isInternal", attachments, "readAt", "createdAt"
)
SELECT
  id, "threadId", "senderId", "senderType", "senderName",
  content, status, COALESCE("isInternal", false),
  attachments, "readAt", "createdAt"
FROM admin.messages
ON CONFLICT (id) DO NOTHING;

-- Migrate announcements (admin schema has no scope/tenantId — default to PLATFORM)
INSERT INTO auth.announcements (
  id, title, content, type, status, scope, "isGlobal",
  "targetCriteria", "publishAt", "expiresAt",
  "requiresAcknowledgment", "viewCount", "acknowledgmentCount",
  "createdBy", "createdByName", "createdAt", "updatedAt"
)
SELECT
  id, title, content, type, status, 'PLATFORM', "isGlobal",
  "targetCriteria", "publishAt", "expiresAt",
  COALESCE("requiresAcknowledgment", false),
  COALESCE("viewCount", 0), COALESCE("acknowledgmentCount", 0),
  "createdBy", "createdByName", "createdAt", "updatedAt"
FROM admin.announcements
ON CONFLICT (id) DO NOTHING;

-- Migrate acknowledgments
INSERT INTO auth.announcement_acknowledgments (
  id, "announcementId", "userId", "userName",
  "tenantId", "viewedAt", "acknowledgedAt"
)
SELECT
  id, "announcementId", "userId", "userName",
  "tenantId", "viewedAt", "acknowledgedAt"
FROM admin.announcement_acknowledgments
ON CONFLICT (id) DO NOTHING;

-- Verify counts
SELECT 'admin.message_threads' as source, count(*) FROM admin.message_threads
UNION ALL
SELECT 'auth.message_threads', count(*) FROM auth.message_threads
UNION ALL
SELECT 'admin.messages', count(*) FROM admin.messages
UNION ALL
SELECT 'auth.messages', count(*) FROM auth.messages
UNION ALL
SELECT 'admin.announcements', count(*) FROM admin.announcements
UNION ALL
SELECT 'auth.announcements', count(*) FROM auth.announcements;

COMMIT;
```

#### 1.4 Deprecation of admin-api-service REST Messaging

**Modify:** `apps/admin-api-service/src/support/controllers/messaging.controller.ts`
**Modify:** `apps/admin-api-service/src/support/controllers/announcement.controller.ts`

Add deprecation headers to all endpoints:

```typescript
@Header('Deprecation', 'true')
@Header('Sunset', '2026-06-01')
@Header('Link', '</graphql>; rel="successor-version"')
```

Do NOT delete yet — keep for backward compatibility until admin panel migration is verified.

---

### Phase 2: Bug Fixes & UI Improvements (Day 3-4)

#### 2.1 BulkMessage Tenant Selection

**File:** `web/modules/admin-panel/src/pages/MessagingPage.tsx`

Replace the broken BulkMessageModal with a proper tenant selector:

```typescript
// New component: TenantMultiSelect
// Fetches active tenants from GraphQL, shows searchable checkbox list
// Options: "Select All", filter by plan, filter by region
// Passes tenantIds[] to bulkCreateThreads mutation
```

**New file:** `web/modules/admin-panel/src/components/TenantMultiSelect.tsx`

Reusable multi-select with:
- Search/filter
- "Select All" toggle
- Plan and region group headers
- Count display ("12 of 45 tenants selected")

#### 2.2 Targeted Announcements UI

**File:** `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx`

When `isGlobal: false`, show targeting form:

```typescript
<AnnouncementTargetForm
  value={targetCriteria}
  onChange={setTargetCriteria}
/>
// Fields: TenantMultiSelect, plan dropdown, module checkboxes, region dropdown
// Preview: "This announcement will reach ~23 tenants"
```

#### 2.3 Target Criteria Enforcement in Auth-Service

**File:** `apps/auth-service/src/modules/announcement/services/announcement.service.ts`

In `getAnnouncements()` — apply `matchesTenant()` filter for non-superadmin users:

```typescript
async getAnnouncements(user: JwtPayload, filters: AnnouncementFilters) {
  const qb = this.announcementRepo.createQueryBuilder('a');

  if (user.role === UserRole.SUPER_ADMIN) {
    // SuperAdmin sees everything
    if (filters.status) qb.andWhere('a.status = :status', { status: filters.status });
  } else {
    // Tenant users see: published PLATFORM (matching target) + own TENANT announcements
    qb.andWhere(new Brackets(sub => {
      sub.where(new Brackets(platform => {
        platform.where('a.scope = :platform', { platform: 'PLATFORM' });
        platform.andWhere('a.status = :published', { published: 'published' });
      }));
      sub.orWhere(new Brackets(tenant => {
        tenant.where('a.scope = :tenantScope', { tenantScope: 'TENANT' });
        tenant.andWhere('a.tenantId = :tenantId', { tenantId: user.tenantId });
      }));
    }));
  }

  const announcements = await qb.getMany();

  // Apply target criteria filtering for tenant users
  if (user.role !== UserRole.SUPER_ADMIN) {
    return announcements.filter(a =>
      a.scope === 'TENANT' ||
      a.matchesTenant(user.tenantId, user.tenantPlan, user.tenantModules)
    );
  }

  return announcements;
}
```

#### 2.4 Role-Based Access Relaxation

**File:** `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts`

```typescript
// READ operations — all authenticated users can see published announcements
@Query(() => [AnnouncementListItem])
@UseGuards(JwtAuthGuard)                    // was: @TenantAdminOrHigher()
async myAnnouncements(...) { ... }

@Query(() => Announcement)
@UseGuards(JwtAuthGuard)                    // was: @TenantAdminOrHigher()
async announcement(...) { ... }

// WRITE operations — keep restricted
@Mutation(() => Announcement)
@SuperAdminOnly()                           // unchanged
async createPlatformAnnouncement(...) { ... }

@Mutation(() => Announcement)
@TenantAdminOrHigher()                      // unchanged
async createTenantAnnouncement(...) { ... }
```

#### 2.5 Shell Notification Routing

**File:** `web/shell/src/components/NotificationPanel.tsx`

```typescript
function resolveNotificationRoute(notification: InAppNotification): string | null {
  switch (notification.data?.type) {
    case 'ALERT':        return '/sensor/alerts';
    case 'SUPPORT':      return '/tenant/support';
    case 'BILLING':      return '/tenant/billing';
    case 'MESSAGE':      return `/tenant/messages?thread=${notification.data.threadId}`;
    case 'ANNOUNCEMENT': return `/tenant/announcements?id=${notification.data.announcementId}`;
    // ... existing cases
  }
}
```

#### 2.6 Tenant Picker for NewThreadModal

**File:** `web/modules/admin-panel/src/pages/MessagingPage.tsx`

Replace raw UUID text input with a searchable single-select tenant dropdown:

```typescript
<TenantSelect
  value={newThread.tenantId}
  onChange={(tenantId) => setNewThread(prev => ({ ...prev, tenantId }))}
  placeholder="Search tenant..."
/>
```

---

### Phase 3: Event-Driven Notifications (Day 5-7)

#### 3.1 NATS Event Contracts

**New file:** `libs/event-contracts/src/messaging-events.ts`

Full event contract definitions (see Section 3.2 above).

**Modify:** `libs/event-contracts/src/index.ts`

```typescript
export * from './messaging-events';

// Update AnyPlatformEvent union:
export type AnyPlatformEvent =
  | AuthEvent | TenantEvent | FarmEvent | SensorEvent
  | AlertEvent | NotificationEvent | HREvent | BillingEvent
  | AIEvent | TaskEvent | EdgeDeviceEvent
  | MessagingEvent;   // NEW
```

#### 3.2 Auth-Service Event Publishing

**File:** `apps/auth-service/src/modules/messaging/services/messaging.service.ts`

After every write operation, publish the corresponding domain event:

```typescript
// After createThread:
await this.eventBus.publish<ThreadCreatedEvent>({
  type: 'ThreadCreated',
  tenantId: thread.tenantId,
  threadId: thread.id,
  subject: thread.subject,
  createdBy: user.sub,
  createdByRole: user.role === 'SUPER_ADMIN' ? 'super_admin' : 'tenant_admin',
});

// After sendMessage:
await this.eventBus.publish<MessageSentEvent>({
  type: 'MessageSent',
  messageId: message.id,
  threadId: message.threadId,
  tenantId: thread.tenantId,
  senderId: user.sub,
  senderType: message.senderType,
  senderName: message.senderName,
  isInternal: message.isInternal,
  contentPreview: message.content.substring(0, 100),
});

// After markAsRead:
await this.eventBus.publish<MessageReadEvent>({
  type: 'MessageRead',
  threadId,
  tenantId: thread.tenantId,
  readBy: user.sub,
  readByRole: user.role,
  messageIds: updatedMessageIds,
});
```

**File:** `apps/auth-service/src/modules/announcement/services/announcement.service.ts`

```typescript
// After publishAnnouncement:
const targetTenantIds = announcement.isGlobal
  ? await this.resolveAllActiveTenantIds()
  : await this.resolveTargetTenantIds(announcement.targetCriteria);

await this.eventBus.publish<AnnouncementPublishedEvent>({
  type: 'AnnouncementPublished',
  announcementId: announcement.id,
  title: announcement.title,
  announcementType: announcement.type,
  scope: announcement.scope,
  isGlobal: announcement.isGlobal,
  targetTenantIds,
  requiresAcknowledgment: announcement.requiresAcknowledgment,
});

// In expireAnnouncements cron:
await this.eventBus.publish<AnnouncementExpiredEvent>({
  type: 'AnnouncementExpired',
  announcementId: announcement.id,
  title: announcement.title,
});
```

#### 3.3 Notification-Service Event Handlers

**New file:** `apps/notification-service/src/notification/event-handlers/messaging-event.handler.ts`

```typescript
@Controller()
export class MessagingEventHandler {
  constructor(
    private readonly notificationService: NotificationCreationService,
    private readonly tenantUserService: TenantUserResolverService,
  ) {}

  @EventPattern('MessageSent')
  async handleMessageSent(event: MessageSentEvent): Promise<void> {
    // Skip internal admin notes
    if (event.isInternal) return;

    if (event.senderType === 'super_admin') {
      // Notify tenant admins
      const tenantAdmins = await this.tenantUserService.getTenantAdminUserIds(event.tenantId);
      await this.notificationService.createBatch(
        tenantAdmins.map(userId => ({
          userId,
          tenantId: event.tenantId,
          type: 'MESSAGE',
          title: `New message from platform support`,
          body: event.contentPreview,
          data: { threadId: event.threadId, messageId: event.messageId },
        })),
      );
    } else if (event.senderType === 'tenant_admin') {
      // Notify superadmins (platform-level notification)
      await this.notificationService.create({
        userId: null,  // all superadmins
        tenantId: event.tenantId,
        type: 'MESSAGE',
        title: `Reply from tenant on: ${event.contentPreview}`,
        data: { threadId: event.threadId, messageId: event.messageId },
      });
    }
  }

  @EventPattern('AnnouncementPublished')
  async handleAnnouncementPublished(event: AnnouncementPublishedEvent): Promise<void> {
    // Create in-app notification for each target tenant's admins
    for (const tenantId of event.targetTenantIds) {
      const tenantAdmins = await this.tenantUserService.getTenantAdminUserIds(tenantId);
      await this.notificationService.createBatch(
        tenantAdmins.map(userId => ({
          userId,
          tenantId,
          type: 'ANNOUNCEMENT',
          title: event.title,
          body: `New ${event.announcementType} announcement from platform`,
          data: {
            announcementId: event.announcementId,
            announcementType: event.announcementType,
            requiresAcknowledgment: event.requiresAcknowledgment,
          },
        })),
      );
    }
  }

  @EventPattern('BulkThreadsCreated')
  async handleBulkCreated(event: BulkThreadsCreatedEvent): Promise<void> {
    // One notification per tenant
    for (let i = 0; i < event.tenantIds.length; i++) {
      const tenantAdmins = await this.tenantUserService.getTenantAdminUserIds(event.tenantIds[i]);
      await this.notificationService.createBatch(
        tenantAdmins.map(userId => ({
          userId,
          tenantId: event.tenantIds[i],
          type: 'MESSAGE',
          title: `New message from platform: ${event.subject}`,
          data: { threadId: event.threadIds[i] },
        })),
      );
    }

    // Email dispatch (if sendEmail = true)
    if (event.sendEmail) {
      await this.emailService.sendBulkMessageEmails(event);
    }
  }
}
```

**Modify:** `apps/notification-service/src/notification/notification.module.ts`

Register the new handler:

```typescript
controllers: [
  // ... existing handlers
  MessagingEventHandler,
],
```

#### 3.4 Gateway Health Check Fix

**File:** `apps/gateway-api/src/health/health.service.ts`

Add notification-service to monitored services:

```typescript
private readonly serviceUrls: Record<string, string> = {
  // ... existing services
  'notification-service': `http://localhost:${process.env.NOTIFICATION_PORT || 4008}/health`,
};
```

---

## 5. Complete File Change Matrix

| Phase | File | Action | LOC Est. |
|-------|------|--------|----------|
| **1** | `apps/auth-service/src/modules/messaging/resolvers/messaging.resolver.ts` | MODIFY — add bulkCreateThreads, resolveTargetTenants | +60 |
| **1** | `apps/auth-service/src/modules/messaging/services/messaging.service.ts` | MODIFY — bulk create logic, tenant resolution | +120 |
| **1** | `apps/auth-service/src/modules/messaging/dto/messaging.dto.ts` | MODIFY — activate BulkCreateThreadsInput | +30 |
| **1** | `web/modules/admin-panel/src/graphql/messaging-operations.ts` | NEW — all GraphQL operation definitions | +150 |
| **1** | `web/modules/admin-panel/src/hooks/useMessaging.ts` | NEW — TanStack Query hooks | +200 |
| **1** | `web/modules/admin-panel/src/providers/ApolloProvider.tsx` | NEW — Apollo Client setup | +40 |
| **1** | `web/modules/admin-panel/src/pages/MessagingPage.tsx` | MODIFY — REST → GraphQL migration | ~300 changed |
| **1** | `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx` | MODIFY — REST → GraphQL migration | ~200 changed |
| **1** | `scripts/migrate-messaging-to-auth.sql` | NEW — one-time data migration | +80 |
| **1** | `apps/admin-api-service/src/support/controllers/messaging.controller.ts` | MODIFY — add deprecation headers | +10 |
| **1** | `apps/admin-api-service/src/support/controllers/announcement.controller.ts` | MODIFY — add deprecation headers | +10 |
| **2** | `web/modules/admin-panel/src/components/TenantMultiSelect.tsx` | NEW — reusable tenant picker | +120 |
| **2** | `web/modules/admin-panel/src/components/TenantSelect.tsx` | NEW — single tenant search select | +80 |
| **2** | `web/modules/admin-panel/src/pages/MessagingPage.tsx` | MODIFY — BulkMessage + NewThread UI | +60 |
| **2** | `web/modules/admin-panel/src/pages/AnnouncementsPage.tsx` | MODIFY — target criteria form | +80 |
| **2** | `apps/auth-service/src/modules/announcement/services/announcement.service.ts` | MODIFY — matchesTenant enforcement | +20 |
| **2** | `apps/auth-service/src/modules/announcement/resolvers/announcement.resolver.ts` | MODIFY — role guard relaxation | +5 |
| **2** | `web/shell/src/components/NotificationPanel.tsx` | MODIFY — route mappings | +4 |
| **3** | `libs/event-contracts/src/messaging-events.ts` | NEW — NATS event contracts | +100 |
| **3** | `libs/event-contracts/src/index.ts` | MODIFY — export + union type | +5 |
| **3** | `apps/auth-service/src/modules/messaging/services/messaging.service.ts` | MODIFY — event publishing | +40 |
| **3** | `apps/auth-service/src/modules/announcement/services/announcement.service.ts` | MODIFY — event publishing | +30 |
| **3** | `apps/notification-service/src/notification/event-handlers/messaging-event.handler.ts` | NEW — event handlers | +150 |
| **3** | `apps/notification-service/src/notification/notification.module.ts` | MODIFY — register handler | +3 |
| **3** | `apps/gateway-api/src/health/health.service.ts` | MODIFY — add notification svc | +2 |

**Total: ~1,900 lines across 25 files**

---

## 6. Testing Strategy

### Phase 1 — Integration Tests

```
Test 1: SuperAdmin creates thread via GraphQL → tenant queries myThreads → sees thread
Test 2: SuperAdmin sends message → tenant queries threadMessages → sees message
Test 3: Tenant replies → SuperAdmin queries same thread → sees reply
Test 4: SuperAdmin bulk creates → all target tenants see their threads
Test 5: SuperAdmin creates announcement → tenant queries myAnnouncements → sees it
Test 6: Data migration script → count verification for all 4 tables
```

### Phase 2 — E2E Tests

```
Test 7: BulkMessage with 5 selected tenants → 5 threads created
Test 8: Targeted announcement (plan=PRO) → only PRO tenants see it
Test 9: MODULE_USER queries myAnnouncements → sees published announcements
Test 10: Click notification bell MESSAGE item → navigates to /tenant/messages?thread=X
```

### Phase 3 — Event Tests

```
Test 11: Send message → NATS event published → notification-service creates InAppNotification
Test 12: Publish announcement (global) → InAppNotification created for all tenant admins
Test 13: Publish announcement (targeted) → only matching tenants get notification
Test 14: Bulk message with sendEmail=true → email dispatch triggered
Test 15: Internal note → NO notification sent to tenant
```

---

## 7. Rollback Strategy

| Phase | Rollback Action | Data Impact |
|-------|----------------|-------------|
| Phase 1 | Revert admin-panel to REST calls. Auth schema data remains valid — tenants still see existing messages. | None — data only grows |
| Phase 2 | Individual revert per fix. Each fix is atomic. | None |
| Phase 3 | Remove event handlers from notification-service. Core messaging unaffected — events are fire-and-forget. | None — notifications stop but messaging works |

---

## 8. Future Enhancements (Post Phase 3)

| Enhancement | Value | Effort |
|-------------|-------|--------|
| GraphQL Subscriptions for real-time push | Instant message delivery without polling | 2-3 days |
| Tenant dashboard comm widgets | Unread count + recent announcements on dashboard | 1 day |
| Email notification for critical announcements | SMTP dispatch via notification-service | 1 day |
| Unified inbox (messages + announcements + support) | Single page for all tenant communications | 3 days |
| Read receipts via WebSocket | Real-time "read" status update in admin panel | 1 day |
| Message search (full-text) | PostgreSQL tsvector index on message content | 1 day |
| Admin-api REST endpoint removal | Clean up deprecated code after 90 days | 0.5 day |
