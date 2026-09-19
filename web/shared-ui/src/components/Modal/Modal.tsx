/**
 * Modal Bileşeni
 * Diyalog ve popup'lar için yeniden kullanılabilir modal
 * Portal, animasyon ve erişilebilirlik desteği
 */

import React, { useCallback, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { dialogThemeAttributes, useDialogBehavior, type DialogTheme } from './useDialogBehavior';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';

export interface ModalProps {
  /** Modal açık mı */
  isOpen: boolean;
  /** Kapatma işleyicisi */
  onClose: () => void;
  /** Modal başlığı — ikonlu başlıklar için ReactNode da olabilir */
  title?: React.ReactNode;
  /** Alt başlık veya açıklama */
  description?: React.ReactNode;
  /** Modal boyutu (`2xl`: bir düzenleyici yüzeyi kadar geniş) */
  size?: ModalSize;
  /** Overlay tıklaması ile kapatma */
  closeOnOverlayClick?: boolean;
  /** Escape tuşu ile kapatma */
  closeOnEscape?: boolean;
  /** Kapatma butonu göster */
  showCloseButton?: boolean;
  /** Kapatma butonunun erişilebilir etiketi */
  closeLabel?: string;
  /**
   * Renk şeması. `auto` (varsayılan) kabuğun `data-theme`'ini izler; `dark`
   * diyaloğun kökünde `data-theme="dark"` sabitler, böylece her zaman koyu
   * olan bir yüzey (ST editörü ve diyalogları) kendi `dark:` sınıflarını ve
   * içeriğininkileri kabuk açıkken de alır (FE-MEDIUM-072).
   */
  theme?: DialogTheme;
  /** Footer içeriği */
  footer?: React.ReactNode;
  /** Modal içeriği */
  children: React.ReactNode;
  /** Panele ek CSS sınıfları */
  className?: string;
  /**
   * Gövde sarmalayıcısının sınıfları (varsayılan `p-4`). Kendi iç düzenini
   * (sekmeler, kaydırılan liste, yapışkan alt şerit) getiren içerik `''` ya da
   * `flex-1 min-h-0 overflow-y-auto` gibi bir değer geçer.
   */
  bodyClassName?: string;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const sizeStyles: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-6xl',
  full: 'max-w-full mx-4',
};

// ============================================================================
// Modal Bileşeni
// ============================================================================

/**
 * Modal bileşeni
 *
 * @example
 * // Temel kullanım
 * <Modal
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   title="Onay"
 * >
 *   <p>İşlemi onaylıyor musunuz?</p>
 * </Modal>
 *
 * @example
 * // Footer ile
 * <Modal
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   title="Çiftlik Ekle"
 *   footer={
 *     <>
 *       <Button variant="secondary" onClick={() => setIsOpen(false)}>İptal</Button>
 *       <Button onClick={handleSubmit}>Kaydet</Button>
 *     </>
 *   }
 * >
 *   <CreateFarmForm />
 * </Modal>
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  description,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  closeLabel = 'Close',
  theme = 'auto',
  footer,
  children,
  className = '',
  bodyClassName = 'p-4',
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Escape, odak tuzağı, scroll kilidi, odak geri verme — Drawer ile ortak
  // davranış useDialogBehavior'da (BUG-001/PERF-007, BUG-005, FE-HIGH-017).
  useDialogBehavior({ isOpen, onClose, closeOnEscape, containerRef: modalRef });

  // Overlay tıklaması
  const handleOverlayClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget && closeOnOverlayClick) {
        onClose();
      }
    },
    [closeOnOverlayClick, onClose]
  );

  // Modal kapalıysa render etme
  if (!isOpen) return null;

  // Portal ile render
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      {...dialogThemeAttributes(theme)}
    >
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        onClick={handleOverlayClick}
        aria-hidden="true"
      />

      {/* Modal içeriği */}
      <div
        ref={modalRef}
        tabIndex={-1}
        className={`
          relative w-full ${sizeStyles[size]}
          bg-white rounded-lg shadow-xl dark:bg-gray-900 dark:border dark:border-gray-700
          transform transition-all
          my-8
          ${className}
        `}
      >
        {/* Header */}
        {(title || showCloseButton) && (
          <div className="flex items-start justify-between p-4 border-b border-gray-200 dark:border-gray-700">
            <div>
              {title && (
                <h2
                  id={titleId}
                  className="text-lg font-semibold text-gray-900 dark:text-gray-100"
                >
                  {title}
                </h2>
              )}
              {description && (
                <p
                  id={descriptionId}
                  className="mt-1 text-sm text-gray-500 dark:text-gray-400"
                >
                  {description}
                </p>
              )}
            </div>
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                className="p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
                aria-label={closeLabel}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className={bodyClassName}>{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end space-x-3 p-4 border-t border-gray-200 bg-gray-50 rounded-b-lg dark:border-gray-700 dark:bg-gray-800">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

// ============================================================================
// Confirm Modal Bileşeni
// ============================================================================

export interface ConfirmModalProps {
  /** Modal açık mı */
  isOpen?: boolean;
  /** Modal açık mı (alias for isOpen) */
  open?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /**
   * Modal gövde metni. `string` geçmeye devam edebilirsin; `ReactNode`
   * kabul etmesi (formatlı içerik — vurgu, liste, sayı-rengi, vs.)
   * çağrı tarafında `<p>`/`<strong>` gibi şeyleri sarmalamak zorunda
   * kalmadan "12 satır silinecek" gibi zengin mesajları iletmeni sağlar.
   * Backward-compatible — string hâlâ geçerli bir ReactNode.
   */
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** Onay butonu varyantı */
  variant?: 'danger' | 'warning' | 'info';
  /** Onay butonu varyantı (alias for variant) */
  confirmVariant?: 'danger' | 'warning' | 'info';
  isLoading?: boolean;
  /**
   * Mesajın altında `role="alert"` ile gösterilen uyarı ya da hata satırı —
   * tipik olarak başarısız bir denemenin nedeni. Diyaloğun içinde kalır ki
   * kullanıcı bağlamı kaybetmeden yeniden deneyebilsin.
   */
  warning?: React.ReactNode;
  /**
   * Yüksek-riskli aksiyonlar için yazı-ile-onay kapısı. Buraya
   * `"ONAYLIYORUM"` gibi bir metin verirsen, kullanıcı onay butonuna
   * bastığında önce bu metni aynen yazmak zorunda kalır — fat-finger
   * tıklamaları tek yanlışla yıkıcı işlem tetikleyemez (örn. prod'da
   * toplu iş-emri üretim tetiklemesi, tenant erasure, vs.).
   *
   * Undefined bırakırsan eski davranış korunur — tek-tık onay.
   */
  requireTypedConfirmation?: string;
  /**
   * isLoading sırasında onay butonunda gösterilen etiket. Türkçe varsayılan
   * korunur; İngilizce yüzeyler açık değer geçer (ADMIN-MEDIUM-018).
   */
  loadingText?: string;
  /**
   * Yazı-ile-onay alanının etiketi. `{text}` yer tutucusu istenen onay
   * metniyle değiştirilir. Türkçe varsayılan korunur.
   */
  typedConfirmationLabel?: string;
}

/**
 * Onay diyaloğu için özelleştirilmiş modal
 *
 * @example
 * <ConfirmModal
 *   isOpen={showConfirm}
 *   onClose={() => setShowConfirm(false)}
 *   onConfirm={handleDelete}
 *   title="Silme Onayı"
 *   message="Bu çiftliği silmek istediğinizden emin misiniz?"
 *   variant="danger"
 *   confirmText="Sil"
 * />
 */
export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen: isOpenProp,
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Onayla',
  cancelText = 'İptal',
  variant: variantProp = 'info',
  confirmVariant,
  isLoading = false,
  requireTypedConfirmation,
  warning,
  loadingText = 'İşleniyor...',
  typedConfirmationLabel,
}) => {
  // isOpen ve open birleştir
  const isOpen = isOpenProp ?? open ?? false;

  // Yazı-ile-onay kapısı — kullanıcı istenen metni aynen yazana kadar
  // onay butonu disabled kalır. Modal her açıldığında sıfırlanır (yanlış
  // yazıp iptal eden bir kullanıcı ikinci açışta "hazır onaylı" bulmasın).
  const [typedConfirmation, setTypedConfirmation] = React.useState('');
  React.useEffect(() => {
    if (isOpen) {
      setTypedConfirmation('');
    }
  }, [isOpen]);
  const typedGatePassed =
    !requireTypedConfirmation ||
    typedConfirmation.trim() === requireTypedConfirmation.trim();

  // BUG-011: confirmVariant is now properly typed — use it directly with fallback to variant prop
  const variant: 'danger' | 'warning' | 'info' = confirmVariant ?? variantProp;
  const iconColors = {
    danger: 'text-red-600 bg-red-100 dark:text-red-400 dark:bg-red-900/40',
    warning: 'text-yellow-600 bg-yellow-100 dark:text-yellow-400 dark:bg-yellow-900/40',
    info: 'text-blue-600 bg-blue-100 dark:text-blue-400 dark:bg-blue-900/40',
  };

  const buttonColors = {
    danger: 'bg-red-600 hover:bg-red-700 focus:ring-red-500',
    warning: 'bg-yellow-600 hover:bg-yellow-700 focus:ring-yellow-500',
    info: 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500',
  };

  const icons = {
    danger: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    warning: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    info: (
      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      showCloseButton={false}
    >
      <div className="text-center">
        {/* İkon */}
        <div className={`mx-auto w-12 h-12 flex items-center justify-center rounded-full ${iconColors[variant]}`}>
          {icons[variant]}
        </div>

        {/* Başlık ve mesaj */}
        <h3 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
        {/*
          `message` ReactNode kabul ediyor — string ile tipografi
          `<p>` sarmalaması; ReactNode ile olduğu gibi render.
        */}
        {typeof message === 'string' ? (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{message}</p>
        ) : (
          <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">{message}</div>
        )}

        {warning && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-amber-100 bg-amber-50 p-3 text-left text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
          >
            {warning}
          </div>
        )}

        {/* Yazı-ile-onay gate — yalnızca requireTypedConfirmation verilmişse */}
        {requireTypedConfirmation && (
          <div className="mt-4 text-left">
            <label className="block text-sm font-medium text-gray-700 mb-1 dark:text-gray-300">
              {typedConfirmationLabel ? (
                typedConfirmationLabel.split('{text}').map((part, idx, arr) => (
                  <React.Fragment key={idx}>
                    {part}
                    {idx < arr.length - 1 && (
                      <code className="font-mono font-semibold">{requireTypedConfirmation}</code>
                    )}
                  </React.Fragment>
                ))
              ) : (
                <>
                  Devam etmek için aşağıya{' '}
                  <code className="font-mono font-semibold">{requireTypedConfirmation}</code> yazın
                </>
              )}
            </label>
            <input
              type="text"
              value={typedConfirmation}
              onChange={(e) => setTypedConfirmation(e.target.value)}
              disabled={isLoading}
              autoComplete="off"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-offset-0 focus:ring-blue-500 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
              aria-label="Typed confirmation"
            />
          </div>
        )}

        {/* Butonlar */}
        <div className="mt-6 flex justify-center space-x-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50 dark:text-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading || !typedGatePassed}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 disabled:opacity-50 ${buttonColors[variant]}`}
          >
            {isLoading ? loadingText : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default Modal;
