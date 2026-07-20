import { getRepositoryToken } from '@nestjs/typeorm';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { validate as isUUID } from 'uuid';

import { SupportTicket, TicketComment } from '../../entities/support.entity';
import { TicketService } from '../ticket.service';

/**
 * APA-185 regression: assignTicket previously wrote the non-UUID literal
 * 'system' into ticket_comments.authorId (uuid NOT NULL) → Postgres 22P02 →
 * 500 before the ticket ever saved. The acting admin's UUID must now author the
 * assignment note, while authorType stays 'system' (the load-bearing SLA/UI
 * discriminator). Mocked repositories — no DB.
 */
describe('TicketService.assignTicket — actor UUID (APA-185)', () => {
  const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
  let service: TicketService;
  let ticketRepo: { findOne: jest.Mock; save: jest.Mock };
  let commentRepo: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const ticket = { id: 't-1', status: 'open', firstResponseAt: null as Date | null };
    ticketRepo = {
      findOne: jest.fn().mockResolvedValue(ticket),
      save: jest.fn().mockImplementation((t: unknown) => Promise.resolve(t)),
    };
    commentRepo = {
      create: jest.fn().mockImplementation((c: unknown) => c),
      save: jest.fn().mockImplementation((c: unknown) => Promise.resolve(c)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getRepositoryToken(SupportTicket), useValue: ticketRepo },
        { provide: getRepositoryToken(TicketComment), useValue: commentRepo },
      ],
    }).compile();
    service = moduleRef.get(TicketService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('authors the assignment note with the acting admin UUID, not the literal "system"', async () => {
    await service.assignTicket('t-1', '22222222-2222-4222-8222-222222222222', 'Jane', ADMIN_ID);

    const created = commentRepo.create.mock.calls[0][0] as {
      authorId: string;
      authorType: string;
    };
    expect(created.authorId).toBe(ADMIN_ID);
    expect(isUUID(created.authorId)).toBe(true);
    expect(created.authorId).not.toBe('system');
    // authorType stays the discriminator the SLA gate + UI rely on.
    expect(created.authorType).toBe('system');
  });

  it('does NOT count the system assignment note as the SLA first response', async () => {
    const savedTickets: Array<{ firstResponseAt: Date | null }> = [];
    ticketRepo.save.mockImplementation((t: { firstResponseAt: Date | null }) => {
      savedTickets.push(t);
      return Promise.resolve(t);
    });

    await service.assignTicket('t-1', '22222222-2222-4222-8222-222222222222', 'Jane', ADMIN_ID);

    // The final ticket save must not have stamped firstResponseAt from the
    // authorType:'system' note (only authorType:'admin' comments do).
    expect(savedTickets.every((t) => t.firstResponseAt === null)).toBe(true);
  });
});
