import { observeCurrentCompletionWindow } from '../src/runtime/completion-proof-bundle-current';

const proofWindow = {
  valid_from: '2026-09-02T12:00:00.000Z',
  valid_until: '2026-09-02T13:00:00.000Z',
};

describe('completion bundle final current window', () => {
  afterEach(() => jest.restoreAllMocks());

  it('rejects expiry while repository and epoch state are revalidated', () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse('2026-09-02T12:59:59.999Z'))
      .mockReturnValueOnce(Date.parse('2026-09-02T13:00:00.001Z'));
    const operation = jest.fn();

    expect(() => observeCurrentCompletionWindow(proofWindow, operation)).toThrow(
      /currently valid/i,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rejects a clock rollback across repository and epoch revalidation', () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse('2026-09-02T12:30:00.001Z'))
      .mockReturnValueOnce(Date.parse('2026-09-02T12:30:00.000Z'));

    expect(() => observeCurrentCompletionWindow(proofWindow, () => undefined)).toThrow(
      /clock rolled back/i,
    );
  });
});
