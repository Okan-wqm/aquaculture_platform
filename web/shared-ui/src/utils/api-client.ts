/**
 * API Client
 * GraphQL ve REST API istekleri için merkezi istemci
 * Token yönetimi, retry mantığı ve hata işleme
 */

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

/**
 * API yapılandırması
 */
export interface ApiConfig {
  /** GraphQL endpoint URL */
  graphqlUrl: string;
  /** REST API base URL */
  restBaseUrl: string;
  /** Varsayılan timeout (ms) */
  timeout: number;
  /** Retry sayısı */
  maxRetries: number;
  /** Retry gecikmesi (ms) */
  retryDelay: number;
}

/**
 * GraphQL istek seçenekleri
 */
export interface GraphQLRequestOptions {
  /** Özel headers */
  headers?: Record<string, string>;
  /** Timeout override */
  timeout?: number;
  /** Signal for abort */
  signal?: AbortSignal;
}

/**
 * GraphQL hata tipi
 */
export interface GraphQLErrorResponse {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: string[];
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

// ============================================================================
// Varsayılan Yapılandırma
// ============================================================================

const defaultConfig: ApiConfig = {
  // Use relative URLs to go through nginx proxy (port 8080) which forwards to gateway-api (port 3000)
  graphqlUrl: import.meta.env.VITE_GRAPHQL_URL || '/graphql',
  restBaseUrl: import.meta.env.VITE_API_URL || '/api',
  timeout: 30000,
  maxRetries: 3,
  retryDelay: 1000,
};

// ============================================================================
// Token Yönetimi
// ============================================================================

/**
 * Token ve Tenant deposu - Memory'de tutulur
 */
let accessToken: string | null = null;
let refreshTokenValue: string | null = null;
let tenantId: string | null = null;
let tokenRefreshPromise: Promise<void> | null = null;

/**
 * Token'ları ayarla
 */
export function setTokens(access: string, refresh: string): void {
  accessToken = access;
  refreshTokenValue = refresh;

  // LocalStorage'a da kaydet (sayfa yenilemesi için)
  try {
    localStorage.setItem('access_token', access);
    localStorage.setItem('refresh_token', refresh);
  } catch (e) {
    console.warn('Token localStorage\'a kaydedilemedi:', e);
  }
}

/**
 * Token'ları temizle
 */
export function clearTokens(): void {
  accessToken = null;
  refreshTokenValue = null;
  tenantId = null;

  try {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('tenant_id');
  } catch (e) {
    // Ignore
  }
}

/**
 * Token'ları localStorage'dan yükle
 */
export function loadTokensFromStorage(): void {
  try {
    accessToken = localStorage.getItem('access_token');
    refreshTokenValue = localStorage.getItem('refresh_token');
    tenantId = localStorage.getItem('tenant_id');
  } catch (e) {
    // Ignore
  }
}

/**
 * Access token al
 */
export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Tenant ID'yi ayarla
 */
export function setTenantId(id: string | null): void {
  tenantId = id;
  try {
    if (id) {
      localStorage.setItem('tenant_id', id);
    } else {
      localStorage.removeItem('tenant_id');
    }
  } catch (e) {
    console.warn('Tenant ID localStorage\'a kaydedilemedi:', e);
  }
}

/**
 * Tenant ID al (memory'den veya localStorage'dan)
 */
export function getTenantId(): string | null {
  // Önce memory'den kontrol et
  if (tenantId) return tenantId;

  // Memory'de yoksa localStorage'dan oku ve cache'le
  try {
    const storedTenantId = localStorage.getItem('tenant_id');
    if (storedTenantId) {
      tenantId = storedTenantId;
      return storedTenantId;
    }
  } catch (e) {
    console.warn('localStorage tenant_id okunamadı:', e);
  }
  return null;
}

// ============================================================================
// GraphQL Client
// ============================================================================

/**
 * GraphQL istemcisi
 */
class GraphQLClient {
  private config: ApiConfig;

  constructor(config: Partial<ApiConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * GraphQL sorgusu/mutasyonu çalıştır
   */
  async request<TData = unknown, TVariables = Record<string, unknown>>(
    query: string,
    variables?: TVariables,
    options?: GraphQLRequestOptions
  ): Promise<TData> {
    const { headers: customHeaders, timeout, signal } = options || {};

    // Headers oluştur
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    // Access token ekle - Always read from localStorage for Module Federation compatibility
    // Module-level variables may not be shared correctly across microfrontend boundaries
    const currentToken = accessToken || localStorage.getItem('access_token');
    if (currentToken) {
      headers['Authorization'] = `Bearer ${currentToken}`;
    }

    // Tenant ID ekle - Always read from localStorage for Module Federation compatibility
    const currentTenantId = getTenantId() || localStorage.getItem('tenant_id');
    if (currentTenantId) {
      headers['X-Tenant-Id'] = currentTenantId;
    }

    // Request ID ekle (tracing için)
    headers['X-Request-Id'] = this.generateRequestId();

    // Timeout controller
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout || this.config.timeout
    );

    try {
      const response = await fetch(this.config.graphqlUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          query,
          variables,
        }),
        signal: signal || controller.signal,
      });

