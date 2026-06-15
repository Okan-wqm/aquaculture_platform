import { MessageContentType } from '../../message/entities/message.entity';
import { ReceiptStatus } from '../../message/entities/message-receipt.entity';
import { ChannelType } from '../../channel/entities/channel.entity';
import {
  ChannelMemberRole,
  NotificationPreference,
} from '../../channel/entities/channel-member.entity';
import { normalizeEnumInput, toWireEnumName } from '../enum-wire.util';

/**
 * S1-CODEGEN / MSG-CRITICAL-055: the WS hydrator must emit the UPPERCASE GraphQL
 * enum NAME (not the lowercase DB value) so the live WS wire form matches the
 * GraphQL query wire form the codegen client consumes. `toWireEnumName` is the
 * canonical VALUE→NAME projection; these tests pin every messaging enum member
 * AND assert the derivation can never silently emit a lowercase value.
 */
describe('toWireEnumName', () => {
  it('projects every MessageContentType VALUE to its UPPERCASE GraphQL NAME', () => {
    expect(toWireEnumName(MessageContentType, MessageContentType.TEXT)).toBe('TEXT');
    expect(toWireEnumName(MessageContentType, MessageContentType.IMAGE)).toBe('IMAGE');
    expect(toWireEnumName(MessageContentType, MessageContentType.FILE)).toBe('FILE');
    expect(toWireEnumName(MessageContentType, MessageContentType.VOICE)).toBe('VOICE');
    expect(toWireEnumName(MessageContentType, MessageContentType.SYSTEM)).toBe('SYSTEM');
  });

  it('projects every ReceiptStatus VALUE to its UPPERCASE GraphQL NAME', () => {
    expect(toWireEnumName(ReceiptStatus, ReceiptStatus.DELIVERED)).toBe('DELIVERED');
    expect(toWireEnumName(ReceiptStatus, ReceiptStatus.READ)).toBe('READ');
  });

  it('projects every ChannelType VALUE to its UPPERCASE GraphQL NAME', () => {
    expect(toWireEnumName(ChannelType, ChannelType.DIRECT)).toBe('DIRECT');
    expect(toWireEnumName(ChannelType, ChannelType.GROUP)).toBe('GROUP');
    expect(toWireEnumName(ChannelType, ChannelType.AI)).toBe('AI');
  });

  it('covers EVERY enum member (no value is left projecting to lowercase)', () => {
    // Derivation invariant: the projection of each VALUE is its KEY, and the
    // result is never the lowercase value itself — guarding against a future
    // enum member added without a wire form.
    for (const [name, value] of Object.entries(MessageContentType)) {
      expect(toWireEnumName(MessageContentType, value)).toBe(name);
      expect(toWireEnumName(MessageContentType, value)).not.toBe(value);
    }
    for (const [name, value] of Object.entries(ReceiptStatus)) {
      expect(toWireEnumName(ReceiptStatus, value)).toBe(name);
    }
  });

  it('throws on a value that is not a member of the enum (corrupted row, not casing drift)', () => {
    expect(() =>
      toWireEnumName(MessageContentType, 'bogus' as MessageContentType),
    ).toThrow(/not a member/);
  });
});

/**
 * S1-CODEGEN / INFRA-CRITICAL-013: the resolver WRITE path is the inverse of the
 * WS read path — it must coerce the inbound UPPERCASE GraphQL enum NAME back to
 * the lowercase DB VALUE the CHECK constraints accept. `normalizeEnumInput` is
 * the canonical NAME→VALUE projection used by BOTH addChannelMember and
 * updateNotificationPreference so the two member-enum writes are uniformly
 * constraint-safe.
 */
describe('normalizeEnumInput', () => {
  it('maps the UPPERCASE GraphQL NAME to the lowercase DB VALUE (ChannelMemberRole)', () => {
    expect(normalizeEnumInput(ChannelMemberRole, 'OWNER')).toBe(ChannelMemberRole.OWNER);
    expect(normalizeEnumInput(ChannelMemberRole, 'ADMIN')).toBe(ChannelMemberRole.ADMIN);
    expect(normalizeEnumInput(ChannelMemberRole, 'MEMBER')).toBe(ChannelMemberRole.MEMBER);
    expect(normalizeEnumInput(ChannelMemberRole, 'OWNER')).toBe('owner');
  });

  it('maps the UPPERCASE GraphQL NAME to the lowercase DB VALUE (NotificationPreference)', () => {
    expect(normalizeEnumInput(NotificationPreference, 'ALL')).toBe(NotificationPreference.ALL);
    expect(normalizeEnumInput(NotificationPreference, 'MENTIONS')).toBe(NotificationPreference.MENTIONS);
    expect(normalizeEnumInput(NotificationPreference, 'NONE')).toBe(NotificationPreference.NONE);
    expect(normalizeEnumInput(NotificationPreference, 'ALL')).toBe('all');
  });

  it('returns an already-normalized lowercase VALUE unchanged (round-trip safe)', () => {
    expect(normalizeEnumInput(ChannelMemberRole, 'member')).toBe(ChannelMemberRole.MEMBER);
    expect(normalizeEnumInput(NotificationPreference, 'mentions')).toBe(
      NotificationPreference.MENTIONS,
    );
  });

  it('is the exact inverse of toWireEnumName for every member-enum value', () => {
    for (const value of Object.values(ChannelMemberRole)) {
      expect(normalizeEnumInput(ChannelMemberRole, toWireEnumName(ChannelMemberRole, value))).toBe(
        value,
      );
    }
    for (const value of Object.values(NotificationPreference)) {
      expect(
        normalizeEnumInput(
          NotificationPreference,
          toWireEnumName(NotificationPreference, value),
        ),
      ).toBe(value);
    }
  });

  it('throws on a literal that is neither a NAME nor a VALUE (would violate the DB CHECK)', () => {
    expect(() => normalizeEnumInput(ChannelMemberRole, 'superuser')).toThrow(
      /neither a NAME nor a VALUE/,
    );
  });
});
