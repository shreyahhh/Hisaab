import { createAccessControl } from 'better-auth/plugins/access';

// Better Auth organization-plugin access control for our four roles (auth-tenancy.md §2.4). This
// gates the plugin's own built-in actions (updateMemberRole, removeMember, createInvitation, ...);
// it is not our application's RBAC matrix (@truepath/shared's `can()`/PERMISSIONS), which gates
// report/settings/privacy endpoints that have nothing to do with the org plugin.
const statement = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
} as const;

export const ac = createAccessControl(statement);

export const ownerRole = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

// Admins manage the team but never the organization itself (auth-tenancy.md §2.4: dpa.accept and
// org.delete are owner-only — org update/delete tracks the same boundary here).
export const adminRole = ac.newRole({
  organization: [],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

export const analystRole = ac.newRole({ organization: [], member: [], invitation: [] });
export const viewerRole = ac.newRole({ organization: [], member: [], invitation: [] });
