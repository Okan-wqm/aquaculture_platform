/**
 * PasswordInput Bileşeni
 *
 * WHAT: Input üzerine kurulu şifre alanı — göster/gizle toggle'ı ve Caps Lock
 * uyarısı içerir. login / şifre-sıfırlama / davet-kabul ekranlarında tek SSoT.
 *
 * WHY compose Input: etiket/hata/aria-describedby/glass-surface makinesini yeniden
 * üretmemek için. Sadece toggle + caps-lock katmanını ekler.
 *
 * İkonlar inline SVG (shared-ui konvansiyonu: federe singleton pakete icon-kütüphanesi
 * bağımlılığı eklenmez — SearchInput/Button da inline SVG kullanır).
 * Toggle/caps metinleri i18n için prop ile geçersiz kılınabilir (İngilizce default).
 */

import React, { forwardRef, useId, useState, useCallback } from 'react';
import { Input, type InputProps } from './Input';

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'rightElement'> {
  /** "Şifreyi göster" toggle aria-label'ı (i18n) */
  showPasswordLabel?: string;
  /** "Şifreyi gizle" toggle aria-label'ı (i18n) */
  hidePasswordLabel?: string;
  /** Caps Lock açık uyarı metni (i18n) */
  capsLockLabel?: string;
}

// Göz açık ikonu (şifre gizli → göstermek için tıkla)
const EyeIcon: React.FC = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
    />
  </svg>
);

// Göz kapalı ikonu (şifre görünür → gizlemek için tıkla)
const EyeOffIcon: React.FC = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"
    />
  </svg>
);

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    {
      error,
      helperText,
      hint,
      surface = 'default',
      id: providedId,
      onKeyDown,
      onKeyUp,
      showPasswordLabel = 'Show password',
      hidePasswordLabel = 'Hide password',
      capsLockLabel = 'Caps Lock is on',
      ...props
    },
    ref
  ) => {
    // Deterministik id: aria-describedby'ı Input'un error/helper id şemasıyla hizalamak
    // ve caps uyarısını da bağlamak için id'yi biz üretip Input'a veriyoruz.
    const reactId = useId();
    const inputId = providedId ?? reactId;
    const capsId = `${inputId}-caps`;

    const [visible, setVisible] = useState(false);
    const [capsOn, setCapsOn] = useState(false);

    const syncCaps = useCallback((e: React.KeyboardEvent<HTMLInputElement>): void => {
      // getModifierState bazı sentetik klavye olaylarında bulunmayabilir → guard.
      if (typeof e.getModifierState === 'function') {
        setCapsOn(e.getModifierState('CapsLock'));
      }
    }, []);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>): void => {
        syncCaps(e);
        onKeyDown?.(e);
      },
      [syncCaps, onKeyDown]
    );

    const handleKeyUp = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>): void => {
        syncCaps(e);
        onKeyUp?.(e);
      },
      [syncCaps, onKeyUp]
    );

    const resolvedHelper = helperText || hint;
    // Input'un kendi describedby hesabıyla aynı id'ler + caps id'sini birleştir.
    const describedBy =
      [
        error ? `${inputId}-error` : resolvedHelper ? `${inputId}-helper` : null,
        capsOn ? capsId : null,
      ]
        .filter(Boolean)
        .join(' ') || undefined;

    const isGlass = surface === 'glass';

    const toggle = (
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? hidePasswordLabel : showPasswordLabel}
        // aria-controls binds the toggle to ITS field so two PasswordInputs on one
        // form (new + confirm) are distinguishable to assistive tech.
        aria-controls={inputId}
        tabIndex={0}
        className={`flex items-center justify-center min-w-[1.5rem] min-h-[1.5rem] transition-colors ${
          isGlass
            ? 'text-[var(--surface-field-fg)] hover:text-[var(--surface-field-focus-border)]'
            : 'text-gray-500 hover:text-gray-700'
        }`}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    );

    return (
      <div>
        <Input
          ref={ref}
          id={inputId}
          type={visible ? 'text' : 'password'}
          error={error}
          helperText={helperText}
          hint={hint}
          surface={surface}
          rightElement={toggle}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          aria-describedby={describedBy}
          {...props}
        />
        {capsOn && (
          <p
            id={capsId}
            role="status"
            aria-live="polite"
            className={`mt-1 text-sm ${isGlass ? 'text-[var(--surface-muted-fg)]' : 'text-amber-700'}`}
          >
            {capsLockLabel}
          </p>
        )}
      </div>
    );
  }
);

PasswordInput.displayName = 'PasswordInput';

export default PasswordInput;
