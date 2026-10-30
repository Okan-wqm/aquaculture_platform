import { useI18n } from '@aquaculture/shared-ui';
import React from 'react';

import { localizeAiPersona } from '../lib/aiPersona';
import type { Team } from '../lib/team';

import { MemberAvatar, memberName } from './MemberAvatar';
import { PersonaAvatar } from './PersonaAvatar';
import { AiSpoken, TierPrefix } from './PersonaText';

/** One face on the strip: the (decorative) avatar, the name or job under it, a second line. */
function TeamItem({
  avatar,
  name,
  sub,
  channelId,
  onOpen,
}: {
  avatar: React.ReactNode;
  name: React.ReactNode;
  sub: React.ReactNode;
  channelId: string | null;
  onOpen: (channelId: string) => void;
}): React.ReactElement {
  const body = (
    <>
      {avatar}
      <span className="sd-team-name">{name}</span>
      {sub && <span className="sd-team-sub">{sub}</span>}
    </>
  );
  return (
    <li>
      {channelId ? (
        <button type="button" className="sd-team-item" onClick={() => onOpen(channelId)}>
          {body}
        </button>
      ) : (
        <div className="sd-team-item">{body}</div>
      )}
    </li>
  );
}

/**
 * "My team": the caller's AI agents first (each with its job and tier under it), then the
 * people they share rooms with. A face opens its room — an agent its latest AI room, a person
 * their direct room; a person reachable only through a group is shown but not a button.
 */
export function TeamStrip({
  team,
  onOpen,
}: {
  team: Team;
  onOpen: (channelId: string) => void;
}): React.ReactElement | null {
  const { t } = useI18n();
  if (team.agents.length === 0 && team.members.length === 0) return null;
  const title = t('messaging.team.title');

  return (
    <section className="sd-card sd-card--flush mb-3" aria-label={title}>
      <div className="border-b border-sd-rule px-4 py-3">
        <span className="text-[11.5px] font-bold uppercase tracking-[0.09em] text-sd-teal-deep">
          {title}
        </span>
      </div>
      <ul className="sd-team">
        {team.agents.map((agent) => {
          const persona = localizeAiPersona(agent.aiPersona, t, agent.name);
          return (
            <TeamItem
              key={`agent:${agent.aiPersona ?? ''}`}
              avatar={<PersonaAvatar aiPersona={agent.aiPersona} size="lg" />}
              name={
                <>
                  {persona.role}
                  <AiSpoken />
                </>
              }
              sub={
                persona.tierLabel && (
                  <>
                    <TierPrefix />
                    {persona.tierLabel}
                  </>
                )
              }
              channelId={agent.channelId}
              onOpen={onOpen}
            />
          );
        })}
        {team.members.map((member) => (
          <TeamItem
            key={`member:${member.userId}`}
            avatar={<MemberAvatar user={member.user} size="lg" />}
            name={memberName(member.user, t('messaging.memberFallback'))}
            sub={null}
            channelId={member.directChannelId}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}
