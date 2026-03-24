import { TagValueBus } from '../TagValueBus';

describe('TagValueBus', () => {
  let bus: TagValueBus;
  beforeEach(() => {
    bus = new TagValueBus();
  });

  it('publishes and receives tag value', () => {
    const cb = vi.fn();
    bus.subscribe('pump1.rpm', cb);
    bus.publish('pump1.rpm', 1450);
    expect(cb).toHaveBeenCalledWith(1450, 'pump1.rpm');
  });

  it('getLatest returns last published value', () => {
    bus.publish('tank1.level', 72.5);
    expect(bus.getLatest('tank1.level')).toBe(72.5);
  });

  it('getLatest returns undefined for unknown tag', () => {
    expect(bus.getLatest('nonexistent')).toBeUndefined();
  });

  it('unsubscribe stops delivery', () => {
    const cb = vi.fn();
    const unsub = bus.subscribe('tag1', cb);
    bus.publish('tag1', 1);
    unsub();
    bus.publish('tag1', 2);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('publishBatch updates multiple tags', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    bus.subscribe('a', cb1);
    bus.subscribe('b', cb2);
    bus.publishBatch({ a: 10, b: 20 });
    expect(cb1).toHaveBeenCalledWith(10, 'a');
    expect(cb2).toHaveBeenCalledWith(20, 'b');
  });

  it('wildcard subscriber receives all changes', () => {
    const cb = vi.fn();
    bus.subscribe('*', cb);
    bus.publish('x', 1);
    bus.publish('y', 2);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('getSnapshot returns all current values', () => {
    bus.publish('a', 1);
    bus.publish('b', 2);
    expect(bus.getSnapshot()).toEqual({ a: 1, b: 2 });
  });

  it('clear removes all listeners and values', () => {
    const cb = vi.fn();
    bus.subscribe('a', cb);
    bus.publish('a', 1);
    bus.clear();
    expect(bus.getLatest('a')).toBeUndefined();
    expect(bus.getSnapshot()).toEqual({});
    bus.publish('a', 2);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
