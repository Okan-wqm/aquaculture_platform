import type { AiPersonaIcon } from '@aquaculture/shared-contracts';
import { useI18n } from '@aquaculture/shared-ui';
import {
  BarChart,
  Bot,
  Cpu,
  Droplets,
  Fish,
  HeartPulse,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import React from 'react';

import { aiPersonaIdentity } from '../lib/aiPersona';

export type AvatarSize = 'sm' | 'md' | 'lg';

export const AVATAR_ICON_PX: Readonly<Record<AvatarSize, number>> = { sm: 14, md: 19, lg: 24 };

/** The catalogue's icon vocabulary as Lucide components — exhaustive over AiPersonaIcon. */
const PERSONA_ICONS: Readonly<Record<AiPersonaIcon, LucideIcon>> = {
  bot: Bot,
  droplets: Droplets,
  fish: Fish,
  'bar-chart': BarChart,
  cpu: Cpu,
  'heart-pulse': HeartPulse,
  wrench: Wrench,
};

/**
 * An AI agent's face: its catalogue icon on its catalogue hue, tagged "AI" so an agent is never
 * mistaken for a person. Decorative — every avatar stands beside a visible name, so it is hidden
 * from assistive technology and AiSpoken says "AI" once beside that name.
 * `tagged={false}` only where the surface already marks AI authorship (the violet AI bubble).
 */
export function PersonaAvatar({
  aiPersona,
  size = 'md',
  tagged = true,
}: {
  aiPersona: string | null | undefined;
  size?: AvatarSize;
  tagged?: boolean;
}): React.ReactElement {
  const { t } = useI18n();
  const identity = aiPersonaIdentity(aiPersona);
  const Icon = PERSONA_ICONS[identity.icon];
  return (
    <span
      className={`sd-avatar sd-avatar--${size} sd-hue-${identity.hue}`}
      aria-hidden="true"
      data-testid="persona-avatar"
    >
      <Icon size={AVATAR_ICON_PX[size]} />
      {tagged && <span className="sd-avatar-tag">{t('messaging.persona.aiBadge')}</span>}
    </span>
  );
}
