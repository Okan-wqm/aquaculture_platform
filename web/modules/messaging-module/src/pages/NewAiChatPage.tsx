import { Button, RadioGroup, useAuth, useI18n } from '@aquaculture/shared-ui';
import { ArrowLeft, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import AiConsentSwitch from '../components/AiConsentSwitch';
import { useAiSettings, useAvailableAiPersonas, useCreateAiChannel } from '../hooks/useAiChannels';
import type { AiPersona } from '../types/messaging';

/** Radio value for the tenant-default entry (`id: null`). */
const DEFAULT_PERSONA_VALUE = '';

const personaValue = (persona: AiPersona): string => persona.id ?? DEFAULT_PERSONA_VALUE;

/**
 * New AI conversation (FE-MEDIUM-065): pick a persona, give consent, create
 * the room. The persona list is what the server says this user may drive
 * (tenant-RBAC filtered in AiResolver.availableAiPersonas — the panel does
 * not re-derive tiers from ids), and creation is gated on the same dual
 * consent the bridge enforces, so a fresh room never opens into a wall of
 * "AI unavailable" notices.
 */
const NewAiChatPage: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canUseAi = hasPermission('ai_assistant:use');

  const { data: personas, isLoading, isError } = useAvailableAiPersonas(canUseAi);
  const { data: settings } = useAiSettings(canUseAi);
  const createChannel = useCreateAiChannel();
  const [selected, setSelected] = useState<string>(DEFAULT_PERSONA_VALUE);

  const consented = settings?.tenantAiEnabled === true && settings.userAiConsent === true;
  const chosen = personas?.find((p) => personaValue(p) === selected);
  const canCreate = canUseAi && consented && !!chosen && !createChannel.isPending;

  const handleCreate = (): void => {
    if (!chosen || !canCreate) return;
    createChannel.mutate(
      { aiPersona: chosen.id, name: chosen.name },
      { onSuccess: (channel) => navigate(`/messaging/${channel.id}`, { replace: true }) },
    );
  };

  return (
    <div className="sd-page max-w-[560px]">
      <div className="sd-pagehead">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/messaging')}
          className="sd-back mb-2"
          leftIcon={<ArrowLeft size={16} />}
          aria-label={t('messaging.backToChannels')}
        >
          {t('messaging.backToChannels')}
        </Button>
        <span className="sd-eyebrow">{t('messaging.title')}</span>
        <h1 className="sd-page-title">{t('messaging.ai.newTitle')}</h1>
        <span className="sd-page-sub">{t('messaging.ai.newSubtitle')}</span>
      </div>

      {!canUseAi && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={17} className="text-sd-danger" />
          <span className="text-[13.5px] font-semibold text-sd-danger-ink">
            {t('messaging.ai.noAccess')}
          </span>
        </div>
      )}

      {canUseAi && (
        <>
          <div className="sd-card mb-3 p-4">
            <AiConsentSwitch />
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-[13.5px] text-sd-ink-muted">
              <RefreshCw size={15} className="animate-spin" /> {t('messaging.ai.loadingPersonas')}
            </div>
          )}
          {isError && (
            <div className="sd-banner sd-banner--error" role="alert">
              <AlertCircle size={17} className="text-sd-danger" />
              <span className="text-[13.5px] font-semibold text-sd-danger-ink">
                {t('messaging.ai.errorPersonas')}
              </span>
            </div>
          )}

          {(personas?.length ?? 0) > 0 && (
            <div className="sd-card sd-card--flush p-4">
              <RadioGroup
                name="ai-persona"
                label={t('messaging.ai.personasLabel')}
                vertical
                value={selected}
                onChange={setSelected}
                options={(personas ?? []).map((persona) => ({
                  value: personaValue(persona),
                  label: persona.name,
                  description: [persona.description, persona.capabilities.join(' · ')]
                    .filter((part) => part.length > 0)
                    .join(' — '),
                }))}
              />
            </div>
          )}

          {createChannel.isError && (
            <div className="sd-banner sd-banner--error mt-3" role="alert">
              <AlertCircle size={17} className="text-sd-danger" />
              <span className="text-[13.5px] font-semibold text-sd-danger-ink">
                {t('messaging.ai.errorCreate')}
              </span>
            </div>
          )}

          <div className="mt-4 flex justify-end">
            <Button
              onClick={handleCreate}
              disabled={!canCreate}
              isLoading={createChannel.isPending}
              leftIcon={<Sparkles size={15} />}
              className="sd-send"
            >
              {t('messaging.ai.createButton')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
};

export default NewAiChatPage;
