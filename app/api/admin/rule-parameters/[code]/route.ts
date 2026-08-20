import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

/*
 * Fetches the complete version history for a single parameter across all statuses (DRAFT / PUBLISHED / SUPERSEDED / ARCHIVED).
 * Constructs the "who published what, when, and why" audit trail for display on the admin rules management UI (audit / rollback inspection).
 * See `GET /api/admin/rule-parameters` for retrieving current active values only (without historical records).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { code } = await params;

  const { data: definition, error: defError } = await supabaseAdmin
    .from('rule_parameter_definitions')
    .select('code, label_ar, description_ar, unit, value_type, min_value, max_value, code_default_value')
    .eq('code', code)
    .maybeSingle();
  if (defError) return NextResponse.json({ error: safeErrorResponse(defError, 'rule-parameter definition fetch failed') }, { status: 500 });
  if (!definition) return NextResponse.json({ error: 'معامل غير معروف' }, { status: 404 });

  const { data: versions, error: versionsError } = await supabaseAdmin
    .from('rule_parameter_versions')
    .select('id, value, status, effective_from, published_by, published_at, change_reason_ar, is_rollback, supersedes_version_id, created_by, created_at, bundle_id')
    .eq('parameter_code', code)
    .order('created_at', { ascending: false });
  if (versionsError) return NextResponse.json({ error: safeErrorResponse(versionsError, 'rule-parameter versions fetch failed') }, { status: 500 });

  return NextResponse.json({
    definition: {
      code: definition.code,
      labelAr: definition.label_ar,
      descriptionAr: definition.description_ar,
      unit: definition.unit,
      valueType: definition.value_type,
      minValue: definition.min_value,
      maxValue: definition.max_value,
      codeDefaultValue: definition.code_default_value,
    },
    versions: (versions || []).map((v: {
      id: string; value: number; status: string; effective_from: string | null;
      published_by: string | null; published_at: string | null; change_reason_ar: string | null;
      is_rollback: boolean; supersedes_version_id: string | null; created_by: string | null; created_at: string;
      bundle_id: string | null;
    }) => ({
      id: v.id,
      value: v.value,
      status: v.status,
      effectiveFrom: v.effective_from,
      publishedBy: v.published_by,
      publishedAt: v.published_at,
      changeReasonAr: v.change_reason_ar,
      isRollback: v.is_rollback,
      supersedesVersionId: v.supersedes_version_id,
      createdBy: v.created_by,
      createdAt: v.created_at,
      bundleId: v.bundle_id,
    })),
  });
}