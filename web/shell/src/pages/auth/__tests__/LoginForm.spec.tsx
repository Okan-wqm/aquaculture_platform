/**
 * LoginForm — the "remember me" checkbox threads through to login()
 * (ORPHAN-LOW-135). useAuthContext is partially mocked; the real Input/Button/
 * PasswordInput/Checkbox/i18n are kept.
 */
import React from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
const login = vi.fn().mockResolvedValue({ redirectPath: '/' });
const verifyMfaLogin = vi.fn().mockResolvedValue({ redirectPath: '/' });
const clearError = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('@aquaculture/shared-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aquaculture/shared-ui')>();
  return {
    ...actual,
    useAuthContext: () => ({
      login,
      verifyMfaLogin,
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

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    login.mockResolvedValue({ redirectPath: '/' });
    verifyMfaLogin.mockResolvedValue({ redirectPath: '/' });
  });

  it('renders the industrial sign-in surface with the mockup alternative controls', () => {
    const { container } = renderForm();

    expect(container.querySelector('.industrial-login-form')).not.toBeNull();
    expect(container.querySelectorAll('.industrial-auth-field')).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Dive back in');
    expect(screen.getByText('Sign in to your Suderra workspace')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();

    // Passkey/SSO are part of the approved login design. They are visual-only
    // (type="button", no handler) until their backend ceremonies land.
    expect(screen.getByRole('button', { name: /passkey/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'SSO' })).toBeTruthy();
    expect(screen.getByText('or')).toBeTruthy();
    expect(screen.getByText('No account yet?')).toBeTruthy();
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'a@b.com', password: 'password123', rememberMe: true }),
    );
  });

  it('blocks invalid credentials and preserves rememberMe=false by default', async () => {
    const { container } = renderForm();
    const submit = screen.getByRole('button', { name: 'Continue' });

    fireEvent.click(submit);
    expect(login).not.toHaveBeenCalled();

    const email = container.querySelector<HTMLInputElement>('input[name="email"]');
    const password = container.querySelector<HTMLInputElement>('input[name="password"]');
    if (!email || !password) throw new Error('login fields not found');

    fireEvent.change(email, { target: { value: 'operator@suderra.com' } });
    fireEvent.change(password, { target: { value: 'password123' } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(login).toHaveBeenCalledWith({
        email: 'operator@suderra.com',
        password: 'password123',
        rememberMe: false,
      }),
    );
  });

  it.each(['/\\evil.example/steal', '/%5cevil.example/steal', '/%2f%2fevil.example/steal'])(
    'never passes browser-normalizable external redirect %s to navigate',
    async (redirectPath) => {
      login.mockResolvedValueOnce({ redirectPath });
      const { container } = renderForm();
      const email = container.querySelector<HTMLInputElement>('input[name="email"]');
      const password = container.querySelector<HTMLInputElement>('input[name="password"]');
      if (!email || !password) throw new Error('login fields not found');

      fireEvent.change(email, { target: { value: 'operator@suderra.com' } });
      fireEvent.change(password, { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

      await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
      expect(navigate).not.toHaveBeenCalledWith(redirectPath);
    },
  );

  it('preserves a valid internal redirect at the navigate sink', async () => {
    login.mockResolvedValueOnce({ redirectPath: '/sites/setup/sites?tab=active#main' });
    const { container } = renderForm();
    const email = container.querySelector<HTMLInputElement>('input[name="email"]');
    const password = container.querySelector<HTMLInputElement>('input[name="password"]');
    if (!email || !password) throw new Error('login fields not found');

    fireEvent.change(email, { target: { value: 'operator@suderra.com' } });
    fireEvent.change(password, { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/sites/setup/sites?tab=active#main'),
    );
  });

  const fillMfaDigits = (container: HTMLElement, code: string): void => {
    const boxes = container.querySelectorAll<HTMLInputElement>('.industrial-mfa-digit');
    if (boxes.length !== 6) throw new Error(`expected 6 MFA digit boxes, got ${boxes.length}`);
    code.split('').forEach((digit, i) => {
      fireEvent.change(boxes[i], { target: { value: digit } });
    });
  };

  it('uses the real MFA challenge token and only enables verification for a valid code', async () => {
    login.mockResolvedValueOnce({
      mfaRequired: true,
      mfaToken: 'mfa-challenge-token',
    });
    const { container } = renderForm();
    const email = container.querySelector<HTMLInputElement>('input[name="email"]');
    const password = container.querySelector<HTMLInputElement>('input[name="password"]');
    if (!email || !password) throw new Error('login fields not found');

    fireEvent.change(email, { target: { value: 'operator@suderra.com' } });
    fireEvent.change(password, { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const verifyButton = await screen.findByRole('button', { name: 'Verify & continue' });
    expect((verifyButton as HTMLButtonElement).disabled).toBe(true);

    fillMfaDigits(container, '123456');
    expect((verifyButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(verifyButton);

    await waitFor(() =>
      expect(verifyMfaLogin).toHaveBeenCalledWith({
        mfaToken: 'mfa-challenge-token',
        code: '123456',
      }),
    );
  });

  it('never passes an encoded control-character MFA redirect to navigate', async () => {
    login.mockResolvedValueOnce({
      mfaRequired: true,
      mfaToken: 'mfa-challenge-token',
    });
    verifyMfaLogin.mockResolvedValueOnce({ redirectPath: '/%09/evil.example' });
    const { container } = renderForm();
    const email = container.querySelector<HTMLInputElement>('input[name="email"]');
    const password = container.querySelector<HTMLInputElement>('input[name="password"]');
    if (!email || !password) throw new Error('login fields not found');

    fireEvent.change(email, { target: { value: 'operator@suderra.com' } });
    fireEvent.change(password, { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    const verifyButton = await screen.findByRole('button', { name: 'Verify & continue' });
    fillMfaDigits(container, '123456');
    fireEvent.click(verifyButton);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
    expect(navigate).not.toHaveBeenCalledWith('/%09/evil.example');
  });
});
