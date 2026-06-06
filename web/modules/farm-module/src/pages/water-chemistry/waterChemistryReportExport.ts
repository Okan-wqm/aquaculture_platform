export type PrintReportResult = 'popup' | 'iframe' | 'unavailable';

export interface ReportChartSnapshot {
  title: string;
  subtitle: string;
  svg: string;
}

export interface WaterChemistryReportHtmlInput {
  generatedAt: Date;
  parameters: string[][];
  results: string[][];
  charts: ReportChartSnapshot[];
  deffeyesChart: ReportChartSnapshot | null;
}

const BLOCKED_SVG_ELEMENTS = new Set([
  'animate',
  'animatemotion',
  'animatetransform',
  'discard',
  'mpath',
  'set',
  'script',
  'style',
  'foreignobject',
  'iframe',
  'object',
  'embed',
]);

const URL_ATTRIBUTE_NAMES = new Set([
  'clip-path',
  'filter',
  'href',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'xlink:href',
  'src',
]);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeReference(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || trimmed.startsWith('#') || /^url\(\s*#[^)]+\)$/i.test(trimmed);
}

function hasUnsafeCssReference(value: string): boolean {
  if (value.includes('\\')) return true;
  const compact = value
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  if (compact.includes('@import')) return true;
  if (/\\[0-9a-f]{1,6}/i.test(value)) return true;
  return compact.includes('url(') && !/^url\(#[-\w:.]+\)$/.test(compact);
}

function sanitizeSvgNode(node: Element): void {
  const children = Array.from(node.children);
  for (const child of children) {
    if (BLOCKED_SVG_ELEMENTS.has(child.tagName.toLowerCase())) {
      child.remove();
      continue;
    }

    sanitizeSvgNode(child);
  }

  for (const attribute of Array.from(node.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;

    if (name.startsWith('on')) {
      node.removeAttribute(attribute.name);
      continue;
    }

    if (URL_ATTRIBUTE_NAMES.has(name) && !isSafeReference(value)) {
      node.removeAttribute(attribute.name);
      continue;
    }

    if (name === 'style') {
      node.removeAttribute(attribute.name);
      continue;
    }

    if (hasUnsafeCssReference(value)) {
      node.removeAttribute(attribute.name);
    }
  }
}

export function sanitizeReportSvg(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute('width', '100%');
  clone.removeAttribute('height');
  sanitizeSvgNode(clone);
  return clone.outerHTML;
}

export function sanitizeReportSvgMarkup(svgMarkup: string): string {
  if (typeof document === 'undefined') return '';
  const container = document.createElement('div');
  container.innerHTML = svgMarkup;
  const svg = container.querySelector('svg');
  return svg instanceof SVGElement ? sanitizeReportSvg(svg) : '';
}

export function collectWaterChemistryReportCharts(root: HTMLElement): {
  charts: ReportChartSnapshot[];
  deffeyesChart: ReportChartSnapshot | null;
} {
  const charts: ReportChartSnapshot[] = [];

  root.querySelectorAll('.bg-white.rounded-lg, .bg-white.rounded-xl').forEach((card) => {
    const title = card.querySelector('h3')?.textContent ?? '';
    const subtitle = card.querySelector('p')?.textContent ?? '';
    const svg = card.querySelector('svg.recharts-surface');
    if (svg instanceof SVGElement && title) {
      charts.push({
        title,
        subtitle,
        svg: sanitizeReportSvg(svg),
      });
    }
  });

  const deffeyesRoot = root.querySelector('[data-report-chart-id="deffeyes"]');
  const deffeyesSvgNode = deffeyesRoot?.querySelector('svg.recharts-surface');
  const deffeyesChart = deffeyesRoot && deffeyesSvgNode instanceof SVGElement
    ? {
        title: deffeyesRoot.querySelector('h3')?.textContent ?? 'Water Quality Management Chart',
        subtitle: deffeyesRoot.querySelector('p')?.textContent ?? '',
        svg: sanitizeReportSvg(deffeyesSvgNode),
      }
    : null;

  return { charts, deffeyesChart };
}

function chartHtml(chart: ReportChartSnapshot | null | undefined): string {
  if (!chart) return '';
  const safeSvg = sanitizeReportSvgMarkup(chart.svg);
  return `<div style="margin-bottom:2px"><strong style="font-size:11px">${escapeHtml(chart.title)}</strong>${
    chart.subtitle ? `<br><span style="font-size:9px;color:#666">${escapeHtml(chart.subtitle)}</span>` : ''
  }</div>${safeSvg}`;
}

function tableHtml(rows: string[][], title: string): string {
  return `
      <div style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:bold;margin-bottom:3px;border-bottom:1px solid #333;padding-bottom:2px">${escapeHtml(title)}</div>
        <table style="width:100%;border-collapse:collapse;font-size:10px">
          ${rows.map(row => `<tr>${row.map((cell, index) => `<td style="padding:2px 6px;border:1px solid #ddd;${index % 2 === 0 ? 'background:#f9fafb;font-weight:500;width:18%' : 'width:32%'}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
        </table>
      </div>`;
}

export function buildWaterChemistryReportHtml(input: WaterChemistryReportHtmlInput): string {
  const [chart0, chart1, , chart3, chart4] = input.charts;
  const generatedAt = escapeHtml(input.generatedAt.toLocaleString());

  return `<!DOCTYPE html><html><head><title>Water Chemistry Report</title>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
    <style>
      @page { size: A4 landscape; margin: 8mm; }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 10px; color: #111; }
      .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #111; padding-bottom: 4px; margin-bottom: 6px; }
      .header h1 { font-size: 16px; }
      .header .date { font-size: 10px; color: #666; }
      .content { display: grid; grid-template-columns: 1fr 1.5fr 1fr; gap: 6px; }
      .chart-box { border: 1px solid #ddd; border-radius: 4px; padding: 4px; overflow: hidden; }
      .chart-box svg { width: 100%; display: block; }
      .side-charts { display: flex; flex-direction: column; gap: 6px; }
      .tables { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
      @media print {
        body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      }
    </style></head><body>
      <div class="header">
        <div><h1>Water Chemistry Report</h1><div class="date">${generatedAt}</div></div>
        <div style="text-align:right;font-size:9px;color:#444">Millero Equations | Mucci 1983 Ksp</div>
      </div>
      <div class="tables">${tableHtml(input.parameters, 'Parameters')}${tableHtml(input.results, 'Calculated Results')}</div>
      <div class="content" style="margin-top:6px">
        <div class="side-charts">
          <div class="chart-box">${chartHtml(chart0)}</div>
          <div class="chart-box">${chartHtml(chart1)}</div>
        </div>
        <div class="chart-box">${chartHtml(input.deffeyesChart ?? input.charts[2])}</div>
        <div class="side-charts">
          <div class="chart-box">${chartHtml(chart3)}</div>
          <div class="chart-box">${chartHtml(chart4)}</div>
        </div>
      </div>
    </body></html>`;
}

function printFrame(frameWindow: Window, cleanup: () => void): void {
  try {
    frameWindow.focus?.();
    frameWindow.print();
  } catch {
    // Some test and kiosk environments expose a non-callable native print shim.
  } finally {
    window.setTimeout(cleanup, 1000);
  }
}

export function printWaterChemistryReport(html: string): PrintReportResult {
  if (!document?.body) {
    return 'unavailable';
  }

  const frame = document.createElement('iframe');
  frame.setAttribute('title', 'Water Chemistry Report');
  frame.style.position = 'fixed';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.left = '-10000px';
  frame.style.top = '0';
  document.body.appendChild(frame);

  const frameWindow = frame.contentWindow;
  const frameDocument = frame.contentDocument ?? frameWindow?.document;
  if (!frameWindow || !frameDocument) {
    frame.remove();
    return 'unavailable';
  }

  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
  window.setTimeout(() => printFrame(frameWindow, () => frame.remove()), 0);
  return 'iframe';
}
