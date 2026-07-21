const getEnvString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const ADMIN_API_URL = getEnvString(import.meta.env.VITE_ADMIN_API_URL) ?? '/api';

const SHARED_AUTH_STATE_KEY = '__AQUACULTURE_AUTH_STATE_V2__';

const CSRF_PROTECTED_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

interface BlobApiError extends Error {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
}

class BlobApiRequestError extends Error implements BlobApiError {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BlobApiRequestError';
  }
}

interface SharedAuthState {
  accessToken: string | null;
  tenantId: string | null;
}

interface AquacultureAuthGlobal {
  getAccessToken?: () => string | null;
  getTenantId?: () => string | null;
}

interface RefreshResponse {
  data?: {
    refreshToken?: {
      accessToken?: unknown;
      user?: {
        tenantId?: unknown;
      };
    };
  };
  errors?: unknown;
}

interface ErrorBody {
  message?: string;
  code?: string;
  details?: Record<string, unknown>;
}

declare global {
  interface Window {
    __AQUACULTURE_AUTH__?: AquacultureAuthGlobal;
    __AQUACULTURE_AUTH_STATE_V2__?: SharedAuthState;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isErrorBody = (value: unknown): value is ErrorBody => {
  if (!isRecord(value)) return false;

  const details = value.details;
  return details === undefined || isRecord(details);
};

const getAuthWindow = (): Window | null => {
  if (typeof window === 'undefined') return null;
  return window;
};

const getSharedAuthState = (create = false): SharedAuthState | null => {
  const authWindow = getAuthWindow();
  if (!authWindow) return null;
  if (authWindow.__AQUACULTURE_AUTH_STATE_V2__) return authWindow.__AQUACULTURE_AUTH_STATE_V2__;
  if (!create) return null;

  const state: SharedAuthState = { accessToken: null, tenantId: null };
  try {
    Object.defineProperty(authWindow, SHARED_AUTH_STATE_KEY, {
      value: state,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    return state;
  } catch {
    return null;
  }
};

const getAccessToken = (): string | null => {
  const sharedState = getSharedAuthState();
  if (sharedState?.accessToken) return sharedState.accessToken;
  return getAuthWindow()?.__AQUACULTURE_AUTH__?.getAccessToken?.() ?? null;
};

const getTenantId = (): string | null => {
  const sharedState = getSharedAuthState();
  if (sharedState?.tenantId) return sharedState.tenantId;

  const globalTenantId = getAuthWindow()?.__AQUACULTURE_AUTH__?.getTenantId?.();
  if (globalTenantId) return globalTenantId;

  try {
    return localStorage.getItem('tenant_id');
  } catch {
    return null;
  }
};

const setSessionState = (accessToken: string | null, tenantId?: string | null): void => {
  const sharedState = getSharedAuthState(true);
  if (sharedState) {
    sharedState.accessToken = accessToken;
    if (tenantId !== undefined) {
      sharedState.tenantId = tenantId;
    }
  }

  if (tenantId !== undefined) {
    try {
      if (tenantId) {
        localStorage.setItem('tenant_id', tenantId);
      } else {
        localStorage.removeItem('tenant_id');
      }
    } catch {
      // Best-effort persistence only.
    }
  }
};

const clearSessionState = (): void => {
  setSessionState(null, null);
};

const isRefreshResponse = (value: unknown): value is RefreshResponse =>
  !!value && typeof value === 'object';

const silentRefresh = async (): Promise<boolean> => {
  try {
    const response = await fetch(getEnvString(import.meta.env.VITE_GRAPHQL_URL) ?? '/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        query: 'mutation { refreshToken(input: { refreshToken: "" }) { accessToken user { id email role tenantId } } }',
      }),
    });

    if (!response.ok) return false;

    const parsed: unknown = await response.json();
    if (!isRefreshResponse(parsed) || parsed.errors) return false;

    const accessToken = parsed.data?.refreshToken?.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return false;

    const tenantId = parsed.data?.refreshToken?.user?.tenantId;
    setSessionState(accessToken, typeof tenantId === 'string' ? tenantId : undefined);
    return true;
  } catch {
    return false;
  }
};

const getAuthHeader = (): Record<string, string> => {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const generateRequestId = (): string => crypto.randomUUID();

const getCsrfTokenFromCookie = (): string | null => {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

const createApiError = (
  message: string,
  status?: number,
  code?: string,
  details?: Record<string, unknown>,
): BlobApiError => {
  return new BlobApiRequestError(message, status, code, details);
};

const normalizeHeaders = (headers?: HeadersInit): Record<string, string> => {
  if (!headers) return {};

  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  }

  return { ...headers };
};

async function readErrorBody(response: Response): Promise<ErrorBody> {
  const parsed: unknown = await response.json().catch(() => ({}));
  if (!isErrorBody(parsed)) return {};

  return {
    message: parsed.message,
    code: parsed.code,
    details: parsed.details,
  };
}

export async function apiFetchBlob(
  endpoint: string,
  options?: RequestInit,
): Promise<{ blob: Blob; filename?: string; contentType: string }> {
  if (!getAccessToken()) {
    const refreshed = await silentRefresh();
    if (!refreshed) {
      throw createApiError('Authentication required', 401);
    }
  }

  const method = (options?.method ?? 'GET').toUpperCase();
  let has401Retried = false;

  for (;;) {
    const headers: Record<string, string> = {
      Accept: 'application/octet-stream',
      'X-Request-ID': generateRequestId(),
      ...getAuthHeader(),
    };

    const tenantId = getTenantId();
    if (tenantId) {
      headers['X-Tenant-Id'] = tenantId;
    }

    if (CSRF_PROTECTED_METHODS.has(method)) {
      const csrfToken = getCsrfTokenFromCookie();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }

    const response = await fetch(`${ADMIN_API_URL}${endpoint}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...headers,
        ...normalizeHeaders(options?.headers),
      },
    });

    if (response.status === 401 && !has401Retried) {
      has401Retried = true;
      const refreshed = await silentRefresh();
      if (refreshed) continue;
      clearSessionState();
      throw createApiError('Session expired', 401);
    }

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw createApiError(
        errorBody.message || `HTTP ${response.status}`,
        response.status,
        errorBody.code,
        errorBody.details,
      );
    }

    // TRANSPORT CONTRACT (APA-253): a 2xx whose body is the SPA fallback page
    // (text/html) means the /api edge is misrouted — the request never reached
    // admin-api. A binary download must never be an HTML document, so surface a
    // typed error instead of handing back a corrupt "file".
    const responseContentType = response.headers.get('content-type') ?? '';
    if (responseContentType.includes('text/html')) {
      throw createApiError(
        `Expected a file download but received "${responseContentType}" — the /api edge is misrouted (request did not reach admin-api)`,
        response.status,
        'NON_JSON_RESPONSE',
        { contentType: responseContentType },
      );
    }

    const disposition = response.headers.get('content-disposition') || '';
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);

    return {
      blob: await response.blob(),
      filename: filenameMatch?.[1],
      contentType: response.headers.get('content-type') || 'application/octet-stream',
    };
  }
}
