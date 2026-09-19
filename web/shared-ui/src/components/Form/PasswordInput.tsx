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

import { useI18n } from '../../i18n';
import { Input, type InputProps } from './Input';
import { Eye, EyeOff } from 'lucide-react';

export interface PasswordInputProps extends Omit<InputProps, 'type' | 'rightElement'> {
  /** "Şifreyi göster" toggle aria-label'ı (i18n) */
  showPasswordLabel?: string;
  /** "Şifreyi gizle" toggle aria-label'ı (i18n) */
  hidePasswordLabel?: string;
  /** Caps Lock açık uyarı metni (i18n) */
  capsLockLabel?: string;
}

// Göz açık ikonu (şifre gizli → göstermek için tıkla)
const EyeIcon: React.FC = () => <Eye className="w-5 h-5" aria-hidden="true" />;

// Göz kapalı ikonu (şifre görünür → gizlemek için tıkla)
const EyeOffIcon: React.FC = () => <EyeOff className="w-5 h-5" aria-hidden="true" />;

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
      showPasswordLabel: showPasswordLabelProp,
      hidePasswordLabel: hidePasswordLabelProp,
      capsLockLabel: capsLockLabelProp,
      ...props
    },
    ref,
  ) => {
    const { t } = useI18n();
    const showPasswordLabel = showPasswordLabelProp ?? t('common.showPassword');
    const hidePasswordLabel = hidePasswordLabelProp ?? t('common.hidePassword');
    const capsLockLabel = capsLockLabelProp ?? t('common.capsLockOn');
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
      [syncCaps, onKeyDown],
    );

    const handleKeyUp = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>): void => {
        syncCaps(e);
        onKeyUp?.(e);
      },
      [syncCaps, onKeyUp],
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
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-100'
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
            className={`mt-1 text-sm ${isGlass ? 'text-[var(--surface-muted-fg)]' : 'text-warning-700'}`}
          >
            {capsLockLabel}
          </p>
        )}
      </div>
    );
  },
);

PasswordInput.displayName = 'PasswordInput';

export default PasswordInput;
