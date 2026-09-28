import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { meQueryKey } from '@/lib/session';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'INVALID_EMAIL_OR_PASSWORD') return 'Invalid email or password.';
    if (error.code === 'rate_limited') return 'Too many attempts. Please wait and try again.';
    if (error.status === 403) return 'That request was refused. Please refresh and try again.';
  }
  return 'Something went wrong. Please try again.';
}

export function LoginPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { redirect?: string };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.login({ email, password });
      await queryClient.invalidateQueries({ queryKey: meQueryKey });
      await navigate({ to: search.redirect ?? '/' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Log in</CardTitle>
          <CardDescription>TruePath — delivered ROAS for your Shopify store</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void onSubmit(e)}>
            <FieldGroup>
              {error ? (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Logging in…' : 'Log in'}
              </Button>
            </FieldGroup>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            No account?{' '}
            <Link to="/signup" className="underline underline-offset-4">
              Sign up
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
