/**
 * consoleIconFor — the one lookup from a lucide icon name to the component
 * that draws it.
 *
 * A module record (`auth.modules.icon`) names its icon in Lucide's kebab-case,
 * the same vocabulary the rail draws its areas with. The tenant dashboard put
 * that name on screen as text ("users", "sprout") because nothing resolved it;
 * this lookup is the single place that does, and a name outside the vocabulary
 * gets a neutral glyph — never the name itself and never an emoji.
 */
import { Bell, Brain, Fish, Package, Sprout, Users } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { CONSOLE_ICON_FALLBACK, consoleIconFor } from '../railIcons';

describe('consoleIconFor', () => {
  it('resolves a vocabulary name to its lucide component', () => {
    expect(consoleIconFor('users')).toBe(Users);
    expect(consoleIconFor('sprout')).toBe(Sprout);
    expect(consoleIconFor('fish')).toBe(Fish);
  });

  it('resolves the alert and AI module icons the catalogue seeds', () => {
    expect(consoleIconFor('bell')).toBe(Bell);
    expect(consoleIconFor('brain')).toBe(Brain);
  });

  it('draws the neutral package glyph for a name outside the vocabulary', () => {
    expect(CONSOLE_ICON_FALLBACK).toBe(Package);
    expect(consoleIconFor('not-an-icon')).toBe(Package);
  });

  it('draws the neutral glyph for a record with no icon', () => {
    expect(consoleIconFor(null)).toBe(Package);
  });

  it('does not resolve a name off the object prototype', () => {
    expect(consoleIconFor('constructor')).toBe(Package);
    expect(consoleIconFor('toString')).toBe(Package);
    expect(consoleIconFor('__proto__')).toBe(Package);
  });
});
