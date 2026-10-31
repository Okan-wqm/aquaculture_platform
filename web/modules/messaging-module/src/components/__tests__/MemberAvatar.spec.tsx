/**
 * MemberAvatar — a person's photo, falling back to initials when there is none or it fails to
 * load (a dead URL, or one the console's img-src policy blocks): never a broken-image icon.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MessagingUser } from '../../types/messaging';
import { MemberAvatar } from '../MemberAvatar';

const AYSE: MessagingUser = {
  id: 'u1',
  firstName: 'Ayşe',
  lastName: 'Yılmaz',
  profileImageUrl: 'https://cdn.example.test/ayse.png',
};

describe('MemberAvatar', () => {
  it('shows the profile photo, decorative beside the visible name', () => {
    render(<MemberAvatar user={AYSE} />);

    const avatar = screen.getByTestId('member-avatar');
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(avatar.querySelector('img')).toHaveAttribute('src', AYSE.profileImageUrl);
  });

  it('falls back to the initials when the photo fails to load', () => {
    render(<MemberAvatar user={AYSE} />);

    const img = screen.getByTestId('member-avatar').querySelector('img');
    if (!img) throw new Error('photo not rendered');
    fireEvent.error(img);

    expect(screen.getByTestId('member-avatar').querySelector('img')).toBeNull();
    expect(screen.getByTestId('member-avatar')).toHaveTextContent('AY');
  });

  it('shows the initials when the profile has no photo', () => {
    render(<MemberAvatar user={{ ...AYSE, profileImageUrl: null }} />);
    expect(screen.getByTestId('member-avatar')).toHaveTextContent('AY');
  });
});
