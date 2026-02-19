---
name: notification-service
description: Knowledge base for notification-service - Email, SMS, push notification dispatch; event-driven only (no GraphQL)
---

# Notification Service Knowledge Base

## Overview
The notification-service is a pure event-driven service (no GraphQL subgraph) that handles multi-channel notification delivery. It consumes NATS events (AlertTriggered, UserInvited, etc.) and dispatches notifications via email, SMS, and push channels. It logs all sent notifications for audit and retry purposes. Runs on its own port but is NOT included in the Apollo Gateway subgraph list.

## Directory Structure
```
apps/notification-service/src/
  app.module.ts              # Root - TypeORM, EventBus, Email/SMS/Push providers
  main.ts
  filters/
    global-exception.filter.ts

  notification/
    notification.module.ts
    entities/
      notification-log.entity.ts     # Record of every dispatched notification
    event-handlers/
      alert-triggered.handler.ts     # Handles AlertTriggered NATS event
    services/
      notification-dispatcher.service.ts  # Orchestrates dispatch across channels
      email.service.ts               # Email delivery (SMTP/SendGrid/SES)
      sms.service.ts                 # SMS delivery (Twilio/AWS SNS)
      push.service.ts                # Push notification delivery (FCM/APNs)

  health/
    health.module.ts
    health.controller.ts
```

## Modules & Features

### NotificationModule
The sole feature module. Contains:
- `NotificationDispatcherService`: receives notification requests and routes to appropriate channel services
- `AlertTriggeredHandler`: NATS event handler for `AlertTriggered` events from alert-engine
- `EmailService`: sends emails via configured provider (SMTP, SendGrid, or AWS SES)
- `SmsService`: sends SMS via configured provider (Twilio or AWS SNS)
- `PushService`: sends push notifications via Firebase Cloud Messaging (FCM) or Apple Push Notification service (APNs)
- `NotificationLog` entity: records all sent notifications with status and channel

### HealthModule
REST endpoint `/health` for service health checks.

## Key Entities

### NotificationLog
- `id` (uuid), `tenantId`
- `channel`: email | sms | push
- `recipient`: email address, phone number, or device token
- `subject`, `body`
- `status`: pending | sent | failed | bounced
- `eventType`: the source event that triggered this notification
- `referenceId`: ID of the alert/invitation/etc. that was notified about
- `sentAt`, `failedAt`, `failureReason`
- `retryCount`, `nextRetryAt`

## API / GraphQL
**This service has NO GraphQL endpoint.** It is NOT included in the Apollo Gateway subgraph list. This is explicitly noted in `gateway-api/src/app.module.ts`:
```typescript
// NOTE: notification-service doesn't expose GraphQL - it's event-driven only
```

The service is entirely event-driven. It only has a REST `/health` endpoint.

## Patterns Used
- **Pure event-driven**: subscribes to NATS events, no HTTP requests
- **Channel routing**: routes notifications based on event type and user preferences
- **Retry logic**: failed notifications are retried with exponential backoff
- **Audit logging**: every notification attempt (success or failure) is logged
- **Provider abstraction**: email/SMS/push services are abstracted so providers can be swapped

## Inter-Service Communication
Consumes NATS events:
- `AlertTriggered` (from alert-engine)
- `AlertEscalated` (from alert-engine)
- `UserInvited` / `InvitationAccepted` (from auth-service)
- `UserRegistered` (from auth-service)
- `SubscriptionCreated`, `InvoiceDue` (from billing-service)
- `TenantProvisioned` (from admin-api-service)

Does NOT publish events (it is an endpoint, not a source).

## Key Dependencies
- `@platform/event-bus` - NATS JetStream subscription
- `nodemailer` or `@sendgrid/mail` - email delivery
- `twilio` or AWS SDK - SMS delivery
- `firebase-admin` - push notification delivery (FCM)
- TypeORM with PostgreSQL (for notification_log table)

## Key Configuration (Environment Variables)
```
# Email
EMAIL_PROVIDER=smtp|sendgrid|ses
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
SENDGRID_API_KEY
SES_REGION, SES_ACCESS_KEY, SES_SECRET_KEY
EMAIL_FROM=noreply@aquaculture.com

# SMS
SMS_PROVIDER=twilio|sns
TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

# Push
FCM_PROJECT_ID, FCM_PRIVATE_KEY, FCM_CLIENT_EMAIL

# NATS
NATS_URL=nats://localhost:4222
NATS_STREAM_NAME=AQUACULTURE_EVENTS
```

## Known Gotchas
- **Not in GraphQL Gateway** - do NOT try to add this to the subgraphs list in gateway-api; it has no GraphQL schema
- **No tenant schema middleware needed** - notifications are logged in the shared public schema (not tenant-scoped), or potentially per-tenant depending on entity configuration
- **Retry mechanism** - failed notifications should be retried; check `retryCount` and `nextRetryAt` in the log entity
- **Channel selection** - the dispatcher service decides which channels to use based on the event type and user notification preferences (may need to call auth-service or a preferences table)

## Related Services
- alert-engine: primary source of notification triggers
- auth-service: source of invitation/registration events
- billing-service: source of billing-related notification triggers
- admin-api-service: source of tenant provisioning notifications
