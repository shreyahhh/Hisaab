import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type Store } from '@/lib/api';

function StoreIntegrations({ orgId, store }: { orgId: string; store: Store }) {
  const queryClient = useQueryClient();
  const integrationsQuery = useQuery({
    queryKey: ['store-integrations', store.id],
    queryFn: () => api.listStoreIntegrations(store.id),
  });

  const disconnectMutation = useMutation({
    mutationFn: (integrationId: string) => api.disconnectIntegration(orgId, integrationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['store-integrations', store.id] });
      toast.success('Disconnected');
    },
    onError: () => toast.error('Could not disconnect that integration.'),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{store.shopDomain}</CardTitle>
        <CardDescription>
          {store.currency} · {store.timezone}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {integrationsQuery.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : integrationsQuery.data && integrationsQuery.data.integrations.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {integrationsQuery.data.integrations.map((integration) => (
              <li
                key={integration.id}
                className="flex items-center justify-between gap-2 rounded-none border p-3 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium capitalize">{integration.provider}</span>
                  <Badge variant={integration.status === 'active' ? 'default' : 'secondary'}>
                    {integration.status}
                  </Badge>
                  {integration.last_synced_at ? (
                    <span className="text-xs text-muted-foreground">
                      last synced {new Date(integration.last_synced_at).toLocaleString('en-IN')}
                    </span>
                  ) : null}
                </div>
                {integration.status === 'active' ? (
                  <AlertDialog>
                    <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>
                      Disconnect
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Disconnect {store.shopDomain}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          TruePath will stop syncing orders and pause tracking for this store. You
                          can reconnect at any time from this page.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => disconnectMutation.mutate(integration.id)}
                        >
                          Disconnect
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No integrations for this store yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsPage({ orgId }: { readonly orgId: string }) {
  const [shop, setShop] = useState('');
  const storesQuery = useQuery({
    queryKey: ['stores', orgId],
    queryFn: () => api.listStores(orgId),
  });

  function onConnect(event: FormEvent) {
    event.preventDefault();
    // A full-page navigation, not a fetch: Shopify's OAuth consent screen needs the real browser
    // to follow the 302 chain (dashboard.md §4.1 step 3).
    window.location.href = api.shopifyConnectUrl(orgId, shop.trim());
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">Connect Shopify to start syncing orders.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connect Shopify</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onConnect} className="flex items-end gap-2">
            <FieldGroup className="flex-1">
              <Field>
                <FieldLabel htmlFor="shop-domain">Shop domain</FieldLabel>
                <Input
                  id="shop-domain"
                  placeholder="your-store.myshopify.com"
                  required
                  value={shop}
                  onChange={(e) => setShop(e.target.value)}
                />
                <FieldDescription>
                  Requests read_orders, write_pixels and read_customer_events, plus protected
                  customer data (email, phone, address) used only to create one-way fingerprints.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <Button type="submit">Connect</Button>
          </form>
        </CardContent>
      </Card>

      {storesQuery.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : storesQuery.data && storesQuery.data.stores.length > 0 ? (
        <div className="flex flex-col gap-4">
          {storesQuery.data.stores.map((store) => (
            <StoreIntegrations key={store.id} orgId={orgId} store={store} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No stores connected yet.</p>
      )}
    </div>
  );
}
