import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useMe } from '@/lib/session';

export function OverviewPage({ orgId }: { readonly orgId: string }) {
  const { data: me } = useMe();
  const org = (
    useQuery({ queryKey: ['orgs'], queryFn: api.listOrgs }).data?.organizations ?? []
  ).find((o) => o.id === orgId);
  const storesQuery = useQuery({
    queryKey: ['stores', orgId],
    queryFn: () => api.listStores(orgId),
  });
  const role = me?.memberships.find((m) => m.organizationId === orgId)?.role;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">{org?.name ?? 'Organization overview'}</h1>
        <p className="text-sm text-muted-foreground">Your role: {role ?? '—'}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Connected stores</CardDescription>
            <CardTitle className="text-3xl">
              {storesQuery.isLoading ? (
                <Skeleton className="h-8 w-10" />
              ) : (
                (storesQuery.data?.stores.length ?? 0)
              )}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Plan</CardDescription>
            <CardTitle className="text-3xl">{org?.plan ?? '—'}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Status</CardDescription>
            <CardTitle>
              <Badge variant={org?.status === 'active' ? 'default' : 'secondary'}>
                {org?.status ?? '—'}
              </Badge>
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Stores</CardTitle>
          <CardDescription>Shopify stores connected to this organization.</CardDescription>
        </CardHeader>
        <CardContent>
          {storesQuery.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : storesQuery.data && storesQuery.data.stores.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {storesQuery.data.stores.map((store) => (
                <li
                  key={store.id}
                  className="flex items-center justify-between rounded-none border p-3 text-sm"
                >
                  <span>{store.shopDomain}</span>
                  <Badge variant={store.status === 'active' ? 'default' : 'secondary'}>
                    {store.status}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No stores connected yet. Connect Shopify from the Integrations page.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
