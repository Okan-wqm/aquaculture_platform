/**
 * SCADA Operator Runtime Widgets — barrel exports.
 *
 * Master dispatcher:
 *   RuntimeWidgetRenderer — resolves widgetType → correct renderer,
 *   subscribes to tags, applies permissions and widget actions.
 *
 * Individual runtime components (also exported for direct use):
 *   RuntimeGauge      — dial / donut / zone SVG gauge
 *   RuntimeInput      — operator tag-write input
 *   RuntimePipe       — animated flow pipe
 *   RuntimeTable      — live data / history / alarms table
 *   RuntimeVideo      — HTML5 video player
 *   RuntimeScheduler  — weekly / monthly schedule calendar
 */

export { RuntimeWidgetRenderer } from './RuntimeWidgetRenderer';
export type { RuntimeWidgetRendererProps } from './RuntimeWidgetRenderer';

export { default as RuntimeGauge }     from './RuntimeGauge';
export { default as RuntimeInput }     from './RuntimeInput';
export { default as RuntimePipe }      from './RuntimePipe';
export { default as RuntimeTable }     from './RuntimeTable';
export { default as RuntimeVideo }     from './RuntimeVideo';
export { default as RuntimeScheduler } from './RuntimeScheduler';
