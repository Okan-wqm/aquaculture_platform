import type { EventHandler } from '../types';

interface TagBusActions {
  publish: (tagName: string, value: unknown) => void;
  getLatest: (tagName: string) => unknown;
}

export function createTagWriteHandler(tagBus: TagBusActions): EventHandler {
  return (event) => {
    if (event.action === 'setValue' && event.params.targetTag) {
      tagBus.publish(event.params.targetTag, event.params.value);
    } else if (event.action === 'toggleValue' && event.params.toggleTag) {
      const current = tagBus.getLatest(event.params.toggleTag);
      tagBus.publish(event.params.toggleTag, !current);
    }
  };
}
