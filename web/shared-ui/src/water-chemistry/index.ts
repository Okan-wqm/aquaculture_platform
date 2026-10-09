/**
 * Water-chemistry shared SSoT — pure logic, plus the sources module (where an
 * input comes from at a measurement point: documents, problem vocabulary, the
 * input adapter and its two tiles). The recharts presentation (DeffeyesChart,
 * ResultsPanel, secondary charts) stays on the `components` source subpath.
 */
export * from './types';
export * from './defaults';
export * from './sources';
export * from './compute';
export * from './deffeyes-data';
export * from './chart-zones';
