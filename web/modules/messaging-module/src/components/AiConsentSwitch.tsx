import { useI18n } from '@aquaculture/shared-ui';
import { AlertCircle, RefreshCw } from 'lucide-react';
import React from 'react';

import { useAiSettings, useUpdateAiConsent } from '../hooks/useAiChannels';

interface AiConsentSwitchProps {
  /** Mount the queries only where an AI room is involved. */
  enabled?: boolean;
}

/**
 * The per-user AI opt-in (FE-MEDIUM-065). The messaging bridge refuses every
 * message in an AI channel until the member has consented, so the switch is
 * shown where an AI room is created or opened. The tenant master switch is
 * read-only here (owned by the tenant admin in ai-service settings).
 */
const AiConsentSwitch: React.FC<AiConsentSwitchProps> = ({ enabled = true }) => {
  const { t } = useI18n();
  const { data: settings, isLoading, isError } = useAiSettings(enabled);
  const { mutate: updateConsent, isPending } = useUpdateAiConsent();

  if (!enabled) return null;

  if (isLoading) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#5c7783', fontSize: 13 }}
      >
        <RefreshCw size={14} className="animate-spin" /> {t('messaging.ai.loadingSettings')}
      </div>
    );
  }
  if (isError || !settings) {
    return (
      <div className="sd-banner sd-banner--error" role="alert">
        <AlertCircle size={17} style={{ color: '#b04a28' }} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
          {t('messaging.ai.errorSettings')}
        </span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {!settings.tenantAiEnabled && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={17} style={{ color: '#b04a28' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
            {t('messaging.ai.tenantDisabled')}
          </span>
        </div>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          role="switch"
          aria-checked={settings.userAiConsent}
          checked={settings.userAiConsent}
          disabled={isPending}
          onChange={(e) => updateConsent(e.target.checked)}
        />
        <span style={{ fontSize: 13.5, color: '#0a1f2b' }}>{t('messaging.ai.consentLabel')}</span>
      </label>
      <span style={{ fontSize: 12, color: '#5c7783' }}>{t('messaging.ai.consentHint')}</span>
    </div>
  );
};

export default AiConsentSwitch;
