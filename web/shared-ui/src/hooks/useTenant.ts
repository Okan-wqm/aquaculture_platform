/**
 * useTenant Hook
 * Tenant (kiracı) bilgileri ve işlemleri için React hook
 * Multi-tenant yapıda tenant izolasyonu sağlar
 */

import { useCallback, useMemo } from 'react';
import { useTenantContext } from '../contexts/TenantContext';
import type { Tenant, TenantSettings, TenantLimits, TenantTier } from '../types';

// ============================================================================
// Hook Return Type
// ============================================================================

export interface UseTenantReturn {
  /** Aktif tenant */
  tenant: Tenant | null;
  /** Tenant ID */
  tenantId: string | null;
  /** Yükleniyor durumu */
  isLoading: boolean;
  /** Tenant ayarları */
  settings: TenantSettings | null;
  /** Tenant limitleri */
  limits: TenantLimits | null;
  /** Tenant tier'ı */
  tier: TenantTier | null;
  /** Tenant değiştir (platform admin için) */
  switchTenant: (tenantId: string) => Promise<void>;
  /** Limit kontrolü */
  checkLimit: (resource: keyof TenantLimits, currentUsage: number) => LimitCheckResult;
  /** Özellik erişimi kontrolü */
  hasFeature: (featureName: string) => boolean;
  /** Tier kontrolü */
  isTierAtLeast: (minimumTier: TenantTier) => boolean;
}

/**
 * Limit kontrol sonucu
 */
export interface LimitCheckResult {
  /** Limit aşıldı mı */
  exceeded: boolean;
  /** Mevcut kullanım */
  current: number;
  /** Maksimum limit (-1 = sınırsız) */
  limit: number;
  /** Kalan kullanım */
  remaining: number;
  /** Kullanım yüzdesi */
  usagePercent: number;
  /** Uyarı eşiği aşıldı mı (80%) */
  warning: boolean;
}

// ============================================================================
// Tier Sıralaması
// ============================================================================

const tierOrder: Record<TenantTier, number> = {
  free: 0,
  starter: 1,
  professional: 2,
  enterprise: 3,
};

// ============================================================================
// Tier Bazlı Özellikler
// ============================================================================

const tierFeatures: Record<TenantTier, string[]> = {
  free: [
    'basic_dashboard',
    'manual_data_entry',
    'email_alerts',
  ],
  starter: [
    'basic_dashboard',
    'manual_data_entry',
    'email_alerts',
    'sensor_integration',
    'basic_reports',
    'api_access',
  ],
  professional: [
    'basic_dashboard',
    'manual_data_entry',
    'email_alerts',
    'sensor_integration',
    'basic_reports',
    'api_access',
    'advanced_analytics',
    'custom_alerts',
    'batch_management',
    'export_data',
    'sms_notifications',
  ],
  enterprise: [
    'basic_dashboard',
    'manual_data_entry',
    'email_alerts',
    'sensor_integration',
    'basic_reports',
    'api_access',
    'advanced_analytics',
    'custom_alerts',
    'batch_management',
    'export_data',
    'sms_notifications',
    'white_label',
    'sso',
    'audit_logs',
    'dedicated_support',
    'custom_integrations',
  ],
};

// ============================================================================
// useTenant Hook
// ============================================================================

/**
 * Tenant hook'u
 *
 * @example
 * const { tenant, tier, hasFeature } = useTenant();
 *
 * if (hasFeature('advanced_analytics')) {
 *   // Gelişmiş analitik göster
 * }
 */
export function useTenant(): UseTenantReturn {
  const context = useTenantContext();

  const {
    tenant,
    isLoading,
    switchTenant,
  } = context;

  // Limit kontrolü
  const checkLimit = useCallback(
    (resource: keyof TenantLimits, currentUsage: number): LimitCheckResult => {
      const limit = tenant?.limits[resource] ?? -1;

      // -1 = sınırsız
      if (limit === -1) {
        return {
          exceeded: false,
          current: currentUsage,
          limit: -1,
          remaining: -1,
          usagePercent: 0,
          warning: false,
        };
      }

      const remaining = Math.max(0, limit - currentUsage);
      const usagePercent = limit > 0 ? (currentUsage / limit) * 100 : 0;

      return {
        exceeded: currentUsage >= limit,
        current: currentUsage,
        limit,
        remaining,
        usagePercent,
        warning: usagePercent >= 80,
      };
    },
    [tenant]
  );

  // Özellik kontrolü
  const hasFeature = useCallback(
    (featureName: string): boolean => {
      if (!tenant) return false;
      const features = tierFeatures[tenant.tier] ?? [];
      return features.includes(featureName);
    },
    [tenant]
  );

  // Tier kontrolü
  const isTierAtLeast = useCallback(
    (minimumTier: TenantTier): boolean => {
      if (!tenant) return false;
      return tierOrder[tenant.tier] >= tierOrder[minimumTier];
    },
    [tenant]
  );

  return {
    tenant,
    tenantId: tenant?.id ?? null,
    isLoading,
    settings: tenant?.settings ?? null,
    limits: tenant?.limits ?? null,
    tier: tenant?.tier ?? null,
    switchTenant,
    checkLimit,
    hasFeature,
    isTierAtLeast,
  };
}

export default useTenant;
