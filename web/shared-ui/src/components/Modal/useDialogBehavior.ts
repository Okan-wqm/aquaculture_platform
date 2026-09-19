/**
 * useDialogBehavior — Modal ve Drawer'ın ortak "açık diyalog" davranışı.
 *
 * Tek yerde: Escape ile kapatma, Tab/Shift+Tab odak tuzağı (BUG-005),
 * gövde scroll kilidi, açılışta odağı kaba taşıma ve kapanışta önceki
 * elemente geri verme (FE-HIGH-017). Dinleyici kimliği ref'te tutulur ki
 * kaldırma her zaman aynı fonksiyonu hedeflesin (BUG-001/PERF-007).
 *
 * Modal bunu kullanır; Drawer da. İkinci bir overlay bileşeni bu dosyayı
 * kopyalamak yerine bu hook'u çağırır — davranış farkı yapısal olarak
 * imkânsız.
 *
 * Açık diyaloglar bir yığında tutulur: Escape ve odak tuzağı yalnızca en
 * üsttekine işler, scroll kilidi sonuncusu kapanınca kalkar. Böylece bir
 * diyaloğun içinden açılan ikinci diyalog (ST editörünün dışa aktarma
 * penceresi, editörün kendi penceresinin içinde) tek başına kapanır.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

// ============================================================================
// Renk şeması
// ============================================================================

/**
 * `auto` kabuğun `<html data-theme>` değerini izler (theme.css `dark:`
 * varyantını bu öznitelik üzerinden tanımlar — FE-MEDIUM-072); `dark`
 * diyaloğun kökünde aynı özniteliği sabitler, böylece her zaman koyu olan
 * bir yüzey kabuk açıkken de kendi ve içeriğinin `dark:` sınıflarını alır.
 */
export type DialogTheme = 'auto' | 'dark';

/** Diyalog kökünün renk-şeması öznitelikleri — `dark` için `data-theme="dark"`, `auto` için hiçbiri. */
export function dialogThemeAttributes(theme: DialogTheme): { 'data-theme'?: 'dark' } {
  return theme === 'dark' ? { 'data-theme': 'dark' } : {};
}

// ============================================================================
// Davranış
// ============================================================================

export interface DialogBehaviorOptions<T extends HTMLElement> {
  /** Diyalog açık mı */
  isOpen: boolean;
  /** Kapatma işleyicisi (Escape bunu çağırır) */
  onClose: () => void;
  /** Escape tuşu ile kapatma */
  closeOnEscape: boolean;
  /** Odak tuzağının sınırı ve açılışta odaklanacak kap */
  containerRef: RefObject<T | null>;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Açık diyaloglar, en dıştaki önce. Klavye yalnızca sonuncusuna (en üsttekine) işler. */
const openDialogs: symbol[] = [];

function isTopDialog(id: symbol): boolean {
  return openDialogs[openDialogs.length - 1] === id;
}

function releaseBodyScrollIfLast(): void {
  if (openDialogs.length === 0) {
    document.body.style.overflow = '';
  }
}

export function useDialogBehavior<T extends HTMLElement>({
  isOpen,
  onClose,
  closeOnEscape,
  containerRef,
}: DialogBehaviorOptions<T>): void {
  const previousActiveElement = useRef<HTMLElement | null>(null);
  const listenerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  // Son prop değerleri ref'te — kararlı dinleyici güncel değeri okur
  const closeOnEscapeRef = useRef(closeOnEscape);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    closeOnEscapeRef.current = closeOnEscape;
  }, [closeOnEscape]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const trapFocus = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !containerRef.current) return;
      const focusable = containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey) {
        if (document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [containerRef]
  );

  useEffect(() => {
    if (isOpen) {
      const id = Symbol('dialog');
      openDialogs.push(id);
      previousActiveElement.current = document.activeElement as HTMLElement;
      document.body.style.overflow = 'hidden';

      listenerRef.current = (event: KeyboardEvent) => {
        // Altta kalan diyalog üsttekinin tuşlarını görmez: Escape ikisini birden kapatamaz.
        if (!isTopDialog(id)) return;
        if (event.key === 'Escape' && closeOnEscapeRef.current) {
          onCloseRef.current();
        }
        trapFocus(event);
      };
      document.addEventListener('keydown', listenerRef.current);

      const focusTimer = setTimeout(() => {
        containerRef.current?.focus();
      }, 0);

      return () => {
        clearTimeout(focusTimer);
        openDialogs.splice(openDialogs.indexOf(id), 1);
        releaseBodyScrollIfLast();
        if (listenerRef.current) {
          document.removeEventListener('keydown', listenerRef.current);
          listenerRef.current = null;
        }
        // Focus goes back to the opener here, in the cleanup, so a wrapper
        // that early-returns null and unmounts the dialog restores it too —
        // not only a dialog that re-renders with isOpen=false.
        const opener = previousActiveElement.current;
        if (opener?.isConnected) opener.focus();
      };
    }

    // Kapalı bir diyalog bir başkasının kilidini kaldıramaz (kapalı bağlanan
    // bir alt diyalog, açık olan üst diyaloğun scroll kilidini bırakmasın).
    releaseBodyScrollIfLast();
    if (listenerRef.current) {
      document.removeEventListener('keydown', listenerRef.current);
      listenerRef.current = null;
    }
    return undefined;
  }, [isOpen, trapFocus, containerRef]);
}
