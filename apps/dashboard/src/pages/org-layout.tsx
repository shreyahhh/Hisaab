import { Outlet } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AppShell } from '@/components/app-shell';
import { useMe } from '@/lib/session';

export function OrgLayout({ orgId }: { readonly orgId: string }) {
  const { data: me, isLoading } = useMe();

  if (isLoading || !me) return null;

  const membership = me.memberships.find((m) => m.organizationId === orgId);
  if (!membership) {
    // Not a 404 page per se — the API itself would 404 any call for this org (SPEC §5.10 test 7);
    // this is just the client-side equivalent so a stale/foreign link doesn't render a broken shell.
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Organization not found</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Either this organization doesn't exist, or you're not a member of it.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <AppShell orgId={orgId} role={membership.role} user={me.user}>
      <Outlet />
    </AppShell>
  );
}
