/**
 * Shared UI - Ortak Tip Tanımlamaları
 * Tüm microfrontend'ler tarafından kullanılan interface ve type'lar
 */

import type { ReactNode } from 'react';

// ============================================================================
// Kullanıcı ve Yetkilendirme Tipleri
// ============================================================================

/**
 * System user roles - hierarchical
 * SUPER_ADMIN > TENANT_ADMIN > MODULE_MANAGER > MODULE_USER
 */
export type UserRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'MODULE_MANAGER' | 'MODULE_USER';

/**
 * Module info for user access
 */
export interface UserModule {
  code: string;
  name: string;
  defaultRoute: string;
}

/**
 * User entity from backend
 */
export interface User {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  role: UserRole;
  tenantId?: string | null;
  isActive: boolean;
  isEmailVerified?: boolean;
  lastLoginAt?: Date | null;
  createdAt?: Date;
}

/**
 * Kimlik doğrulama durumu
 */
export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

/**
 * Kimlik doğrulama tokenları
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * API yanıt wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ============================================================================
// Tenant Tipleri
// ============================================================================

/**
 * Tenant abonelik katmanları
 */
export type TenantTier = 'free' | 'starter' | 'professional' | 'enterprise';

/**
 * Tenant plan bilgisi (TenantTier için alias)
 */
export type TenantPlan = TenantTier;

/**
 * Tenant durumları
 */
export type TenantStatus = 'pending' | 'active' | 'suspended' | 'archived';

/**
 * Tenant bilgileri
 */
export interface Tenant {
  id: string;
  name: string;
  slug: string;
  tier: TenantTier;
  status: TenantStatus;
  logoUrl?: string;
  settings: TenantSettings;
  limits: TenantLimits;
  createdAt: Date;
}

/**
 * Tenant ayarları
 */
export interface TenantSettings {
  timezone: string;
  locale: string;
  currency: string;
  dateFormat: string;
  measurementSystem: 'metric' | 'imperial';
  theme?: 'light' | 'dark' | 'system';
}

/**
 * Tenant limitleri
 */
export interface TenantLimits {
  maxUsers: number;
  maxFarms: number;
  maxPonds: number;
  maxSensors: number;
  maxAlertRules: number;
  dataRetentionDays: number;
  apiRateLimit: number;
}

// ============================================================================
// API ve GraphQL Tipleri
// ============================================================================

/**
 * Sayfalama parametreleri
 */
export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Sayfalı sonuç
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

/**
 * API hata yanıtı
 */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  statusCode: number;
  timestamp: string;
  path?: string;
}

/**
 * GraphQL sorgu durumu
 */
export interface QueryState<T> {
  data: T | null;
  isLoading: boolean;
  isError: boolean;
  error: ApiError | null;
  refetch: () => void;
}

// ============================================================================
// Çiftlik ve Havuz Tipleri
// ============================================================================

/**
 * Coğrafi konum
 */
export interface GeoLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
}

/**
 * Çiftlik bilgileri
 */
export interface Farm {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  location: GeoLocation;
  address?: string;
  status: 'active' | 'inactive' | 'maintenance';
  pondsCount: number;
  activeBatchesCount: number;
  totalSensors: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Havuz tipleri
 */
export type PondType = 'raceway' | 'circular' | 'rectangular' | 'natural';

/**
 * Havuz bilgileri
 */
export interface Pond {
  id: string;
  farmId: string;
  name: string;
  type: PondType;
  volumeLiters: number;
  surfaceAreaM2: number;
  depthM: number;
  status: 'active' | 'inactive' | 'cleaning' | 'maintenance';
  currentBatchId?: string;
  sensors: Sensor[];
  createdAt: Date;
}

// ============================================================================
// Sensör Tipleri
// ============================================================================

/**
 * Sensör tipleri
 */
export type SensorType =
  | 'temperature'
  | 'ph'
  | 'dissolved_oxygen'
  | 'turbidity'
  | 'ammonia'
  | 'nitrite'
  | 'nitrate'
  | 'salinity'
  | 'flow_rate'
  | 'water_level';

/**
 * Sensör durumları
 */
export type SensorStatus = 'online' | 'offline' | 'warning' | 'error' | 'maintenance';

/**
 * Sensör bilgileri
 */
export interface Sensor {
  id: string;
  pondId: string;
  name: string;
  type: SensorType;
  unit: string;
  status: SensorStatus;
  currentValue?: number;
  minThreshold?: number;
  maxThreshold?: number;
  lastReadingAt?: Date;
  batteryLevel?: number;
}

/**
 * Sensör okuması
 */
export interface SensorReading {
  id: string;
  sensorId: string;
  value: number;
  unit: string;
  quality: 'good' | 'suspect' | 'bad';
  timestamp: Date;
}

// ============================================================================
// Alarm Tipleri
// ============================================================================

/**
 * Alarm önem dereceleri
 */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Alarm durumları
 */
export type AlertStatus = 'active' | 'acknowledged' | 'resolved';

/**
 * Sistem alarm bilgileri
 * Not: Alert component'ı ile isim çakışmasını önlemek için SystemAlert kullanılıyor
 */
export interface SystemAlert {
  id: string;
  tenantId: string;
  farmId?: string;
  pondId?: string;
  sensorId?: string;
  ruleId: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  message: string;
  triggeredAt: Date;
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  resolvedAt?: Date;
  resolvedBy?: string;
}

// ============================================================================
// UI Component Tipleri
// ============================================================================

/**
 * Buton varyantları
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'warning' | 'ghost' | 'outline';

/**
 * MetricCard trend yönü
 */
export type TrendDirection = 'up' | 'down' | 'neutral';

/**
 * Boyut değerleri
 */
export type Size = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Tablo kolonu tanımı
 * Table component'ı tarafından kullanılır
 */
export interface TableColumn<T> {
  /** Kolon anahtarı - veri nesnesindeki alan veya özel tanımlayıcı */
  key: keyof T | string;
  /** Kolon başlığı - string veya React component olabilir */
  header?: string | ReactNode;
  /** Kolon başlığı metni (header ile aynı, geriye uyumluluk için) */
  label?: string;
  /** Sıralanabilir mi */
  sortable?: boolean;
  /** Kolon genişliği */
  width?: string | number;
  /** Hizalama */
  align?: 'left' | 'center' | 'right';
  /** Özel hücre render fonksiyonu */
  render?: (row: T, index?: number) => ReactNode;
}

/**
 * Form alanı durumu
 */
export interface FieldState {
  value: unknown;
  error?: string;
  touched: boolean;
  dirty: boolean;
}

/**
 * Temel Modal props - BaseModalProps
 * Not: Modal component'ı kendi ModalProps'unu export eder
 */
export interface BaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
}

// ============================================================================
// Navigasyon Tipleri
// ============================================================================

/**
 * Navigasyon menü öğesi - NavigationItem
 * Not: Sidebar component'ı kendi NavItem'ını export eder
 */
export interface NavigationItem {
  id: string;
  label: string;
  icon?: string;
  path?: string;
  children?: NavigationItem[];
  requiredRoles?: UserRole[];
  requiredPermissions?: string[];
  badge?: string | number;
  isExternal?: boolean;
}

/**
 * Breadcrumb öğesi
 */
export interface BreadcrumbItem {
  label: string;
  path?: string;
  icon?: string;
}

// ============================================================================
// Notification Tipleri
// ============================================================================

/**
 * Bildirim türleri
 */
export type NotificationType = 'success' | 'error' | 'warning' | 'info';

/**
 * Toast bildirimi
 */
export interface ToastNotification {
  id: string;
  type: NotificationType;
  title: string;
  message?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}
