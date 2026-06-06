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
        <a href="javascript:alert(1)"><text>bad</text></a>
        <image href="https://evil.example/pixel.png" />
        <image href="#safe-image"><animate attributeName="href" to="https://evil.example/animated.png" /></image>
        <set attributeName="style" to="fill:url(https://evil.example/animated-paint)" />
        <style>@import "https://evil.example/a.css"; .x { fill: url(https://evil.example/paint); }</style>
        <rect fill="url(https://evil.example/gradient)" stroke="u\\rl(https://evil.example/stroke)" filter="url(https://evil.example/filter)" />
        <path mask="url(#safe-mask)" marker-end="url(https://evil.example/marker)" />
        <use href="#safe-symbol" />
      </svg>
    `;

    const svg = wrapper.querySelector('svg') as unknown as SVGElement;
    const sanitized = sanitizeReportSvg(svg);

    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('foreignObject');
    expect(sanitized).not.toContain('<animate');
    expect(sanitized).not.toContain('<set');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('<style');
    expect(sanitized).not.toContain('@import');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).not.toContain('https://evil.example');
    expect(sanitized).toContain('href="#safe-symbol"');
    expect(sanitized).toContain('mask="url(#safe-mask)"');
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
          svg: '<svg class="recharts-surface"><script>alert(1)</script><rect fill="url(https://evil.example/paint)" /><use href="#safe-symbol" /></svg>',
        },
      ],
      deffeyesChart: null,
    });

    expect(html).toContain('Injected Chart');
    expect(html).not.toContain('<script');
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
