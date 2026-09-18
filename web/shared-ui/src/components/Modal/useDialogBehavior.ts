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
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

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
    [containerRef],
  );

  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      document.body.style.overflow = 'hidden';

      listenerRef.current = (event: KeyboardEvent) => {
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
        document.body.style.overflow = '';
        if (listenerRef.current) {
          document.removeEventListener('keydown', listenerRef.current);
          listenerRef.current = null;
        }
      };
    }

    document.body.style.overflow = '';
    if (listenerRef.current) {
      document.removeEventListener('keydown', listenerRef.current);
      listenerRef.current = null;
    }
    previousActiveElement.current?.focus();
    return undefined;
  }, [isOpen, trapFocus, containerRef]);
}
