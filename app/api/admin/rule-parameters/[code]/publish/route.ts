import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// نشر نسخة جديدة لمعامل قابل للضبط — يُفوَّض بالكامل لـ
// publish_rule_parameter_version (RPC ذرّي، migration 202608060003):
// يتحقق من المدى الآمن (min/max)، يُنهي (SUPERSEDED) النسخة PUBLISHED
// الحالية إن وُجدت، وينشئ نسخة PUBLISHED جديدة — كل ذلك ذرياً. لا يؤثر على
// أي تقييم حي إلا في دورة التقييم التالية (refreshRuleParameters تُستدعى
// في بداية كل evaluateProject، لا فوراً عند هذا الطلب — نفس مبدأ باقي هذا
// النظام: لا تحديث حي وسط تقييم قيد التنفيذ).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const { code } = await params;
  const body = await request.json().catch(() => null);

  const value = typeof body?.value === 'number' && Number.isFinite(body.value) ? body.value : NaN;
  if (Number.isNaN(value)) {
    return NextResponse.json({ error: 'value إلزامي ويجب أن يكون رقماً صالحاً' }, { status: 400 });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب النشر (changeReasonAr) إلزامي — سجل تدقيق: لماذا تغيّرت هذه القيمة؟' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('publish_rule_parameter_version', {
    p_parameter_code: code,
    p_value: value,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    // أخطاء التحقق (مدى آمن، معامل غير معروف) من RPC نفسها تُعرَض للمستخدم
    // كما هي — رسائل عربية واضحة مبنية صراحة داخل publish_rule_parameter_version
    // (raise exception بمعاملات format() تصف السبب تحديداً، مثال: "القيمة
    // 500 أعلى من الحد الأقصى الآمن 100")، لا رسالة PostgREST تقنية عامة.
    // safeErrorResponse (رسالة عامة موحَّدة) تبقى محجوزة لأخطاء حقيقية غير
    // متوقعة (فشل شبكة/DB)، لا لهذين الكودين المعروفين تحديداً.
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter publish validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter publish failed') }, { status: 500 });
  }

  return NextResponse.json({ version: data });
}
