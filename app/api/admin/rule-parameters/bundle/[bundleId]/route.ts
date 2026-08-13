import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// تفاصيل بندلة نشر واحدة — رأس البندلة (rule_parameter_publication_bundles)
// + كل النسخ الأعضاء (rule_parameter_versions حيث bundle_id يطابق)، مع
// تسمية المعامل (label_ar) من rule_parameter_definitions للعرض. تُستخدَم
// لعرض شارة "جزء من مجموعة" في لوحة الإدارة والانتقال لتفاصيل البندلة
// كاملة، بما فيها زر "تراجع عن المجموعة".
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bundleId: string }> }
) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { bundleId } = await params;

  const { data: bundle, error: bundleError } = await supabaseAdmin
    .from('rule_parameter_publication_bundles')
    .select('id, status, change_reason_ar, published_by, published_at, is_rollback, rolled_back_from_bundle_id, created_at')
    .eq('id', bundleId)
    .maybeSingle();
  if (bundleError) return NextResponse.json({ error: safeErrorResponse(bundleError, 'rule-parameter bundle fetch failed') }, { status: 500 });
  if (!bundle) return NextResponse.json({ error: 'بندلة غير موجودة' }, { status: 404 });

  const { data: members, error: membersError } = await supabaseAdmin
    .from('rule_parameter_versions')
    .select('id, parameter_code, value, status, supersedes_version_id, created_at, rule_parameter_definitions(label_ar, unit)')
    .eq('bundle_id', bundleId)
    .order('parameter_code', { ascending: true });
  if (membersError) return NextResponse.json({ error: safeErrorResponse(membersError, 'rule-parameter bundle members fetch failed') }, { status: 500 });

  return NextResponse.json({
    bundle: {
      id: bundle.id,
      status: bundle.status,
      changeReasonAr: bundle.change_reason_ar,
      publishedBy: bundle.published_by,
      publishedAt: bundle.published_at,
      isRollback: bundle.is_rollback,
      rolledBackFromBundleId: bundle.rolled_back_from_bundle_id,
      createdAt: bundle.created_at,
    },
    members: (members || []).map((m: {
      id: string; parameter_code: string; value: number; status: string;
      supersedes_version_id: string | null; created_at: string;
      rule_parameter_definitions: { label_ar: string; unit: string } | { label_ar: string; unit: string }[] | null;
    }) => {
      const def = Array.isArray(m.rule_parameter_definitions) ? m.rule_parameter_definitions[0] : m.rule_parameter_definitions;
      return {
        id: m.id,
        parameterCode: m.parameter_code,
        labelAr: def?.label_ar ?? m.parameter_code,
        unit: def?.unit ?? '',
        value: m.value,
        status: m.status,
        supersedesVersionId: m.supersedes_version_id,
        createdAt: m.created_at,
      };
    }),
  });
}
