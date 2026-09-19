/**
 * Drawer Bileşeni
 * Kenardan açılan panel — özellik panelleri, filtreler, detay görünümleri.
 *
 * Modal ile aynı diyalog davranışını (useDialogBehavior) paylaşır: portal,
 * role="dialog", aria-modal, odak tuzağı, Escape, scroll kilidi, odak geri
 * verme. Fark yalnızca yerleşim: sağ/sol kenardan tam yükseklik ya da alttan
 * (mobil "bottom sheet") açılır.
 */

import React, { useCallback, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import { dialogThemeAttributes, useDialogBehavior, type DialogTheme } from '../Modal/useDialogBehavior';

// ============================================================================
// Tip Tanımlamaları
// ============================================================================

export type DrawerSide = 'right' | 'left' | 'bottom';
export type DrawerSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface DrawerProps {
  /** Drawer açık mı */
  isOpen: boolean;
  /** Kapatma işleyicisi */
  onClose: () => void;
  /** Başlık — ikonlu başlıklar için ReactNode da olabilir */
  title?: React.ReactNode;
  /** Alt başlık veya açıklama */
  description?: React.ReactNode;
  /** Hangi kenardan açılır (varsayılan: sağ) */
  side?: DrawerSide;
  /** Genişlik (sağ/sol) ya da yükseklik (alt) */
  size?: DrawerSize;
  /** Overlay tıklaması ile kapatma */
  closeOnOverlayClick?: boolean;
  /** Escape tuşu ile kapatma */
  closeOnEscape?: boolean;
  /** Kapatma butonu göster */
  showCloseButton?: boolean;
  /** Kapatma butonunun erişilebilir etiketi */
  closeLabel?: string;
  /**
   * Başlıksız çekmecenin erişilebilir adı (içerik kendi başlığını taşıyorsa,
   * örn. AlarmPanel). `title` verildiğinde yok sayılır.
   */
  ariaLabel?: string;
  /**
   * Renk şeması. `auto` (varsayılan) kabuğun `data-theme`'ini izler; `dark`
   * çekmecenin kökünde `data-theme="dark"` sabitler — Modal ile aynı sözleşme
   * (FE-MEDIUM-072).
   */
  theme?: DialogTheme;
  /** Footer içeriği (örn. Uygula / Vazgeç) */
  footer?: React.ReactNode;
  /** İçerik */
  children: React.ReactNode;
  /** Panele ek CSS sınıfları */
  className?: string;
  /** Gövde sarmalayıcısının sınıfları (varsayılan kaydırılabilir `p-4`) */
  bodyClassName?: string;
}

// ============================================================================
// Stil Sınıfları
// ============================================================================

const widthStyles: Record<DrawerSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  full: 'max-w-full',
};

const heightStyles: Record<DrawerSize, string> = {
  sm: 'max-h-[40vh]',
  md: 'max-h-[60vh]',
  lg: 'max-h-[80vh]',
  xl: 'max-h-[90vh]',
  full: 'max-h-full',
};

const placementStyles: Record<DrawerSide, string> = {
  right: 'justify-end',
  left: 'justify-start',
  bottom: 'items-end',
};

function panelStyles(side: DrawerSide, size: DrawerSize): string {
  if (side === 'bottom') {
    return `w-full ${heightStyles[size]} rounded-t-2xl`;
  }
  const edge = side === 'right' ? 'border-l' : 'border-r';
  return `h-full w-full ${widthStyles[size]} ${edge} border-gray-200 dark:border-gray-700`;
}

// ============================================================================
// Drawer Bileşeni
// ============================================================================

/**
 * @example
 * <Drawer
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   title="Widget özellikleri"
 *   footer={<Button onClick={apply}>Uygula</Button>}
 * >
 *   <PropertiesForm />
 * </Drawer>
 *
 * @example
 * // Mobil alt sayfa
 * <Drawer isOpen={open} onClose={close} side="bottom" size="sm" title="Kaydı sil?">
 *   …
 * </Drawer>
 */
export const Drawer: React.FC<DrawerProps> = ({
  isOpen,
  onClose,
  title,
  description,
  side = 'right',
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  closeLabel = 'Kapat',
  ariaLabel,
  theme = 'auto',
  footer,
  children,
  className = '',
  bodyClassName = 'flex-1 min-h-0 overflow-y-auto p-4',
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useDialogBehavior({ isOpen, onClose, closeOnEscape, containerRef: panelRef });

  const handleOverlayClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target === event.currentTarget && closeOnOverlayClick) {
        onClose();
      }
    },
    [closeOnOverlayClick, onClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex ${placementStyles[side]}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : ariaLabel}
      aria-describedby={description ? descriptionId : undefined}
      {...dialogThemeAttributes(theme)}
    >
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 transition-opacity"
        onClick={handleOverlayClick}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        data-side={side}
        className={`relative flex flex-col bg-white shadow-xl dark:bg-gray-900 ${panelStyles(side, size)} ${className}`}
      >
        {/* Header */}
        {(title || showCloseButton) && (
          <div className="flex items-start justify-between gap-3 p-4 border-b border-gray-200 dark:border-gray-700">
            <div className="min-w-0">
              {title && (
                <h2 id={titleId} className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {description}
                </p>
              )}
            </div>
            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-gray-800"
                aria-label={closeLabel}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        )}

        {/* Body — kaydırılabilir alan */}
        <div className={bodyClassName}>{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end space-x-3 p-4 border-t border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default Drawer;
