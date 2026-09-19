/**
 * useConfirm / usePrompt — tarayıcı `confirm()` ve `prompt()`'un promise
 * tabanlı, tasarım sistemine bağlı karşılığı.
 *
 * WHY: `if (!confirm('Emin misiniz?')) return;` deseni 40+ yerde vardı ve
 * ESLint `no-alert` ile yasaklandı. Her çağrı yerinde modal state'i hoist
 * etmek yerine bu hook aynı tek satırlık şekli korur:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Planı sil', variant: 'danger' }))) return;
 *
 * Diyaloğu `ConfirmProvider` çizer — ToastProvider gibi shell'de BİR kez
 * monte edilir ve federation'ın tekil React'i üzerinden her remote'a ulaşır.
 * Provider yoksa dönen fonksiyon çağrıldığında açık bir hata fırlatır:
 * sessizce askıda kalan bir promise yerine dev'de anında görünür (Tier 3).
 */

import React, { createContext, useCallback, useContext, useId, useMemo, useState } from 'react';

import { ConfirmModal, Modal } from '../components/Modal';

// ============================================================================
// Tipler
// ============================================================================

export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  /** Yüksek riskli işlemler için yazı-ile-onay kapısı (bkz. ConfirmModal) */
  requireTypedConfirmation?: string;
}

export interface PromptOptions {
  title: string;
  message?: React.ReactNode;
  /** Giriş alanının etiketi */
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  /** Boş metinle onaya izin verme (varsayılan: true) */
  required?: boolean;
}

/** `confirm('…')` gibi düz string de kabul eder — string başlık olur. */
export type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;
/** Onayda girilen metni, iptalde `null` döndürür — tarayıcı prompt() ile aynı sözleşme. */
export type PromptFn = (options: PromptOptions | string) => Promise<string | null>;

interface ConfirmContextValue {
  confirm: ConfirmFn;
  prompt: PromptFn;
}

type PendingRequest =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

const MISSING_PROVIDER =
  'useConfirm/usePrompt: ConfirmProvider bulunamadı. Uygulama kökünü (shell bootstrap, ' +
  'modül main.tsx) <ConfirmProvider> ile sarın; diyalog orada çizilir.';

function normalizeConfirm(options: ConfirmOptions | string): ConfirmOptions {
  return typeof options === 'string' ? { title: options } : options;
}

function normalizePrompt(options: PromptOptions | string): PromptOptions {
  return typeof options === 'string' ? { title: options } : options;
}

// ============================================================================
// Prompt diyaloğu (Modal üstünde tek giriş alanı)
// ============================================================================

interface PromptDialogProps {
  options: PromptOptions;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

const PromptDialog: React.FC<PromptDialogProps> = ({ options, onSubmit, onCancel }) => {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const inputId = useId();
  const required = options.required ?? true;
  const canSubmit = !required || value.trim().length > 0;

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit(value.trim());
  };

  return (
    <Modal isOpen onClose={onCancel} size="sm" title={options.title} showCloseButton={false}>
      <form onSubmit={handleSubmit}>
        {options.message !== undefined && (
          <div className="mb-3 text-sm text-gray-500 dark:text-gray-400">{options.message}</div>
        )}
        <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          {options.label ?? options.title}
        </label>
        <input
          id={inputId}
          type="text"
          autoFocus
          autoComplete="off"
          value={value}
          placeholder={options.placeholder}
          onChange={(e) => setValue(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-offset-0 focus:ring-blue-500"
        />
        <div className="mt-6 flex justify-end space-x-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
          >
            {options.cancelText ?? 'İptal'}
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {options.confirmText ?? 'Tamam'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================================
// Provider
// ============================================================================

/**
 * Uygulama düzeyi onay/istem sağlayıcısı. Host (shell) provider ağacında
 * BİR kez monte edilir; istekler kuyruğa alınır ve sırayla tek diyalogda
 * çizilir, böylece iç içe/çakışan onaylar birbirini ezmez.
 */
export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [queue, setQueue] = useState<PendingRequest[]>([]);

  const settle = useCallback(() => {
    setQueue((prev) => prev.slice(1));
  }, []);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setQueue((prev) => [...prev, { kind: 'confirm', options: normalizeConfirm(options), resolve }]);
      }),
    []
  );

  const prompt = useCallback<PromptFn>(
    (options) =>
      new Promise<string | null>((resolve) => {
        setQueue((prev) => [...prev, { kind: 'prompt', options: normalizePrompt(options), resolve }]);
      }),
    []
  );

  const value = useMemo<ConfirmContextValue>(() => ({ confirm, prompt }), [confirm, prompt]);
  const active = queue[0] ?? null;

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {active?.kind === 'confirm' && (
        <ConfirmModal
          isOpen
          title={active.options.title}
          message={active.options.message ?? null}
          confirmText={active.options.confirmText}
          cancelText={active.options.cancelText}
          variant={active.options.variant}
          requireTypedConfirmation={active.options.requireTypedConfirmation}
          onClose={() => {
            active.resolve(false);
            settle();
          }}
          onConfirm={() => {
            active.resolve(true);
            settle();
          }}
        />
      )}
      {active?.kind === 'prompt' && (
        <PromptDialog
          // Her istek kendi başlangıç değeriyle açılsın
          key={queue.length}
          options={active.options}
          onSubmit={(text) => {
            active.resolve(text);
            settle();
          }}
          onCancel={() => {
            active.resolve(null);
            settle();
          }}
        />
      )}
    </ConfirmContext.Provider>
  );
};

// ============================================================================
// Hook'lar
// ============================================================================

const confirmWithoutProvider: ConfirmFn = () => {
  throw new Error(MISSING_PROVIDER);
};
const promptWithoutProvider: PromptFn = () => {
  throw new Error(MISSING_PROVIDER);
};

/**
 * Promise tabanlı onay. Tarayıcı `confirm()` ile aynı sözleşme (true/false),
 * ancak tasarım sistemi diyaloğuyla, klavye ve ekran okuyucu desteğiyle.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  return ctx?.confirm ?? confirmWithoutProvider;
}

/**
 * Promise tabanlı metin istemi. Tarayıcı `prompt()` ile aynı sözleşme
 * (metin ya da iptalde `null`).
 */
export function usePrompt(): PromptFn {
  const ctx = useContext(ConfirmContext);
  return ctx?.prompt ?? promptWithoutProvider;
}
