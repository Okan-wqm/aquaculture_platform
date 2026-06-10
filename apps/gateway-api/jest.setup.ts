// WHY: every internal HTTP call from the gateway is HMAC-signed (HIGH-003 —
// buildSignedInternalHeaders binds tenantId + method + path + body into the
// signature) and the signer HARD-FAILS without INTERNAL_SERVICE_SECRET so a
// misconfigured deployment cannot silently send unsigned traffic. Unit tests
// exercise the same signing code path with a deterministic fixture secret;
// the ?? guard lets CI inject a different value without being overridden.
process.env['INTERNAL_SERVICE_SECRET'] =
  process.env['INTERNAL_SERVICE_SECRET'] ?? 'jest-internal-service-secret-fixture';
