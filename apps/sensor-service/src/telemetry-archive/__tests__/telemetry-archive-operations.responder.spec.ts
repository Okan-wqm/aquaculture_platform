import type { IRequestReply, RequestReplyResponderHandle } from '@platform/event-bus';

import { TelemetryArchiveOperationsResponder } from '../telemetry-archive-operations.responder';

function handle(subject: string, drain: jest.Mock): RequestReplyResponderHandle {
  return { subject, drain };
}

describe('TelemetryArchiveOperationsResponder', () => {
  it('drains every completed registration when a later async registration fails', async () => {
    const firstDrain = jest.fn(async () => undefined);
    const requestReply: Pick<IRequestReply, 'respond'> = {
      respond: jest
        .fn()
        .mockResolvedValueOnce(handle('request.sensor.telemetryArchive.export', firstDrain))
        .mockRejectedValueOnce(new Error('registration failed')),
    };
    const responder = new TelemetryArchiveOperationsResponder(
      requestReply,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(responder.onModuleInit()).rejects.toThrow('registration failed');

    expect(firstDrain).toHaveBeenCalledTimes(1);
  });
});
