# Messaging persona identity — 2026-10-30

Requested by Okan on 2026-10-30 for the tenant console pages `/messaging` and
`/messaging/new-ai`: every AI agent should read like a member of the team — a face, with what it
does written under it in the user's language — and the people added to rooms should appear beside
the agents.

## FE-MEDIUM-397

Defect. The messaging pages draw one generic icon for every AI room, call agents by the persona
catalogue's English names in the Turkish console, and never show people beside the agents.

Severity MEDIUM. Owner Okan-wqm, deadline 2026-11-13.

Where. `ChannelListPage` drew the same `Sparkles` icon for every AI room and generic icons for
people, although the persona catalogue (`libs/shared-contracts/src/ai/persona-catalogue.ts`)
carries an icon and a colour per persona. The new-AI-conversation picker was a text radio list
that joined the name, description and capabilities into one line. `aiPersonaDisplayName` returned
the catalogue's English name, and the catalogue's names, descriptions and capabilities are
English-only, so a Turkish user read English job titles. The chat room showed no faces, and its
header showed the room's stored English persona name.

Failure. A Turkish user opening `/messaging` sees several identical violet tiles named "Production
Specialist (Expert)" and "Aquaculture Expert (General)", cannot tell the agents apart at a glance,
and finds the people they work with only as separate rows, never next to the agents.

Fix. A persona identity layer in the messaging module resolves each persona's icon, hue, tier
and specialty from the catalogue and localises its job, tier, description and capabilities by
catalogue id, with a spec that pins every published persona and capability to both locales. One
square avatar family shows agents on their persona hue with an "AI" tag and people with their
photo or initials. `/messaging` gains a "My team" strip with the agents and the people side by
side; `/messaging/new-ai` shows the personas as cards through a new card variant of the
shared-ui `RadioGroup`; the room shows faces in its header and beside each message.

Not covered here: streaming AI answers (the reply still appears at once) is a separate change
across the AI provider interface, the agent runner, NATS and the gateway.
