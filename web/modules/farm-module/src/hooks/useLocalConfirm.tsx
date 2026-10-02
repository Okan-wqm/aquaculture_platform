/**
 * useLocalConfirm — farm-module içi, federation-context'e bağlanmayan onay diyaloğu.
 *
 * WHY (2026-09-21 canlı olay): shared-ui'nin `useConfirm()` hook'u, context'i
 * shell'de mount edilen `ConfirmProvider`'dan okur. Üretimde shell ile remote
 * arasında context örneği eşleşmediğinde hook ya fırlıyor ya —daha kötüsü—
 * diyaloğu hiç çizmeden askıda kalıyordu; Species/Suppliers/Consumables/
 * Chemicals/Feeds/Workers sekmelerinde Delete butonları "ölü" görünüyordu
 * (istek gitmiyor, hata da görünmüyordu).
 *
 * Bu hook aynı sözleşmeyi (await confirm({...}) → boolean) YEREL state ile
 * sağlar ve diyaloğu çağıran sekmenin ağacında çizer — modülün kendi Modal
 * bileşeni zaten üretimde çalışıyor (Add/Edit formları). Çağıran sekme
 * `{dialog}`'u JSX'inde render etmek zorundadır.
 */

import { useCallback, useRef, useState } from 'react';

import { ConfirmModal } from '@aquaculture/shared-ui';

export interface LocalConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
}

interface PendingConfirm extends LocalConfirmOptions {
  resolve: (value: boolean) => void;
}

export function useLocalConfirm(): {
  confirm: (options: LocalConfirmOptions | string) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [active, setActive] = useState<PendingConfirm | null>(null);
  const seq = useRef(0);

  const confirm = useCallback((options: LocalConfirmOptions | string) => {
    const normalized: LocalConfirmOptions =
      typeof options === 'string' ? { title: options } : options;
    return new Promise<boolean>((resolve) => {
      seq.current += 1;
      setActive({ ...normalized, resolve });
    });
  }, []);

  const dialog = active
    ? [
        <ConfirmModal
          key={`local-confirm-${seq.current}`}
          isOpen
          title={active.title}
          message={active.message ?? null}
          confirmText={active.confirmText}
          cancelText={active.cancelText}
          variant={active.variant}
          onClose={() => {
            active.resolve(false);
            setActive(null);
          }}
          onConfirm={() => {
            active.resolve(true);
            setActive(null);
          }}
        />,
      ][0]
    : null;

  return { confirm, dialog };
}
