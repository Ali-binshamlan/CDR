import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { refreshForecastSnapshots } from '@/app/lib/dustEvaluation';

// Forecast Worker — القسم 9.2 من "دليل الإصلاح الجذري لمنظومة مرقاب":
// يجلب Open-Meteo لشبكة توقعات ساعات الدوام (hourlyForecasts) لكل نشاط
// دوام قادم ويخزّنها في forecast_snapshots، بمعزل تام عن مسار القرار الحي
// (evaluateProject/computeDustResults لا تستدعيان الشبكة إطلاقاً للأنشطة
// الحية بعد الإصلاح — راجع evaluateLiveOperationalDecision في dust-engine).
// فشل هذا المسار أو تأخره لا يمكن أن يؤثر على أي قرار مُخزَّن في
// final_decisions إطلاقاً — إثراء عرض توعوي فقط.
//
// مصادقة عبر FORECAST_REFRESH_CRON_SECRET — متغير بيئة منفصل عن باقي أسرار
// الـcron (CRON_SECRET/PROVIDER_PULL_CRON_SECRET/SCHEDULER_CRON_SECRET)، بنفس
// مبدأ الفصل الموثَّق في provider-pull/route.ts وscheduler-tick/route.ts.
// يُستدعى خارجياً كل 15-30 دقيقة عبر خدمة cron مجانية (cron-job.org) — لا
// إضافة لـvercel.json (خطة Vercel Hobby لا تدعم جدولة أقل من يومية).
export async function GET(request: Request) {
  if (!process.env.FORECAST_REFRESH_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'FORECAST_REFRESH_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.FORECAST_REFRESH_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { data: projects, error: fetchError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .is('archived_at', null);

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const results: Array<{ projectId: string; refreshed: number; failed: number; error?: string }> = [];

  // تسلسلي عمداً — نفس مبدأ provider-pull/scheduler-tick: يبسّط تتبع الفشل
  // الجزئي ويتفادى إغراق Open-Meteo بطلبات متزامنة ضخمة عبر كل المشاريع.
  for (const project of projects || []) {
    try {
      const { data: dustProfiles } = await supabaseAdmin
        .from('project_dust_profiles')
        .select('*')
        .eq('project_id', project.id)
        .is('archived_at', null);

      const { data: projectShifts } = await supabaseAdmin
        .from('project_shifts')
        .select('*')
        .eq('project_id', project.id)
        .order('sort_order', { ascending: true });
      project.shifts = projectShifts || [];

      const { refreshed, failed } = await refreshForecastSnapshots(
        supabaseAdmin,
        project.id,
        dustProfiles || [],
        project
      );
      results.push({ projectId: project.id, refreshed, failed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`forecast-refresh failed for project ${project.id}:`, message);
      results.push({ projectId: project.id, refreshed: 0, failed: 0, error: message });
    }
  }

  const hasErrors = results.some((r) => r.error || r.failed > 0);

  return NextResponse.json(
    {
      ok: !hasErrors,
      checkedAt: new Date().toISOString(),
      total: results.length,
      results,
    },
    { status: 200 }
  );
}
