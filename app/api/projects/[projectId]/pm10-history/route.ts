import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { displayActivityLabel } from '@/app/lib/activityLabels';
import { riyadhLocalToUtcIso } from '@/app/lib/dustEvaluation';

// أقصى مدى زمني نقبله عبر hours= — سقف بسيط يمنع طلباً يطلب سنوات من
// السجل التاريخي دفعة واحدة (لا فائدة عملية، وحمل غير ضروري على القاعدة).
const MAX_HOURS = 24 * 14; // أسبوعان
const DEFAULT_HOURS = 6;

// يجلب سجل قراءات PM10 (pm10_readings_history) لمشروع، مُجمَّعاً حسب
// activity_group_id، للرسم البياني — كل نشاط له نقاطه الزمنية الخاصة.
// قراءات الجهاز (source='device', activity_group_id=null) تُدمَج ضمن كل
// نشاط نشط لها جهاز مرتبط، بنفس منطق fetchPm10SustainedStatus في
// app/lib/dustEvaluation.ts (الجهاز مرتبط بالمشروع ككل، لا نشاط محدد).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const auth = await requireUserId(request);
    if ('error' in auth) return auth.error;

    const { projectId: rawProjectId } = await params;
    const projectId = rawProjectId.trim();

    const owns = await verifyProjectOwnership(projectId, auth.userId);
    if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

    const hoursParam = Number(request.nextUrl.searchParams.get('hours'));
    const hours = Number.isFinite(hoursParam) && hoursParam > 0
      ? Math.min(hoursParam, MAX_HOURS)
      : DEFAULT_HOURS;
    const sinceIso = new Date(Date.now() - hours * 3600000).toISOString();

    // كل الأنشطة (لا الجارية فقط) — نشاط منتهٍ لا يزال يملك سجلاً تاريخياً
    // مفيداً للمراجعة، والفلترة الزمنية لعرض الرسم تبقى مسؤولية hours= أعلاه.
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('project_dust_profiles')
      .select('id, activity_group_id, regulatory_activity, device_id, planned_date, planned_time, duration_hours')
      .eq('project_id', projectId);
    if (profilesError) {
      return NextResponse.json({ error: safeErrorResponse(profilesError, 'pm10-history profiles fetch failed') }, { status: 500 });
    }

    // خطأ مكتشَف ومُصلَح (نفس الجهاز يُستخدَم لأكثر من نشاط متتالٍ فيرث
    // النشاط الجديد قراءات النشاط القديم كاملة): windowStartMs/windowEndMs
    // يحصران قراءات الجهاز المدموجة لكل نشاط ضمن نافذته الفعلية فقط (من
    // planned_date/planned_time وحتى planned_start+duration_hours، أو الآن
    // إن كان لا يزال جارياً) — بنفس startIso المستخدَم في computeDustResults
    // (dustEvaluation.ts) لحساب DVI لهذا النشاط بالضبط، فلا تعارض بين وقت
    // "بداية النشاط" هنا وهناك.
    //
    // مجموعة activity_group_id فريدة لكل نشاط حقيقي — نفس fallback المستخدم
    // في DELETE /api/activities (activity_group_id || `dust-${id}`), حتى
    // تتطابق مفاتيح التجميع مع ما يُسجَّل فعلياً في pm10_readings_history.
    const groups = new Map<
      string,
      { activityGroupId: string; label: string; hasDeviceLink: boolean; windowStartMs: number | null; windowEndMs: number }
    >();
    for (const row of profiles || []) {
      const groupId = row.activity_group_id || `dust-${row.id}`;
      if (groups.has(groupId)) continue;
      const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
      const startMs = startIso ? new Date(startIso).getTime() : null;
      const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
      const endMs = startMs !== null ? startMs + durationHours * 3600000 : Date.now();
      groups.set(groupId, {
        activityGroupId: groupId,
        label: displayActivityLabel(row),
        hasDeviceLink: !!row.device_id,
        windowStartMs: startMs,
        // نشاط لا يزال جارياً (لم تنتهِ نافذته المخططة بعد) يقبل قراءات حتى
        // الآن، لا حتى نهايته النظرية فقط — يبقى الرسم البياني حياً أثناء
        // التنفيذ الفعلي بدل التوقف عند حد المدة المخطَّطة.
        windowEndMs: Math.max(endMs, Date.now()),
      });
    }

    const { data: readings, error: readingsError } = await supabaseAdmin
      .from('pm10_readings_history')
      .select('pm10_ug_m3, recorded_at, activity_group_id, source')
      .eq('project_id', projectId)
      .gte('recorded_at', sinceIso)
      .order('recorded_at', { ascending: true });
    if (readingsError) {
      return NextResponse.json({ error: safeErrorResponse(readingsError, 'pm10-history readings fetch failed') }, { status: 500 });
    }

    // قراءات الجهاز (activity_group_id=null) تُنسَخ لكل نشاط مرتبط فعلياً
    // بجهاز — نفس دمج fetchPm10SustainedStatus، حتى يعرض الرسم البياني
    // لكل نشاط بجهاز سلسلته الكاملة (لا سلسلة فارغة رغم وجود قراءات).
    const deviceReadings = (readings || []).filter((r: { activity_group_id: string | null }) => r.activity_group_id === null);
    const series = new Map<string, { time: string; pm10: number; source: string }[]>();
    for (const g of groups.values()) series.set(g.activityGroupId, []);

    for (const row of readings || []) {
      const point = { time: row.recorded_at, pm10: Number(row.pm10_ug_m3), source: row.source };
      if (row.activity_group_id !== null) {
        if (!series.has(row.activity_group_id)) series.set(row.activity_group_id, []);
        series.get(row.activity_group_id)!.push(point);
      }
    }
    if (deviceReadings.length > 0) {
      for (const g of groups.values()) {
        if (!g.hasDeviceLink) continue;
        const arr = series.get(g.activityGroupId)!;
        for (const row of deviceReadings) {
          const recordedMs = new Date(row.recorded_at).getTime();
          // قراءة الجهاز تُضم لهذا النشاط فقط إن وقعت ضمن نافذته الفعلية
          // (من بدايته المخططة وحتى نهايته/الآن) — راجع تعليق windowStartMs
          // أعلاه لمنع نشاط جديد من وراثة قراءات نشاط قديم على نفس الجهاز.
          if (g.windowStartMs !== null && recordedMs < g.windowStartMs) continue;
          if (recordedMs > g.windowEndMs) continue;
          arr.push({ time: row.recorded_at, pm10: Number(row.pm10_ug_m3), source: row.source });
        }
        arr.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
      }
    }

    const activities = Array.from(groups.values())
      .map((g) => ({
        activityGroupId: g.activityGroupId,
        label: g.label,
        hasDeviceLink: g.hasDeviceLink,
        readings: series.get(g.activityGroupId) || [],
      }))
      // أنشطة بلا أي قراءة إطلاقاً خلال المدى المطلوب لا تُفيد الرسم — تُستبعد
      // بدل عرض خط فارغ.
      .filter((a) => a.readings.length > 0);

    return NextResponse.json({ activities, hours });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'pm10-history failed') }, { status: 500 });
  }
}
