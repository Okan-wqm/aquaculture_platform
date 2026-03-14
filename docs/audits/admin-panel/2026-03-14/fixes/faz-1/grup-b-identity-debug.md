# C6 Fix Raporu: DebugToolsController Client-Supplied Admin Identity

## Bulgu
DebugToolsController'da 4 endpoint, admin kimligini `@Query('adminId')` ile client'tan aliyordu. Bu, herhangi bir kullanicinin baska bir admin gibi islem yapmasina olanak taniyordu (identity spoofing).

## Etkilenen Dosya
`apps/admin-api-service/src/impersonation/controllers/debug-tools.controller.ts`

## Referans Pattern
`apps/admin-api-service/src/impersonation/controllers/impersonation.controller.ts` -- SECURITY FIX uygulanmis pattern.

## Yapilan Degisiklikler

### 1. Controller-Level Guard Eklendi
- `@UseGuards(PlatformAdminGuard)` class seviyesinde eklendi
- Tum endpoint'ler artik JWT dogrulamasi gerektiriyor
- Import'lara `Req`, `UseGuards`, `UnauthorizedException`, `Request`, `PlatformAdminGuard` eklendi

### 2. POST `sessions` - startDebugSession
- **Onceki**: `@Query('adminId') adminId: string` -- client'tan aliniyordu
- **Sonraki**: `@Req() req: Request` ile JWT'den `(req as any).user?.id` alinyor
- adminId yoksa `UnauthorizedException` firlatiliyor

### 3. POST `feature-overrides` - createFeatureFlagOverride
- **Onceki**: `@Query('adminId') adminId: string` -- client'tan aliniyordu
- **Sonraki**: `@Req() req: Request` ile JWT'den `(req as any).user?.id` alinyor
- adminId yoksa `UnauthorizedException` firlatiliyor

### 4. POST `feature-overrides/:id/revert` - revertFeatureFlagOverride
- **Onceki**: `@Query('adminId') revertedBy: string` -- client'tan aliniyordu
- **Sonraki**: `@Req() req: Request` ile JWT'den `(req as any).user?.id` alinyor
- revertedBy yoksa `UnauthorizedException` firlatiliyor

### 5. GET `feature-overrides` - queryOverrides
- **Onceki**: `@Query('adminId') adminId?: string` -- client filtre parametresi olarak gonderebiliyordu
- **Sonraki**: `@Req() req?: Request` ile JWT'den `(req as any)?.user?.id` alinyor
- adminId filtresi artik sadece authenticated admin'in kendi ID'si ile calisiyor

## Geriye Uyumluluk
- `adminId` query parametresi artik kabul edilmiyor
- Frontend'de bu endpoint'leri cagiran kodlarin `adminId` query parametresini kaldirmasi gerekiyor (artik JWT otomatik sagliyor)
- PlatformAdminGuard zaten `req.user`'i dolduruyor, ek mekanizma gerekmiyor

## Derleme Durumu
TypeScript derleme hatasi yok -- temiz gecti.

## Tarih
2026-03-14
