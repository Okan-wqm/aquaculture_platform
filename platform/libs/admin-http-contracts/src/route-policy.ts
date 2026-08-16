/**
 * Exact network-coordinate authority for the admin HTTP surface.
 *
 * Logical controller paths are compiled into both the neutral and URI-v1
 * aliases. Health probes are deliberately outside the global API prefix.
 * Host-specific controllers are not part of this policy.
 */
export const ADMIN_HTTP_ROUTE_POLICY = Object.freeze({
  schemaVersion: 'admin-http-route-policy.v1',
  globalPrefix: 'api',
  prefixExclusions: Object.freeze(['health', 'health/(.*)'] as const),
  versioning: Object.freeze({
    strategy: 'uri' as const,
    prefix: 'v',
    defaultVersions: Object.freeze(['1', 'neutral'] as const),
  }),
  hostPolicy: 'any-host' as const,
  matcher: Object.freeze({
    caseSensitive: false,
    strictTrailingSlash: false,
    parameterCodec: 'decode-uri-component' as const,
    staticBeforeParameter: true,
    getProvidesImplicitHead: true,
    optionsDiscovery: 'framework-generated' as const,
  }),
  requestTarget: Object.freeze({
    repeatedSlash: 'reject' as const,
    trailingSlash: 'reject' as const,
    encodedUnreserved: 'reject' as const,
    encodedPathDelimiter: 'reject' as const,
    percentHexCase: 'uppercase' as const,
  }),
});

export type AdminHttpRoutePolicy = typeof ADMIN_HTTP_ROUTE_POLICY;

export function assertSupportedAdminRoutePathSegment(segment: string): void {
  const supported = segment.startsWith(':')
    ? /^:[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
    : /^[A-Za-z0-9._~-]+$/.test(segment);
  if (!supported) {
    throw new TypeError(
      `unsupported Nest route path segment ${JSON.stringify(segment)}; ` +
        'wildcards, optional parameters, and inline regex require an explicit compiler model',
    );
  }
}

/**
 * Convert Nest's controller/handler decorator metadata to the one logical
 * absolute path used by both the compiler and the runtime request guard.
 * Nest represents a parameterless route decorator as `/`; no other alternate
 * slash spelling is accepted.
 */
export function adminLogicalRoutePathFromMetadata(...routeParts: readonly unknown[]): string {
  const segments: string[] = [];
  for (const part of routeParts) {
    if (part === undefined || part === '' || part === '/') continue;
    if (
      typeof part !== 'string' ||
      part.startsWith('/') ||
      part.endsWith('/') ||
      part.includes('//') ||
      part.includes('\\') ||
      part.includes('?') ||
      part.includes('#')
    ) {
      throw new TypeError('Nest route metadata must use one canonical relative path');
    }
    const partSegments = part.split('/');
    for (const segment of partSegments) assertSupportedAdminRoutePathSegment(segment);
    segments.push(...partSegments);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

/**
 * Headers owned by HTTP, the browser transport kernel, authentication, or the
 * trusted ingress. Controller request contracts may not reinterpret them as
 * route-owned values. Every other caller-supplied header must be declared by
 * the exact route request DAG.
 */
export const ADMIN_RESERVED_REQUEST_HEADER_NAMES: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'baggage',
  'cache-control',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'dnt',
  'host',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'origin',
  'pragma',
  'priority',
  'proxy-authorization',
  'range',
  'referer',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'te',
  'traceparent',
  'tracestate',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'x-correlation-id',
  'x-csrf-token',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-client-ip',
  'x-client-user-agent',
  'x-real-ip',
  'x-request-id',
  'x-service-assertion-hash',
  'x-service-audience',
  'x-service-body-hash',
  'x-service-content-type',
  'x-service-effective-tenant-id',
  'x-service-identity',
  'x-service-key-id',
  'x-service-method',
  'x-service-nonce',
  'x-service-path',
  'x-service-query-hash',
  'x-service-sig-version',
  'x-service-signature',
  'x-service-timestamp',
  'x-tenant-id',
]);

const UNRESERVED_OR_PATH_DELIMITER_BYTE = /^[A-Za-z0-9._~%\\/]$/;

/**
 * Fail closed before a controller is allowed to consume an alternate spelling
 * of a route. Express matches the raw path and decodes parameters afterwards;
 * without this gate, `%73tats` can bypass a preceding `/stats` route and be
 * reinterpreted as the value of `/:id`.
 */
export function assertCanonicalAdminRequestTarget(
  requestTarget: unknown,
): asserts requestTarget is string {
  if (typeof requestTarget !== 'string' || !requestTarget.startsWith('/')) {
    throw new TypeError('admin request target must be an origin-form path');
  }
  const queryStart = requestTarget.indexOf('?');
  const path = queryStart === -1 ? requestTarget : requestTarget.slice(0, queryStart);
  if (path.length > 1 && path.endsWith('/')) {
    throw new TypeError('admin request path must not contain a trailing slash');
  }
  if (path.includes('//') || path.includes('\\')) {
    throw new TypeError('admin request path contains a non-canonical delimiter');
  }
  if (/[^\x20-\x7e]/.test(requestTarget)) {
    throw new TypeError('admin request target must use an ASCII URI wire representation');
  }
  try {
    decodeURI(path);
  } catch {
    throw new TypeError('admin request path contains malformed UTF-8 percent encoding');
  }
  for (let index = 0; index < path.length; index++) {
    if (path[index] !== '%') continue;
    const hex = path.slice(index + 1, index + 3);
    if (!/^[0-9A-F]{2}$/.test(hex)) {
      throw new TypeError('admin request path percent encoding must use uppercase hex');
    }
    const decodedByte = String.fromCharCode(Number.parseInt(hex, 16));
    if (UNRESERVED_OR_PATH_DELIMITER_BYTE.test(decodedByte)) {
      throw new TypeError('admin request path percent-encodes a canonical path byte');
    }
    index += 2;
  }
}

export function adminNetworkAliases(logicalPath: string): readonly string[] {
  if (
    !logicalPath.startsWith('/') ||
    (logicalPath.length > 1 && logicalPath.endsWith('/')) ||
    logicalPath.includes('//') ||
    logicalPath.includes('\\') ||
    logicalPath.includes('?') ||
    logicalPath.includes('#')
  ) {
    throw new TypeError('logical admin route path must be one canonical absolute path');
  }
  const excluded = logicalPath === '/health' || logicalPath.startsWith('/health/');
  const neutralPrefix = excluded ? '' : `/${ADMIN_HTTP_ROUTE_POLICY.globalPrefix}`;
  const versionPrefix = `${neutralPrefix}/${ADMIN_HTTP_ROUTE_POLICY.versioning.prefix}1`;
  return Object.freeze([`${neutralPrefix}${logicalPath}`, `${versionPrefix}${logicalPath}`]);
}
