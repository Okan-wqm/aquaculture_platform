/**
 * PrintScheduleButton Component
 * Button to print or export weekly schedule
 */

import React from 'react';
import { Printer, FileDown } from 'lucide-react';
import { cn } from '@aquaculture/shared-ui';
import { formatMinutesAsHours, getWeekdayShortTR } from '../../hooks/useScheduling';
import type { TeamWeeklyOverview, WeekDay } from '../../types/scheduling.types';

/**
 * Sanitize string for safe HTML insertion (XSS prevention)
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

interface PrintScheduleButtonProps {
  overview: TeamWeeklyOverview;
  siteName?: string;
  departmentName?: string;
  className?: string;
}

const WEEKDAYS: WeekDay[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

export function PrintScheduleButton({
  overview,
  siteName,
  departmentName,
  className,
}: PrintScheduleButtonProps) {
  const handlePrint = () => {
    // Create printable content
    const printContent = generatePrintableHTML(overview, siteName, departmentName);

    // Open new window and print
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(printContent);
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => {
        printWindow.print();
        // Close after print dialog closes
        printWindow.onafterprint = () => printWindow.close();
      }, 250);
    }
  };

  return (
    <button
      onClick={handlePrint}
      className={cn(
        'inline-flex items-center gap-2 px-4 py-2 text-sm font-medium',
        'text-gray-700 bg-white border border-gray-300 rounded-lg',
        'hover:bg-gray-50 transition-colors',
        className
      )}
    >
      <Printer className="h-4 w-4" />
      Yazdir
    </button>
  );
}

function generatePrintableHTML(
  overview: TeamWeeklyOverview,
  siteName?: string,
  departmentName?: string
): string {
  const weekStart = new Date(overview.weekStartDate);
  const weekEnd = new Date(overview.weekEndDate);

  const formatDate = (date: Date) =>
    date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

  // Generate table rows
  const tableRows = overview.employeePlans
    .map((emp) => {
      const dayCells = WEEKDAYS.map((day) => {
        const dayEntry = emp.days.find((d) => d.dayOfWeek === day);
        if (!dayEntry) return '<td class="cell">-</td>';

        if (dayEntry.entryType === 'off') {
          return '<td class="cell off">TATIL</td>';
        }
        if (dayEntry.entryType === 'leave') {
          return '<td class="cell leave">IZIN</td>';
        }
        if (dayEntry.entryType === 'holiday') {
          return '<td class="cell holiday">RESMI</td>';
        }

        const timeRange = dayEntry.startTime && dayEntry.endTime
          ? `${escapeHtml(dayEntry.startTime.slice(0, 5))}-${escapeHtml(dayEntry.endTime.slice(0, 5))}`
          : escapeHtml(dayEntry.shiftCode || '-');

        return `<td class="cell work">${timeRange}</td>`;
      }).join('');

      const overtime = emp.overtimeMinutes > 0
        ? `+${formatMinutesAsHours(emp.overtimeMinutes)}`
        : '-';

      return `
        <tr>
          <td class="name">${escapeHtml(emp.employeeName)}</td>
          ${dayCells}
          <td class="total">${emp.totalWorkDays}</td>
          <td class="hours">${formatMinutesAsHours(emp.totalMinutes)}</td>
          <td class="overtime">${overtime}</td>
        </tr>
      `;
    })
    .join('');

  // Day summary row
  const summaryRow = WEEKDAYS.map((day) => {
    const summary = overview.daysSummary.find((d) => d.dayOfWeek === day);
    if (!summary) return '<td class="summary-cell">-</td>';
    return `<td class="summary-cell">${summary.workingCount}C / ${summary.offCount}T</td>`;
  }).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Haftalik Calisma Cizelgesi</title>
      <style>
        * { box-sizing: border-box; }
        body {
          font-family: Arial, sans-serif;
          font-size: 11px;
          padding: 20px;
          max-width: 1200px;
          margin: 0 auto;
        }
        .header {
          text-align: center;
          margin-bottom: 20px;
          border-bottom: 2px solid #333;
          padding-bottom: 15px;
        }
        .header h1 {
          font-size: 18px;
          margin: 0 0 5px 0;
          text-transform: uppercase;
        }
        .header .subtitle {
          font-size: 14px;
          color: #666;
          margin: 5px 0;
        }
        .header .meta {
          font-size: 11px;
          color: #888;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 10px;
        }
        th, td {
          border: 1px solid #333;
          padding: 6px 4px;
          text-align: center;
        }
        th {
          background: #f0f0f0;
          font-weight: bold;
          font-size: 10px;
        }
        th.day {
          width: 10%;
        }
        .name {
          text-align: left;
          font-weight: 500;
          padding-left: 8px;
          width: 15%;
        }
        .cell {
          font-size: 10px;
        }
        .cell.work {
          background: #e3f2fd;
        }
        .cell.off {
          background: #f5f5f5;
          color: #666;
        }
        .cell.leave {
          background: #e8f5e9;
          color: #2e7d32;
        }
        .cell.holiday {
          background: #f3e5f5;
          color: #7b1fa2;
        }
        .total, .hours, .overtime {
          font-weight: bold;
          width: 6%;
        }
        .overtime {
          color: #d32f2f;
        }
        .summary-row {
          background: #fff3e0;
        }
        .summary-cell {
          font-size: 9px;
          font-weight: bold;
        }
        .footer {
          margin-top: 20px;
          font-size: 10px;
          color: #666;
          border-top: 1px solid #ccc;
          padding-top: 10px;
        }
        .legend {
          display: flex;
          gap: 15px;
          justify-content: center;
          margin-top: 15px;
        }
        .legend-item {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .legend-box {
          width: 16px;
          height: 12px;
          border: 1px solid #ccc;
        }
        @media print {
          body { padding: 10px; }
          .header { page-break-after: avoid; }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; }
        }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>Haftalik Calisma Cizelgesi</h1>
        <div class="subtitle">${formatDate(weekStart)} - ${formatDate(weekEnd)}</div>
        ${siteName || departmentName ? `<div class="meta">${[siteName, departmentName].filter(Boolean).map(s => escapeHtml(s)).join(' - ')}</div>` : ''}
      </div>

      <table>
        <thead>
          <tr>
            <th>Calisan</th>
            <th class="day">Pzt</th>
            <th class="day">Sal</th>
            <th class="day">Car</th>
            <th class="day">Per</th>
            <th class="day">Cum</th>
            <th class="day">Cts</th>
            <th class="day">Paz</th>
            <th>Gun</th>
            <th>Saat</th>
            <th>Mesai</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
          <tr class="summary-row">
            <td class="name"><strong>OZET</strong></td>
            ${summaryRow}
            <td colspan="3">${overview.totalEmployees} Calisan</td>
          </tr>
        </tbody>
      </table>

      <div class="legend">
        <div class="legend-item">
          <div class="legend-box" style="background: #e3f2fd;"></div>
          <span>Mesai</span>
        </div>
        <div class="legend-item">
          <div class="legend-box" style="background: #f5f5f5;"></div>
          <span>Tatil</span>
        </div>
        <div class="legend-item">
          <div class="legend-box" style="background: #e8f5e9;"></div>
          <span>Izin</span>
        </div>
        <div class="legend-item">
          <div class="legend-box" style="background: #f3e5f5;"></div>
          <span>Resmi Tatil</span>
        </div>
      </div>

      <div class="footer">
        <p>C = Calisan, T = Tatil</p>
        <p>Yazdirma Tarihi: ${new Date().toLocaleDateString('tr-TR')} ${new Date().toLocaleTimeString('tr-TR')}</p>
      </div>
    </body>
    </html>
  `;
}

export default PrintScheduleButton;
