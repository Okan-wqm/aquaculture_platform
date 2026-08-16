import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AdminHttpContractError,
  decodeAdminAttachmentFilename,
} from '@platform/admin-http-contracts';

import {
  createAdminDownloadFilename,
  decodeAdminNavigationUrl,
  downloadAdminOwnedBlob,
  openAdminNavigation,
} from '../browser-capabilities';

describe('admin browser capability authority', () => {
  const createObjectURL = vi.fn(() => 'blob:https://admin.example.test/owned-object');
  const revokeObjectURL = vi.fn();
  const click = vi.fn();

  beforeEach(() => {
    window.history.replaceState({}, '', '/admin');
    const BrowserUrl = URL;
    class TestUrl extends BrowserUrl {}
    Object.defineProperties(TestUrl, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: revokeObjectURL },
    });
    vi.stubGlobal('URL', TestUrl);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    click.mockClear();
  });

  it('admits only a same-origin absolute application path', () => {
    const decoded = decodeAdminNavigationUrl('/tenant#impersonation_session=session-1');
    expect(new URL(decoded).origin).toBe(window.location.origin);
    expect(new URL(decoded).pathname).toBe('/tenant');
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,unsafe',
    'blob:https://admin.example.test/unowned',
    '//attacker.example.test/tenant',
    'https://attacker.example.test/tenant',
    'tenant/relative',
  ])('rejects untrusted navigation input %s', (candidate) => {
    expect(() => decodeAdminNavigationUrl(candidate)).toThrow(AdminHttpContractError);
  });

  it('opens through the sole capability with opener isolation', () => {
    const opened = { opener: window };
    const open = vi.spyOn(window, 'open').mockReturnValue(opened as Window);

    openAdminNavigation('/tenant#impersonation_session=session-1');

    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('/tenant#impersonation_session=session-1'),
      '_blank',
      'noopener,noreferrer',
    );
    expect(opened.opener).toBeNull();
  });

  it('owns the complete blob URL and anchor lifecycle', () => {
    const blob = new Blob(['id,name\n1,Farm'], { type: 'text/csv' });
    const filename = createAdminDownloadFilename('Ciftlik raporu.csv');

    downloadAdminOwnedBlob({ blob, filename });

    expect(filename).toBe('Ciftlik_raporu.csv');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://admin.example.test/owned-object');
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('revokes the owned URL even when the browser rejects the click', () => {
    click.mockImplementationOnce(() => {
      throw new Error('download blocked');
    });
    const filename = decodeAdminAttachmentFilename('report.csv');

    expect(() => downloadAdminOwnedBlob({ blob: new Blob(['x']), filename })).toThrow(
      'download blocked',
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:https://admin.example.test/owned-object');
    expect(document.querySelector('a[download]')).toBeNull();
  });
});