      clearTimeout(timeoutId);

      // 401 - Token yenileme gerekebilir
      if (response.status === 401) {
        await this.handleUnauthorized();
        // Retry with new token
        return this.request(query, variables, options);
      }

      // Response parse
      const result = await response.json();

      // GraphQL hataları kontrol et
      if (result.errors && result.errors.length > 0) {
        const error = result.errors[0] as GraphQLErrorResponse;
        throw new GraphQLClientError(
          error.message,
          error.extensions?.code || 'GRAPHQL_ERROR',
          result.errors
        );
      }

      return result.data as TData;
    } catch (error) {
      clearTimeout(timeoutId);

      // Abort hatası
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GraphQLClientError('İstek zaman aşımına uğradı', 'TIMEOUT');
      }

      // Network hatası
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new GraphQLClientError('Sunucuya bağlanılamadı', 'NETWORK_ERROR');
      }

      throw error;
    }
  }

  /**
   * Unauthorized durumu işle
   */
  private async handleUnauthorized(): Promise<void> {
    // Eğer zaten token yenileme yapılıyorsa bekle
    if (tokenRefreshPromise) {
      await tokenRefreshPromise;
      return;
    }

    if (!refreshTokenValue) {
      clearTokens();
      throw new GraphQLClientError('Oturum süresi doldu', 'UNAUTHENTICATED');
    }

    // Token yenileme
    tokenRefreshPromise = this.refreshAccessToken();

    try {
      await tokenRefreshPromise;
    } finally {
      tokenRefreshPromise = null;
    }
  }

  /**
   * Access token yenile
   */
  private async refreshAccessToken(): Promise<void> {
    try {
      const response = await fetch(`${this.config.restBaseUrl}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          refreshToken: refreshTokenValue,
        }),
      });

      if (!response.ok) {
        clearTokens();
        throw new GraphQLClientError('Token yenileme başarısız', 'REFRESH_FAILED');
      }

      const data = await response.json();
      setTokens(data.accessToken, data.refreshToken);
    } catch (error) {
      clearTokens();
      throw error;
    }
  }

  /**
   * Benzersiz request ID oluştur
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}

// ============================================================================
// GraphQL Error Class
// ============================================================================

export class GraphQLClientError extends Error {
  code: string;
  graphqlErrors?: GraphQLErrorResponse[];

  constructor(message: string, code: string, graphqlErrors?: GraphQLErrorResponse[]) {
    super(message);
    this.name = 'GraphQLClientError';
    this.code = code;
    this.graphqlErrors = graphqlErrors;
  }
}

// ============================================================================
// REST Client
// ============================================================================

/**
 * REST API istemcisi
 */
class RestClient {
  private config: ApiConfig;

  constructor(config: Partial<ApiConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * HTTP isteği gönder
   */
  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | boolean>;
      headers?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<T> {
    const { body, params, headers: customHeaders, timeout } = options || {};

    // URL oluştur
    let url = `${this.config.restBaseUrl}${path}`;
    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        searchParams.append(key, String(value));
      });
      url += `?${searchParams.toString()}`;
    }

    // Headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    // Tenant ID ekle (memory veya localStorage'dan)
    const currentTenantId = getTenantId();
    if (currentTenantId) {
      headers['X-Tenant-Id'] = currentTenantId;
    }

    // Timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      timeout || this.config.timeout
    );

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new RestClientError(
          errorData.message || `HTTP ${response.status}`,
          response.status,
          errorData
        );
      }

      // 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  // Kısayol metodlar
  get<T>(path: string, params?: Record<string, string | number | boolean>) {
    return this.request<T>('GET', path, { params });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>('POST', path, { body });
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, { body });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, { body });
  }

  delete<T>(path: string) {
    return this.request<T>('DELETE', path);
  }
}

// ============================================================================
// REST Error Class
// ============================================================================

export class RestClientError extends Error {
  statusCode: number;
  data?: unknown;

  constructor(message: string, statusCode: number, data?: unknown) {
    super(message);
    this.name = 'RestClientError';
    this.statusCode = statusCode;
    this.data = data;
  }
}

// ============================================================================
// Singleton İstemciler
// ============================================================================

export const graphqlClient = new GraphQLClient();
export const restClient = new RestClient();

export default graphqlClient;
