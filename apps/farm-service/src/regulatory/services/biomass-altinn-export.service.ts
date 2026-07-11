/**
 * BiomassAltinnExportService (RPT-001, Phase 5) — renders a biomass report into
 * a form-ordered export the operator transcribes into the Fiskeridirektoratet
 * Altinn FD-0001 form (monthly biomass + feed reporting). The platform has no
 * automated FDIR channel, so this export IS the submission aid: a machine-
 * parseable CSV plus a printable text block, both built deterministically from
 * the persisted (assembled) biomass payload.
 *
 * Pure builder — no DB, no clock — so it is golden-fixture testable; the
 * resolver stamps `generatedAt`.
 */
import { Injectable } from '@nestjs/common';

import { BiomassReport, BiomassReportPayload } from '../entities/biomass-report.entity';

export interface BiomassAltinnExport {
  /** `FD-0001-<site8>-<year>-<mm>.csv` */
  filename: string;
  periodLabel: string;
  /** `Section,Field,Value` rows — form-ordered, machine-parseable. */
  csv: string;
  /** Human-readable, section-ordered block for printing/transcription. */
  printable: string;
}

function kg(value: number): string {
  return value.toFixed(2);
}

function csvCell(value: string | number): string {
  // Numbers are our own formatted values — never a spreadsheet formula, and a
  // leading-minus negative must stay numeric, so pass them through untouched.
  if (typeof value === 'number') {
    return String(value);
  }
  // SEC-MEDIUM-002 — CSV formula/injection neutralisation. A tenant-controlled
  // string cell (species name, feed name, mortality cause) that a spreadsheet
  // would evaluate as a formula — leading '=', '+', '-', '@', tab, or CR — is
  // prefixed with a single quote so the cell opens as literal text and never
  // executes (OWASP CSV Injection). Standard RFC-4180 quoting still applies.
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

@Injectable()
export class BiomassAltinnExportService {
  build(report: BiomassReport): BiomassAltinnExport {
    const mm = report.reportMonth.toString().padStart(2, '0');
    const periodLabel = `${report.reportYear}-${mm}`;
    const filename = `FD-0001-${report.siteId.slice(0, 8)}-${periodLabel}.csv`;

    const rows = this.buildRows(report);
    const csv = [
      'Section,Field,Value',
      ...rows.map((r) => `${csvCell(r.section)},${csvCell(r.field)},${csvCell(r.value)}`),
    ].join('\n');

    const printable = this.buildPrintable(report, periodLabel, rows);

    return { filename, periodLabel, csv, printable };
  }

  private buildRows(
    report: BiomassReport,
  ): Array<{ section: string; field: string; value: string | number }> {
    const p: BiomassReportPayload = report.reportData;
    const rows: Array<{ section: string; field: string; value: string | number }> = [];

    rows.push({
      section: 'Report',
      field: 'Period',
      value: `${report.reportYear}-${report.reportMonth}`,
    });
    rows.push({ section: 'Report', field: 'SiteId', value: report.siteId });
    rows.push({
      section: 'Report',
      field: 'TotalBiomassKg',
      value: kg(Number(report.totalBiomassKg)),
    });

    // Standing biomass per species (FD-0001 §beholdning).
    rows.push({
      section: 'StandingBiomass',
      field: 'TotalKg',
      value: kg(p.currentBiomass.totalKg),
    });
    for (const s of p.currentBiomass.bySpecies) {
      rows.push({
        section: 'StandingBiomass',
        field: `${s.speciesName} — fishCount`,
        value: s.fishCount,
      });
      rows.push({
        section: 'StandingBiomass',
        field: `${s.speciesName} — biomassKg`,
        value: kg(s.biomassKg),
      });
      rows.push({
        section: 'StandingBiomass',
        field: `${s.speciesName} — avgWeightG`,
        value: s.avgWeightG,
      });
    }

    // Mortality (FD-0001 §dødelighet).
    rows.push({ section: 'Mortality', field: 'TotalCount', value: p.mortality.totalCount });
    for (const c of p.mortality.byCause) {
      rows.push({ section: 'Mortality', field: `Cause: ${c.cause}`, value: c.count });
    }

    // Stockings (§utsett).
    for (const st of p.stockings) {
      rows.push({
        section: 'Stockings',
        field: `${st.date} ${st.speciesCode}`,
        value: `${st.fishCount} fish, ${kg(st.biomassKg)} kg`,
      });
    }

    // Transfers (§flytting).
    for (const t of p.transfers) {
      rows.push({
        section: 'Transfers',
        field: `${t.date} ${t.direction} ${t.speciesCode}`,
        value: `${t.fishCount} fish, ${kg(t.biomassKg)} kg`,
      });
    }

    // Slaughter/harvest (§slakt).
    rows.push({ section: 'Slaughter', field: 'TotalQuantity', value: p.slaughter.totalQuantity });
    rows.push({
      section: 'Slaughter',
      field: 'TotalBiomassKg',
      value: kg(p.slaughter.totalBiomassKg),
    });

    // Feed (§fôr).
    rows.push({ section: 'Feed', field: 'TotalKg', value: kg(p.feedConsumption.totalKg) });
    for (const f of p.feedConsumption.byFeedType) {
      rows.push({ section: 'Feed', field: f.feedName, value: kg(f.quantityKg) });
    }

    return rows;
  }

  private buildPrintable(
    report: BiomassReport,
    periodLabel: string,
    rows: Array<{ section: string; field: string; value: string | number }>,
  ): string {
    const lines: string[] = [];
    lines.push(`Fiskeridirektoratet FD-0001 — Monthly biomass report`);
    lines.push(`Period: ${periodLabel}   Site: ${report.siteId}`);
    lines.push(
      `Transcribe the values below into the Altinn FD-0001 form, then confirm the submission with the Altinn receipt reference.`,
    );
    lines.push('');

    let currentSection = '';
    for (const r of rows) {
      if (r.section !== currentSection) {
        currentSection = r.section;
        lines.push(`— ${currentSection} —`);
      }
      lines.push(`  ${r.field}: ${r.value}`);
    }
    return lines.join('\n');
  }
}
