import { useNavigate } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/theme-toggle';
import { api } from '@/lib/api';
import { meQueryKey } from '@/lib/session';
import { queryClient } from '@/lib/queryClient';
import type { User } from '@/lib/api';

function initials(user: User): string {
  return (user.name || user.email).charAt(0).toUpperCase();
}

export function UserMenu({ user }: { readonly user: User }) {
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Even if the server call fails, clear local session state so the UI doesn't strand the
      // user in a signed-in-looking shell; /login re-checks the real session on load anyway.
    }
    queryClient.removeQueries({ queryKey: meQueryKey });
    toast.success('Signed out');
    await navigate({ to: '/login' });
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
            <Avatar className="size-8 rounded-none">
              <AvatarFallback className="rounded-none">{initials(user)}</AvatarFallback>
            </Avatar>
            <div className="flex flex-col gap-0.5 leading-none overflow-hidden">
              <span className="truncate font-medium">{user.name}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="start" side="top">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{user.email}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between px-2 py-1.5 text-sm">
              <span>Theme</span>
              <ThemeToggle />
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleLogout()}>
              <LogOut className="size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
