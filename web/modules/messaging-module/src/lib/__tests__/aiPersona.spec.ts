/**
 * Persona identity + localisation. The catalogue (`@aquaculture/shared-contracts`) owns WHICH
 * personas exist and their icon/hue; its names, descriptions and capabilities are English-only,
 * so the panel localises them by catalogue id. The coverage block below is the build-time
 * detector: a persona (or capability) added to the catalogue without both locale entries fails
 * here instead of shipping an English string into the Turkish UI.
 */
import {
  AI_GENERAL_ASSISTANT_PICKER_ENTRY,
  AI_PERSONA_CATALOGUE,
  AI_PERSONA_COLORS,
  AI_PERSONA_ICONS,
} from '@aquaculture/shared-contracts';
import { en } from '@aquaculture/shared-ui/i18n/locales/en';
import { tr } from '@aquaculture/shared-ui/i18n/locales/tr';
import { describe, expect, it } from 'vitest';

import { aiPersonaIdentity, localizeAiPersona, type Translate } from '../aiPersona';
import { PERSONA_CAPABILITY_KEYS } from '../personaCapabilities';

const tEn: Translate = (key) => en[key];
const tTr: Translate = (key) => tr[key];

/** Every capability string a picker can show: the personas' and the tenant-default entry's. */
const PUBLISHED_CAPABILITIES: ReadonlySet<string> = new Set([
  ...AI_PERSONA_CATALOGUE.flatMap((entry) => [...entry.capabilities]),
  ...AI_GENERAL_ASSISTANT_PICKER_ENTRY.capabilities,
]);

describe('aiPersonaIdentity', () => {
  it('reads icon and hue from the shared catalogue', () => {
    expect(aiPersonaIdentity('expert-farm-production-v1')).toMatchObject({
      icon: 'fish',
      hue: 'blue',
      tier: 'expert',
      specialty: 'farm-production',
      known: true,
    });
    expect(aiPersonaIdentity('supervisor-v1')).toMatchObject({
      icon: 'cpu',
      hue: 'orange',
      tier: 'supervisor',
      specialty: 'general',
    });
  });

  it('gives a missing persona (tenant default) the general assistant identity, with no tier', () => {
    for (const missing of [null, undefined, '']) {
      expect(aiPersonaIdentity(missing)).toMatchObject({
        icon: 'bot',
        hue: 'purple',
        tier: null,
        specialty: 'general',
        known: true,
      });
    }
  });

  it('keeps an unknown persona visible with the general look, flagged unknown', () => {
    expect(aiPersonaIdentity('future-persona-9')).toMatchObject({
      icon: 'bot',
      hue: 'purple',
      tier: null,
      specialist: false,
      known: false,
    });
  });

  it('resolves another version of a published role to that role (catalogue version bump)', () => {
    expect(aiPersonaIdentity('expert-farm-production-v2')).toMatchObject({
      icon: 'fish',
      hue: 'blue',
      tier: 'expert',
      specialty: 'farm-production',
      specialist: true,
      known: true,
    });
  });

  it('counts an unknown specialty as a specialist, not a general assistant', () => {
    expect(aiPersonaIdentity('expert-hr-payroll-v1')).toMatchObject({
      specialist: true,
      known: false,
    });
    expect(aiPersonaIdentity('operator-v1').specialist).toBe(false);
  });
});

