import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireSuperAdmin } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// نشر مجموعة معاملات مترابطة كوحدة ذرية واحدة — يُفوَّض بالكامل لـ
// publish_rule_parameter_bundle (RPC ذرّي، migration 202608110003): ينشئ
// سجل rule_parameter_publication_bundles واحداً، ثم ينشر كل معامل في
// المصفوفة داخل نفس المعاملة (لا N استدعاء منفصل لـ publish_rule_parameter_
// version — فشل أي معامل يُلغي المجموعة بأكملها). راجع خطة "حزمة نشر ذرية
// لمعاملات القواعد" — يحل فجوة "تغيير عدة معاملات مترابطة يتطلب عدة
// استدعاءات منفصلة بلا رابط مشترك".
export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);

  const changesRaw = Array.isArray(body?.changes) ? body.changes : null;
  if (!changesRaw || changesRaw.length === 0) {
    return NextResponse.json({ error: 'changes إلزامية ويجب أن تكون مصفوفة غير فارغة من {code, value}' }, { status: 400 });
  }

  const changes: { code: string; value: number }[] = [];
  for (const item of changesRaw) {
    const code = typeof item?.code === 'string' ? item.code.trim() : '';
    const value = typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : NaN;
    if (!code || Number.isNaN(value)) {
      return NextResponse.json({ error: 'كل عنصر في changes يجب أن يحتوي code (نص) وvalue (رقم صالح)' }, { status: 400 });
    }
    changes.push({ code, value });
  }

  const changeReasonAr = typeof body?.changeReasonAr === 'string' ? body.changeReasonAr.trim() : '';
  if (!changeReasonAr) {
    return NextResponse.json({ error: 'سبب النشر المشترك (changeReasonAr) إلزامي — سجل تدقيق لكل المجموعة' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.rpc('publish_rule_parameter_bundle', {
    p_changes: changes,
    p_published_by: auth.userId,
    p_change_reason_ar: changeReasonAr,
  });

  if (error) {
    // نفس تمييز أخطاء التحقق (رسالة عربية واضحة من RPC نفسها) عن الأخطاء
    // غير المتوقعة — راجع تعليق [code]/publish/route.ts المطابق.
    if (error.code === '22023' || error.code === '23503') {
      console.error('rule-parameter bundle publish validation failed:', error.message);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: safeErrorResponse(error, 'rule-parameter bundle publish failed') }, { status: 500 });
  }

  return NextResponse.json({ versions: data });
}
