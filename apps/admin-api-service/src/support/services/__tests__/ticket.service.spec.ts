import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SupportTicket, TicketComment } from '../../entities/support.entity';
import { TicketService } from '../ticket.service';

describe('TicketService assignment actor', () => {
  const operatorId = '11111111-1111-4111-8111-111111111111';
  let service: TicketService;
  let ticketRepository: { findOne: jest.Mock; save: jest.Mock };
  let commentRepository: { create: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    ticketRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'ticket-1',
        status: 'open',
        firstResponseAt: null,
      }),
      save: jest.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    };
    commentRepository = {
      create: jest.fn().mockImplementation((value: unknown) => value),
      save: jest.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TicketService,
        { provide: getRepositoryToken(SupportTicket), useValue: ticketRepository },
        { provide: getRepositoryToken(TicketComment), useValue: commentRepository },
      ],
    }).compile();

    service = moduleRef.get(TicketService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('records the authenticated operator UUID while preserving the system-note discriminator', async () => {
    await service.assignTicket(
      'ticket-1',
      '22222222-2222-4222-8222-222222222222',
      'Support Owner',
      operatorId,
    );

    expect(commentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ authorId: operatorId, authorType: 'system' }),
    );
    expect(ticketRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedTo: '22222222-2222-4222-8222-222222222222',
        status: 'in_progress',
      }),
    );
  });

  it('does not classify an assignment note as the first human response', async () => {
    await service.assignTicket(
      'ticket-1',
      '22222222-2222-4222-8222-222222222222',
      'Support Owner',
      operatorId,
    );

    expect(ticketRepository.save).toHaveBeenCalledTimes(1);
    expect(ticketRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ firstResponseAt: null }),
    );
  });
});
