---
name: auth-service
description: Knowledge base for auth-service - JWT authentication, tenant management, user management, GDPR, invitation flow, messaging, announcements
---

# Auth Service Knowledge Base

## Overview
The auth-service is the identity and authorization backbone of the platform. It handles user registration, JWT-based login/logout, refresh token rotation, invitation flow, tenant management, RBAC roles, GDPR consent, internal messaging, support tickets, announcements, and system module definitions. It exposes a GraphQL Federation v2 subgraph (default port 3001).

## Directory Structure
```
apps/auth-service/src/
  app.module.ts              # Root module - TypeORM (auth schema), GraphQL Fed v2, JWT, EventBus
  main.ts
  constants/
    auth.constants.ts        # SECURITY_CONSTANTS, TOKEN_CONSTANTS (min lengths, expiry defaults)
  audit/
    audit-log.entity.ts      # AuditLog entity
    audit-log.service.ts     # Security event logging
    audit.module.ts
  database/
    seed.service.ts          # Seeds initial modules into auth.modules table
  privacy/
    data-masking.service.ts
    gdpr-compliance.service.ts
  rate-limit/
    rate-limiter.service.ts
    throttle.decorator.ts
  utils/
    sanitize.ts
  modules/
    authentication/
      authentication.module.ts
      entities/
        user.entity.ts            # Core User entity (email, password hash, role, tenantId)
        refresh-token.entity.ts   # Hashed refresh tokens with revocation
        invitation.entity.ts      # Pending invitations with expiry
        user-module-assignment.entity.ts  # Which modules a user can access
      services/
        authentication.service.ts  # Login, register, refresh, logout, acceptInvitation
      resolvers/
        auth.resolver.ts           # login, register, refreshToken, logout, me, validateInvitation
      guards/
        jwt-auth.guard.ts
      dto/
        login.dto.ts
        register.dto.ts
        auth-response.dto.ts       # AuthPayload (accessToken, refreshToken, user, redirectUrl)
        accept-invitation.dto.ts
        refresh-token.dto.ts
    tenant/
      tenant.module.ts
      entities/
        tenant.entity.ts
        tenant-module.entity.ts    # Which modules a tenant has enabled
        mobile-user-settings.entity.ts
      services/
        tenant.service.ts          # Tenant CRUD
        tenant-admin.service.ts    # User invitation, role management within tenant
        tenant-user-management.service.ts
        tenant-role.service.ts
        mobile-settings.service.ts
      resolvers/
        tenant.resolver.ts
        tenant-admin.resolver.ts
        tenant-role.resolver.ts
        mobile-settings.resolver.ts
      dto/
        create-tenant.dto.ts
        tenant-admin.dto.ts        # InviteUserInput, UpdateUserRoleInput
        tenant-role.dto.ts
        tenant-stats.dto.ts
        mobile-settings.dto.ts
    system-module/
      system-module.module.ts
      entities/
        module.entity.ts           # Platform modules (farm, sensor, hr, billing, hydroponics)
    gdpr/
      gdpr.module.ts
      services/
        user-consent.service.ts
      resolvers/
        user-consent.resolver.ts
      dto/
        user-consent.dto.ts
    messaging/
      messaging.module.ts
      entities/
        message-thread.entity.ts
        message.entity.ts
      services/
        messaging.service.ts
      resolvers/
        messaging.resolver.ts
      dto/
        messaging.dto.ts
    support/
      support.module.ts
      entities/
        support-ticket.entity.ts
        ticket-comment.entity.ts
      services/
        support.service.ts
      resolvers/
        support.resolver.ts
      dto/
        support.dto.ts
    announcement/
      announcement.module.ts
      entities/
        announcement.entity.ts
        announcement-acknowledgment.entity.ts
      services/
        announcement.service.ts
      resolvers/
        announcement.resolver.ts
      dto/
        announcement.dto.ts
  health/
    health.module.ts
    health.controller.ts
```

## Modules & Features

### AuthenticationModule
Core auth functionality:
- `AuthenticationService`: login (timing-safe, account lockout, bcrypt), register, refreshToken (rotation with hashing), logout (blacklist + revoke), acceptInvitation, validateInvitation, me (user + modules + redirectPath)
- JWT payload: `{ sub, email, role, roles, tenantId, modules, jti }`
- JTI (JWT ID) included for token blacklisting
- Minimum login duration (MIN_LOGIN_DURATION_MS) prevents timing attacks
- Account lockout after N failed attempts (MAX_FAILED_ATTEMPTS env var)
- Refresh tokens are bcrypt-hashed before storage; plaintext returned to client
- Session management via optional ISessionManager injection

### TenantModule
- Tenant CRUD (create, update, list, get)
- TenantAdminService: invite users to tenant, manage roles, deactivate users
- TenantRoleService: per-tenant RBAC role definitions
- Mobile settings per user

### SystemModule
- Defines available platform modules (farm, sensor, hr, billing, hydroponics)
- Seeded on startup via `seed.service.ts`

### GdprModule
- User consent management (GDPR Article 7)
- Consent records for data processing purposes

### MessagingModule
- Internal messaging with thread support
- Message threads between users

### SupportModule
- Support ticket creation and management
- Ticket comments

