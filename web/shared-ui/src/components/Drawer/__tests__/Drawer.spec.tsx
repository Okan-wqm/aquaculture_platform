/**
 * Drawer — davranış testleri
 *
 * Modal ile paylaşılan useDialogBehavior'ın Drawer üstünden çalıştığını ve
 * yerleşim seçeneklerinin doğru sınıfları ürettiğini sabitler.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { Drawer } from '../Drawer';

describe('Drawer — görünürlük ve erişilebilirlik', () => {
  it('kapalıyken hiçbir şey render etmez', () => {
    render(
      <Drawer isOpen={false} onClose={() => {}} title="Özellikler">
        <p>içerik</p>
      </Drawer>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('açıkken role="dialog" + aria-modal ile başlığa bağlanır', () => {
    render(
      <Drawer isOpen onClose={() => {}} title="Widget özellikleri" description="Eşikler ve etiket">
        <p>içerik</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Widget özellikleri');
    expect(dialog).toHaveAccessibleDescription('Eşikler ve etiket');
  });

  it('kapatma butonu erişilebilir etiket taşır ve onClose çağırır', () => {
    const onClose = vi.fn();
    render(
      <Drawer isOpen onClose={onClose} title="Panel">
        <p>içerik</p>
      </Drawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('açılışta odağı panele taşır', async () => {
    render(
      <Drawer isOpen onClose={() => {}} title="Panel">
        <button type="button">İlk</button>
      </Drawer>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const panel = screen.getByRole('dialog').querySelector('[data-side]');
    expect(document.activeElement).toBe(panel);
  });
});

describe('Drawer — kapatma yolları', () => {
  it('Escape onClose çağırır', () => {
    const onClose = vi.fn();
    render(
      <Drawer isOpen onClose={onClose} title="Panel">
        <p>içerik</p>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closeOnEscape=false iken Escape kapatmaz', () => {
    const onClose = vi.fn();
    render(
      <Drawer isOpen onClose={onClose} title="Panel" closeOnEscape={false}>
        <p>içerik</p>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('overlay tıklaması onClose çağırır, closeOnOverlayClick=false iken çağırmaz', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Drawer isOpen onClose={onClose} title="Panel">
        <p>içerik</p>
      </Drawer>,
    );
    const overlay = screen.getByRole('dialog').firstElementChild;
    if (!overlay) throw new Error('overlay bulunamadı');
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const onClose2 = vi.fn();
    render(
      <Drawer isOpen onClose={onClose2} title="Panel" closeOnOverlayClick={false}>
        <p>içerik</p>
      </Drawer>,
    );
    const overlay2 = screen.getByRole('dialog').firstElementChild;
    if (!overlay2) throw new Error('overlay bulunamadı');
    fireEvent.click(overlay2);
    expect(onClose2).not.toHaveBeenCalled();
  });
});

describe('Drawer — yerleşim', () => {
  it('varsayılan sağ kenar, md genişlik', () => {
    render(
      <Drawer isOpen onClose={() => {}} title="Panel">
        <p>içerik</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('justify-end');
    const panel = dialog.querySelector('[data-side="right"]');
    expect(panel?.className).toContain('max-w-md');
    expect(panel?.className).toContain('h-full');
  });

  it('side="bottom" alt sayfa olarak yerleşir', () => {
    render(
      <Drawer isOpen onClose={() => {}} title="Kaydı sil?" side="bottom" size="sm">
        <p>içerik</p>
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('items-end');
    const panel = dialog.querySelector('[data-side="bottom"]');
    expect(panel?.className).toContain('rounded-t-2xl');
    expect(panel?.className).toContain('max-h-[40vh]');
  });

  it('footer verildiğinde alt şeritte render eder', () => {
    render(
      <Drawer isOpen onClose={() => {}} title="Panel" footer={<button type="button">Uygula</button>}>
        <p>içerik</p>
      </Drawer>,
    );
    expect(screen.getByRole('button', { name: 'Uygula' })).toBeInTheDocument();
  });
});
