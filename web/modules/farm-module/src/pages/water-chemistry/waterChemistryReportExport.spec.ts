import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildWaterChemistryReportHtml,
  printWaterChemistryReport,
  sanitizeReportSvg,
} from './waterChemistryReportExport';

describe('waterChemistryReportExport', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sanitizes cloned SVG content before report embedding', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <svg class="recharts-surface" onclick="alert(1)" style="background:url(https://evil.example/x)">
        <script>alert(1)</script>
        <foreignObject><div>unsafe</div></foreignObject>
        <customWidget><path d="M0 0L1 1" /></customWidget>
        <a href="javascript:alert(1)"><text>bad</text></a>
        <image href="https://evil.example/pixel.png" />
        <image href="#safe-image"><animate attributeName="href" to="https://evil.example/animated.png" /></image>
        <set attributeName="style" to="fill:url(https://evil.example/animated-paint)" />
        <style>@import "https://evil.example/a.css"; .x { fill: url(https://evil.example/paint); }</style>
        <rect fill="url(https://evil.example/gradient)" stroke="u\\rl(https://evil.example/stroke)" filter="url(https://evil.example/filter)" clip-path="url(https://evil.example/clip)" mask="url(https://evil.example/mask)" />
        <path mask="url(#safe-mask)" marker-end="url(https://evil.example/marker)" data-unknown-url="@import url(https://evil.example/data)" />
        <use href="#safe-symbol" />
        <iframe src="https://evil.example/frame"></iframe>
        <object data="https://evil.example/object"></object>
        <embed src="https://evil.example/embed"></embed>
      </svg>
    `;

    const svg = wrapper.querySelector('svg') as unknown as SVGElement;
    const sanitized = sanitizeReportSvg(svg);

    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toMatch(/<(?:a|customwidget|embed|foreignobject|iframe|image|object)\b/i);
    expect(sanitized).not.toContain('<animate');
    expect(sanitized).not.toContain('<set');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('style=');
    expect(sanitized).not.toContain('<style');
    expect(sanitized).not.toContain('@import');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).not.toContain('https://evil.example');
    expect(sanitized).not.toContain('marker-end');
    expect(sanitized).not.toContain('data-unknown-url');
    expect(sanitized).toContain('href="#safe-symbol"');
    expect(sanitized).toContain('mask="url(#safe-mask)"');
  });

  it('preserves chart-safe SVG elements and local paint, clip, and mask references', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <svg class="recharts-surface" viewBox="0 0 100 100" width="640" height="320" role="img">
        <title>Safe chart</title>
        <desc>Renderable report chart</desc>
        <defs>
          <linearGradient id="safeGradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#ffffff" stop-opacity="1" />
            <stop offset="100%" stop-color="#2563eb" stop-opacity="0.8" />
          </linearGradient>
          <clipPath id="safeClip"><rect x="0" y="0" width="80" height="80" /></clipPath>
          <mask id="safeMask"><rect x="0" y="0" width="100" height="100" fill="#fff" /></mask>
        </defs>
        <g data-testid="deffeyes-layer-safe-zone" data-layer-id="deffeyes-layer-safe-zone" clip-path="url(#safeClip)" mask="url(#safeMask)" transform="translate(4 6)">
          <path d="M0 0L20 20" fill="url(#safeGradient)" stroke="#111827" stroke-width="2" />
          <line x1="0" y1="10" x2="80" y2="10" stroke="#2563eb" stroke-dasharray="4 2" />
          <polyline points="0,0 20,20 40,10" fill="none" stroke="#16a34a" />
          <polygon data-layer-id="deffeyes-layer-safe-zone-polygon" points="10,10 20,30 0,30" fill="rgba(34, 197, 94, 0.15)" />
          <circle cx="35" cy="35" r="3" fill="#ef4444" />
          <ellipse cx="50" cy="50" rx="6" ry="3" fill="#f59e0b" />
          <text x="8" y="18" text-anchor="middle" font-size="12"><tspan dx="1" dy="2">pH 7.0</tspan></text>
          <use href="#safeSymbol" x="4" y="4" />
        </g>
      </svg>
    `;

    const svg = wrapper.querySelector('svg') as unknown as SVGElement;
    const sanitized = sanitizeReportSvg(svg);

    expect(sanitized).toContain('viewBox="0 0 100 100"');
    expect(sanitized).toContain('<title>Safe chart</title>');
    expect(sanitized).toContain('<desc>Renderable report chart</desc>');
    expect(sanitized).toContain('id="safeGradient"');
    expect(sanitized).toContain('fill="url(#safeGradient)"');
    expect(sanitized).toContain('clip-path="url(#safeClip)"');
    expect(sanitized).toContain('mask="url(#safeMask)"');
    expect(sanitized).toContain('data-testid="deffeyes-layer-safe-zone"');
    expect(sanitized).toContain('data-layer-id="deffeyes-layer-safe-zone-polygon"');
    expect(sanitized).toContain('<tspan dx="1" dy="2">pH 7.0</tspan>');
    expect(sanitized).toContain('<polyline points="0,0 20,20 40,10"');
    expect(sanitized).toContain('points="10,10 20,30 0,30"');
    expect(sanitized).toContain('href="#safeSymbol"');
  });

  it('escapes report table text and chart titles', () => {
    const html = buildWaterChemistryReportHtml({
      generatedAt: new Date('2026-06-05T00:00:00Z'),
      parameters: [['<Temperature>', '"12"', 'Fish', '<script>alert(1)</script>']],
      results: [['Status', 'SAFE & SOUND', 'H₂S', '15']],
      charts: [
        {
          title: '<Bad Chart>',
          subtitle: 'A&B',
          svg: '<svg class="recharts-surface"><text>safe</text></svg>',
        },
      ],
      deffeyesChart: null,
    });

    expect(html).toContain('&lt;Temperature&gt;');
    expect(html).toContain('&quot;12&quot;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;Bad Chart&gt;');
    expect(html).toContain('A&amp;B');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('sanitizes chart SVG at the report builder boundary', () => {
    const html = buildWaterChemistryReportHtml({
      generatedAt: new Date('2026-06-05T00:00:00Z'),
      parameters: [['Mode', 'DIC/pH']],
      results: [['Status', 'SAFE']],
      charts: [
        {
          title: 'Injected Chart',
          subtitle: '',
          svg: '<svg class="recharts-surface"><script>alert(1)</script><unknown><path d="M0 0L1 1" /></unknown><rect fill="url(https://evil.example/paint)" /><use href="#safe-symbol" /></svg>',
        },
      ],
      deffeyesChart: null,
    });

    expect(html).toContain('Injected Chart');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<unknown');
    expect(html).not.toContain('https://evil.example');
    expect(html).toContain('href="#safe-symbol"');
  });

  it('prints through a same-origin iframe without opening a noopener blank tab', () => {
    vi.useFakeTimers();
    const openSpy = vi.spyOn(window, 'open');
    const result = printWaterChemistryReport('<!DOCTYPE html><html><body>report</body></html>');
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Water Chemistry Report"]');

    expect(result).toBe('iframe');
    expect(openSpy).not.toHaveBeenCalled();
    expect(frame).toBeInTheDocument();
    expect(frame?.contentDocument?.body.textContent).toContain('report');
    if (frame?.contentWindow) {
      Object.defineProperty(frame.contentWindow, 'focus', { value: vi.fn(), configurable: true });
      Object.defineProperty(frame.contentWindow, 'print', { value: vi.fn(), configurable: true });
    }

    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('iframe[title="Water Chemistry Report"]')).not.toBeInTheDocument();
  });

  it('cleans up iframe fallback even when focus throws', () => {
    vi.useFakeTimers();
    const result = printWaterChemistryReport('<!DOCTYPE html><html><body>report</body></html>');
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Water Chemistry Report"]');
    expect(result).toBe('iframe');
    expect(frame).toBeInTheDocument();

    if (frame?.contentWindow) {
      Object.defineProperty(frame.contentWindow, 'focus', {
        value: () => {
          throw new Error('focus unavailable');
        },
        configurable: true,
      });
      Object.defineProperty(frame.contentWindow, 'print', { value: vi.fn(), configurable: true });
    }

    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('iframe[title="Water Chemistry Report"]')).not.toBeInTheDocument();
  });
});
