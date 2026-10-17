/**
 * The console header's small pure helpers: the palette shortcut's platform
 * (README §7.4 — ⌘K on Apple, Ctrl+K elsewhere; decision D12) and the user
 * plate's initials (the first letters of the first two name words).
 */
import { describe, expect, it } from 'vitest';

import { initialsOf } from '../initials';
import { paletteShortcut } from '../paletteShortcut';

describe('paletteShortcut', () => {
  it('names the Command key on Apple platforms', () => {
    const mac = paletteShortcut(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15',
    );
    expect(mac).toEqual({
      modifierKey: 'console.header.paletteKeyMac',
      ariaKeyShortcuts: 'Meta+K',
    });
    expect(paletteShortcut('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X)').ariaKeyShortcuts).toBe(
      'Meta+K',
    );
  });

  it('names Ctrl everywhere else, and when there is no user agent', () => {
    expect(paletteShortcut('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toEqual({
      modifierKey: 'console.header.paletteKeyCtrl',
      ariaKeyShortcuts: 'Control+K',
    });
    expect(paletteShortcut(undefined).ariaKeyShortcuts).toBe('Control+K');
  });
});

describe('initialsOf', () => {
  it('takes the first letter of the first two name words, uppercase', () => {
    expect(initialsOf('Deniz Yılmaz', 'deniz@example.com')).toBe('DY');
    expect(initialsOf('ayşe nur demir', 'a@example.com')).toBe('AN');
  });

  it('uses the one word a single-word name has', () => {
    expect(initialsOf('Okan', 'okan@example.com')).toBe('O');
  });

  it('falls back to the e-mail when the name is blank', () => {
    expect(initialsOf('   ', 'zeynep@example.com')).toBe('Z');
  });

  it('uppercases in the UI locale (Turkish dotted i)', () => {
    expect(initialsOf('ilker işık', 'i@example.com', 'tr')).toBe('İİ');
    expect(initialsOf('ilker işık', 'i@example.com', 'en')).toBe('II');
  });
});
