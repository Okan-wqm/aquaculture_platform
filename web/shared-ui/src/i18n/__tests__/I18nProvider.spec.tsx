/**
 * I18nProvider — the locale follows the user (FE-HIGH-089).
 *
 * Before: four providers, `<html lang="tr">` static, the auth pages pinned to
 * English, no way to switch. These tests pin the resolution order (device
 * preference, then the browser, then Turkish), that `setLocale` persists the
 * device preference and moves `<html lang>`, that a pinned subtree ignores
 * the preference, and that the no-provider fallback answers in English.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { I18nProvider, useI18n } from '../I18nProvider';
import { LOCALE_STORAGE_KEY } from '../localePreference';

function Probe(): React.ReactElement {
  const { locale, t, setLocale } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="save">{t('common.save')}</span>
      <button type="button" onClick={() => setLocale('en')}>
        to-en
      </button>
      <button type="button" onClick={() => setLocale('tr')}>
        to-tr
      </button>
    </div>
  );
}

function setBrowserLanguage(language: string): void {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.lang = '';
  setBrowserLanguage('de-DE');
});

afterEach(cleanup);

describe('I18nProvider — resolution', () => {
  it('falls back to Turkish when neither a device preference nor the browser language is shipped', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('tr');
    expect(screen.getByTestId('save').textContent).toBe('Kaydet');
    expect(document.documentElement.lang).toBe('tr');
  });

  it('takes the browser language when it is one the platform ships', () => {
    setBrowserLanguage('en-GB');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
  });

  it('prefers the stored device preference over the browser', () => {
    setBrowserLanguage('en-US');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('tr');
  });

  it('ignores an unknown stored value', () => {
    setBrowserLanguage('en-US');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');
  });
});

describe('I18nProvider — switching', () => {
  it('setLocale re-renders every consumer, persists the device preference and moves <html lang>', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText('to-en'));
    });
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('save').textContent).toBe('Save');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('a pinned subtree keeps its language whatever the preference says', () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'tr');
    render(
      <I18nProvider locale="en">
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('save').textContent).toBe('Save');
    act(() => {
      fireEvent.click(screen.getByText('to-tr'));
    });
    expect(screen.getByTestId('save').textContent).toBe('Save');
  });
});

describe('useI18n without a provider', () => {
  it('answers in English so isolated renders and tests read the map, not the key', () => {
    render(<Probe />);
    expect(screen.getByTestId('locale').textContent).toBe('en');
    expect(screen.getByTestId('save').textContent).toBe('Save');
  });
});
