import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { api } from '@/lib/api';
import { rememberLastOrg } from '@/lib/session';

export function OrgSwitcher({ activeOrgId }: { readonly activeOrgId: string }) {
  const navigate = useNavigate();
  const { data } = useQuery({ queryKey: ['orgs'], queryFn: api.listOrgs });
  const organizations = data?.organizations ?? [];
  const active = organizations.find((o) => o.id === activeOrgId);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <div className="flex h-8 w-8 items-center justify-center rounded-none bg-sidebar-primary text-sidebar-primary-foreground">
              {(active?.name ?? 'T').charAt(0).toUpperCase()}
            </div>
            <div className="flex flex-col gap-0.5 leading-none">
              <span className="font-medium">{active?.name ?? 'Select organization'}</span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="start">
            {organizations.map((org) => (
              <DropdownMenuItem
                key={org.id}
                onSelect={() => {
                  rememberLastOrg(org.id);
                  void navigate({ to: '/o/$orgId', params: { orgId: org.id } });
                }}
              >
                <span className="flex-1">{org.name}</span>
                {org.id === activeOrgId ? <Check className="size-4" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void navigate({ to: '/orgs/new' })}>
              <Plus className="size-4" />
              New organization
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
