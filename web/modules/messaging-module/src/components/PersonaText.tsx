import { useI18n } from '@aquaculture/shared-ui';
import React from 'react';

/**
 * The words that carry an agent's identity to a screen reader. Avatars are decorative (every
 * one stands beside a visible name), so "AI" is spoken once beside the name instead, and the
 * tier chip is introduced ("tier Expert") so a job like "Aquaculture Expert" does not stutter.
 */

/** Visually hidden " (AI)" after an agent's name — the spoken form of the avatar's AI tag. */
export function AiSpoken(): React.ReactElement {
  const { t } = useI18n();
  return <span className="sr-only"> ({t('messaging.persona.aiSpoken')})</span>;
}

/**
 * The visually hidden word before a tier. Spaced on both sides so the spoken name separates it
 * from the job before it whatever the surrounding elements' display is.
 */
export function TierPrefix(): React.ReactElement {
  const { t } = useI18n();
  return <span className="sr-only">{` ${t('messaging.persona.tierPrefix')} `}</span>;
}

/** The tier as a square chip, introduced to a screen reader by the word "tier". */
export function TierChip({ tierLabel }: { tierLabel: string }): React.ReactElement {
  return (
    <span className="sd-chip shrink-0">
      <TierPrefix />
      {tierLabel}
    </span>
  );
}
