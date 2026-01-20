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

  // ESC tuşu ile kapatma
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape' && closeOnEscape) {
        onClose();
      }
    },
    [closeOnEscape, onClose]
  );

  // Overlay tıklaması
  const handleOverlayClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget && closeOnOverlayClick) {
        onClose();
      }
    },
    [closeOnOverlayClick, onClose]
  );

  // Modal açıldığında/kapandığında
  useEffect(() => {
    if (isOpen) {
      // Önceki aktif elementi kaydet
      previousActiveElement.current = document.activeElement as HTMLElement;

      // Scroll'u engelle
      document.body.style.overflow = 'hidden';

      // Keyboard event listener ekle
      document.addEventListener('keydown', handleKeyDown);

      // Modal'a focus
      setTimeout(() => {
        modalRef.current?.focus();
      }, 0);
    } else {
      // Scroll'u geri aç
      document.body.style.overflow = '';

      // Keyboard event listener kaldır
      document.removeEventListener('keydown', handleKeyDown);

      // Önceki elemente focus
      previousActiveElement.current?.focus();
    }

    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

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
                className="p-1 text-gray-400 hover:text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
                aria-label="Kapat"
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
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Onay butonu varyantı */
  variant?: 'danger' | 'warning' | 'info';
  /** Onay butonu varyantı (alias for variant) */
  confirmVariant?: string;
  isLoading?: boolean;
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
}) => {
  // isOpen ve open birleştir
  const isOpen = isOpenProp ?? open ?? false;

  // variant ve confirmVariant birleştir
  const variant: 'danger' | 'warning' | 'info' = confirmVariant === 'danger'
    ? 'danger'
    : confirmVariant === 'warning'
    ? 'warning'
    : variantProp;
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
        <p className="mt-2 text-sm text-gray-500">{message}</p>

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
            disabled={isLoading}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 ${buttonColors[variant]}`}
          >
            {isLoading ? 'İşleniyor...' : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default Modal;
