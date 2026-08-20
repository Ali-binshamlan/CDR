import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { displayActivityLabel } from '@/app/lib/activityLabels';
import { riyadhLocalToUtcIso } from '@/app/lib/dustEvaluation';

// أقصى مدى زمني نقبله عبر hours= — نفس سقف pm10-history/route.ts.
const MAX_HOURS = 24 * 14; // أسبوعان
const DEFAULT_HOURS = 6;

type ReadingPoint = {
  time: string;
  windSpeedKmh: number | null;
  windGustKmh: number | null;
  windDirectionDeg: number | null;
  pm10: number | null;
  pm25: number | null;
  visibilityM: number | null;
  relativeHumidityPercent: number | null;
  temperatureC: number | null;
};

// يجلب سجل device_readings_history لمشروع، مُجمَّعاً حسب device_id ثم مرتبطاً
// بكل نشاط عبر project_dust_profiles.device_id — للرسم البياني التاريخي لكل
// عنصر قياس على حدة (رياح/هبة/اتجاه/رؤية/رطوبة/حرارة/PM10/PM2.5). نفس مبدأ
// pm10-history/route.ts تماماً (تجميع حسب نشاط عبر الجهاز المرتبط)، لكن كل
// الحقول معاً بدل PM10 وحده.
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

    // كل الأنشطة المرتبطة بجهاز فعلياً — الأنشطة بلا device_id لا سجل قراءات
    // لها في هذا الجدول أصلاً (لا فائدة من تضمينها).
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('project_dust_profiles')
      .select('id, activity_group_id, device_id, regulatory_activity, planned_date, planned_time, duration_hours')
      .eq('project_id', projectId)
      .not('device_id', 'is', null);
    if (profilesError) {
      return NextResponse.json({ error: safeErrorResponse(profilesError, 'device-readings-history profiles fetch failed') }, { status: 500 });
    }

    // خطأ مكتشَف ومُصلَح (نفس الجهاز يُستخدَم لأكثر من نشاط متتالٍ فيرث
    // النشاط الجديد قراءات النشاط القديم كاملة): windowStartMs/windowEndMs
    // يحصران قراءات الجهاز المضمومة لكل نشاط ضمن نافذته الفعلية فقط (من
    // planned_date/planned_time وحتى planned_start+duration_hours، أو الآن
    // إن كان لا يزال جارياً) — بنفس startIso المستخدَم في computeDustResults
    // (dustEvaluation.ts) لحساب DVI لهذا النشاط بالضبط.
    const groups = new Map<
      string,
      { activityGroupId: string; label: string; deviceIds: Set<string>; windowStartMs: number | null; windowEndMs: number }
    >();
    for (const row of profiles || []) {
      const groupId = row.activity_group_id || `dust-${row.id}`;
      let g = groups.get(groupId);
      if (!g) {
        const startIso = riyadhLocalToUtcIso(row.planned_date, row.planned_time);
        const startMs = startIso ? new Date(startIso).getTime() : null;
        const durationHours = Math.max(1, Math.round(row.duration_hours || 1));
        const endMs = startMs !== null ? startMs + durationHours * 3600000 : Date.now();
        g = {
          activityGroupId: groupId,
          label: displayActivityLabel(row),
          deviceIds: new Set(),
          windowStartMs: startMs,
          windowEndMs: Math.max(endMs, Date.now()),
        };
        groups.set(groupId, g);
      }
      if (row.device_id) g.deviceIds.add(row.device_id);
    }

    if (groups.size === 0) {
      return NextResponse.json({ activities: [], hours });
    }

    const { data: readings, error: readingsError } = await supabaseAdmin
      .from('device_readings_history')
      .select('device_id, recorded_at, wind_speed_kmh, wind_gust_kmh, wind_direction_deg, pm10_ug_m3, pm25_ug_m3, visibility_m, relative_humidity_percent, temperature_c')
      .eq('project_id', projectId)
      .gte('recorded_at', sinceIso)
      .order('recorded_at', { ascending: true });
    if (readingsError) {
      return NextResponse.json({ error: safeErrorResponse(readingsError, 'device-readings-history readings fetch failed') }, { status: 500 });
    }

    const readingsByDevice = new Map<string, ReadingPoint[]>();
    for (const row of readings || []) {
      const point: ReadingPoint = {
        time: row.recorded_at,
        windSpeedKmh: row.wind_speed_kmh === null ? null : Number(row.wind_speed_kmh),
        windGustKmh: row.wind_gust_kmh === null ? null : Number(row.wind_gust_kmh),
        windDirectionDeg: row.wind_direction_deg === null ? null : Number(row.wind_direction_deg),
        pm10: row.pm10_ug_m3 === null ? null : Number(row.pm10_ug_m3),
        pm25: row.pm25_ug_m3 === null ? null : Number(row.pm25_ug_m3),
        visibilityM: row.visibility_m === null ? null : Number(row.visibility_m),
        relativeHumidityPercent: row.relative_humidity_percent === null ? null : Number(row.relative_humidity_percent),
        temperatureC: row.temperature_c === null ? null : Number(row.temperature_c),
      };
      if (!readingsByDevice.has(row.device_id)) readingsByDevice.set(row.device_id, []);
      readingsByDevice.get(row.device_id)!.push(point);
    }

    const activities = Array.from(groups.values())
      .map((g) => {
        const points = Array.from(g.deviceIds)
          .flatMap((deviceId) => readingsByDevice.get(deviceId) ?? [])
          // قراءة الجهاز تُضم لهذا النشاط فقط إن وقعت ضمن نافذته الفعلية —
          // راجع تعليق windowStartMs أعلاه لمنع نشاط جديد من وراثة قراءات
          // نشاط قديم انتهى على نفس الجهاز.
          .filter((p) => {
            const recordedMs = new Date(p.time).getTime();
            if (g.windowStartMs !== null && recordedMs < g.windowStartMs) return false;
            return recordedMs <= g.windowEndMs;
          })
          .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        return {
          activityGroupId: g.activityGroupId,
          label: g.label,
          readings: points,
        };
      })
      // نشاط بلا أي قراءة خلال المدى المطلوب لا يُفيد الرسم — يُستبعد.
      .filter((a) => a.readings.length > 0);

    return NextResponse.json({ activities, hours });
  } catch (error) {
    return NextResponse.json({ error: safeErrorResponse(error, 'device-readings-history failed') }, { status: 500 });
  }
}
