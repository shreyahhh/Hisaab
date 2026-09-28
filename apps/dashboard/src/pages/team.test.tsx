import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithQueryClient } from '@/testUtils';
import { TeamPage } from './team';

const listMembers = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listMembers: (...args: unknown[]) => listMembers(...args),
    },
  };
});

vi.mock('@/lib/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/session')>('@/lib/session');
  return { ...actual, useMe: vi.fn() };
});

import { useMe } from '@/lib/session';

const ORG_ID = 'org-1';

function meWithRole(role: 'owner' | 'admin' | 'analyst' | 'viewer') {
  return {
    data: {
      user: { id: 'me', email: 'me@example.invalid', name: 'Me' },
      memberships: [{ organizationId: ORG_ID, role }],
    },
  };
}

describe('TeamPage — role ceilings (auth-tenancy.md §2.1/§2.4)', () => {
  it('an admin cannot invite someone as owner (the owner role is not offered)', async () => {
    vi.mocked(useMe).mockReturnValue(meWithRole('admin') as never);
    listMembers.mockResolvedValue({
      members: [{ userId: 'me', email: 'me@example.invalid', name: 'Me', role: 'admin' }],
    });

    renderWithQueryClient(<TeamPage orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByText('Me')).toBeInTheDocument());

    // The invite role <select> is the first combobox on the page (the invite form's, not a
    // member row's) — admin's own rank excludes 'owner' from the options it renders.
    const roleSelects = screen.getAllByRole('combobox');
    await userEvent.click(roleSelects[0]!);
    expect(screen.queryByRole('option', { name: 'owner' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'admin' })).toBeInTheDocument();
  });

  it('an owner can invite at any role, including owner', async () => {
    vi.mocked(useMe).mockReturnValue(meWithRole('owner') as never);
    listMembers.mockResolvedValue({
      members: [{ userId: 'me', email: 'me@example.invalid', name: 'Me', role: 'owner' }],
    });

    renderWithQueryClient(<TeamPage orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByText('Me')).toBeInTheDocument());

    const roleSelects = screen.getAllByRole('combobox');
    await userEvent.click(roleSelects[0]!);
    expect(screen.getByRole('option', { name: 'owner' })).toBeInTheDocument();
  });

  it("an admin sees no remove/role-change action on another admin's row (only manages analyst/viewer)", async () => {
    vi.mocked(useMe).mockReturnValue(meWithRole('admin') as never);
    listMembers.mockResolvedValue({
      members: [
        { userId: 'me', email: 'me@example.invalid', name: 'Me', role: 'admin' },
        {
          userId: 'other-admin',
          email: 'other@example.invalid',
          name: 'Other Admin',
          role: 'admin',
        },
      ],
    });

    renderWithQueryClient(<TeamPage orgId={ORG_ID} />);
    await waitFor(() => expect(screen.getByText('Other Admin')).toBeInTheDocument());

    // "Other Admin"'s row: the role <select> is disabled and there's no action button (not even
    // "Remove") — the UI hides what the API would refuse anyway (dashboard.md §6).
    const otherAdminRow = screen.getByText('Other Admin').closest('tr')!;
    const { getByRole, queryByRole } = within(otherAdminRow);
    expect(getByRole('combobox')).toBeDisabled();
    expect(queryByRole('button')).not.toBeInTheDocument();
  });
});
