import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { rememberLastOrg } from '@/lib/session';

// The OAuth callback (apps/api/src/routes/integrations.ts) redirects the browser here after a
// successful Shopify connect — a plain top-level navigation, not a fetch, so this can't just read
// the org id out of a query param the API never sends (the callback resolves org/store entirely
// from the verified state token, ADR-0025 — nothing about which org owns this store is on the URL
// by design). Find it client-side instead: list the caller's orgs, then each org's stores, until
// the one that owns this storeId turns up, then land on that org's Integrations page.
export function StoreConnectedPage({ storeId }: { readonly storeId: string }) {
  const navigate = useNavigate();
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      const { organizations } = await api.listOrgs();
      for (const org of organizations) {
        const { stores } = await api.listStores(org.id);
        if (stores.some((s) => s.id === storeId)) {
          if (cancelled) return;
          rememberLastOrg(org.id);
          await navigate({ to: '/o/$orgId/integrations', params: { orgId: org.id } });
          return;
        }
      }
      if (!cancelled) setNotFound(true);
    }
    void resolve();
    return () => {
      cancelled = true;
    };
  }, [storeId, navigate]);

  if (notFound) {
    return (
      <div className="flex min-h-svh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Store connected</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Your Shopify store connected successfully, but this account isn't a member of the
            organization it belongs to — go to your organization's Integrations page directly.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <p className="text-sm text-muted-foreground">Store connected — taking you there…</p>
    </div>
  );
}
