import {
  Button,
  PageTitle,
  RadioGroup,
  useAuth,
  useI18n,
  type MessageKey,
  type RadioOption,
} from '@aquaculture/shared-ui';
import { ArrowLeft, Sparkles, RefreshCw, AlertCircle } from 'lucide-react';
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import AiConsentSwitch from '../components/AiConsentSwitch';
import { PersonaAvatar } from '../components/PersonaAvatar';
import { TierChip } from '../components/PersonaText';
import { useAiSettings, useAvailableAiPersonas, useCreateAiChannel } from '../hooks/useAiChannels';
import { aiPersonaIdentity, localizeAiPersona, type LocalizedAiPersona } from '../lib/aiPersona';
import type { AiPersona } from '../types/messaging';

/** Radio value for the tenant-default entry (`id: null`). */
const DEFAULT_PERSONA_VALUE = '';

const personaValue = (persona: AiPersona): string => persona.id ?? DEFAULT_PERSONA_VALUE;

/** Capability chips per card — the leading ones; the description carries the rest. */
const CARD_CAPABILITY_LIMIT = 3;

/** Picker sections, in display order: the general assistants, then the topic specialists. */
const PERSONA_GROUPS: ReadonlyArray<{ id: 'general' | 'specialists'; labelKey: MessageKey }> = [
  { id: 'general', labelKey: 'messaging.persona.group.general' },
  { id: 'specialists', labelKey: 'messaging.persona.group.specialists' },
];

const personaGroup = (persona: AiPersona): 'general' | 'specialists' =>
  aiPersonaIdentity(persona.id).specialist ? 'specialists' : 'general';

/**
 * The card's words. A persona the panel's catalogue does not know yet (server deployed ahead of
 * the panel) is shown with the server's own English wording rather than its raw id.
 */
function personaWords(persona: AiPersona, t: (key: MessageKey) => string): LocalizedAiPersona {
  if (persona.id !== null && !aiPersonaIdentity(persona.id).known) {
    return {
      role: persona.name,
      tierLabel: null,
      description: persona.description,
      capabilities: persona.capabilities,
    };
  }
  return localizeAiPersona(persona.id, t);
}

/**
 * One persona as a card option: the agent's face, its job and tier, one line on what it does and
 * its leading capabilities. shared-ui's card RadioGroup carries the choice on a native radio, named
 * by the job + tier and described by the description.
 */
function personaOption(persona: AiPersona, t: (key: MessageKey) => string): RadioOption {
  const words = personaWords(persona, t);
  const tierChip = words.tierLabel ? <TierChip tierLabel={words.tierLabel} /> : undefined;
  const face = <PersonaAvatar aiPersona={persona.id} size="lg" />;
  const capabilityChips = words.capabilities.length ? (
    <span className="flex flex-wrap gap-1.5">
      {words.capabilities.slice(0, CARD_CAPABILITY_LIMIT).map((capability) => (
        <span key={capability} className="sd-chip">
          {capability}
        </span>
      ))}
    </span>
  ) : undefined;
  return {
    value: personaValue(persona),
    label: words.role,
    labelSuffix: tierChip,
    description: words.description,
    media: face,
    details: capabilityChips,
  };
}

/**
 * New AI conversation (FE-MEDIUM-065): pick a persona, give consent, create
 * the room. The persona list is what the server says this user may drive
 * (tenant-RBAC filtered in AiResolver.availableAiPersonas — the panel does
 * not re-derive tiers from ids), and creation is gated on the same dual
 * consent the bridge enforces, so a fresh room never opens into a wall of
 * "AI unavailable" notices.
 *
 * Each persona is a card with the agent's face and its job in the UI language
 * (the same identity the channel list, "My team" and the room header show),
 * grouped into general assistants and topic specialists.
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
    <div className="sd-page sd-stack max-w-[560px]">
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
        <PageTitle className="sd-page-title">{t('messaging.ai.newTitle')}</PageTitle>
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

          {/* One radio name across both groups: the platform keeps a single choice and the
              arrow keys move through every card. */}
          {(personas?.length ?? 0) > 0 && (
            <section
              className="sd-card flex flex-col gap-5 p-4"
              aria-label={t('messaging.ai.personasLabel')}
            >
              {PERSONA_GROUPS.map((group) => {
                const members = (personas ?? []).filter((p) => personaGroup(p) === group.id);
                if (members.length === 0) return null;
                return (
                  <RadioGroup
                    key={group.id}
                    variant="card"
                    name="ai-persona"
                    label={t(group.labelKey)}
                    value={selected}
                    onChange={setSelected}
                    options={members.map((persona) => personaOption(persona, t))}
                  />
                );
              })}
            </section>
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
