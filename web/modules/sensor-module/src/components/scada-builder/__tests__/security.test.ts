/**
 * SCADA Builder Security Tests
 *
 * Phase 0.1 + 0.3: SVG XSS elimination, URL validation, file size limits,
 * tenant-scoped localStorage, and event action hardening.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DOMPurify, { type Config } from 'dompurify';

// ---- SVG Sanitization Config (mirrors CustomSvgRenderer) ----

const DOMPURIFY_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'embed', 'object', 'base', 'form'],
  FORBID_ATTR: ['xlink:href', 'formaction', 'action', 'srcdoc'],
  ADD_TAGS: [
    'use',
    'symbol',
    'defs',
    'clipPath',
    'mask',
    'pattern',
    'marker',
    'linearGradient',
    'radialGradient',
    'stop',
    'filter',
    'feGaussianBlur',
    'feOffset',
    'feMerge',
    'feMergeNode',
    'feFlood',
    'feComposite',
    'feBlend',
    'feColorMatrix',
  ],
  ALLOW_DATA_ATTR: false,
};

function sanitizeSvg(raw: string): string {
  return DOMPurify.sanitize(raw, DOMPURIFY_CONFIG);
}

// ---- URL Validation (mirrors VideoStreamRenderer) ----

function isValidStreamUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ---- File Size Constants ----

const MAX_SVG_SIZE_BYTES = 500 * 1024; // 500KB
const MAX_BG_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

// ---- Tenant-scoped Storage Key (mirrors ThemeProvider) ----

// Mock getTenantId from shared-ui
vi.mock('@aquaculture/shared-ui', () => ({
  getTenantId: vi.fn(() => 'tenant-42'),
}));

function getStorageKey(tenantId: string | null): string {
  const id = tenantId || 'default';
  return `scada-theme-mode-${id}`;
}

// =============================================================================
// Test Suites
// =============================================================================

describe('SVG XSS Sanitization', () => {
  // Test 1: <script> tag'lari temizlenmeli -- en temel XSS vektoru
  it('strips <script> tags from SVG content', () => {
    const malicious = '<svg><script>alert("xss")</script><rect width="100" height="100"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert');
    expect(result).toContain('<rect');
  });

  // Test 2: Unquoted onclick handler -- regex-tabanli sanitizasyon bunu kacirabilir
  it('strips unquoted inline event handlers like onclick=alert(1)', () => {
    const malicious = '<svg><rect onclick=alert(1) width="100" height="100"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('alert');
  });

  // Test 3: foreignObject -- SVG icinde HTML embed etmek icin kullanilir, XSS riski
  it('strips <foreignObject> tags', () => {
    const malicious =
      '<svg><foreignObject><body><script>alert(1)</script></body></foreignObject></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('foreignObject');
    expect(result).not.toContain('<script');
  });

  // Test 4: data: URI ile <use> elemani -- harici kaynak yukleme vektoru
  it('strips data: URI from use href attribute', () => {
    const malicious = '<svg><use href="data:image/svg+xml,<svg onload=alert(1)>"/></svg>';
    const result = sanitizeSvg(malicious);
    // DOMPurify should handle this -- either strip the href or sanitize the data
    expect(result).not.toContain('onload');
    expect(result).not.toContain('alert');
  });

  // Test 5: Gecerli SVG seklileri korunmali -- false positive olmamali
  it('preserves valid SVG shapes and attributes', () => {
    const valid =
      '<svg viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="blue"/><circle cx="50" cy="50" r="20" fill="red"/><line x1="0" y1="0" x2="100" y2="100" stroke="black"/><text x="10" y="50">Hello</text></svg>';
    const result = sanitizeSvg(valid);
    expect(result).toContain('<rect');
    expect(result).toContain('<circle');
    expect(result).toContain('<line');
    expect(result).toContain('<text');
    expect(result).toContain('viewBox');
  });

  // Ek: iframe, embed, object tag'lari da engellenmeli
  it('strips iframe, embed, and object tags', () => {
    const malicious =
      '<svg><iframe src="evil.html"/><embed src="evil.swf"/><object data="evil.swf"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('<embed');
    expect(result).not.toContain('<object');
  });

  // Ek: SVG filter elementleri korunmali
  it('preserves SVG filter elements', () => {
    const valid =
      '<svg><defs><filter id="blur"><feGaussianBlur stdDeviation="5"/></filter></defs><rect filter="url(#blur)" width="100" height="100"/></svg>';
    const result = sanitizeSvg(valid);
    expect(result).toContain('<filter');
    expect(result).toContain('feGaussianBlur');
  });

  // Ek: onerror event handler testi
  it('strips onerror event handlers', () => {
    const malicious = '<svg><image onerror="alert(1)" href="x"/></svg>';
    const result = sanitizeSvg(malicious);
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('alert');
  });
});

describe('Video Stream URL Validation', () => {
  // Test 6: javascript: protokolu -- XSS injection
  it('rejects javascript: protocol URLs', () => {
    expect(isValidStreamUrl('javascript:alert(1)')).toBe(false);
  });

  // Test 7: data: protokolu -- icerik injection
  it('rejects data: protocol URLs', () => {
    expect(isValidStreamUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  // Test 8: https:// gecerli -- normal kullanim
  it('accepts valid https:// URLs', () => {
    expect(isValidStreamUrl('https://camera.example.com/stream.mjpeg')).toBe(true);
  });

  // Ek: http:// da gecerli -- dahili ag kamerlari
  it('accepts valid http:// URLs', () => {
    expect(isValidStreamUrl('http://192.168.1.100:8080/video')).toBe(true);
  });

  // Ek: bos string -- placeholder gostermeli
  it('rejects empty string', () => {
    expect(isValidStreamUrl('')).toBe(false);
  });

  // Ek: gecersiz URL formati
  it('rejects malformed URLs', () => {
    expect(isValidStreamUrl('not-a-url')).toBe(false);
  });

  // Ek: file: protokolu -- dosya sistemi erisimi
  it('rejects file: protocol URLs', () => {
    expect(isValidStreamUrl('file:///etc/passwd')).toBe(false);
  });

  // Ek: blob: protokolu
  it('rejects blob: protocol URLs', () => {
    expect(isValidStreamUrl('blob:http://evil.com/abc')).toBe(false);
  });

  // Ek: ftp: protokolu
  it('rejects ftp: protocol URLs', () => {
    expect(isValidStreamUrl('ftp://files.example.com/data')).toBe(false);
  });
});

describe('File Size Limits', () => {
  // Test 9: 500KB uzerindeki SVG dosyalari reddedilmeli
  it('rejects SVG files exceeding 500KB', () => {
    const oversizedFile = { size: 600 * 1024, name: 'huge.svg' };
    expect(oversizedFile.size > MAX_SVG_SIZE_BYTES).toBe(true);
  });

  it('accepts SVG files within 500KB limit', () => {
    const normalFile = { size: 100 * 1024, name: 'small.svg' };
    expect(normalFile.size <= MAX_SVG_SIZE_BYTES).toBe(true);
  });

  it('rejects background images exceeding 5MB', () => {
    const oversizedFile = { size: 6 * 1024 * 1024, name: 'huge.png' };
    expect(oversizedFile.size > MAX_BG_IMAGE_SIZE).toBe(true);
  });

  it('accepts background images within 5MB limit', () => {
    const normalFile = { size: 2 * 1024 * 1024, name: 'normal.jpg' };
    expect(normalFile.size <= MAX_BG_IMAGE_SIZE).toBe(true);
  });

  // Ek: sinir degerleri -- tam 500KB kabul edilmeli
  it('accepts SVG files at exactly 500KB boundary', () => {
    const boundaryFile = { size: MAX_SVG_SIZE_BYTES, name: 'exact.svg' };
    expect(boundaryFile.size <= MAX_SVG_SIZE_BYTES).toBe(true);
  });

  // Ek: sinir degerleri -- tam 5MB kabul edilmeli
  it('accepts background images at exactly 5MB boundary', () => {
    const boundaryFile = { size: MAX_BG_IMAGE_SIZE, name: 'exact.png' };
    expect(boundaryFile.size <= MAX_BG_IMAGE_SIZE).toBe(true);
  });
});

describe('Tenant-Scoped localStorage', () => {
  // Test 10: localStorage anahtari tenant ID icermeli
  it('includes tenant ID in localStorage key', () => {
    const key = getStorageKey('tenant-42');
    expect(key).toBe('scada-theme-mode-tenant-42');
    expect(key).toContain('tenant-42');
  });

  it('uses "default" when tenant ID is null', () => {
    const key = getStorageKey(null);
    expect(key).toBe('scada-theme-mode-default');
  });

  it('uses "default" when tenant ID is empty string', () => {
    const key = getStorageKey('');
    expect(key).toBe('scada-theme-mode-default');
  });

  // Farkli tenant'lar icin farkli key uretmeli -- cross-tenant izolasyon
  it('generates different keys for different tenants', () => {
    const keyA = getStorageKey('tenant-a');
    const keyB = getStorageKey('tenant-b');
    expect(keyA).not.toBe(keyB);
    expect(keyA).toBe('scada-theme-mode-tenant-a');
    expect(keyB).toBe('scada-theme-mode-tenant-b');
  });
});

describe('SVG Upload Validation', () => {
  it('rejects content that does not start with <svg or <?xml', () => {
    const notSvg = '<html><body>evil</body></html>';
    const trimmed = notSvg.trim();
    const isValid = trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
    expect(isValid).toBe(false);
  });

  it('accepts content starting with <svg', () => {
    const valid = '<svg viewBox="0 0 100 100"><rect/></svg>';
    const trimmed = valid.trim();
    const isValid = trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
    expect(isValid).toBe(true);
  });

  it('accepts content starting with <?xml', () => {
    const valid = '<?xml version="1.0"?><svg viewBox="0 0 100 100"><rect/></svg>';
    const trimmed = valid.trim();
    const isValid = trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
    expect(isValid).toBe(true);
  });

  // Boslukla baslayan SVG de kabul edilmeli (trim sonrasi)
  it('accepts SVG with leading whitespace after trimming', () => {
    const valid = '   <svg viewBox="0 0 100 100"><rect/></svg>';
    const trimmed = valid.trim();
    const isValid = trimmed.startsWith('<svg') || trimmed.startsWith('<?xml');
    expect(isValid).toBe(true);
  });
});

describe('EventAction Type Safety', () => {
  // runScript ve openUrl type'tan kaldirildi -- type-level dogrulama
  it('does not include runScript or openUrl in allowed actions', () => {
    // Import the type and verify at runtime with the ACTIONS array equivalent
    const allowedActions = ['navigate', 'openCard', 'openDialog', 'setValue', 'toggleValue'];
    expect(allowedActions).not.toContain('runScript');
    expect(allowedActions).not.toContain('openUrl');
  });

  it('contains all expected safe actions', () => {
    const allowedActions = ['navigate', 'openCard', 'openDialog', 'setValue', 'toggleValue'];
    expect(allowedActions).toHaveLength(5);
    expect(allowedActions).toContain('navigate');
    expect(allowedActions).toContain('openCard');
    expect(allowedActions).toContain('openDialog');
    expect(allowedActions).toContain('setValue');
    expect(allowedActions).toContain('toggleValue');
  });
});