describe('localizeAiPersona', () => {
  it('writes the job in English', () => {
    expect(localizeAiPersona('expert-farm-production-v1', tEn)).toMatchObject({
      role: 'Production Specialist',
      tierLabel: 'Expert',
      description:
        'Growth, FCR/SGR, feeding plans, harvest planning, biomass reports, production cost',
    });
    expect(localizeAiPersona('operator-v1', tEn)).toMatchObject({
      role: 'Operations Assistant',
      tierLabel: 'Operator',
    });
  });

  it('writes the job in Turkish', () => {
    expect(localizeAiPersona('expert-farm-production-v1', tTr)).toMatchObject({
      role: 'Üretim Uzmanı',
      tierLabel: 'Uzman',
    });
    expect(localizeAiPersona('expert-farm-water-health-v1', tTr).role).toBe(
      'Su ve Balık Sağlığı Uzmanı',
    );
  });

  it('localises capabilities and keeps their catalogue order', () => {
    expect(localizeAiPersona('expert-farm-production-v1', tTr).capabilities).toEqual([
      'Parti performansı ve büyüme',
      'Yemleme planları ve tüketim',
      'Hasat planları ve uygunluk',
      'Biyokütle ve mevzuat raporları',
      'Finans özetleri',
    ]);
  });

  it('labels the tenant default with the generic assistant name and no tier', () => {
    expect(localizeAiPersona(null, tEn)).toMatchObject({
      role: 'AI Assistant',
      tierLabel: null,
      description: 'Ask anything about your aquaculture operations',
    });
    expect(localizeAiPersona(null, tTr).role).toBe('Yapay Zekâ Asistanı');
  });

  it('names an unknown persona by the fallback name, else its raw id (never hides it)', () => {
    expect(localizeAiPersona('future-persona-9', tEn, 'Future Bot')).toMatchObject({
      role: 'Future Bot',
      tierLabel: null,
      description: '',
      capabilities: [],
    });
    expect(localizeAiPersona('future-persona-9', tEn).role).toBe('future-persona-9');
    expect(localizeAiPersona('future-persona-9', tEn, null).role).toBe('future-persona-9');
  });

  it('translates a version-bumped persona like its published role', () => {
    expect(
      localizeAiPersona('expert-farm-production-v2', tTr, 'Production Specialist (Expert)'),
    ).toMatchObject({ role: 'Üretim Uzmanı', tierLabel: 'Uzman' });
  });
});

describe('catalogue coverage (every published persona reads in both locales)', () => {
  it.each(AI_PERSONA_CATALOGUE.map((entry) => [entry.id] as const))(
    '%s has a translated role, tier and description',
    (id) => {
      const english = localizeAiPersona(id, tEn);
      const turkish = localizeAiPersona(id, tTr);
      for (const text of [english.role, english.tierLabel, english.description]) {
        expect(text).toBeTruthy();
      }
      for (const text of [turkish.role, turkish.tierLabel, turkish.description]) {
        expect(text).toBeTruthy();
      }
      // A key copied from en into tr unchanged is an untranslated string.
      expect(turkish.role).not.toBe(english.role);
      expect(turkish.description).not.toBe(english.description);
    },
  );

  // The English locale copies the catalogue's wording; these two pin the copy to its source so a
  // catalogue rename cannot leave the panel saying the old name.
  it.each(AI_PERSONA_CATALOGUE.map((entry) => [entry.id, entry] as const))(
    '%s keeps the catalogue English name and description',
    (_id, entry) => {
      const english = localizeAiPersona(entry.id, tEn);
      const nameSuffix = entry.specialty === 'general' ? 'General' : english.tierLabel;
      expect(`${english.role} (${nameSuffix})`).toBe(entry.name);
      expect(english.description).toBe(entry.description);
    },
  );

  it('maps every catalogue capability string to a key whose English text is that string', () => {
    for (const capability of PUBLISHED_CAPABILITIES) {
      const key = (PERSONA_CAPABILITY_KEYS as Readonly<Record<string, keyof typeof en>>)[
        capability
      ];
      expect(key, `capability "${capability}" has no locale key`).toBeDefined();
      if (key === undefined) continue;
      expect(en[key]).toBe(capability);
      expect(tr[key]).toBeTruthy();
      expect(tr[key]).not.toBe(en[key]);
    }
  });

  it('has no capability key the catalogue no longer publishes', () => {
    for (const capability of Object.keys(PERSONA_CAPABILITY_KEYS)) {
      expect(PUBLISHED_CAPABILITIES.has(capability), `stale capability key "${capability}"`).toBe(
        true,
      );
    }
  });

  it('draws only icons and hues the avatar knows how to render', () => {
    for (const entry of AI_PERSONA_CATALOGUE) {
      expect(AI_PERSONA_ICONS).toContain(entry.icon);
      expect(AI_PERSONA_COLORS).toContain(entry.color);
    }
  });
});
