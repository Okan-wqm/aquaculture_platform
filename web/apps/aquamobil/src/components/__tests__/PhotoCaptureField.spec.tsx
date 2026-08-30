/**
 * PhotoCaptureField tests — incident evidence capture.
 *
 * Pins:
 *   - renders the field (photo section + add control),
 *   - OFFLINE → the capture control is disabled with an honest hint,
 *   - a successful upload shows a thumbnail and threads the storageKey to
 *     onChange (tested through the real controlled contract via a stateful host).
 */
import { render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react';
import { type ReactElement, useState } from 'react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

const mockUploadPhoto = vi.fn<(file: File, incidentType: string) => Promise<string>>();
let mockIsOnline = true;

vi.mock('@/hooks/useIncidentMediaUpload', () => ({
  useIncidentMediaUpload: () => ({
    uploadPhoto: mockUploadPhoto,
    isUploading: false,
    progress: 0,
    error: null,
  }),
}));

vi.mock('@/hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockIsOnline,
}));

import { PhotoCaptureField } from '../PhotoCaptureField';

/** Stateful host so the controlled `value`/`onChange` contract runs for real. */
function Host({ onChangeSpy }: { onChangeSpy?: (keys: string[]) => void }): ReactElement {
  const [keys, setKeys] = useState<string[]>([]);
  return (
    <PhotoCaptureField
      incidentType="WELFARE"
      value={keys}
      onChange={(next) => {
        onChangeSpy?.(next);
        setKeys(next);
      }}
    />
  );
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('no file input rendered');
  return input as HTMLInputElement;
}

describe('PhotoCaptureField', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnline = true;
    // jsdom implements neither — stub so the thumbnail preview + cleanup work.
    URL.createObjectURL = vi.fn(() => 'blob:mock-preview');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the photos section with an add control when online', () => {
    render(<PhotoCaptureField incidentType="ESCAPE" value={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/photos/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /add photo/i })).toBeTruthy();
  });

  it('offline: disables capture with an honest hint', () => {
    mockIsOnline = false;
    render(<PhotoCaptureField incidentType="ESCAPE" value={[]} onChange={vi.fn()} />);

    const addBtn = screen.getByRole('button', { name: /add photo/i });
    expect(addBtn).toHaveProperty('disabled', true);
    expect(screen.getByText(/connect to add photos/i)).toBeTruthy();
    expect(mockUploadPhoto).not.toHaveBeenCalled();
  });

  it('on a successful upload: shows a thumbnail and threads the storageKey to onChange', async () => {
    mockUploadPhoto.mockResolvedValue('incidents/photo-1');
    const onChangeSpy = vi.fn();
    const { container } = render(<Host onChangeSpy={onChangeSpy} />);

    fireEvent.change(fileInput(container), {
      target: { files: [new File([new Uint8Array(8)], 'p.jpg', { type: 'image/jpeg' })] },
    });

    await waitFor(() => expect(onChangeSpy).toHaveBeenCalledWith(['incidents/photo-1']));
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(mockUploadPhoto).toHaveBeenCalledTimes(1);
    expect(mockUploadPhoto.mock.calls[0]?.[1]).toBe('WELFARE');
  });
});
