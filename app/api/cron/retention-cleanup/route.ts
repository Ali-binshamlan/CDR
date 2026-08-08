import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { timingSafeStringEqual } from '@/app/lib/timingSafe';

// حذف احتفاظ (retention) دوري — الصفوف الأقدم من 30 يوماً فقط، على الجداول
// الأربعة التي شخّصناها فعلياً كمصدر نمو مساحة Supabase غير المحدود
// (append-only بلا أي تنظيف سابقاً): dust_evaluations، dust_compliance_
// evaluations، pm10_readings_history، device_readings_history.
//
// القرار (صريح من المستخدم، 2026-08-08): حذف مباشر بلا أرشفة — لا حاجة
// للاحتفاظ بالقديم بمكان آخر. راجع migration 202608080002 للاستثناء
// الضيق المضاف على forbid_evidence_mutation (DELETE مسموح فقط لصف عمره
// >30 يوماً — لا فتح عام لأي حذف آخر على هذه الجداول).
//
// مصادقة عبر RETENTION_CRON_SECRET — سر منفصل تماماً عن CRON_SECRET/
// PROVIDER_PULL_CRON_SECRET/SCHEDULER_CRON_SECRET (نفس درس ثغرة موثَّقة
// سابقاً: لا يجوز أن يطابق أي سر آخر بالنظام).
//
// يُستدعى خارجياً مرة يومياً عبر cron-job.org (نفس نمط provider-pull —
// خطة Vercel Hobby لا تدعم جدولة دون يومية عبر vercel.json).
const RETENTION_DAYS = 30;

export async function GET(request: Request) {
  if (!process.env.RETENTION_CRON_SECRET) {
    return NextResponse.json({ ok: false, error: 'RETENTION_CRON_SECRET غير مُعرَّف بالخادم' }, { status: 503 });
  }
  const authHeader = request.headers.get('authorization') || '';
  if (!timingSafeStringEqual(authHeader, `Bearer ${process.env.RETENTION_CRON_SECRET}`)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const results: Record<string, { deleted: number; error: string | null }> = {};

  const createdAtTables = ['dust_evaluations', 'dust_compliance_evaluations'] as const;
  const recordedAtTables = ['pm10_readings_history', 'device_readings_history'] as const;

  for (const table of createdAtTables) {
    const { error, count } = await supabaseAdmin
      .from(table)
      .delete({ count: 'exact' })
      .lt('created_at', cutoffIso);
    results[table] = { deleted: count ?? 0, error: error?.message ?? null };
  }

  for (const table of recordedAtTables) {
    const { error, count } = await supabaseAdmin
      .from(table)
      .delete({ count: 'exact' })
      .lt('recorded_at', cutoffIso);
    results[table] = { deleted: count ?? 0, error: error?.message ?? null };
  }

  const hasErrors = Object.values(results).some((r) => r.error !== null);

  return NextResponse.json(
    { ok: !hasErrors, retentionDays: RETENTION_DAYS, cutoffIso, results },
    { status: hasErrors ? 500 : 200 }
  );
}
