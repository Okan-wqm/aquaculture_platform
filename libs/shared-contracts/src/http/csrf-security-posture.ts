/**
 * Browser credential / CSRF authority shared by server and web transports.
 *
 * Access-token requests are authenticated by an explicit Authorization bearer
 * header. The only ambient browser credential is the refresh cookie; it is
 * httpOnly, SameSite=Lax and consumed by a POST mutation. Consequently the
 * platform does not implement a double-submit token protocol. Adding a cookie-
 * authenticated cross-site mutation requires replacing this contract and
 * landing both server validation and client emission atomically.
 */
export const CSRF_SECURITY_POSTURE = Object.freeze({
  accessCredentialTransport: 'authorization-bearer' as const,
  adminApiCredentialsMode: 'omit' as const,
  doubleSubmitTokenEnabled: false as const,
  refresh: Object.freeze({
    cookieName: 'refresh_token' as const,
    httpOnly: true as const,
    sameSite: 'lax' as const,
    operationMethod: 'POST' as const,
    credentialsMode: 'include' as const,
  }),
});

export type CsrfSecurityPosture = typeof CSRF_SECURITY_POSTURE;
