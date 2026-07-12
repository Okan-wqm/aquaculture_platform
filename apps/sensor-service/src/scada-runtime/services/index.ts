/**
 * Barrel export for all SCADA runtime services.
 *
 * ScriptEngineService and SchedulerService are re-exported conditionally:
 * their source files may still be in progress, so we guard with a try/catch
 * rather than a static export statement that would cause a compile error if
 * the file does not yet exist.
 */

export { TagManagerService, SCADA_TAG_WRITE_EVENT } from './tag-manager.service';
export type { TagWriteRequest, TagValueRoutingMap } from './tag-manager.service';

export { AlarmEngineService } from './alarm-engine.service';

export { AlarmStorageService } from './alarm-storage.service';

export { NotificationService } from './notification.service';

export { DaqStorageService } from './daq-storage.service';

export { TagValueFanoutService, mapQualityCode } from './tag-value-fanout.service';
export type { IngestedMetricForFanout } from './tag-value-fanout.service';
