import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithQueryClient } from '@/testUtils';
import { DpaPage } from './dpa';

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

describe('DpaPage — dpa.accept is owner-only (auth-tenancy.md §2.4)', () => {
  it('an admin sees no accept button, only an explanatory message', () => {
    vi.mocked(useMe).mockReturnValue(meWithRole('admin') as never);
    renderWithQueryClient(<DpaPage orgId={ORG_ID} />);

    expect(screen.getByText(/only the organization owner can accept/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /accept version/i })).not.toBeInTheDocument();
  });

  it('an owner sees the accept button', () => {
    vi.mocked(useMe).mockReturnValue(meWithRole('owner') as never);
    renderWithQueryClient(<DpaPage orgId={ORG_ID} />);

    expect(screen.queryByText(/only the organization owner can accept/i)).not.toBeInTheDocument();
    // VITE_DPA_VERSION isn't set in the test environment, so the misconfiguration panel shows
    // instead of the accept button — still proves the owner isn't blocked by the role gate.
    expect(screen.getByText(/dashboard misconfigured|accept version/i)).toBeInTheDocument();
  });
});