### AnnouncementModule
- Platform-wide announcements
- Acknowledgment tracking per user

### AuditModule
- Security event logging (LOGIN_SUCCESS, LOGIN_FAILED, ACCOUNT_LOCKED, etc.)
- Severity levels: INFO, WARNING, CRITICAL
- Never fails main operation (errors caught silently)

## Key Entities

### User
- `id` (uuid), `email`, `password` (bcrypt hash), `firstName`, `lastName`
- `role`: SUPER_ADMIN | TENANT_ADMIN | MODULE_MANAGER | MODULE_USER
- `tenantId` (null for SUPER_ADMIN)
- `isActive`, `isEmailVerified`
- `failedLoginAttempts`, `lockedUntil` (account lockout)
- `lastLoginAt`, `lastLoginIp`
- `invitationToken`, `invitationExpiresAt`
- Methods: `validatePassword()`, `isLocked()`, `isPendingInvitation()`

### RefreshToken
- `token` (bcrypt hash of the raw token)
- `userId`, `tenantId`
- `isRevoked`, `revokedAt`, `revokedReason`
- `expiresAt`, `ipAddress`, `userAgent`

### Invitation
- `token` (random UUID), `email`, `role`
- `status`: PENDING | ACCEPTED | EXPIRED | CANCELLED
- `tenantId`, `invitedBy`, `expiresAt`
- `acceptedAt`, `acceptedFromIp`
- Methods: `canBeAccepted()`, `isExpired()`, `isPending()`

### Tenant
- `id`, `name`, `slug`, `isActive`
- `schemaName` (tenant_{first16chars_uuid})

### TenantModule
- Links tenants to platform modules (`tenantId`, `moduleId`, `isEnabled`)

### Module
- `code` (farm, sensor, hr, billing, hydroponics), `name`, `defaultRoute`

## API / GraphQL (auth subgraph)

### Queries
- `me`: Returns current user, their accessible modules, and redirectPath
- `validateInvitation(token)`: Check if invitation token is valid
- `tenant`, `tenants`, `tenantStats`
- `userConsents`, `messages`, `messageThread`, `supportTickets`, `announcements`

### Mutations
- `login(email, password)`: Returns AuthPayload (accessToken, refreshToken, redirectUrl)
- `register(...)`: Self-registration (can be disabled via REGISTRATION_ENABLED=false)
- `refreshToken(token)`: Token rotation, returns new pair
- `logout`: Revokes tokens, blacklists JTI
- `logoutAllDevices`: Revokes all sessions
- `acceptInvitation(token, password)`: Completes invitation flow
- `inviteUser(...)`: Tenant admin invites a user
- `updateUserRole(...)`, `deactivateUser(...)`
- `createTenant`, `updateTenant`
- `recordConsent`, `withdrawConsent`
- `sendMessage`, `createThread`
- `createSupportTicket`, `addTicketComment`
- `createAnnouncement`, `acknowledgeAnnouncement`

## Patterns Used
- GraphQL Federation v2 subgraph (`ApolloFederationDriver`)
- Event-driven: publishes UserRegistered, UserLoggedIn, InvitationAccepted events via EventBus (NATS)
- Security-first: timing-safe login, bcrypt refresh token hashing, JTI blacklisting
- Transactional invitation acceptance (atomic user update + invitation status update)

## Inter-Service Communication
- Publishes NATS events: `UserRegistered`, `UserLoggedIn`, `InvitationAccepted`
- admin-api-service calls auth-service to create users during tenant provisioning
- gateway-api forwards all auth mutations here

## Key Dependencies
- `bcryptjs` - password and refresh token hashing
- `@nestjs/jwt` - JWT sign/verify
- `@platform/backend-common` - Role enum, TimingSafeService, ISessionManager, ITokenBlacklist
- `@platform/event-bus` - NATS event publishing
- TypeORM with PostgreSQL (`auth` schema)

## Known Gotchas
- **auth schema** - The service owns the `auth` schema in PostgreSQL (`DATABASE_SCHEMA=auth`). This is NOT a tenant-scoped schema.
- **SUPER_ADMIN has null tenantId** - must be handled everywhere; JWT `tenantId` can be null
- **Refresh token hashing** - client gets the plaintext token, DB stores bcrypt hash. When `HASH_REFRESH_TOKENS=true`, finding the matching token requires iterating recent tokens and comparing hashes (up to `TOKEN_CONSTANTS.MAX_REFRESH_TOKEN_CHECK` tokens)
- **Role-based redirect** - `me` query returns `redirectPath` and `generateTokens` returns `redirectUrl` based on role (SUPER_ADMIN -> /admin, TENANT_ADMIN -> /tenant, MODULE_USER -> module's defaultRoute)
- **Module access** - TENANT_ADMIN sees all tenant modules; MODULE_USER sees only their assigned modules; SUPER_ADMIN sees none (they use admin panel)
- **Registration disabled by default in enterprise** - check `REGISTRATION_ENABLED` env var in auth.resolver.ts
- **Audit logging never blocks** - errors in audit logging are caught and logged but do not fail the main operation

## Related Services
- gateway-api: validates JWT tokens issued here
- admin-api-service: creates users and tenants via direct API calls during provisioning
- notification-service: receives events to send welcome/invitation emails
