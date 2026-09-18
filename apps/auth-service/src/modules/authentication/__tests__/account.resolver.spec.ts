import { AccountResolver } from '../resolvers/account.resolver';
import { AccountService } from '../services/account.service';

describe('AccountResolver', () => {
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
  };

  const accountService = {
    updateMyProfile: jest.fn().mockResolvedValue(user),
    changeMyPassword: jest
      .fn()
      .mockResolvedValue({ success: true, message: 'Password changed successfully' }),
    getMySecuritySettings: jest.fn().mockResolvedValue({
      mfaEnabled: true,
      mfaAvailable: true,
      mfaUnavailableReason: null,
    }),
  };

  let resolver: AccountResolver;

  beforeEach(() => {
    jest.clearAllMocks();
    resolver = new AccountResolver(accountService as unknown as AccountService);
  });

  it('delegates canonical profile updates to AccountService', async () => {
    await expect(
      resolver.updateMyProfile('user-1', { firstName: 'Grace', lastName: 'Hopper' }),
    ).resolves.toBe(user);

    expect(accountService.updateMyProfile).toHaveBeenCalledWith('user-1', {
      firstName: 'Grace',
      lastName: 'Hopper',
    });
  });

  it('delegates deprecated profile alias with email compatibility option', async () => {
    await resolver.updateProfileAlias('user-1', {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'user@example.com',
    });

    expect(accountService.updateMyProfile).toHaveBeenCalledWith(
      'user-1',
      { firstName: 'Grace', lastName: 'Hopper' },
      { email: 'user@example.com' },
    );
  });

  it('delegates canonical and deprecated password mutations to AccountService', async () => {
    const input = { currentPassword: 'OldPass1!', newPassword: 'NewPass1!' };

    await resolver.changeMyPassword('user-1', input);
    await resolver.changePasswordAlias('user-1', input);

    expect(accountService.changeMyPassword).toHaveBeenNthCalledWith(1, 'user-1', input);
    expect(accountService.changeMyPassword).toHaveBeenNthCalledWith(2, 'user-1', input);
  });

  it('returns my security settings from AccountService', async () => {
    await expect(resolver.mySecuritySettings('user-1')).resolves.toEqual({
      mfaEnabled: true,
      mfaAvailable: true,
      mfaUnavailableReason: null,
    });

    expect(accountService.getMySecuritySettings).toHaveBeenCalledWith('user-1');
  });
});
