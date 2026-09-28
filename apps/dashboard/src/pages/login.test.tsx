import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from './login';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => ({}),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock('@/lib/queryClient', () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

const login = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, login: (...args: unknown[]) => login(...args) } };
});

describe('LoginPage', () => {
  it('shows an inline error and does not navigate on invalid credentials', async () => {
    const { ApiError } = await import('@/lib/api');
    login.mockRejectedValue(new ApiError(401, 'INVALID_EMAIL_OR_PASSWORD'));

    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'me@example.invalid');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(screen.getByText('Invalid email or password.')).toBeInTheDocument());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates on successful login', async () => {
    login.mockResolvedValue(undefined);

    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText('Email'), 'me@example.invalid');
    await userEvent.type(screen.getByLabelText('Password'), 'correct-password');
    await userEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/' }));
  });
});
