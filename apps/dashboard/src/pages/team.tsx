import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ROLES, isAtOrBelowOwnRank, roleCan, type Role } from '@truepath/shared';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import { api, ApiError, type OrgMember } from '@/lib/api';
import { useMe } from '@/lib/session';

function RoleSelect({
  value,
  onChange,
  allowedRoles,
  disabled,
}: {
  value: Role;
  onChange: (role: Role) => void;
  allowedRoles: readonly Role[];
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Role)} disabled={disabled}>
      <SelectTrigger className="w-32">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowedRoles.map((role) => (
          <SelectItem key={role} value={role}>
            {role}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function TeamPage({ orgId }: { readonly orgId: string }) {
  const { data: me } = useMe();
  const myRole = me?.memberships.find((m) => m.organizationId === orgId)?.role;
  const queryClient = useQueryClient();
  const membersQuery = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api.listMembers(orgId),
  });

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('viewer');
  const [inviteError, setInviteError] = useState<string | null>(null);

  const inviteMutation = useMutation({
    mutationFn: () => api.createInvite(orgId, { email: inviteEmail, role: inviteRole }),
    onSuccess: () => {
      toast.success(`Invited ${inviteEmail}`);
      setInviteEmail('');
    },
    onError: (err) => {
      setInviteError(
        err instanceof ApiError && err.code === 'forbidden_role'
          ? "You can't invite at that role."
          : 'Could not send the invite.',
      );
    },
  });

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api.updateMemberRole(orgId, userId, role),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members', orgId] });
      toast.success('Role updated');
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError && err.code === 'last_owner'
          ? "Can't change the only owner's role."
          : 'Could not update the role.',
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.removeMember(orgId, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['members', orgId] });
      toast.success('Member removed');
    },
    onError: (err) => {
      toast.error(
        err instanceof ApiError && err.code === 'last_owner'
          ? "Can't remove the only owner."
          : 'Could not remove that member.',
      );
    },
  });

  function onInvite(event: FormEvent) {
    event.preventDefault();
    setInviteError(null);
    inviteMutation.mutate();
  }

  // Role ceilings (auth-tenancy.md §2.1/§2.4): nobody invites or promotes above their own rank; an
  // admin (not owner) can only manage analyst/viewer members. The UI hides what the API would
  // refuse anyway — the API still enforces it (dashboard.md §6 "the UI is not the control").
  const invitableRoles = myRole ? ROLES.filter((r) => isAtOrBelowOwnRank(myRole, r)) : [];

  function canManage(member: OrgMember): boolean {
    if (!myRole || !roleCan(myRole, 'team.manage')) return false;
    if (myRole === 'admin' && member.role !== 'analyst' && member.role !== 'viewer') return false;
    return true;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Team & invites</h1>
        <p className="text-sm text-muted-foreground">Manage who has access to this organization.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite a teammate</CardTitle>
          <CardDescription>They'll receive an email with a link to accept.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onInvite} className="flex items-end gap-2">
            <FieldGroup className="flex-1">
              <Field>
                <FieldLabel htmlFor="invite-email">Email</FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
              </Field>
            </FieldGroup>
            <RoleSelect value={inviteRole} onChange={setInviteRole} allowedRoles={invitableRoles} />
            <Button type="submit" disabled={inviteMutation.isPending}>
              Invite
            </Button>
          </form>
          {inviteError ? <p className="mt-2 text-sm text-destructive">{inviteError}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          {membersQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {membersQuery.data?.members.map((member) => {
                  const isSelf = member.userId === me?.user.id;
                  const manageable = canManage(member);
                  return (
                    <TableRow key={member.userId}>
                      <TableCell>{member.name}</TableCell>
                      <TableCell>{member.email}</TableCell>
                      <TableCell>
                        <RoleSelect
                          value={member.role}
                          allowedRoles={
                            myRole ? ROLES.filter((r) => isAtOrBelowOwnRank(myRole, r)) : []
                          }
                          disabled={!manageable || roleMutation.isPending}
                          onChange={(role) => roleMutation.mutate({ userId: member.userId, role })}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        {manageable || isSelf ? (
                          <AlertDialog>
                            <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>
                              {isSelf ? 'Leave' : 'Remove'}
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  {isSelf ? 'Leave this organization?' : `Remove ${member.name}?`}
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  {isSelf
                                    ? "You'll lose access immediately."
                                    : `${member.name} will lose access to this organization immediately.`}
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => removeMutation.mutate(member.userId)}
                                >
                                  {isSelf ? 'Leave' : 'Remove'}
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
