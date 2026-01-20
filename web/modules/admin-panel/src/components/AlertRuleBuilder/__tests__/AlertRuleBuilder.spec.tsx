/**
 * AlertRuleBuilder Tests
 *
 * Comprehensive tests for the Alert Rule Builder component.
 * Tests cover form validation, condition management, and user interactions.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import AlertRuleBuilder, {
  AlertRule,
  AlertSeverity,
  RuleCondition,
  ConditionGroup,
  ConditionOperator,
  SensorType,
  ValidationError,
  generateId,
  createCondition,
  createConditionGroup,
  createDefaultRule,
  validateRule,
  getSensorUnit,
  formatCondition,
  ConditionEditor,
  ConditionGroupEditor,
  NotificationChannelEditor,
  SeveritySelector,
  SEVERITY_OPTIONS,
  OPERATOR_OPTIONS,
  SENSOR_TYPE_OPTIONS,
  TIME_UNIT_OPTIONS,
  NOTIFICATION_CHANNEL_OPTIONS,
} from '../AlertRuleBuilder';

// ============================================================================
// Helper Functions Tests
// ============================================================================

describe('Helper Functions', () => {
  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }
      expect(ids.size).toBe(100);
    });

    it('should generate string IDs', () => {
      const id = generateId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe('createCondition', () => {
    it('should create condition with defaults', () => {
      const condition = createCondition();

      expect(condition.id).toBeDefined();
      expect(condition.sensorType).toBe('temperature');
      expect(condition.operator).toBe('gt');
      expect(condition.value).toBe(0);
    });

    it('should accept overrides', () => {
      const condition = createCondition({
        sensorType: 'ph',
        operator: 'lt',
        value: 7.5,
      });

      expect(condition.sensorType).toBe('ph');
      expect(condition.operator).toBe('lt');
      expect(condition.value).toBe(7.5);
    });

    it('should generate unique ID even with overrides', () => {
      const c1 = createCondition({ value: 10 });
      const c2 = createCondition({ value: 10 });

      expect(c1.id).not.toBe(c2.id);
    });
  });

  describe('createConditionGroup', () => {
    it('should create group with defaults', () => {
      const group = createConditionGroup();

      expect(group.id).toBeDefined();
      expect(group.logicalOperator).toBe('and');
      expect(group.conditions).toHaveLength(1);
    });

    it('should accept overrides', () => {
      const group = createConditionGroup({
        logicalOperator: 'or',
        conditions: [createCondition(), createCondition()],
      });

      expect(group.logicalOperator).toBe('or');
      expect(group.conditions).toHaveLength(2);
    });
  });

  describe('createDefaultRule', () => {
    it('should create rule with defaults', () => {
      const rule = createDefaultRule();

      expect(rule.name).toBe('');
      expect(rule.description).toBe('');
      expect(rule.enabled).toBe(true);
      expect(rule.severity).toBe('medium');
      expect(rule.conditionGroups).toHaveLength(1);
      expect(rule.groupOperator).toBe('and');
      expect(rule.cooldownMinutes).toBe(5);
      expect(rule.notificationChannels).toHaveLength(1);
      expect(rule.notificationChannels[0].type).toBe('email');
      expect(rule.notificationChannels[0].enabled).toBe(true);
    });

    it('should accept overrides', () => {
      const rule = createDefaultRule({
        name: 'Test Rule',
        severity: 'critical',
        cooldownMinutes: 15,
      });

      expect(rule.name).toBe('Test Rule');
      expect(rule.severity).toBe('critical');
      expect(rule.cooldownMinutes).toBe(15);
    });
  });

  describe('validateRule', () => {
    const validRule = createDefaultRule({
      name: 'Valid Rule',
      conditionGroups: [
        createConditionGroup({
          conditions: [createCondition({ value: 30 })],
        }),
      ],
    });

    describe('name validation', () => {
      it('should require name', () => {
        const rule = { ...validRule, name: '' };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'name')).toBe(true);
      });

      it('should require minimum length', () => {
        const rule = { ...validRule, name: 'ab' };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'name' && e.message.includes('3 karakter'))).toBe(true);
      });

      it('should enforce maximum length', () => {
        const rule = { ...validRule, name: 'a'.repeat(101) };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'name' && e.message.includes('100 karakter'))).toBe(true);
      });

      it('should accept valid name', () => {
        const errors = validateRule(validRule);

        expect(errors.some(e => e.field === 'name')).toBe(false);
      });
    });

    describe('description validation', () => {
      it('should enforce maximum length', () => {
        const rule = { ...validRule, description: 'a'.repeat(501) };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'description')).toBe(true);
      });

      it('should accept empty description', () => {
        const rule = { ...validRule, description: '' };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'description')).toBe(false);
      });
    });

    describe('condition groups validation', () => {
      it('should require at least one condition group', () => {
        const rule = { ...validRule, conditionGroups: [] };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'conditionGroups')).toBe(true);
      });

      it('should require at least one condition in each group', () => {
        const rule = {
          ...validRule,
          conditionGroups: [createConditionGroup({ conditions: [] })],
        };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field.includes('conditions'))).toBe(true);
      });

      it('should require condition value', () => {
        const rule = {
          ...validRule,
          conditionGroups: [
            createConditionGroup({
              conditions: [createCondition({ value: undefined as any })],
            }),
          ],
        };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field.includes('value'))).toBe(true);
      });

      it('should require second value for between operator', () => {
        const rule = {
          ...validRule,
          conditionGroups: [
            createConditionGroup({
              conditions: [
                createCondition({
                  operator: 'between',
                  value: 20,
                  secondValue: undefined,
                }),
              ],
            }),
          ],
        };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field.includes('secondValue'))).toBe(true);
      });

      it('should require second value greater than first for between', () => {
        const rule = {
          ...validRule,
          conditionGroups: [
            createConditionGroup({
              conditions: [
                createCondition({
                  operator: 'between',
                  value: 30,
                  secondValue: 20,
                }),
              ],
            }),
          ],
        };
        const errors = validateRule(rule);

        expect(errors.some(e =>
          e.field.includes('secondValue') && e.message.includes('büyük')
        )).toBe(true);
      });

      it('should reject negative duration', () => {
        const rule = {
          ...validRule,
          conditionGroups: [
            createConditionGroup({
              conditions: [
                createCondition({
                  value: 30,
                  duration: -5,
                }),
              ],
            }),
          ],
        };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field.includes('duration'))).toBe(true);
      });
    });

    describe('cooldown validation', () => {
      it('should reject negative cooldown', () => {
        const rule = { ...validRule, cooldownMinutes: -1 };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'cooldownMinutes')).toBe(true);
      });

      it('should reject cooldown over 24 hours', () => {
        const rule = { ...validRule, cooldownMinutes: 1441 };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'cooldownMinutes')).toBe(true);
      });

      it('should accept valid cooldown', () => {
        const rule = { ...validRule, cooldownMinutes: 60 };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'cooldownMinutes')).toBe(false);
      });
    });

    describe('notification channels validation', () => {
      it('should require at least one enabled channel', () => {
        const rule = {
          ...validRule,
          notificationChannels: [{ type: 'email' as const, enabled: false }],
        };
        const errors = validateRule(rule);

        expect(errors.some(e => e.field === 'notificationChannels')).toBe(true);
      });

      it('should accept enabled channel', () => {
        const errors = validateRule(validRule);

        expect(errors.some(e => e.field === 'notificationChannels')).toBe(false);
      });
    });

    it('should return empty array for valid rule', () => {
      const errors = validateRule(validRule);
      expect(errors).toHaveLength(0);
    });
  });

  describe('getSensorUnit', () => {
    it('should return correct unit for temperature', () => {
      expect(getSensorUnit('temperature')).toBe('°C');
    });

    it('should return correct unit for pH', () => {
      expect(getSensorUnit('ph')).toBe('pH');
    });

    it('should return correct unit for dissolved_oxygen', () => {
      expect(getSensorUnit('dissolved_oxygen')).toBe('mg/L');
    });

    it('should return empty string for unknown sensor', () => {
      expect(getSensorUnit('unknown' as SensorType)).toBe('');
    });
  });

  describe('formatCondition', () => {
    it('should format simple condition', () => {
      const condition = createCondition({
        sensorType: 'temperature',
        operator: 'gt',
        value: 30,
      });

      const formatted = formatCondition(condition);

      expect(formatted).toContain('Sıcaklık');
      expect(formatted).toContain('>');
      expect(formatted).toContain('30');
      expect(formatted).toContain('°C');
    });

    it('should format between condition', () => {
      const condition = createCondition({
        sensorType: 'ph',
        operator: 'between',
        value: 6.5,
        secondValue: 8.5,
      });

      const formatted = formatCondition(condition);

      expect(formatted).toContain('pH');
      expect(formatted).toContain('6.5');
      expect(formatted).toContain('8.5');
      expect(formatted).toContain('arasında');
    });

    it('should format outside condition', () => {
      const condition = createCondition({
        sensorType: 'dissolved_oxygen',
        operator: 'outside',
        value: 5,
        secondValue: 10,
      });

      const formatted = formatCondition(condition);

      expect(formatted).toContain('Çözünmüş Oksijen');
      expect(formatted).toContain('5');
      expect(formatted).toContain('10');
      expect(formatted).toContain('dışında');
    });
  });
});

// ============================================================================
// Constants Tests
// ============================================================================

describe('Constants', () => {
  describe('SEVERITY_OPTIONS', () => {
    it('should have all severity levels', () => {
      const severities: AlertSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
      severities.forEach(severity => {
        expect(SEVERITY_OPTIONS.some(opt => opt.value === severity)).toBe(true);
      });
    });

    it('should have labels and colors for all options', () => {
      SEVERITY_OPTIONS.forEach(opt => {
        expect(opt.label).toBeDefined();
        expect(opt.color).toBeDefined();
      });
    });
  });

  describe('OPERATOR_OPTIONS', () => {
    it('should have all operators', () => {
      const operators: ConditionOperator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'between', 'outside'];
      operators.forEach(op => {
        expect(OPERATOR_OPTIONS.some(opt => opt.value === op)).toBe(true);
      });
    });

    it('should have symbols for all operators', () => {
      OPERATOR_OPTIONS.forEach(opt => {
        expect(opt.symbol).toBeDefined();
      });
    });
  });

  describe('SENSOR_TYPE_OPTIONS', () => {
    it('should have all sensor types', () => {
      const types: SensorType[] = [
        'temperature', 'ph', 'dissolved_oxygen', 'turbidity',
        'ammonia', 'nitrite', 'nitrate', 'salinity',
      ];
      types.forEach(type => {
        expect(SENSOR_TYPE_OPTIONS.some(opt => opt.value === type)).toBe(true);
      });
    });

    it('should have units for all sensors', () => {
      SENSOR_TYPE_OPTIONS.forEach(opt => {
        expect(opt.unit).toBeDefined();
      });
    });
  });

  describe('TIME_UNIT_OPTIONS', () => {
    it('should have standard time units', () => {
      const units = ['seconds', 'minutes', 'hours', 'days'];
      units.forEach(unit => {
        expect(TIME_UNIT_OPTIONS.some(opt => opt.value === unit)).toBe(true);
      });
    });
  });

  describe('NOTIFICATION_CHANNEL_OPTIONS', () => {
    it('should have all channel types', () => {
      const channels = ['email', 'sms', 'slack', 'webhook', 'push'];
      channels.forEach(ch => {
        expect(NOTIFICATION_CHANNEL_OPTIONS.some(opt => opt.type === ch)).toBe(true);
      });
    });
  });
});

// ============================================================================
// Sub-Component Tests
// ============================================================================

describe('ConditionEditor', () => {
  const defaultCondition = createCondition({
    id: 'test-condition',
    sensorType: 'temperature',
    operator: 'gt',
    value: 30,
  });

  it('should render condition fields', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.getByTestId('sensor-select-test-condition')).toBeInTheDocument();
    expect(screen.getByTestId('operator-select-test-condition')).toBeInTheDocument();
    expect(screen.getByTestId('value-input-test-condition')).toBeInTheDocument();
  });

  it('should display current values', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    const sensorSelect = screen.getByTestId('sensor-select-test-condition') as HTMLSelectElement;
    const operatorSelect = screen.getByTestId('operator-select-test-condition') as HTMLSelectElement;
    const valueInput = screen.getByTestId('value-input-test-condition') as HTMLInputElement;

    expect(sensorSelect.value).toBe('temperature');
    expect(operatorSelect.value).toBe('gt');
    expect(valueInput.value).toBe('30');
  });

  it('should call onChange when sensor type changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={onChange}
        onRemove={() => {}}
      />
    );

    await user.selectOptions(screen.getByTestId('sensor-select-test-condition'), 'ph');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      sensorType: 'ph',
    }));
  });

  it('should call onChange when operator changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={onChange}
        onRemove={() => {}}
      />
    );

    await user.selectOptions(screen.getByTestId('operator-select-test-condition'), 'lt');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      operator: 'lt',
    }));
  });

  it('should call onChange when value changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={onChange}
        onRemove={() => {}}
      />
    );

    const valueInput = screen.getByTestId('value-input-test-condition');
    await user.clear(valueInput);
    await user.type(valueInput, '35');

    expect(onChange).toHaveBeenCalled();
  });

  it('should show second value input for between operator', () => {
    const betweenCondition = createCondition({
      id: 'between-condition',
      operator: 'between',
      value: 20,
      secondValue: 30,
    });

    render(
      <ConditionEditor
        condition={betweenCondition}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.getByTestId('second-value-input-between-condition')).toBeInTheDocument();
  });

  it('should not show second value input for simple operators', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.queryByTestId('second-value-input-test-condition')).not.toBeInTheDocument();
  });

  it('should show remove button by default', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.getByTestId('remove-condition-test-condition')).toBeInTheDocument();
  });

  it('should hide remove button when showRemove=false', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
        showRemove={false}
      />
    );

    expect(screen.queryByTestId('remove-condition-test-condition')).not.toBeInTheDocument();
  });

  it('should call onRemove when remove clicked', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();

    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={onRemove}
      />
    );

    await user.click(screen.getByTestId('remove-condition-test-condition'));

    expect(onRemove).toHaveBeenCalled();
  });

  it('should be disabled when disabled=true', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
        disabled
      />
    );

    expect(screen.getByTestId('sensor-select-test-condition')).toBeDisabled();
    expect(screen.getByTestId('operator-select-test-condition')).toBeDisabled();
    expect(screen.getByTestId('value-input-test-condition')).toBeDisabled();
  });

  it('should filter available sensor types', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
        availableSensorTypes={['temperature', 'ph']}
      />
    );

    const select = screen.getByTestId('sensor-select-test-condition');
    const options = within(select).getAllByRole('option');

    expect(options).toHaveLength(2);
  });

  it('should display duration inputs', () => {
    render(
      <ConditionEditor
        condition={defaultCondition}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.getByTestId('duration-input-test-condition')).toBeInTheDocument();
    expect(screen.getByTestId('duration-unit-test-condition')).toBeInTheDocument();
  });
});

describe('ConditionGroupEditor', () => {
  const defaultGroup = createConditionGroup({
    id: 'test-group',
    conditions: [
      createCondition({ id: 'cond-1' }),
      createCondition({ id: 'cond-2' }),
    ],
  });

  it('should render group with conditions', () => {
    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.getByTestId('condition-group-test-group')).toBeInTheDocument();
    expect(screen.getByTestId('condition-cond-1')).toBeInTheDocument();
    expect(screen.getByTestId('condition-cond-2')).toBeInTheDocument();
  });

  it('should display group index', () => {
    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={2}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.getByText('Grup 3')).toBeInTheDocument();
  });

  it('should show logical operator between conditions', () => {
    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    // Should show VE between conditions
    expect(screen.getByText('VE')).toBeInTheDocument();
  });

  it('should allow changing group operator', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={onChange}
        onRemove={() => {}}
      />
    );

    await user.selectOptions(screen.getByTestId('group-operator-test-group'), 'or');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      logicalOperator: 'or',
    }));
  });

  it('should add condition when add button clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={onChange}
        onRemove={() => {}}
      />
    );

    await user.click(screen.getByTestId('add-condition-test-group'));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      conditions: expect.arrayContaining([
        expect.objectContaining({ id: 'cond-1' }),
        expect.objectContaining({ id: 'cond-2' }),
        expect.any(Object), // New condition
      ]),
    }));
  });

  it('should remove condition when remove clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={onChange}
        onRemove={() => {}}
      />
    );

    await user.click(screen.getByTestId('remove-condition-cond-1'));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      conditions: [expect.objectContaining({ id: 'cond-2' })],
    }));
  });

  it('should show group remove button', () => {
    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={() => {}}
        onRemove={() => {}}
      />
    );

    expect(screen.getByTestId('remove-group-test-group')).toBeInTheDocument();
  });

  it('should hide group remove button when showRemove=false', () => {
    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={() => {}}
        onRemove={() => {}}
        showRemove={false}
      />
    );

    expect(screen.queryByTestId('remove-group-test-group')).not.toBeInTheDocument();
  });

  it('should call onRemove when group remove clicked', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();

    render(
      <ConditionGroupEditor
        group={defaultGroup}
        groupIndex={0}
        onChange={() => {}}
        onRemove={onRemove}
      />
    );

    await user.click(screen.getByTestId('remove-group-test-group'));

    expect(onRemove).toHaveBeenCalled();
  });
});

describe('NotificationChannelEditor', () => {
  const defaultChannels = [
    { type: 'email' as const, enabled: true },
    { type: 'sms' as const, enabled: false },
  ];

  it('should render all channel options', () => {
    render(
      <NotificationChannelEditor
        channels={defaultChannels}
        onChange={() => {}}
      />
    );

    expect(screen.getByTestId('channel-email')).toBeInTheDocument();
    expect(screen.getByTestId('channel-sms')).toBeInTheDocument();
    expect(screen.getByTestId('channel-slack')).toBeInTheDocument();
    expect(screen.getByTestId('channel-webhook')).toBeInTheDocument();
    expect(screen.getByTestId('channel-push')).toBeInTheDocument();
  });

  it('should show enabled state for enabled channels', () => {
    render(
      <NotificationChannelEditor
        channels={defaultChannels}
        onChange={() => {}}
      />
    );

    const emailBtn = screen.getByTestId('channel-email');
    const smsBtn = screen.getByTestId('channel-sms');

    expect(emailBtn).toHaveClass('bg-blue-50');
    expect(smsBtn).toHaveClass('bg-gray-50');
  });

  it('should toggle channel on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <NotificationChannelEditor
        channels={defaultChannels}
        onChange={onChange}
      />
    );

    await user.click(screen.getByTestId('channel-email'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'email', enabled: false }),
      ])
    );
  });

  it('should add new channel when not in list', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <NotificationChannelEditor
        channels={defaultChannels}
        onChange={onChange}
      />
    );

    await user.click(screen.getByTestId('channel-slack'));

    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'slack', enabled: true }),
      ])
    );
  });

  it('should be disabled when disabled=true', () => {
    render(
      <NotificationChannelEditor
        channels={defaultChannels}
        onChange={() => {}}
        disabled
      />
    );

    expect(screen.getByTestId('channel-email')).toBeDisabled();
  });
});

describe('SeveritySelector', () => {
  it('should render all severity options', () => {
    render(
      <SeveritySelector
        value="medium"
        onChange={() => {}}
      />
    );

    expect(screen.getByTestId('severity-critical')).toBeInTheDocument();
    expect(screen.getByTestId('severity-high')).toBeInTheDocument();
    expect(screen.getByTestId('severity-medium')).toBeInTheDocument();
    expect(screen.getByTestId('severity-low')).toBeInTheDocument();
    expect(screen.getByTestId('severity-info')).toBeInTheDocument();
  });

  it('should show selected severity', () => {
    render(
      <SeveritySelector
        value="critical"
        onChange={() => {}}
      />
    );

    const criticalBtn = screen.getByTestId('severity-critical');
    expect(criticalBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('should call onChange when severity clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <SeveritySelector
        value="medium"
        onChange={onChange}
      />
    );

    await user.click(screen.getByTestId('severity-high'));

    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('should be disabled when disabled=true', () => {
    render(
      <SeveritySelector
        value="medium"
        onChange={() => {}}
        disabled
      />
    );

    expect(screen.getByTestId('severity-critical')).toBeDisabled();
  });
});

// ============================================================================
// Main Component Tests
// ============================================================================

describe('AlertRuleBuilder', () => {
  describe('Rendering', () => {
    it('should render the builder', () => {
      render(<AlertRuleBuilder />);

      expect(screen.getByTestId('alert-rule-builder')).toBeInTheDocument();
    });

    it('should show "create" title for new rule', () => {
      render(<AlertRuleBuilder />);

      expect(screen.getByText('Yeni Kural Oluştur')).toBeInTheDocument();
    });

    it('should show "edit" title for existing rule', () => {
      render(<AlertRuleBuilder initialRule={{ id: 'existing-rule', name: 'Test' }} />);

      expect(screen.getByText('Kuralı Düzenle')).toBeInTheDocument();
    });

    it('should render form fields', () => {
      render(<AlertRuleBuilder />);

      expect(screen.getByTestId('rule-name-input')).toBeInTheDocument();
      expect(screen.getByTestId('rule-description-input')).toBeInTheDocument();
      expect(screen.getByTestId('rule-enabled-toggle')).toBeInTheDocument();
      expect(screen.getByTestId('severity-selector')).toBeInTheDocument();
      expect(screen.getByTestId('notification-channels')).toBeInTheDocument();
    });

    it('should render with custom className', () => {
      render(<AlertRuleBuilder className="custom-class" />);

      expect(screen.getByTestId('alert-rule-builder')).toHaveClass('custom-class');
    });
  });

  describe('Initial Values', () => {
    it('should populate fields from initialRule', () => {
      render(
        <AlertRuleBuilder
          initialRule={{
            name: 'Test Rule',
            description: 'Test description',
            severity: 'high',
            cooldownMinutes: 15,
          }}
        />
      );

      expect(screen.getByTestId('rule-name-input')).toHaveValue('Test Rule');
      expect(screen.getByTestId('rule-description-input')).toHaveValue('Test description');
      expect(screen.getByTestId('severity-high')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('cooldown-input')).toHaveValue(15);
    });

    it('should start with enabled=true by default', () => {
      render(<AlertRuleBuilder />);

      expect(screen.getByTestId('rule-enabled-toggle')).toBeChecked();
    });
  });

  describe('Form Interactions', () => {
    it('should update name field', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder />);

      const nameInput = screen.getByTestId('rule-name-input');
      await user.type(nameInput, 'New Rule Name');

      expect(nameInput).toHaveValue('New Rule Name');
    });

    it('should update description field', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder />);

      const descInput = screen.getByTestId('rule-description-input');
      await user.type(descInput, 'Description text');

      expect(descInput).toHaveValue('Description text');
    });

    it('should toggle enabled state', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder />);

      const toggle = screen.getByTestId('rule-enabled-toggle');
      await user.click(toggle);

      expect(toggle).not.toBeChecked();
    });

    it('should change severity', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder />);

      await user.click(screen.getByTestId('severity-critical'));

      expect(screen.getByTestId('severity-critical')).toHaveAttribute('aria-pressed', 'true');
    });

    it('should update cooldown', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder />);

      const cooldownInput = screen.getByTestId('cooldown-input');
      await user.clear(cooldownInput);
      await user.type(cooldownInput, '30');

      expect(cooldownInput).toHaveValue(30);
    });
  });

  describe('Condition Groups', () => {
    it('should render initial condition group', () => {
      render(<AlertRuleBuilder />);

      // Should have at least one condition group
      const groups = screen.getAllByTestId(/^condition-group-/);
      expect(groups.length).toBeGreaterThanOrEqual(1);
    });

    it('should add condition group when button clicked', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder />);

      const initialGroups = screen.getAllByTestId(/^condition-group-/).length;

      await user.click(screen.getByTestId('add-condition-group'));

      const finalGroups = screen.getAllByTestId(/^condition-group-/).length;
      expect(finalGroups).toBe(initialGroups + 1);
    });

    it('should show group operator select when multiple groups', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder />);

      await user.click(screen.getByTestId('add-condition-group'));

      expect(screen.getByTestId('group-operator-select')).toBeInTheDocument();
    });
  });

  describe('Validation', () => {
    it('should show error for empty name', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();

      render(<AlertRuleBuilder onSave={onSave} />);

      await user.click(screen.getByTestId('save-button'));

      expect(screen.getByTestId('name-error')).toBeInTheDocument();
      expect(onSave).not.toHaveBeenCalled();
    });

    it('should clear error when field is corrected', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder onSave={() => Promise.resolve()} />);

      // Trigger validation error
      await user.click(screen.getByTestId('save-button'));
      expect(screen.getByTestId('name-error')).toBeInTheDocument();

      // Fix the error
      await user.type(screen.getByTestId('rule-name-input'), 'Valid Name');

      // Error should be cleared
      expect(screen.queryByTestId('name-error')).not.toBeInTheDocument();
    });

    it('should allow save with valid data', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn().mockResolvedValue(undefined);

      render(<AlertRuleBuilder onSave={onSave} />);

      // Fill required fields
      await user.type(screen.getByTestId('rule-name-input'), 'Valid Rule Name');

      await user.click(screen.getByTestId('save-button'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalled();
      });
    });
  });

  describe('Save and Cancel', () => {
    it('should call onSave with rule data', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn().mockResolvedValue(undefined);

      render(<AlertRuleBuilder onSave={onSave} />);

      await user.type(screen.getByTestId('rule-name-input'), 'Test Rule');
      await user.click(screen.getByTestId('save-button'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
          name: 'Test Rule',
        }));
      });
    });

    it('should show saving state', async () => {
      const user = userEvent.setup();
      const onSave = vi.fn().mockImplementation(() =>
        new Promise(resolve => setTimeout(resolve, 100))
      );

      render(<AlertRuleBuilder onSave={onSave} />);

      await user.type(screen.getByTestId('rule-name-input'), 'Test Rule');
      await user.click(screen.getByTestId('save-button'));

      expect(screen.getByText('Kaydediliyor...')).toBeInTheDocument();
    });

    it('should call onCancel when cancel clicked', async () => {
      const user = userEvent.setup();
      const onCancel = vi.fn();

      render(<AlertRuleBuilder onCancel={onCancel} />);

      await user.click(screen.getByTestId('cancel-button'));

      expect(onCancel).toHaveBeenCalled();
    });

    it('should not show cancel button when onCancel not provided', () => {
      render(<AlertRuleBuilder />);

      expect(screen.queryByTestId('cancel-button')).not.toBeInTheDocument();
    });
  });

  describe('Disabled State', () => {
    it('should disable all inputs when disabled=true', () => {
      render(<AlertRuleBuilder disabled />);

      expect(screen.getByTestId('rule-name-input')).toBeDisabled();
      expect(screen.getByTestId('rule-description-input')).toBeDisabled();
      expect(screen.getByTestId('rule-enabled-toggle')).toBeDisabled();
      expect(screen.getByTestId('cooldown-input')).toBeDisabled();
      expect(screen.getByTestId('save-button')).toBeDisabled();
    });

    it('should disable inputs when isLoading=true', () => {
      render(<AlertRuleBuilder isLoading />);

      expect(screen.getByTestId('rule-name-input')).toBeDisabled();
      expect(screen.getByTestId('save-button')).toBeDisabled();
    });

    it('should hide add buttons when disabled', () => {
      render(<AlertRuleBuilder disabled />);

      expect(screen.queryByTestId('add-condition-group')).not.toBeInTheDocument();
    });
  });

  describe('Farm and Pond Selection', () => {
    const farms = [
      { id: 'farm-1', name: 'Farm 1' },
      { id: 'farm-2', name: 'Farm 2' },
    ];

    const ponds = [
      { id: 'pond-1', name: 'Pond 1', farmId: 'farm-1' },
      { id: 'pond-2', name: 'Pond 2', farmId: 'farm-1' },
      { id: 'pond-3', name: 'Pond 3', farmId: 'farm-2' },
    ];

    it('should render farm selector when farms provided', () => {
      render(<AlertRuleBuilder farms={farms} />);

      expect(screen.getByTestId('farm-select')).toBeInTheDocument();
    });

    it('should render pond selector when farms provided', () => {
      render(<AlertRuleBuilder farms={farms} ponds={ponds} />);

      expect(screen.getByTestId('pond-select')).toBeInTheDocument();
    });

    it('should not render farm/pond selectors when farms empty', () => {
      render(<AlertRuleBuilder farms={[]} ponds={ponds} />);

      expect(screen.queryByTestId('farm-select')).not.toBeInTheDocument();
      expect(screen.queryByTestId('pond-select')).not.toBeInTheDocument();
    });
  });

  describe('Escalation Policy Selection', () => {
    const policies = [
      { id: 'policy-1', name: 'Policy 1' },
      { id: 'policy-2', name: 'Policy 2' },
    ];

    it('should render escalation policy selector when provided', () => {
      render(<AlertRuleBuilder escalationPolicies={policies} />);

      expect(screen.getByTestId('escalation-policy-select')).toBeInTheDocument();
    });

    it('should not render selector when no policies', () => {
      render(<AlertRuleBuilder />);

      expect(screen.queryByTestId('escalation-policy-select')).not.toBeInTheDocument();
    });

    it('should display policy options', () => {
      render(<AlertRuleBuilder escalationPolicies={policies} />);

      const select = screen.getByTestId('escalation-policy-select');
      const options = within(select).getAllByRole('option');

      // +1 for the placeholder option
      expect(options.length).toBe(policies.length + 1);
    });
  });

  describe('Accessibility', () => {
    it('should have accessible form labels', () => {
      render(<AlertRuleBuilder />);

      expect(screen.getByLabelText(/kural adı/i)).toBeInTheDocument();
    });

    it('should have aria-invalid on error fields', async () => {
      const user = userEvent.setup();
      render(<AlertRuleBuilder onSave={() => Promise.resolve()} />);

      await user.click(screen.getByTestId('save-button'));

      expect(screen.getByTestId('rule-name-input')).toHaveAttribute('aria-invalid', 'true');
    });

    it('should have accessible buttons', () => {
      render(<AlertRuleBuilder onCancel={() => {}} onSave={() => Promise.resolve()} />);

      expect(screen.getByRole('button', { name: /iptal/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /oluştur/i })).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle rapid save clicks', async () => {
      const user = userEvent.setup();
      let saveCount = 0;
      const onSave = vi.fn().mockImplementation(() => {
        saveCount++;
        return new Promise(resolve => setTimeout(resolve, 100));
      });

      render(<AlertRuleBuilder onSave={onSave} />);

      await user.type(screen.getByTestId('rule-name-input'), 'Test');

      // Rapidly click save
      await user.click(screen.getByTestId('save-button'));
      await user.click(screen.getByTestId('save-button'));
      await user.click(screen.getByTestId('save-button'));

      await waitFor(() => {
        // Should only save once due to disabled state during save
        expect(saveCount).toBeLessThanOrEqual(2);
      });
    });

    it('should handle save error gracefully', async () => {
      const user = userEvent.setup();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onSave = vi.fn().mockRejectedValue(new Error('Save failed'));

      render(<AlertRuleBuilder onSave={onSave} />);

      await user.type(screen.getByTestId('rule-name-input'), 'Test');
      await user.click(screen.getByTestId('save-button'));

      await waitFor(() => {
        expect(screen.getByText(/oluştur/i)).toBeInTheDocument(); // Button text returns
      });

      consoleError.mockRestore();
    });

    it('should handle missing optional props', () => {
      // Should not throw
      expect(() => render(<AlertRuleBuilder />)).not.toThrow();
    });
  });
});
