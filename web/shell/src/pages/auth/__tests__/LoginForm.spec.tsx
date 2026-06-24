/**
 * LoginForm — the "remember me" checkbox threads through to login()
 * (ORPHAN-LOW-135). useAuthContext is partially mocked; the real Input/Button/
 * PasswordInput/Checkbox/i18n are kept.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const login = vi.fn().mockResolvedValue({ redirectPath: '/' });
const clearError = vi.fn();

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => ({
      login,
      verifyMfaLogin: vi.fn(),
      error: null,
      clearError,
    }),
  };
});

// Import AFTER the mock is registered.
import LoginForm from '../LoginForm';

const renderForm = (): ReturnType<typeof render> =>
  render(
    <MemoryRouter>
      <LoginForm />
    </MemoryRouter>,
  );

describe('LoginForm remember-me wiring', () => {
  it('passes rememberMe=true to login() when the checkbox is checked', async () => {
    const { container } = renderForm();

    const byName = (name: string): HTMLInputElement => {
      const el = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (!el) throw new Error(`input[name="${name}"] not found`);
      return el;
    };

    fireEvent.change(byName('email'), { target: { value: 'a@b.com' } });
    fireEvent.change(byName('password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com', password: 'password123', rememberMe: true }),
    );
  });
});
