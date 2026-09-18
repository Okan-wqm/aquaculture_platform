/**
 * Avatar tests — initials fallback, image mode, deterministic background.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { Avatar } from '../Avatar';

describe('Avatar', () => {
  it('renders uppercase initials from the name when no image is given', () => {
    render(<Avatar name="Jane Doe" />);
    const el = screen.getByRole('img', { name: 'Jane Doe' });
    expect(el).toHaveTextContent('JD');
  });

  it('renders the image with the name as alt text when src is given', () => {
    render(<Avatar name="Jane Doe" src="https://example.test/a.png" />);
    const img = screen.getByRole('img', { name: 'Jane Doe' });
    expect(img.tagName).toBe('IMG');
    expect(img).toHaveAttribute('src', 'https://example.test/a.png');
  });

  it('uses a deterministic background class for the same name', () => {
    const { unmount } = render(<Avatar name="Jane Doe" />);
    const first = screen.getByRole('img', { name: 'Jane Doe' }).className;
    unmount();
    render(<Avatar name="Jane Doe" />);
    const second = screen.getByRole('img', { name: 'Jane Doe' }).className;
    expect(first).toBe(second);
  });

  it('falls back to ?? for an empty name', () => {
    render(<Avatar name="" />);
    expect(screen.getByText('??')).toBeInTheDocument();
  });
});
