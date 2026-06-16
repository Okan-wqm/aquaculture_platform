/**
 * AttachmentPicker Tests — MSG-LOW-051 client MIME pre-flight validation.
 *
 * The picker validates file.type against the SAME shared MIME allowlist SSoT the
 * upload hook + server use, BEFORE onFileSelect. A disallowed type (svg) is
 * rejected at pick time with a clear message and onFileSelect is NOT called.
 */
import { render, fireEvent, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';

import { AttachmentPicker } from '../AttachmentPicker';

function fileOf(type: string): File {
  return new File(['x'], `f.${type.split('/')[1] ?? 'bin'}`, { type });
}

function firstFileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('no file input rendered');
  return input as HTMLInputElement;
}

describe('AttachmentPicker — MIME validation (MSG-LOW-051)', () => {
  it('rejects image/svg+xml at pick time and never calls onFileSelect', () => {
    const onFileSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <AttachmentPicker isOpen onClose={onClose} onFileSelect={onFileSelect} />,
    );

    const input = firstFileInput(container);
    fireEvent.change(input, { target: { files: [fileOf('image/svg+xml')] } });

    expect(onFileSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/not supported/i)).toBeTruthy();
  });

  it('accepts an allowed type (image/png) and calls onFileSelect', () => {
    const onFileSelect = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <AttachmentPicker isOpen onClose={onClose} onFileSelect={onFileSelect} />,
    );

    const input = firstFileInput(container);
    fireEvent.change(input, { target: { files: [fileOf('image/png')] } });

    expect(onFileSelect).toHaveBeenCalledTimes(1);
  });
});
