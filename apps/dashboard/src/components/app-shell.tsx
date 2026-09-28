import { Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import {
  BarChart3,
  ClipboardList,
  FileText,
  LayoutDashboard,
  Plug,
  Receipt,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { roleCan, type Permission, type Role } from '@truepath/shared';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { OrgSwitcher } from '@/components/org-switcher';
import { UserMenu } from '@/components/user-menu';
import type { User } from '@/lib/api';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
  /** Undefined = visible to every role (dashboard.md §2.1 route table). */
  readonly requires?: Permission;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/o/$orgId', label: 'Overview', icon: LayoutDashboard },
  { to: '/o/$orgId/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/o/$orgId/attribution', label: 'Attribution', icon: FileText },
  { to: '/o/$orgId/orders', label: 'Orders', icon: Receipt },
];

const SETTINGS_ITEMS: readonly NavItem[] = [
  { to: '/o/$orgId/team', label: 'Team & invites', icon: Users, requires: 'team.manage' },
  {
    to: '/o/$orgId/integrations',
    label: 'Integrations',
    icon: Plug,
    requires: 'integrations.manage',
  },
  { to: '/o/$orgId/audit-log', label: 'Audit log', icon: ClipboardList, requires: 'audit.read' },
  {
    to: '/o/$orgId/dpa',
    label: 'Data Processing Agreement',
    icon: ShieldCheck,
    requires: 'dpa.accept',
  },
];

function NavLinks({
  items,
  orgId,
  role,
}: {
  items: readonly NavItem[];
  orgId: string;
  role: Role;
}) {
  const matchRoute = useMatchRoute();
  return (
    <SidebarMenu>
      {items
        .filter((item) => !item.requires || roleCan(role, item.requires))
        .map((item) => {
          const isActive = Boolean(matchRoute({ to: item.to, params: { orgId } }));
          return (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton
                isActive={isActive}
                render={<Link to={item.to} params={{ orgId }} />}
              >
                <item.icon className="size-4" />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
    </SidebarMenu>
  );
}

export function AppShell({
  orgId,
  role,
  user,
  children,
}: {
  readonly orgId: string;
  readonly role: Role;
  readonly user: User;
  readonly children?: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <OrgSwitcher activeOrgId={orgId} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <NavLinks items={NAV_ITEMS} orgId={orgId} role={role} />
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupContent>
              <NavLinks items={SETTINGS_ITEMS} orgId={orgId} role={role} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <UserMenu user={user} />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="text-sm text-muted-foreground">TruePath</span>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">{children ?? <Outlet />}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
