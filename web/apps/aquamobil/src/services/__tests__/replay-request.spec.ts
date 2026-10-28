/**
 * The foreground replay transport (PKG-42; ADR-051 C6): every foreground replay — one queued
 * mutation, the leave follow-up, the media lane's presign and send — goes through
 * authenticatedFetch, the one auth lane, and is read by replay-response.ts, so a rejection keeps
 * the server's code. The media lane used graphqlRequest, whose GraphQLError the queue does not
 * read, so its rejections were never listed for re-entry.
 */
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { parse } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  authenticatedFetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
}));

vi.mock('@/services/authenticated-fetch', () => ({
  authenticatedFetch: transport.authenticatedFetch,
}));

import { replayDocument, replayOperation } from '../replay-request';

import { GraphQLReplayError } from '@/pwa/graphql-replay-error';

/** A media-lane document, built here so no codegen source names it. */
const SEND: TypedDocumentNode<{ sendMessage: { id: string } }, { input: { channelId: string } }> =
  parse('mutation ReplayProbe($input: SendMessageInput!) { sendMessage(input: $input) { id } }');

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('replay-request', () => {
  beforeEach(() => {
    transport.authenticatedFetch.mockReset();
  });

  it('sends the operation through the one auth lane and resolves to its data', async () => {
    transport.authenticatedFetch.mockResolvedValue(json(200, { data: { deleteMessage: true } }));

    await expect(
      replayOperation('mutation ReplayProbe($id: ID!) { deleteMessage(id: $id) }', { id: 'm1' }),
    ).resolves.toEqual({ deleteMessage: true });

    expect(transport.authenticatedFetch).toHaveBeenCalledTimes(1);
    const [call] = transport.authenticatedFetch.mock.calls;
    if (call === undefined) throw new Error('nothing was sent');
    const [url, init] = call;
    expect(url).toBe('/graphql');
    expect(init.method).toBe('POST');
    if (typeof init.body !== 'string') throw new Error('the replay sent no JSON body');
    expect(JSON.parse(init.body)).toMatchObject({ variables: { id: 'm1' } });
  });

  it('rejects a media-lane document with the code of an HTTP 400 answer', async () => {
    transport.authenticatedFetch.mockResolvedValue(
      json(400, {
        errors: [
          { message: 'Cannot query field', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
        ],
      }),
    );

    const replay = replayDocument(SEND, { input: { channelId: 'c1' } });
    await expect(replay).rejects.toBeInstanceOf(GraphQLReplayError);
    await expect(replay).rejects.toMatchObject({ code: 'GRAPHQL_VALIDATION_FAILED' });
  });

  it('rejects a media-lane document the server refused, with its code', async () => {
    transport.authenticatedFetch.mockResolvedValue(
      json(200, { errors: [{ message: 'Forbidden resource', extensions: { code: 'FORBIDDEN' } }] }),
    );

    await expect(replayDocument(SEND, { input: { channelId: 'c1' } })).rejects.toMatchObject({
      name: 'GraphQLReplayError',
      code: 'FORBIDDEN',
    });
  });

  it('resolves a media-lane document to its data, and fails when the answer carries none', async () => {
    transport.authenticatedFetch.mockResolvedValueOnce(
      json(200, { data: { sendMessage: { id: 'msg-1' } } }),
    );
    await expect(replayDocument(SEND, { input: { channelId: 'c1' } })).resolves.toEqual({
      sendMessage: { id: 'msg-1' },
    });

    transport.authenticatedFetch.mockResolvedValueOnce(json(200, {}));
    await expect(replayDocument(SEND, { input: { channelId: 'c1' } })).rejects.toThrow(
      'No data returned',
    );
  });
});
