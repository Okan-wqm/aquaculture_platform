/**
 * AiAssistantDrawer persona picker (FE-MEDIUM-065): offers the tenant default
 * plus exactly the catalogue personas whose required capabilities the user
 * holds; choosing one is forwarded to the socket hook.
 */
import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { hasPermission, setPersona, sendMessage, reset } = vi.hoisted(() => ({
  hasPermission: vi.fn<(permission: string) => boolean>(),
  setPersona: vi.fn(),
  sendMessage: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return { ...actual, useAuth: () => ({ hasPermission }) };
});

vi.mock('../../../hooks/useAiAssistantSocket', () => ({
  useAiAssistantSocket: () => ({
    messages: [],
    status: 'ready',
    persona: null,
    setPersona,
    sendMessage,
    reset,
  }),
}));

// Import AFTER the mocks are registered.
import AiAssistantDrawer from '../AiAssistantDrawer';

const optionValues = (): string[] =>
  Array.from(screen.getByLabelText('Assistant').querySelectorAll('option')).map(
    (o) => (o as HTMLOptionElement).value,
  );

describe('AiAssistantDrawer persona picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers only the personas the user holds every required capability for', () => {
    const held = new Set(['ai_personas:operator', 'ai_personas:expert', 'ai_specialties:farm']);
    hasPermission.mockImplementation((p) => held.has(p));

    render(<AiAssistantDrawer open onClose={() => {}} />);

    expect(optionValues()).toEqual([
      '',
      'operator-v1',
      'expert-v1',
      'operator-farm-water-health-v1',
      'expert-farm-water-health-v1',
      'operator-farm-production-v1',
      'expert-farm-production-v1',
      'operator-farm-operations-v1',
      'expert-farm-operations-v1',
    ]);
    expect(screen.getByText('Water & Fish Health Specialist (Expert)')).toBeTruthy();
  });

  it('withholds farm specialists from a user without the farm specialty', () => {
    hasPermission.mockImplementation((p) => p === 'ai_personas:manager');

    render(<AiAssistantDrawer open onClose={() => {}} />);

    expect(optionValues()).toEqual(['', 'manager-v1']);
  });

  it('forwards the chosen id to the socket hook and null for the default', () => {
    hasPermission.mockReturnValue(true);
    render(<AiAssistantDrawer open onClose={() => {}} />);
    const select = screen.getByLabelText('Assistant');

    fireEvent.change(select, { target: { value: 'manager-farm-production-v1' } });
    expect(setPersona).toHaveBeenLastCalledWith('manager-farm-production-v1');

    fireEvent.change(select, { target: { value: '' } });
    expect(setPersona).toHaveBeenLastCalledWith(null);
  });
});
