import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { roleCan } from '@truepath/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, ApiError, type DpaAcceptResponse } from '@/lib/api';
import { useMe } from '@/lib/session';

// No GET endpoint exists to read the DPA version an org has already accepted, or the version the
// API currently requires (SPEC §10 has no such route — a prior overnight run's decision, #7/#21).
// The dashboard is configured with the version it expects via VITE_DPA_VERSION, matching the API's
// own DPA_VERSION; a 409 from the accept call means the two are out of sync, and shows the server's
// current_version so an operator can fix the mismatch. Documented in how-to-run-dashboard.md.
const DPA_VERSION = import.meta.env.VITE_DPA_VERSION as string | undefined;

export function DpaPage({ orgId }: { readonly orgId: string }) {
  const { data: me } = useMe();
  const myRole = me?.memberships.find((m) => m.organizationId === orgId)?.role;
  const [accepted, setAccepted] = useState<DpaAcceptResponse | null>(null);
  const [mismatchVersion, setMismatchVersion] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.acceptDpa(orgId, DPA_VERSION ?? ''),
    onSuccess: (result) => {
      setMismatchVersion(null);
      setAccepted(result);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'dpa_version_mismatch') {
        const current = err.data?.current_version;
        setMismatchVersion(typeof current === 'string' ? current : 'unknown');
      }
    },
  });

  if (!myRole || !roleCan(myRole, 'dpa.accept')) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Only the organization owner can accept the Data Processing Agreement.
        </CardContent>
      </Card>
    );
  }

  if (!DPA_VERSION) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Dashboard misconfigured</AlertTitle>
        <AlertDescription>
          VITE_DPA_VERSION is not set — see docs/how-to-run-dashboard.md.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Data Processing Agreement</h1>
        <p className="text-sm text-muted-foreground">
          Tracking stays disabled for this organization until the DPA is accepted.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Version {DPA_VERSION}</CardTitle>
          <CardDescription>
            See docs/dpdp/dpa-template.md for the full text of the agreement.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {accepted ? (
            <Alert>
              <AlertTitle>Accepted</AlertTitle>
              <AlertDescription>
                Version {accepted.dpa_version} accepted on{' '}
                {new Date(accepted.accepted_at).toLocaleString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                })}
                .
              </AlertDescription>
            </Alert>
          ) : (
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="w-fit"
            >
              {mutation.isPending ? 'Accepting…' : `Accept version ${DPA_VERSION}`}
            </Button>
          )}
          {mismatchVersion ? (
            <Alert variant="destructive">
              <AlertTitle>Version mismatch</AlertTitle>
              <AlertDescription>
                The API currently requires version {mismatchVersion}, but this dashboard is
                configured for {DPA_VERSION}. Update VITE_DPA_VERSION to match and reload.
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
