/**
 * Norwegian Regulatory Reports - Mock Data
 *
 * Bu modül tüm rapor tipleri için mock data sağlar.
 * Frontend phase'de API entegrasyonu olmadan kullanılır.
 */

export * from './seaLiceData';
export * from './biomassData';
export * from './smoltData';
export * from './cleanerFishData';
export * from './slaughterData';
export * from './welfareEventData';
export * from './diseaseOutbreakData';
export * from './escapeReportData';

// Re-export helper functions
export { getMockReports, getMockReportById, submitMockReport } from './helpers';
