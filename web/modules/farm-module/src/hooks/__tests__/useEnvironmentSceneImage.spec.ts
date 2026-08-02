import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { blobRequestMock } = vi.hoisted(() => ({
  blobRequestMock: vi.fn(),
}));

vi.mock('@aquaculture/shared-ui', async () => {
  const { createSharedUiMock } = await import('../../test-utils/sharedUiMock');
  return {
    ...(await createSharedUiMock()),
    restClient: { requestBlob: blobRequestMock },
  };
});

import { ENVIRONMENT_SCENE_RENDER_TIMEOUT_MS, useEnvironmentSceneImage } from '../useEnvironment';

beforeEach(() => {
  blobRequestMock.mockReset();
});

describe('useEnvironmentSceneImage', () => {
  it('terminates loading with a stable error when the active browser deadline aborts', async () => {
    blobRequestMock.mockRejectedValueOnce(new DOMException('Request timed out', 'AbortError'));

    const { result } = renderHook(() =>
      useEnvironmentSceneImage({
        siteId: '10000000-0000-4000-8000-000000000001',
        layerId: 'catalog:sentinel-image',
        sceneId: 'S2-REAL-SCENE-1',
        enabled: true,
      }),
    );

    await waitFor(() => {
      expect(result.current).toEqual({
        imageUrl: null,
        isLoading: false,
        error: 'The selected satellite image could not be loaded.',
      });
    });
    expect(blobRequestMock).toHaveBeenCalledWith(
      'POST',
      '/marine/sites/10000000-0000-4000-8000-000000000001/render',
      expect.objectContaining({ timeout: ENVIRONMENT_SCENE_RENDER_TIMEOUT_MS }),
    );
  });
});
