import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';
import { refreshForecastSnapshots, type DustActivityRow } from '@/app/lib/dustEvaluation';

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
//
// خطأ أداء مكتشَف ومُصلَح (سياق: تنبيه Supabase حول استهلاك Disk IO Budget،
// 2026-08-13 — راجع migration 202608130001 لإصلاح مماثل على scheduler-tick):
// (1) لا قفل تداخل دورة هنا إطلاقاً — على عكس provider-pull/scheduler-tick/
//     db-cleanup-worker، فلو تأخرت دورة (طلبات Open-Meteo الخارجية بطيئة تحت
//     حمل)، دورة تالية من cron-job.org تبدأ فوقها بلا أي حماية. أُضيف قفل
//     forecast_refresh_run_lock (نفس نمط provider_pull_run_lock حرفياً).
// (2) نمط N+1 استعلام: SELECT * على project_dust_profiles وSELECT * على
//     project_shifts كانا يُنفَّذان منفصلين *لكل مشروع* داخل الحلقة — لو 50
//     مشروعاً نشطاً، هذا 100 استعلام إضافي في كل تشغيلة (كل 15-30 دقيقة)
//     بصرف النظر عن وجود نشاط غبار فعلي يستحق التحديث. استُبدلا باستعلامين
//     مُجمَّعين واحدين (IN على كل project_ids دفعة واحدة) خارج الحلقة، ثم
//     تجميع النتائج محلياً بـMap — نفس البيانات بالضبط، عدد استعلامات ثابت
//     (2) بدل O(عدد المشاريع).
const RUN_BUCKET_SECONDS = 900; // 15 دقيقة — أقصر نافذة معلنة لتكرار هذا المسار

export async function GET(request: Request) {
  if (!process.env.FORECAST_REFRESH_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'FORECAST_REFRESH_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.FORECAST_REFRESH_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const runBucket = Math.floor(Date.now() / (RUN_BUCKET_SECONDS * 1000));
  const { error: lockError } = await supabaseAdmin
    .from('forecast_refresh_run_lock')
    .insert({ run_bucket: runBucket });
  if (lockError) {
    if (lockError.code === '23505') {
      return NextResponse.json(
        { ok: true, skipped: true, reason: 'previous forecast-refresh run still in window', runBucket },
        { status: 200 }
      );
    }
    return NextResponse.json({ ok: false, error: lockError.message }, { status: 500 });
  }

  const { data: projects, error: fetchError } = await supabaseAdmin
    .from('projects')
    .select('*')
    .is('archived_at', null);

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const projectIds = (projects || []).map((p) => p.id as string);

  const [{ data: allDustProfiles, error: dustProfilesError }, { data: allShifts, error: shiftsError }] =
    projectIds.length > 0
      ? await Promise.all([
          supabaseAdmin.from('project_dust_profiles').select('*').in('project_id', projectIds).is('archived_at', null),
          supabaseAdmin.from('project_shifts').select('*').in('project_id', projectIds).order('sort_order', { ascending: true }),
        ])
      : [{ data: [] as DustActivityRow[], error: null }, { data: [] as Array<{ project_id: string }>, error: null }];

  if (dustProfilesError) {
    return NextResponse.json({ ok: false, error: dustProfilesError.message }, { status: 500 });
  }
  if (shiftsError) {
    return NextResponse.json({ ok: false, error: shiftsError.message }, { status: 500 });
  }

  const dustProfilesByProject = new Map<string, DustActivityRow[]>();
  for (const row of allDustProfiles || []) {
    const key = (row as DustActivityRow).project_id as string;
    if (!key) continue;
    const list = dustProfilesByProject.get(key) ?? [];
    list.push(row as DustActivityRow);
    dustProfilesByProject.set(key, list);
  }

  const shiftsByProject = new Map<string, Array<{ project_id: string }>>();
  for (const row of allShifts || []) {
    const key = row.project_id;
    if (!key) continue;
    const list = shiftsByProject.get(key) ?? [];
    list.push(row);
    shiftsByProject.set(key, list);
  }

  const results: Array<{ projectId: string; refreshed: number; failed: number; error?: string }> = [];

  // تسلسلي عمداً — نفس مبدأ provider-pull/scheduler-tick: يبسّط تتبع الفشل
  // الجزئي ويتفادى إغراق Open-Meteo بطلبات متزامنة ضخمة عبر كل المشاريع.
  for (const project of projects || []) {
    try {
      const dustProfiles = dustProfilesByProject.get(project.id) ?? [];
      project.shifts = shiftsByProject.get(project.id) ?? [];

      const { refreshed, failed } = await refreshForecastSnapshots(
        supabaseAdmin,
        project.id,
        dustProfiles,
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
