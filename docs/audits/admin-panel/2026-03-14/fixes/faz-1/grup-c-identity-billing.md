# Grup C Faz 2 -- BillingController Identity Security Fix

**Tarih:** 2026-03-14
**Bulgu:** C6 Faz 2
**Dosya:** `apps/admin-api-service/src/billing/billing.controller.ts`
**Referans Pattern:** `apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts`

## Sorun

BillingController'daki birden fazla endpoint, admin kimligini (`cancelledBy`, `approverId`, `createdBy`, `updatedBy`, `rejectedBy`, `markedBy`, `voidedBy`, `extendedBy`, `reactivatedBy`, `redeemedBy`, `changedBy`) client-supplied `@Body()` parametreleri araciligiyla aliyordu. Bu, herhangi bir kimlik dogrulanmis kullanicinin baska bir admin gibi islem yapmasina olanak taniyordu.

## Cozum

Tum identity parametreleri JWT token'indan (`req.user.id`) alinacak sekilde degistirildi. Client-supplied identity field'lari kaldirildi veya backend'de override edildi.

## Degisiklik Ozeti

| # | Endpoint | Method | Eski Parametre | Yeni Kaynak |
|---|----------|--------|----------------|-------------|
| 1 | `POST /billing/plans` | `createPlan` | `dto.createdBy` (DTO body) | `req.user.id` override |
| 2 | `PUT /billing/plans/:id` | `updatePlan` | `dto.updatedBy` (DTO body) | `req.user.id` override |
| 3 | `POST /billing/plans/:id/deprecate` | `deprecatePlan` | `@Body('updatedBy')` | `req.user.id` |
| 4 | `POST /billing/plans/seed` | `seedPlans` | `@Body('createdBy')` | `req.user.id` |
| 5 | `POST /billing/discounts` | `createDiscountCode` | `dto.createdBy` (DTO body) | `req.user.id` override |
| 6 | `PUT /billing/discounts/:id` | `updateDiscountCode` | `dto.updatedBy` (DTO body) | `req.user.id` override |
| 7 | `POST /billing/discounts/:id/deactivate` | `deactivateDiscountCode` | `@Body('updatedBy')` | `req.user.id` |
| 8 | `POST /billing/discounts/apply` | `applyDiscountCode` | `@Body('redeemedBy')` | `req.user.id` |
| 9 | `POST /billing/subscriptions` | `createSubscription` | `dto.createdBy` (DTO body) | `req.user.id` override |
| 10 | `POST /billing/subscriptions/change-plan` | `changePlan` | `request.changedBy` (DTO body) | `req.user.id` override |
| 11 | `POST /billing/subscriptions/tenant/:tenantId/cancel` | `cancelSubscription` | `@Body('cancelledBy')` | `req.user.id` |
| 12 | `POST /billing/subscriptions/tenant/:tenantId/reactivate` | `reactivateSubscription` | `@Body('reactivatedBy')` | `req.user.id` |
| 13 | `POST /billing/subscriptions/tenant/:tenantId/extend-trial` | `extendTrial` | `@Body('extendedBy')` | `req.user.id` |
| 14 | `POST /billing/custom-plans` | `createCustomPlan` | `dto.createdBy` (DTO body) | `req.user.id` override |
| 15 | `PUT /billing/custom-plans/:planId` | `updateCustomPlan` | `dto.updatedBy` (DTO body) | `req.user.id` override |
| 16 | `POST /billing/custom-plans/:planId/approve` | `approveCustomPlan` | `@Body('approverId')` | `req.user.id` |
| 17 | `POST /billing/custom-plans/:planId/reject` | `rejectCustomPlan` | `@Body('rejectedBy')` | `req.user.id` |
| 18 | `POST /billing/invoices/:invoiceId/mark-paid` | `markInvoiceAsPaid` | `@Body('markedBy')` | `req.user.id` |
| 19 | `POST /billing/invoices/:invoiceId/void` | `voidInvoice` | `@Body('voidedBy')` | `req.user.id` |

## Teknik Detaylar

- Her endpoint'e `@Req() req: Request` eklendi
- `import { Request } from 'express'` ve `Req` import'u eklendi
- Identity degeri: `const userId = (req as any).user?.id`
- DTO-based endpoint'lerde spread operator ile override: `{ ...dto, createdBy: userId }`
- Direct-param endpoint'lerde client parametresi kaldirilip `userId` gecildi
- Service method imzalarina dokunulmadi
- Her degisiklige `// Fix: C6 -- JWT-based identity` yorumu eklendi

## Derleme Durumu

TypeScript derleme hatasi yok (`tsc --noEmit` basarili).
