/**
 * useConfirm / usePrompt — sözleşme testleri
 *
 * Tarayıcı confirm()/prompt() ile aynı dönüş sözleşmesi, string kısayolu,
 * kuyruklama ve provider yokken açık hata.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import { ConfirmProvider, useConfirm, usePrompt } from '../useConfirm';

type ConfirmFn = ReturnType<typeof useConfirm>;
type PromptFn = ReturnType<typeof usePrompt>;

function Harness({
  onReady,
}: {
  onReady: (api: { confirm: ConfirmFn; prompt: PromptFn }) => void;
}): null {
  const confirm = useConfirm();
  const prompt = usePrompt();
  onReady({ confirm, prompt });
  return null;
}

function mount(): { confirm: ConfirmFn; prompt: PromptFn } {
  let api: { confirm: ConfirmFn; prompt: PromptFn } | null = null;
  render(
    <ConfirmProvider>
      <Harness
        onReady={(a) => {
          api = a;
        }}
      />
    </ConfirmProvider>,
  );
  if (!api) throw new Error('harness hazır değil');
  return api;
}

describe('useConfirm', () => {
  it('onayda true, iptalde false döndürür', async () => {
    const { confirm } = mount();

    let result: Promise<boolean> | null = null;
    act(() => {
      result = confirm({
        title: 'Planı sil',
        message: 'Geri alınamaz.',
        confirmText: 'Sil',
        variant: 'danger',
      });
    });
    expect(await screen.findByText('Planı sil')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sil' }));
    await expect(result).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    let cancelled: Promise<boolean> | null = null;
    act(() => {
      cancelled = confirm({ title: 'Tekrar?', cancelText: 'Vazgeç' });
    });
    expect(await screen.findByText('Tekrar?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
    await expect(cancelled).resolves.toBe(false);
  });

  it('düz string başlık olarak kullanılır (confirm("…") kısayolu)', async () => {
    const { confirm } = mount();
    let result: Promise<boolean> | null = null;
    act(() => {
      result = confirm('Bu kaydı silmek istediğinize emin misiniz?');
    });
    expect(await screen.findByText('Bu kaydı silmek istediğinize emin misiniz?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(result).resolves.toBe(true);
  });

  it('art arda istekleri kuyruklar; ikincisi birincisi kapanınca açılır', async () => {
    const { confirm } = mount();
    let first: Promise<boolean> | null = null;
    let second: Promise<boolean> | null = null;
    act(() => {
      first = confirm('Birinci');
      second = confirm('İkinci');
    });
    expect(await screen.findByText('Birinci')).toBeTruthy();
    expect(screen.queryByText('İkinci')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await expect(first).resolves.toBe(true);
    expect(await screen.findByText('İkinci')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(second).resolves.toBe(false);
  });

  it('Escape iptal sayılır', async () => {
    const { confirm } = mount();
    let result: Promise<boolean> | null = null;
    act(() => {
      result = confirm('Kapat?');
    });
    await screen.findByText('Kapat?');
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(result).resolves.toBe(false);
  });

  it('provider yokken çağrı açık hata fırlatır (askıda kalmaz)', () => {
    let confirmFn: ConfirmFn | null = null;
    render(
      <Harness
        onReady={(a) => {
          confirmFn = a.confirm;
        }}
      />,
    );
    if (!confirmFn) throw new Error('harness hazır değil');
    const fn: ConfirmFn = confirmFn;
    expect(() => fn('x')).toThrow(/ConfirmProvider/);
  });
});

describe('usePrompt', () => {
  it('girilen metni döndürür, boşken onay kapalıdır', async () => {
    const { prompt } = mount();
    let result: Promise<string | null> | null = null;
    act(() => {
      result = prompt({ title: 'Reddetme gerekçesi', label: 'Gerekçe', confirmText: 'Gönder' });
    });
    const input = await screen.findByRole('textbox', { name: 'Gerekçe' });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Gönder' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '  Eksik kalibrasyon ' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await expect(result).resolves.toBe('Eksik kalibrasyon');
  });

  it('iptalde null döndürür', async () => {
    const { prompt } = mount();
    let result: Promise<string | null> | null = null;
    act(() => {
      result = prompt('Kaç dakika?');
    });
    await screen.findByRole('textbox', { name: 'Kaç dakika?' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(result).resolves.toBeNull();
  });

  it('defaultValue ile açılır ve required=false boş onaya izin verir', async () => {
    const { prompt } = mount();
    let result: Promise<string | null> | null = null;
    act(() => {
      result = prompt({ title: 'Süre', defaultValue: '30', required: false });
    });
    const input = await screen.findByRole<HTMLInputElement>('textbox', { name: 'Süre' });
    expect(input.value).toBe('30');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await expect(result).resolves.toBe('');
  });
});
