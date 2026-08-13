// القيم المسموحة لحقل profiles.role (تصنيف عرض فقط للمسمى الوظيفي — لا صلة
// بـ is_super_admin/account_role المعزولين في user_authorizations). المصدر
// الوحيد لهذه القيم في الواجهة هو roleOptions في app/signup/page.tsx
// وapp/dashboard/settings/page.tsx (نفس السبع قيم بالضبط في كليهما).
export const ALLOWED_PROFILE_ROLES = [
  'project_owner',
  'project_manager',
  'site_engineer',
  'safety_officer',
  'equipment_supervisor',
  'consultant',
  'subcontractor',
  'other',
] as const;

export type AllowedProfileRole = typeof ALLOWED_PROFILE_ROLES[number];

export function normalizeProfileRole(role: unknown): AllowedProfileRole {
  return (ALLOWED_PROFILE_ROLES as readonly string[]).includes(role as string)
    ? (role as AllowedProfileRole)
    : 'other';
}
