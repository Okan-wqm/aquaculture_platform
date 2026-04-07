// Constants & DI tokens
export {
  OUTBOX_ENTITY_CLASS,
  OUTBOX_OPTIONS,
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_RETRIES,
  OUTBOX_LAST_ERROR_MAX_LENGTH,
} from './constants';

// Abstract base class — concrete services subclass this
export { OutboxEntityBase } from './outbox-entity.base';

// Public API
export { OutboxPublisher } from './outbox-publisher.service';
export { OutboxWorkerService } from './outbox-worker.service';
export { OutboxModule } from './outbox.module';
