import { Switch, useI18n } from '@aquaculture/shared-ui';
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
      <div className="flex items-center gap-2 text-[13px] text-sd-ink-muted">
        <RefreshCw size={14} className="animate-spin" /> {t('messaging.ai.loadingSettings')}
      </div>
    );
  }
  if (isError || !settings) {
    return (
      <div className="sd-banner sd-banner--error" role="alert">
        <AlertCircle size={17} className="text-sd-danger" />
        <span className="text-[13.5px] font-semibold text-sd-danger-ink">
          {t('messaging.ai.errorSettings')}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {!settings.tenantAiEnabled && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={17} className="text-sd-danger" />
          <span className="text-[13.5px] font-semibold text-sd-danger-ink">
            {t('messaging.ai.tenantDisabled')}
          </span>
        </div>
      )}
      <Switch
        size="sm"
        label={t('messaging.ai.consentLabel')}
        description={t('messaging.ai.consentHint')}
        checked={settings.userAiConsent}
        disabled={isPending}
        onChange={(e) => updateConsent(e.target.checked)}
      />
    </div>
  );
};

export default AiConsentSwitch;
