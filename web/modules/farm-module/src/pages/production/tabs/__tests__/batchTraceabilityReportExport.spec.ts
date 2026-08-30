/**
 * Pure specs for the printable batch-traceability report builder.
 *
 * The builder is the trust boundary between backend data and a document
 * rendered via document.write — every interpolated value MUST go through
 * escapeHtml, so hostile field content may never become live markup.
 */
import { describe, expect, it } from 'vitest';

import type { BatchTraceability } from '../../../../hooks/useBatchTraceability';
import {
  buildBatchTraceabilityReportHtml,
  formatWaterTemperature,
} from '../batchTraceabilityReportExport';

function makeTraceability(): BatchTraceability {
  return {
    summary: {
      batchId: 'batch-1',
      batchNumber: 'B-2026-001',
      status: 'GROWING',
      speciesName: 'Rainbow Trout',
      stockedAt: '2026-03-01T00:00:00.000Z',
      harvestedAt: null,
      daysInProduction: 123,
      initialQuantity: 12000,
      currentQuantity: 10500,
      initialAvgWeightG: 5,
      currentAvgWeightG: 250,
      survivalRatePercent: 87.5,
      protocolId: 'proto-1',
      protocolName: 'Trout Grower 2026',
      totalFeedKg: 3120.5,
      totalFeedCost: 5430.25,
      totalFeedCostDecimal: '5430.25',
      fcrActual: 1.19,
    },
    residencies: [
      {
        tankId: 'tank-1',
        tankName: 'Tank A-1',
        tankCode: 'TNK-A1',
        movedAt: '2026-03-01T00:00:00.000Z',
        exitedAt: '2026-05-01T00:00:00.000Z',
        isCurrent: false,
        durationDays: 61,
        quantityAtEntry: 12000,
        avgWeightAtEntryG: 5,
        transferReason: 'stocking',
        water: {
          temperatureMinC: 11.2,
          temperatureAvgC: 13.4,
          temperatureMaxC: 16.8,
          measurementCount: 240,
        },
        feed: [
          {
            feedId: 'feed-1',
            feedName: 'Starter Pellet',
            feedCode: 'SP-1',
            totalKg: 820.5,
            totalCost: 1400.75,
            totalCostDecimal: '1400.75',
          },
        ],
        feedTotalKg: 820.5,
      },
      {
        tankId: 'tank-2',
        tankName: 'Tank B-2',
        tankCode: 'TNK-B2',
        movedAt: '2026-05-01T00:00:00.000Z',
        exitedAt: null,
        isCurrent: true,
        durationDays: 62,
        quantityAtEntry: 11000,
        avgWeightAtEntryG: 120,
        transferReason: null,
        water: {
          temperatureMinC: null,
          temperatureAvgC: null,
          temperatureMaxC: null,
          measurementCount: 0,
        },
        feed: [],
        feedTotalKg: 2300,
      },
    ],
    feedTotals: [
      {
        feedId: 'feed-2',
        feedName: 'Grower Pellet',
        feedCode: 'GP-2',
        totalKg: 2300,
        totalCostDecimal: '4029.5',
        totalCost: 4029.5,
      },
    ],
    events: [
      {
        id: 'evt-1',
        eventType: 'MORTALITY',
        timestamp: '2026-04-10T09:30:00.000Z',
        description: 'Mortality recorded after storm',
        performedBy: 'operator@farm.test',
        tankId: 'tank-1',
        tankCode: 'TNK-A1',
        quantityChange: -500,
        biomassChangeKg: -12.5,
      },
    ],
  };
}

describe('buildBatchTraceabilityReportHtml', () => {
  it('includes the summary and residency rows with per-stay aggregates', () => {
    const html = buildBatchTraceabilityReportHtml(
      makeTraceability(),
      new Date('2026-07-04T12:00:00.000Z'),
    );

    // Summary header.
    expect(html).toContain('Batch Traceability Report');
    expect(html).toContain('B-2026-001');
    expect(html).toContain('Rainbow Trout');
    expect(html).toContain('Trout Grower 2026');

    // Residency rows — both tanks, the current stay labelled as such.
    expect(html).toContain('Tank A-1');
    expect(html).toContain('TNK-A1');
    expect(html).toContain('Tank B-2');
    expect(html).toContain('→ current');

    // Measured stay shows real aggregates; unmeasured stay stays honest.
    expect(html).toContain('11.2 / 13.4 / 16.8');
    expect(formatWaterTemperature(makeTraceability().residencies[1]!.water)).toBe('—');

    // Feed totals + events sections carry their data through.
    expect(html).toContain('Grower Pellet');
    expect(html).toContain('Mortality recorded after storm');
    expect(html).toContain('-500');
  });

  it('escapes hostile HTML in every interpolated field', () => {
    const traceability = makeTraceability();
    traceability.summary.batchNumber = 'B<script>alert(1)</script>';
    traceability.summary.speciesName = '<img src=x onerror=alert(2)>';
    traceability.residencies[0]!.tankName = 'Tank "A" & <b>bold</b>';
    traceability.events[0]!.description = '<iframe src="https://evil.example"></iframe>';

    const html = buildBatchTraceabilityReportHtml(
      traceability,
      new Date('2026-07-04T12:00:00.000Z'),
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('<iframe src=');
    expect(html).toContain('B&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('Tank &quot;A&quot; &amp; &lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&lt;iframe src=&quot;https://evil.example&quot;&gt;&lt;/iframe&gt;');
  });

  it('renders honest empty-state rows when a section has no records', () => {
    const traceability = makeTraceability();
    traceability.residencies = [];
    traceability.feedTotals = [];
    traceability.events = [];

    const html = buildBatchTraceabilityReportHtml(
      traceability,
      new Date('2026-07-04T12:00:00.000Z'),
    );

    expect((html.match(/No records/g) ?? []).length).toBe(3);
  });
});
