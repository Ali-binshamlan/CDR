import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { DEFAULT_RULE_PARAMETERS } from '@/app/utils/dust-compliance-engine';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
// لا يوجد نظام حقيقي يدعم إنشاء نسخة قاعدة، النشر الذري، منع تعديل نسخة
// منشورة، التراجع لنسخة سابقة"): هذا المسار يعرض كتالوج المعاملات القابلة
// للضبط (rule_parameter_definitions) مع القيمة الحالية الفعلية لكل معامل
// (آخر نسخة PUBLISHED إن وُجدت، وإلا code_default_value) — راجع migration
// 202608060003_rule_parameter_versioning.sql وapp/utils/dust-compliance-
// engine/ruleParameters.ts للتصميم الكامل. POST publish/rollback في
// app/api/admin/rule-parameters/[code]/publish|rollback/route.ts.
//
// requireSuperAdmin فقط (لا verifyProjectOwnership — هذه معاملات نظام
// عامة، لا بيانات مشروع) — نفس حراسة app/api/admin/users/route.ts.
export async function GET(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { data: definitions, error: defError } = await supabaseAdmin
    .from('rule_parameter_definitions')
    .select('code, label_ar, description_ar, unit, value_type, min_value, max_value, code_default_value')
    .order('code', { ascending: true });
  if (defError) return NextResponse.json({ error: safeErrorResponse(defError, 'rule-parameters definitions fetch failed') }, { status: 500 });

  const { data: published, error: pubError } = await supabaseAdmin
    .from('rule_parameter_versions')
    .select('id, parameter_code, value, published_at, published_by, change_reason_ar, is_rollback')
    .eq('status', 'PUBLISHED');
  if (pubError) return NextResponse.json({ error: safeErrorResponse(pubError, 'rule-parameters published fetch failed') }, { status: 500 });

  type PublishedRow = {
    id: string;
    parameter_code: string;
    value: number;
    published_at: string | null;
    published_by: string | null;
    change_reason_ar: string | null;
    is_rollback: boolean;
  };
  const publishedByCode = new Map<string, PublishedRow>(
    ((published as PublishedRow[]) || []).map((row) => [row.parameter_code, row])
  );

  type DefinitionRow = {
    code: string;
    label_ar: string;
    description_ar: string;
    unit: string;
    value_type: string;
    min_value: number | null;
    max_value: number | null;
    code_default_value: number;
  };
  const data = ((definitions as DefinitionRow[]) || []).map((def) => {
    const pub = publishedByCode.get(def.code);
    return {
      code: def.code,
      labelAr: def.label_ar,
      descriptionAr: def.description_ar,
      unit: def.unit,
      valueType: def.value_type,
      minValue: def.min_value,
      maxValue: def.max_value,
      codeDefaultValue: def.code_default_value,
      currentValue: pub?.value ?? def.code_default_value,
      isUsingCodeDefault: !pub,
      publishedVersionId: pub?.id ?? null,
      publishedAt: pub?.published_at ?? null,
      publishedBy: pub?.published_by ?? null,
      changeReasonAr: pub?.change_reason_ar ?? null,
      isRollback: pub?.is_rollback ?? false,
    };
  });

  // للتحقق البصري فقط — تأكيد أن code_default_value في القاعدة لا يزال
  // مطابقاً لما هو مكتوب فعلياً في ruleParameters.ts وقت هذا الطلب (يُقارَن
  // في الواجهة، لا خطأً هنا لو اختلف — قد يكون تعديلاً متعمَّداً على الافتراضي).
  return NextResponse.json({ data, codeDefaults: DEFAULT_RULE_PARAMETERS });
}
