import { prepareSprintCompletion } from '../src/application/progress-admission';

import { admissionInput } from './admission-fixture';

describe('runner-issued negative-control admission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T12:30:00.000Z'));
  });

  afterEach(() => jest.useRealTimers());

  it('rejects DONE when required controls have only synthetic execution receipts', () => {
    const scenario = admissionInput();

    expect(() => prepareSprintCompletion(scenario.candidate, scenario.context)).toThrow(
      /runner-issued.*negative-control.*receipt/i,
    );
  });
});
