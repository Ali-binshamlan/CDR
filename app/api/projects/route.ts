import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';

// Explicit allowlist of allowed fields when creating a project — replaces spreading
// raw body.project directly into insert() (mass-assignment), which previously allowed
// any additional client-supplied field (including sensitive/internal columns added later
// to the projects table) to reach the database without restriction. Same principle as
// excluding id/user_id/created_at applied in PATCH (same file group) — full allowlist here
// instead of partial denylist since POST builds a row from scratch.
const ALLOWED_PROJECT_FIELDS = [
  'name', 'client_name', 'city', 'neighborhood', 'project_status', 'soil_type',
  'project_type', 'latitude', 'longitude', 'coordinates',
  'zone_type', 'zone_polygon', 'zone_radius_m',
  'site_location_nature', 'wind_exposure',
  'start_date', 'end_date', 'work_days', 'work_days_list',
  'work_hours_start', 'work_hours_end', 'project_manager', 'contact_number',
  'site_area_m2', 'daily_truck_movements', 'has_onsite_crusher', 'has_onsite_batching_plant',
  'dmp_approval_status',
  'baseline_monitoring_days', 'monitoring_logging_interval_minutes', 'anemometer_height_m',
  'entry_exit_cameras_installed', 'camera_retention_days', 'sensitivity_map_prepared',
  'data_accuracy_confirmed', 'data_accuracy_confirmed_at',
] as const;

function pickAllowedProjectFields(project: Record<string, unknown>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of ALLOWED_PROJECT_FIELDS) {
    if (key in project) picked[key] = project[key];
  }
  return picked;
}

// Replaces direct supabase.from('projects').insert(...) from
// Projects/create/page.tsx — user_id is derived from token (auth.userId) rather than
// request body, preventing project creation under another user's identity.
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json();
  const project = body?.project;
  if (!project || typeof project !== 'object') {
    return NextResponse.json({ error: 'project مطلوب' }, { status: 400 });
  }

  // Pre-insert validation of actual coordinates — same Number.isFinite check applied
  // in GET /api/weather, plus realistic geographic bounds, preventing weather/Overpass API
  // calls from being poisoned by invalid coordinates like 99999 that do not map anywhere.
  const { latitude, longitude } = project;
  if (latitude !== undefined && latitude !== null) {
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return NextResponse.json({ error: 'latitude غير صالح — يجب أن يكون رقماً بين -90 و90' }, { status: 400 });
    }
  }
  if (longitude !== undefined && longitude !== null) {
    if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return NextResponse.json({ error: 'longitude غير صالح — يجب أن يكون رقماً بين -180 و180' }, { status: 400 });
    }
  }

  // Work shifts (project_shifts) is a separate table — saved atomically with project via
  // single RPC (create_project_with_shifts, 202608120016) instead of two separate inserts:
  // if shifts are provided, either both save or whole operation fails — no silently "incomplete"
  // projects. Projects without shifts (missing or empty array) remain supported with zero behavior change.
  const shifts = Array.isArray(project.shifts) ? project.shifts : [];
  const projectInsert = pickAllowedProjectFields(project);

  const { data: insertedProject, error: projectError } = await supabaseAdmin
    .rpc('create_project_with_shifts', {
      p_user_id: auth.userId,
      p_project: projectInsert,
      p_shifts: shifts.length > 0 ? shifts : null,
    }) as { data: Record<string, unknown> | null; error: { code?: string; message: string } | null };

  if (projectError) {
    let message = safeErrorResponse(projectError, 'project insert failed');
    // Known error categories mapped to helpful user messages (without exposing column/constraint
    // names) — falls back to general safe error message above otherwise.
    if (projectError.code === '42501' || /row-level security/i.test(projectError.message)) {
      message = 'تم رفض الحفظ بواسطة سياسات الأمان (RLS) على جدول المشاريع. تأكد من صلاحيات المستخدم.';
    } else if (projectError.code === '23502') {
      message = 'حقل إلزامي مفقود — تحقق من تعبئة كل الحقول المطلوبة.';
    } else if (projectError.code === '23505') {
      message = 'يوجد مشروع آخر بنفس البيانات الفريدة (تكرار).';
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!insertedProject?.id) {
    return NextResponse.json(
      { error: 'تم إرسال طلب حفظ المشروع لكن لم يتم استلام بيانات المشروع المُنشأ من قاعدة البيانات.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ data: insertedProject });
}