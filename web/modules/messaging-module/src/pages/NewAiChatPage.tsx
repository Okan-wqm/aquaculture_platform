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
    <div className="sd-page" style={{ maxWidth: 560 }}>
      <div className="sd-pagehead">
        <button
          onClick={() => navigate('/messaging')}
          className="sd-back"
          aria-label={t('messaging.backToChannels')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
        >
          <ArrowLeft size={16} /> {t('messaging.backToChannels')}
        </button>
        <span className="sd-eyebrow">{t('messaging.title')}</span>
        <h1 className="sd-page-title">{t('messaging.ai.newTitle')}</h1>
        <span className="sd-page-sub">{t('messaging.ai.newSubtitle')}</span>
      </div>

      {!canUseAi && (
        <div className="sd-banner sd-banner--error" role="alert">
          <AlertCircle size={17} style={{ color: '#b04a28' }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
            {t('messaging.ai.noAccess')}
          </span>
        </div>
      )}

      {canUseAi && (
        <>
          <div className="sd-card" style={{ padding: 16, marginBottom: 12 }}>
            <AiConsentSwitch />
          </div>

          {isLoading && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: '#5c7783',
                fontSize: 13.5,
              }}
            >
              <RefreshCw size={15} className="animate-spin" /> {t('messaging.ai.loadingPersonas')}
            </div>
          )}
          {isError && (
            <div className="sd-banner sd-banner--error" role="alert">
              <AlertCircle size={17} style={{ color: '#b04a28' }} />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
                {t('messaging.ai.errorPersonas')}
              </span>
            </div>
          )}

          {(personas?.length ?? 0) > 0 && (
            <fieldset
              className="sd-card sd-card--flush"
              style={{ border: 0, padding: 0, margin: 0 }}
            >
              <legend
                style={{
                  padding: '12px 16px',
                  fontSize: 11.5,
                  fontWeight: 700,
                  letterSpacing: '0.09em',
                  textTransform: 'uppercase',
                  color: '#0b4f60',
                }}
              >
                {t('messaging.ai.personasLabel')}
              </legend>
              {personas?.map((persona) => {
                const value = personaValue(persona);
                const active = value === selected;
                return (
                  <label
                    key={value}
                    className={`sd-chan-row${active ? ' sd-chan-row--active' : ''}`}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="radio"
                      name="ai-persona"
                      value={value}
                      checked={active}
                      onChange={() => setSelected(value)}
                      aria-label={persona.name}
                      style={{ marginTop: 4 }}
                    />
                    <span className="sd-chan-icon sd-chan-icon--ai">
                      <Sparkles size={19} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="sd-chan-title">{persona.name}</span>
                      <span className="sd-chan-preview" style={{ display: 'block', marginTop: 2 }}>
                        {persona.description}
                      </span>
                      <span
                        style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#5c7783' }}
                      >
                        {persona.capabilities.join(' · ')}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          )}

          {createChannel.isError && (
            <div className="sd-banner sd-banner--error" role="alert" style={{ marginTop: 12 }}>
              <AlertCircle size={17} style={{ color: '#b04a28' }} />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: '#8e3a1e' }}>
                {t('messaging.ai.errorCreate')}
              </span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              onClick={handleCreate}
              disabled={!canCreate}
              className="sd-send"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px' }}
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
