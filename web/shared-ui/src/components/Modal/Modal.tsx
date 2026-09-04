/**
 * Modal Bileşeni
 * Diyalog ve popup'lar için yeniden kullanılabilir modal
 * Portal, animasyon ve erişilebilirlik desteği
 */

import React, { useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export interface ModalProps {
  /** Modal açık mı */
  isOpen: boolean;
  /** Kapatma işleyicisi */
  onClose: () => void;
  /** Modal başlığı */
  title?: string;
  /** Alt başlık veya açıklama */
  description?: string;
  /** Modal boyutu */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Overlay tıklaması ile kapatma */
  closeOnOverlayClick?: boolean;
  /** Escape tuşu ile kapatma */
  closeOnEscape?: boolean;
  /** Kapatma butonu göster */
  showCloseButton?: boolean;
  /** Footer içeriği */
  footer?: React.ReactNode;
  /** Modal içeriği */
  children: React.ReactNode;
  /** Ek CSS sınıfları */
  className?: string;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const sizeStyles = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
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
  footer,
  children,
  className = '',
}) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);
  // BUG-001/PERF-007: Store listener ref so removal always targets same identity
  const listenerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  // Store latest props in refs so the stable listener can access current values
  const closeOnEscapeRef = useRef(closeOnEscape);
  const onCloseRef = useRef(onClose);
  useEffect(() => { closeOnEscapeRef.current = closeOnEscape; }, [closeOnEscape]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Overlay tıklaması
  const handleOverlayClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget && closeOnOverlayClick) {
        onClose();
      }
    },
    [closeOnOverlayClick, onClose]
  );

  // Focus trap helper: cycle focus within modal (BUG-005)
  const trapFocus = useCallback((event: KeyboardEvent) => {
    if (!modalRef.current) return;
    const focusable = modalRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.key === 'Tab') {
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  }, []);

  // Modal açıldığında/kapandığında
  useEffect(() => {
    if (isOpen) {
      // Önceki aktif elementi kaydet
      previousActiveElement.current = document.activeElement as HTMLElement;

      // Scroll'u engelle
      document.body.style.overflow = 'hidden';

      // BUG-001/PERF-007: Create stable listener using refs — avoids accumulating stale listeners
      listenerRef.current = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && closeOnEscapeRef.current) {
          onCloseRef.current();
        }
        trapFocus(event);
      };
      document.addEventListener('keydown', listenerRef.current);

      // Modal'a focus
      setTimeout(() => {
        modalRef.current?.focus();
      }, 0);
    } else {
      // Scroll'u geri aç
      document.body.style.overflow = '';

      // Remove by stable ref — guaranteed identity match
      if (listenerRef.current) {
        document.removeEventListener('keydown', listenerRef.current);
        listenerRef.current = null;
      }

      // Önceki elemente focus
      previousActiveElement.current?.focus();
    }

    return () => {
      document.body.style.overflow = '';
      if (listenerRef.current) {
        document.removeEventListener('keydown', listenerRef.current);
        listenerRef.current = null;
      }
    };
  }, [isOpen, trapFocus]);

  // Modal kapalıysa render etme
  if (!isOpen) return null;

  // Portal ile render
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
      aria-describedby={description ? 'modal-description' : undefined}
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
          bg-white rounded-lg shadow-xl
          transform transition-all
          my-8
          ${className}
        `}
      >
        {/* Header */}
        {(title || showCloseButton) && (
          <div className="flex items-start justify-between p-4 border-b border-gray-200">
            <div>
              {title && (
                <h2
                  id="modal-title"
                  className="text-lg font-semibold text-gray-900"
                >
                  {title}
                </h2>
              )}
              {description && (
                <p
                  id="modal-description"
                  className="mt-1 text-sm text-gray-500"
                >
                  {description}
                </p>
              )}
            </div>
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                className="p-1 text-gray-500 hover:text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Body */}
        <div className="p-4">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end space-x-3 p-4 border-t border-gray-200 bg-gray-50 rounded-b-lg">
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
    danger: 'text-red-600 bg-red-100',
    warning: 'text-yellow-600 bg-yellow-100',
    info: 'text-blue-600 bg-blue-100',
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
        <h3 className="mt-4 text-lg font-semibold text-gray-900">{title}</h3>
        {/*
          `message` ReactNode kabul ediyor — string ile tipografi
          `<p>` sarmalaması; ReactNode ile olduğu gibi render.
        */}
        {typeof message === 'string' ? (
          <p className="mt-2 text-sm text-gray-500">{message}</p>
        ) : (
          <div className="mt-2 text-sm text-gray-500">{message}</div>
        )}

        {/* Yazı-ile-onay gate — yalnızca requireTypedConfirmation verilmişse */}
        {requireTypedConfirmation && (
          <div className="mt-4 text-left">
            <label className="block text-sm font-medium text-gray-700 mb-1">
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
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-offset-0 focus:ring-blue-500 disabled:opacity-50"
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
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-50"
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
