import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/session';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invite_email_mismatch') {
      return "This invite was sent to a different email address than the one you're logged in with.";
    }
    if (error.code === 'invite_no_longer_valid') {
      return 'This invite is no longer valid — the person who sent it may have lost access.';
    }
    if (error.status === 404) return 'This invite could not be found. It may have expired.';
  }
  return 'Something went wrong accepting this invite.';
}

export function InviteAcceptPage({ token }: { readonly token: string }) {
  const navigate = useNavigate();
  const { data: me, isLoading } = useMe();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function accept() {
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.acceptInvite(token);
      await navigate({ to: '/o/$orgId', params: { orgId: result.invitation.organizationId } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (isLoading) return null;

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Join organization</CardTitle>
          <CardDescription>You've been invited to join a TruePath organization.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {me ? (
            <Button onClick={() => void accept()} disabled={submitting}>
              {submitting ? 'Joining…' : 'Accept invite'}
            </Button>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">Log in or sign up first to accept.</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  render={<Link to="/login" search={{ redirect: `/invite/${token}` }} />}
                >
                  Log in
                </Button>
                <Button className="flex-1" render={<Link to="/signup" />}>
                  Sign up
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
