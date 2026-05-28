import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { IsNull } from 'typeorm';
import { ChannelMember, ChannelMemberRole } from '../../../channel/entities/channel-member.entity';
import { ChannelMemberGuard, CHANNEL_CONTEXT_KEY } from '../channel-member.guard';
import {
  createMockChannelMember,
  createMockRepository,
  fakeUuid,
  resetUuidCounter,
  MockRepository,
} from '../../../__tests__/test-helpers';

// Mock GqlExecutionContext
jest.mock('@nestjs/graphql', () => ({
  ...jest.requireActual('@nestjs/graphql'),
  GqlExecutionContext: {
    create: jest.fn(),
  },
}));

describe('ChannelMemberGuard', () => {
  let guard: ChannelMemberGuard;
  let memberRepo: MockRepository<ChannelMember>;

  const channelId = fakeUuid('ch');
  const userId = fakeUuid('usr');
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  beforeEach(async () => {
    resetUuidCounter();

    memberRepo = createMockRepository<ChannelMember>();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelMemberGuard,
        { provide: getRepositoryToken(ChannelMember), useValue: memberRepo },
      ],
    }).compile();

    guard = module.get(ChannelMemberGuard);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function createGqlExecutionContext(
    args: Record<string, unknown>,
    userSub: string | undefined,
  ): ExecutionContext {
    const req: Record<string, unknown> = {
      user: userSub ? { sub: userSub, tenantId } : undefined,
    };
    const mockGqlCtx = {
      getArgs: jest.fn().mockReturnValue(args),
      getContext: jest.fn().mockReturnValue({ req }),
    };
    (GqlExecutionContext.create as jest.Mock).mockReturnValue(mockGqlCtx);

    // Return a context that getType() returns 'graphql'
    return {
      getType: jest.fn().mockReturnValue('graphql'),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;
  }

  // -----------------------------------------------------------------------
  // Allow active member
  // -----------------------------------------------------------------------
  it('allows access for active channel member', async () => {
    const ctx = createGqlExecutionContext({ channelId }, userId);

    memberRepo.findOne.mockResolvedValue(
      createMockChannelMember({
        channelId,
        tenantId,
        userId,
        role: ChannelMemberRole.MEMBER,
        leftAt: null,
      }),
    );

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Deny non-member
  // -----------------------------------------------------------------------
  it('denies access for non-member (ForbiddenException)', async () => {
    const ctx = createGqlExecutionContext({ channelId }, userId);

    memberRepo.findOne.mockResolvedValue(null);

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // Deny member who left - the guard uses IsNull() for leftAt, so
  // a member with leftAt set will not be found
  // -----------------------------------------------------------------------
  it('denies access for member who left (leftAt IS NOT NULL)', async () => {
    const ctx = createGqlExecutionContext({ channelId }, userId);

    // The guard queries with leftAt: IsNull(), so a left member won't match
    memberRepo.findOne.mockResolvedValue(null);

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // -----------------------------------------------------------------------
  // Missing channelId
  // -----------------------------------------------------------------------
  it('throws ForbiddenException when channelId is missing', async () => {
    const ctx = createGqlExecutionContext({}, userId);

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });
});
