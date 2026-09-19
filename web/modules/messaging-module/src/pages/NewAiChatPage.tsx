import { useAuth, useI18n } from '@aquaculture/shared-ui';
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
        <button
          onClick={() => navigate('/messaging')}
          className="sd-back mb-2 inline-flex items-center gap-1.5"
          aria-label={t('messaging.backToChannels')}
        >
          <ArrowLeft size={16} /> {t('messaging.backToChannels')}
        </button>
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
            <fieldset className="sd-card sd-card--flush m-0 border-0 p-0">
              <legend className="px-4 py-3 text-[11.5px] font-bold uppercase tracking-[0.09em] text-sd-teal-deep">
                {t('messaging.ai.personasLabel')}
              </legend>
              {personas?.map((persona) => {
                const value = personaValue(persona);
                const active = value === selected;
                return (
                  <label
                    key={value}
                    className={`sd-chan-row flex cursor-pointer items-start gap-3${active ? ' sd-chan-row--active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="ai-persona"
                      value={value}
                      checked={active}
                      onChange={() => setSelected(value)}
                      aria-label={persona.name}
                      className="mt-1"
                    />
                    <span className="sd-chan-icon sd-chan-icon--ai">
                      <Sparkles size={19} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="sd-chan-title">{persona.name}</span>
                      <span className="sd-chan-preview mt-0.5 block">{persona.description}</span>
                      <span className="mt-1 block text-xs text-sd-ink-muted">
                        {persona.capabilities.join(' · ')}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
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
            <button
              onClick={handleCreate}
              disabled={!canCreate}
              className="sd-send inline-flex items-center gap-2 px-3.5 py-2"
            >
              {createChannel.isPending ? (
                <RefreshCw size={15} className="animate-spin" />
              ) : (
                <Sparkles size={15} />
              )}
              {t('messaging.ai.createButton')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default NewAiChatPage;
