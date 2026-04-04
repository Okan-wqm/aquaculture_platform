---
name: Dual messaging systems — admin support vs tenant in-app
description: Platform has TWO separate messaging systems — admin-to-tenant support (existing) and tenant-internal WhatsApp-like messaging (ADR-012, new)
type: project
---

The platform has TWO completely separate messaging systems:

1. **Admin → Tenant Support Messaging** (EXISTING)
   - Location: Admin Panel → `web/modules/admin-panel/src/pages/MessagingPage.tsx`
   - Backend: `admin-api-service` REST endpoints (`supportApi`)
   - Purpose: SUPER_ADMIN ↔ TENANT_ADMIN support threads, bulk messaging
   - Features: Thread list, internal notes, bulk message to all tenants, read receipts
   - DO NOT MODIFY this system when working on ADR-012

2. **Tenant Internal Messaging** (ADR-012, NEW)
   - Location: AquaMobil PWA → messaging pages (ChannelListPage, ChatRoomPage, etc.)
   - Backend: New `messaging-service` (NestJS, port 3000)
   - Purpose: Tenant users (field workers, supervisors, managers) chat about operations
   - Features: DM, group chat, AI chat, media upload, offline-first, WhatsApp-like UX
   - Use cases: balık sağlığı tartışması, su kalitesi raporları, vardiya devir teslim, AI asistan

**Why:** These are architecturally separate because admin messaging is cross-tenant (SUPER_ADMIN sees all tenants) while tenant messaging is strictly tenant-isolated (users only see their own tenant's channels).

**How to apply:** Never confuse or merge these systems. The admin panel's MessagingPage.tsx is for support. The new admin panel monitoring pages (MessagingMonitoringPage, MessagingTenantsPage, MessagingAuditPage) are for SUPER_ADMIN to MONITOR the tenant messaging system — not to participate in it.
