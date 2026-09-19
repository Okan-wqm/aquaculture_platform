/**
 * useClickOutside — bir öğenin DIŞINA basıldığında (mousedown / touchstart)
 * geri çağırır. Açılır menüler, popover'lar ve bağlam menüleri içindir.
 *
 * Yerine geçtiği hile: menünün arkasına görünmez bir `fixed inset-0` katman
 * koyup ona tıklamayı yakalamak. O katman kaydırmayı ve odak sırasını
 * kırar, üstteki her şeyi tıklanamaz yapar, iç içe menülerde yanlış olanı
 * kapatır ve tasarım sistemi ratchet'inde bir "overlay" olarak sayılır.
 *
 * Yalnızca `enabled` iken dinler (PERF-006 disiplini: kapalı bir menü için
 * belge dinleyicisi tutulmaz). Geri çağırmanın en son hâli kullanılır; inline
 * ok fonksiyonu geçmek dinleyiciyi her render'da yeniden kurmaz.
 */
import { useEffect, useRef, type RefObject } from 'react';

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onClickOutside: () => void,
  enabled = true,
): void {
  const callbackRef = useRef(onClickOutside);
  useEffect(() => {
    callbackRef.current = onClickOutside;
  });

  useEffect(() => {
    if (!enabled) return undefined;

    const handle = (event: MouseEvent | TouchEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const element = ref.current;
      if (element && !element.contains(target)) {
        callbackRef.current();
      }
    };

    document.addEventListener('mousedown', handle);
    document.addEventListener('touchstart', handle);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('touchstart', handle);
    };
  }, [ref, enabled]);
}
