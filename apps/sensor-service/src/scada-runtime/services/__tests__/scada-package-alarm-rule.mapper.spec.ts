/**
 * Package → runtime alarm-rule mapper (RT-011 Faz 3).
 *
 * Pins the field renames + defaults + condition normalisation that turn a
 * stored builder-shape rule into a runtime `AlarmRuleRuntime`, and that an
 * un-mappable rule is DROPPED with a reason (never silently mis-evaluated).
 */
import {
  mapPackageAlarmRules,
  normalizeCondition,
  normalizeSeverity,
  type StoredAlarmRule,
} from '../scada-package-alarm-rule.mapper';

describe('mapPackageAlarmRules — builder → runtime', () => {
  it('renames tag→tagId, value→threshold, delay→timeDelay and defaults the missing required fields', () => {
    const stored: StoredAlarmRule[] = [
      {
        id: 'r1',
        tag: 'pond/temp',
        condition: '>',
        value: 30,
        severity: 'high',
        message: 'hot',
        delay: 5,
        deadband: 2,
      },
    ];
    const { rules, dropped } = mapPackageAlarmRules(stored);

    expect(dropped).toEqual([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      id: 'r1',
      tagId: 'pond/temp',
      condition: '>',
      threshold: 30,
      severity: 'high',
      message: 'hot',
      timeDelay: 5,
      deadband: 2,
      // defaults the builder shape lacks
      name: 'hot', // falls back to message
      ackMode: 'ackActive',
      enabled: true,
    });
  });

  it('synthesises a name when neither name nor message is present', () => {
    const { rules } = mapPackageAlarmRules([
      { id: 'r9', tag: 't', condition: '<', value: 1, severity: 'info' },
    ]);
    expect(rules[0]!.name).toBe('Alarm r9');
  });

  it('honours runtime-only fields when a future package already carries them', () => {
    const { rules } = mapPackageAlarmRules([
      {
        id: 'r2',
        tag: 't',
        condition: '>=',
        value: 5,
        severity: 'critical',
        name: 'Explicit',
        ackMode: 'float',
        enabled: false,
      },
    ]);
    expect(rules[0]).toMatchObject({ name: 'Explicit', ackMode: 'float', enabled: false });
  });

  it('drops rules that cannot be evaluated, with a reason', () => {
    const { rules, dropped } = mapPackageAlarmRules([
      { id: '', tag: 't', condition: '>', value: 1, severity: 'info' }, // no id
      { id: 'r3', tag: '', condition: '>', value: 1, severity: 'info' }, // no tag
      { id: 'r4', tag: 't', condition: 'sideways', value: 1, severity: 'info' }, // bad condition
      { id: 'r5', tag: 't', condition: '>', value: 'NaN', severity: 'info' }, // bad value
      { id: 'r6', tag: 't', condition: '>', value: 1, severity: 'info' }, // ok
    ]);
    expect(rules.map((r) => r.id)).toEqual(['r6']);
    expect(dropped).toHaveLength(4);
    expect(dropped.map((d) => d.reason)).toEqual([
      'missing id',
      'missing tag',
      expect.stringContaining('condition'),
      expect.stringContaining('value'),
    ]);
  });
});

describe('normalizeCondition', () => {
  it('passes operator forms through', () => {
    for (const op of ['>', '<', '>=', '<=', '==', '!=']) {
      expect(normalizeCondition(op)).toBe(op);
    }
  });
  it('maps word/alias forms', () => {
    expect(normalizeCondition('greater')).toBe('>');
    expect(normalizeCondition('greater_than_or_equal')).toBe('>=');
    expect(normalizeCondition('LESS')).toBe('<');
    expect(normalizeCondition('notEqual')).toBe('!=');
  });
  it('returns null for unknown conditions', () => {
    expect(normalizeCondition('approximately')).toBeNull();
    expect(normalizeCondition('')).toBeNull();
  });
});

describe('normalizeSeverity', () => {
  it('passes runtime severities through and defaults unknowns to warning', () => {
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity('medium')).toBe('warning');
    expect(normalizeSeverity('low')).toBe('info');
    expect(normalizeSeverity('bogus')).toBe('warning');
  });
});
