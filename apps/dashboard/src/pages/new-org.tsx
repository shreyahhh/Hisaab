import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { api, ApiError } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { rememberLastOrg } from '@/lib/session';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function NewOrgPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const org = await api.createOrg({ name, slug: slug || slugify(name) });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      await queryClient.invalidateQueries({ queryKey: ['orgs'] });
      rememberLastOrg(org.id);
      await navigate({ to: '/o/$orgId', params: { orgId: org.id } });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? 'That organization could not be created.'
          : 'Something went wrong.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your organization</CardTitle>
          <CardDescription>One organization per brand or agency client.</CardDescription>
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
                <FieldLabel htmlFor="org-name">Organization name</FieldLabel>
                <Input
                  id="org-name"
                  required
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(slugify(e.target.value));
                  }}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="org-slug">Slug</FieldLabel>
                <Input
                  id="org-slug"
                  required
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setSlugTouched(true);
                  }}
                />
                <FieldDescription>
                  Used in URLs; lowercase letters, numbers and dashes.
                </FieldDescription>
              </Field>
              <Button type="submit" disabled={submitting}>
                {submitting ? 'Creating…' : 'Create organization'}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
