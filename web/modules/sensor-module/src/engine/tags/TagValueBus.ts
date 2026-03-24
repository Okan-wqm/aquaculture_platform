type TagListener = (value: unknown, tagName: string) => void;

export class TagValueBus {
  private listeners = new Map<string, Set<TagListener>>();
  private values = new Map<string, unknown>();

  subscribe(tagName: string, listener: TagListener): () => void {
    if (!this.listeners.has(tagName)) this.listeners.set(tagName, new Set());
    this.listeners.get(tagName)!.add(listener);
    return () => {
      this.listeners.get(tagName)?.delete(listener);
    };
  }

  publish(tagName: string, value: unknown): void {
    this.values.set(tagName, value);
    this.listeners.get(tagName)?.forEach((cb) => cb(value, tagName));
    this.listeners.get('*')?.forEach((cb) => cb(value, tagName));
  }

  publishBatch(values: Record<string, unknown>): void {
    for (const [tag, val] of Object.entries(values)) {
      this.publish(tag, val);
    }
  }

  getLatest(tagName: string): unknown {
    return this.values.get(tagName);
  }

  getSnapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.values.forEach((v, k) => {
      result[k] = v;
    });
    return result;
  }

  clear(): void {
    this.listeners.clear();
    this.values.clear();
  }
}
