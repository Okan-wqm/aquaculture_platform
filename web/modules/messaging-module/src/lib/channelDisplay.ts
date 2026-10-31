import type { Channel } from '../types/messaging';

import { localizeAiPersona, type Translate } from './aiPersona';

export interface ChannelHeading {
  readonly title: string;
  /** The agent's authority tier chip ("Expert"); null for people and the tenant default. */
  readonly tierLabel: string | null;
}

/**
 * What a room is called in the list and its header. An AI room is called by its agent's job in
 * the caller's language — its stored `name` is the English persona name written at creation, so
 * it would read English in the Turkish console — and falls back to that stored name only for a
 * persona the panel cannot resolve; every other room keeps channelTitle.
 */
export function channelHeading(
  channel: Channel,
  myId: string | null | undefined,
  t: Translate,
): ChannelHeading {
  if (channel.type === 'AI') {
    const persona = localizeAiPersona(channel.aiPersona, t, channel.name);
    return { title: persona.role, tierLabel: persona.tierLabel };
  }
  return { title: channelTitle(channel, myId), tierLabel: null };
}

/**
 * A channel's display title. Group/AI channels carry an explicit `name`; direct
 * channels have none, so we derive it from the OTHER members' names — `myId`
 * filters the caller's own membership out so a DM header never contains the
 * current user's own name (FAZ 1). Pure — the single most reused piece of
 * channel rendering, extracted so it is unit-tested independently of React.
 */
export function channelTitle(channel: Channel, myId?: string | null): string {
  if (channel.name) return channel.name;
  const others = (channel.members ?? [])
    .filter((m) => m.userId !== myId)
    .map((m) => m.user)
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Member');
  return others.join(', ') || 'Direct message';
}
