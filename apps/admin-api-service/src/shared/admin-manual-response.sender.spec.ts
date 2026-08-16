import { adminManualResponse, decodeAdminAttachmentFilename } from '@platform/admin-http-contracts';
import express from 'express';
import request from 'supertest';

import { sendAdminBinaryResponse } from './admin-manual-response.sender';

const csvProfile = adminManualResponse.binary([200], ['text/csv'], 1_024);
const requestId = 'binary_request_123';

describe('admin manual binary response transport', () => {
  it('preserves the profile media type and the exact UTF-8 bytes through Express', async () => {
    const csv = 'name,value\nçipura,42\n';
    const expected = Buffer.from(csv, 'utf8');
    const app = express();
    app.get('/export', (_request, response) => {
      response.setHeader('X-Request-ID', requestId);
      sendAdminBinaryResponse(response, csvProfile, {
        status: 200,
        mediaType: 'text/csv',
        filename: decodeAdminAttachmentFilename('report.csv'),
        data: csv,
      });
    });

    const response = await request(app)
      .get('/export')
      .buffer(true)
      .parse((incoming, complete) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => complete(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv');
    expect(response.headers['content-length']).toBe(String(expected.byteLength));
    expect(response.headers['content-disposition']).toBe('attachment; filename="report.csv"');
    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toEqual(expected);
  });

  it('rejects bytes above the route budget before writing a response', () => {
    const response = {
      getHeader: jest.fn().mockReturnValue(requestId),
      setHeader: jest.fn(),
      status: jest.fn(),
      end: jest.fn(),
    };

    expect(() =>
      sendAdminBinaryResponse(response as never, csvProfile, {
        status: 200,
        mediaType: 'text/csv',
        filename: decodeAdminAttachmentFilename('report.csv'),
        data: Buffer.alloc(csvProfile.maxBytes + 1),
      }),
    ).toThrow(`binary response exceeds route budget ${csvProfile.maxBytes} bytes`);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
  });
});
