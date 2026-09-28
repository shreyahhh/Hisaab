import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AUDIT_ACTIONS } from '@truepath/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, type AuditEntry } from '@/lib/api';

const ALL_ACTIONS = '__all__';

export function AuditLogPage({ orgId }: { readonly orgId: string }) {
  const [action, setAction] = useState<string>(ALL_ACTIONS);
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const query = useQuery({
    queryKey: ['audit-log', orgId, action, cursor],
    queryFn: () =>
      api.listAuditLog(orgId, {
        ...(action !== ALL_ACTIONS ? { action } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 25,
      }),
  });

  function resetPaging() {
    setCursorStack([undefined]);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Access to personal-data views, exports, DSR actions and settings changes.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Select
          value={action}
          onValueChange={(v) => {
            setAction(v ?? ALL_ACTIONS);
            resetPaging();
          }}
        >
          <SelectTrigger className="w-64">
            {/* Base UI's Select.Value shows the raw value unless told how to render it
                (children-as-function) — it doesn't read SelectItem labels itself. */}
            <SelectValue>
              {(value: string) => (value === ALL_ACTIONS ? 'All actions' : value)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ACTIONS}>All actions</SelectItem>
            {AUDIT_ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Events</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : query.isError ? (
            <p className="text-sm text-destructive">Could not load the audit log.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Target</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data?.items.map((entry: AuditEntry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(entry.created_at).toLocaleString('en-IN', {
                          timeZone: 'Asia/Kolkata',
                        })}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{entry.action}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.actor_type}
                        {entry.actor_user_id ? ` (${entry.actor_user_id.slice(0, 8)}…)` : ''}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.target_type}:{entry.target_id.slice(0, 8)}…
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4 flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cursorStack.length <= 1}
                  onClick={() => setCursorStack((s) => s.slice(0, -1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!query.data?.next_cursor}
                  onClick={() =>
                    query.data?.next_cursor &&
                    setCursorStack((s) => [...s, query.data.next_cursor ?? undefined])
                  }
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
