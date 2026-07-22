// APA-371: the guard-bypass key ('isPublic') is the platform SSoT, defined once
// in backend-common (decorators/roles.decorator.ts). Re-export it here — never
// re-declare an equal string literal — so admin-api's PlatformAdminGuard and
// AdminBypassRlsInterceptor read the EXACT same symbol that every @Public()
// stamps, including backend-common's own MetricsController. A rename becomes a
// type-level break instead of silent 'isPublic' string drift across four
// independent definitions. The canonical Public() also stamps skipTenantGuard,
// which is inert in admin-api (no tenant guard) and matches the metrics route.
export { IS_PUBLIC_KEY, Public } from '@aquaculture/backend-common/decorators';
