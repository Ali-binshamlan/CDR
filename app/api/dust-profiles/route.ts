import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { supabaseAdmin } from '@/app/lib/supabaseAdmin';
import { requireUserId, verifyProjectOwnership } from '@/app/lib/apiAuth';
import { safeErrorResponse } from '@/app/lib/apiError';
import { haversineDistanceM } from '@/app/utils/geo/zone';
import { isActivityTimeWithinWorkHours } from '@/app/lib/shiftValidation';

// حقول حساسة لا يجوز أن يتحكم بها العميل مطلقاً — id لمنع انتحال/تصادم
// صف موجود، created_at لمنع تزوير توقيت السجل، device_id (الربط بمحطة
// الرصد يصير تلقائياً بأقرب جهاز حسب الإحداثيات — راجع
// resolveNearestActiveDeviceId أدناه). aei_score/aei_status: لا يحسبهما
// الخادم حالياً (لا مصدر ثقة بديل بعد)، لكن العميل لا يجوز أن يتحكم بهما
// أيضاً — إسقاطهما هنا أفضل من تخزين قيمة العميل كأنها موثوقة (كانت القيمة
// المُرسَلة من AddActivityModal/index.tsx تُخزَّن حرفياً بلا أي تحقق خادمي،
// رغم عدم قراءتها فعلياً في أي مكان آخر بالتطبيق حالياً).
//
// خطأ أمني مكتشَف ومُصلَح (طلب صريح من المستخدم): is_dust_generating لم
// يكن ضمن هذه القائمة، فيسقط ضمن .catchall أدناه ويُقبَل حرفياً من العميل.
// هذا الحقل يغذّي مباشرة بوابة الرياح التنظيمية (GATE-WIND-ABOVE-25-004 في
// dust-compliance-engine/engine.ts: ctx.activity.isDustGenerating) وقواعد
// أخرى (enhancedSuppressionRule، windGustSafetyRule) — طلب API مباشر
// بـis_dust_generating=false كان يعطّل هذه البوابات بالكامل لأي نشاط
// (حفر/هدم/إلخ) بصرف النظر عن نوعه الفعلي. لا يوجد نشاط تنظيمي واحد ضمن
// REGULATORY_ACTIVITY_VALUES (حتى OTHER/ENTRY_EXIT) غير مولّد للغبار
// منطقياً — القيمة تُشتَق ثابتة true دائماً خادمياً (راجع insert.is_dust_
// generating أدناه)، مطابقة تماماً لـdefault true الحالي في migration
// 202607290001_baseline_final.sql، فلا تغيير سلوكي على أي مسار طبيعي.
const FORBIDDEN_DUST_PROFILE_FIELDS = ['id', 'created_at', 'device_id', 'aei_score', 'aei_status', 'is_dust_generating'];

// enums فعلية — نفس المصادر الموثوقة في dust-engine/types.ts وdust-compliance-
// engine/types.ts (لا نسخة مكرَّرة يدوياً هنا قد تنحرف عنها لاحقاً).
const ACTIVITY_TYPE_VALUES = [
  'CRANE_LIFTING', 'WORK_AT_HEIGHT', 'STEEL_ERECTION', 'FACADE_INSTALLATION',
  'HEAVY_EQUIPMENT_MOVEMENT', 'MATERIAL_TRANSPORT', 'EXCAVATION', 'BACKFILLING',
  'GRADING', 'SOIL_TRANSPORT', 'COMPACTION', 'ROAD_WORKS', 'ASPHALT_PAVING',
  'EXTERNAL_PAINTING', 'COATING', 'WATERPROOFING', 'CONCRETE_POURING',
  'GENERAL_OUTDOOR_WORK', 'MEP_EXTERNAL_WORK', 'LANDSCAPING', 'INDOOR_WORK', 'OFFICE_WORK',
] as const;

const REGULATORY_ACTIVITY_VALUES = [
  'EARTHWORKS', 'SITE_TRAFFIC', 'ENTRY_EXIT', 'MATERIAL_HANDLING_STOCKPILE',
  'DEMOLITION', 'CRUSHER', 'BATCHING_PLANT', 'STONE_CUTTING', 'CD_WASTE_TRANSPORT',
  'IDLE_SURFACE', 'OTHER',
] as const;

// خطأ أمني مكتشَف ومُصلَح (طلب صريح من المستخدم): regulatory_activity
// مُرسَل من العميل (اختيار مستخدم فعلي، لا يمكن اشتقاقه بالكامل خادمياً —
// activity_type الواحد قد يخدم أكثر من regulatory_activity واحد، مثال:
// HEAVY_EQUIPMENT_MOVEMENT يُستخدَم لكل من DEMOLITION/CRUSHER/STONE_CUTTING)
// لكن كان يُقبَل بلا أي تحقق تناسب — طلب API مباشر بـregulatory_activity:
// 'CRUSHER' مع activity_type: 'INDOOR_WORK' (غير متوافقين منطقياً) كان
// يمر بصمت، فيُشغِّل قواعد الكسارة الصارمة (CRUSHER-CATEGORY-001 وغيرها)
// على نشاط لا علاقة له فعلياً بكسارة. الخريطة أدناه (نسخة طبق الأصل من
// REGULATORY_ACTIVITY_OPTIONS في AddActivityModal/constants.ts — مصدر
// موثوق واحد لكل مفتاح تنظيمي قابل للاختيار من الواجهة، وليست نسخة يدوية
// منفصلة قد تنحرف عنها) تحدد activity_type الوحيد الجائز فعلياً لكل
// regulatory_activity. ENTRY_EXIT/OTHER مستثنيان عمداً من التحقق الصارم:
// ENTRY_EXIT محذوف من مسار الإنشاء الجديد أصلاً (نفس تعليق constants.ts)
// فلا dviCategory معروف له هنا، وOTHER هو fallback عام بلا نوع نشاط
// فيزيائي محدد بطبيعته.
const REGULATORY_ACTIVITY_EXPECTED_TYPE: Partial<Record<(typeof REGULATORY_ACTIVITY_VALUES)[number], (typeof ACTIVITY_TYPE_VALUES)[number]>> = {
  EARTHWORKS: 'GRADING',
  SITE_TRAFFIC: 'ROAD_WORKS',
  MATERIAL_HANDLING_STOCKPILE: 'MATERIAL_TRANSPORT',
  DEMOLITION: 'HEAVY_EQUIPMENT_MOVEMENT',
  CRUSHER: 'HEAVY_EQUIPMENT_MOVEMENT',
  BATCHING_PLANT: 'CONCRETE_POURING',
  STONE_CUTTING: 'HEAVY_EQUIPMENT_MOVEMENT',
  CD_WASTE_TRANSPORT: 'MATERIAL_TRANSPORT',
  IDLE_SURFACE: 'GENERAL_OUTDOOR_WORK',
};

const RECEPTOR_TYPE_VALUES = [
  'HOSPITAL_SCHOOL_NURSERY_RESIDENTIAL_ADJACENT', 'HIGH_TRAFFIC_PUBLIC_ROAD',
  'COMMERCIAL_AREA', 'INDUSTRIAL_AREA', 'NONE_NEARBY',
] as const;

// موقع (lat/lng) — يظهر بأكثر من اسم عمود (activity_lat/lng، entry_point_*،
// exit_point_*، stockpile_*، batching_*، crusher_*) حسب نوع النشاط
// التنظيمي. nullable: نشاط بلا موقع محدد بعد يبقى مسموحاً (الحفظ الأول قد
// يسبق تحديد الموقع في بعض تدفقات الواجهة)، لكن قيمة مُرسَلة فعلياً يجب أن
// تقع ضمن نطاق إحداثيات صالح فعلياً — لا NaN ولا خارج الكوكب.
const latSchema = z.number().finite().min(-90).max(90).nullable().optional();
const lngSchema = z.number().finite().min(-180).max(180).nullable().optional();

// رقم غير سالب nullable — القيمة الشائعة لحقول القياس/المسافة/الارتفاع
// (demolition_active_area_m2، drop_height_m، stockpile_height_m، إلخ).
// finite() يمنع NaN/Infinity من الوصول لقاعدة البيانات أو محركات القرار —
// بالضبط الثغرة التي حذّر منها classifyWind في dust-compliance-engine
// (NaN لا يجوز أن يُصنَّف "رياح أعلى من 25" أو ينتشر داخل DVI).
const nonNegativeFiniteNullable = z.number().finite().min(0).nullable().optional();

const durationHoursSchema = z.number().finite().min(0.5).max(240);

// كل حقل قياس/إعداد إضافي غير مذكور صراحة أعلاه (نحو 150 حقلاً في
// AddActivityModal/constants.ts، معظمها boolean بإعدادات افتراضية،
// تتوسع مع كل ميزة جديدة على النموذج) — لا allowlist اسمية جامدة لكل حقل
// (كانت ستكسر صمتاً أي حقل جديد يُضاف للنموذج دون تحديث هذا الملف بالتزامن،
// نفس المخاطرة الموثَّقة سابقاً في هذا الملف)، لكن نوعه محصور: نص قصير،
// رقم finite، boolean، أو null فقط — لا كائنات/مصفوفات متداخلة يمكن أن
// تُدخِل بنية بيانات غير متوقعة لمحركات القرار أو قاعدة البيانات.
const catchallFieldSchema = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

const DustProfileInsertSchema = z
  .object({
    project_id: z.string().uuid(),
    activity_group_id: z.string().min(1).max(200).optional().nullable(),
    shift_id: z.string().uuid().nullable().optional(),

    activity_type: z.enum(ACTIVITY_TYPE_VALUES),
    regulatory_activity: z.enum(REGULATORY_ACTIVITY_VALUES).optional(),
    receptor_type: z.enum(RECEPTOR_TYPE_VALUES).optional(),

    activity_lat: latSchema,
    activity_lng: lngSchema,
    entry_point_lat: latSchema,
    entry_point_lng: lngSchema,
    exit_point_lat: latSchema,
    exit_point_lng: lngSchema,
    stockpile_lat: latSchema,
    stockpile_lng: lngSchema,
    batching_lat: latSchema,
    batching_lng: lngSchema,
    crusher_lat: latSchema,
    crusher_lng: lngSchema,

    planned_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'planned_date يجب أن يكون بصيغة YYYY-MM-DD'),
    planned_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'planned_time يجب أن يكون بصيغة HH:MM'),
    duration_hours: durationHoursSchema,

    onsite_visibility_m: nonNegativeFiniteNullable,
    onsite_pm10: nonNegativeFiniteNullable,
    onsite_pm25: nonNegativeFiniteNullable,
  })
  .catchall(catchallFieldSchema);

// أقرب جهاز رصد نشط (project_devices.is_active=true) لنقطة نشاط معيّنة —
// نفس خوارزمية findNearestActiveDeviceId التي كانت سابقاً في
// AddActivityModal/index.tsx (اقتراح تلقائي قابل للتغيير يدوياً)، مُنقولة
// هنا لتصبح الحساب الحيد الملزم على السيرفر (لا اختيار عميل يُوثَق به —
// device_id محذوف من allowlist أعلاه، فأي قيمة يرسلها العميل تُتجاهل).
// null إن لم توجد أي محطة نشطة بموقع معروف — النشاط يُحفظ بلا device_id
// ويعتمد على API الطقس (Open-Meteo) بدل الجهاز، بنفس أولوية جهاز > API
// المعتادة في resolveFreshProjectDevice (dustEvaluation.ts).
async function resolveNearestActiveDeviceId(
  projectId: string,
  lat: number | null | undefined,
  lng: number | null | undefined
): Promise<string | null> {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const { data: devices } = await supabaseAdmin
    .from('project_devices')
    .select('id, lat, lng, is_active')
    .eq('project_id', projectId)
    .eq('is_active', true);

  let nearestId: string | null = null;
  let nearestDist = Infinity;
  for (const d of devices || []) {
    if (typeof d.lat !== 'number' || typeof d.lng !== 'number') continue;
    const dist = haversineDistanceM({ lat, lng }, { lat: d.lat, lng: d.lng });
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestId = d.id;
    }
  }
  return nearestId;
}

// حفظ تقييم غبار/رؤية نشاط جديد — يستبدل استدعاء
// supabase.from('project_dust_profiles').insert(...) المباشر من
// AddActivityModal/index.tsx (handleDustSubmit)
export async function POST(request: NextRequest) {
  const auth = await requireUserId(request);
  if ('error' in auth) return auth.error;

  const body = await request.json().catch(() => null);
  const rawInsert = (body as Record<string, unknown> | null)?.insert;
  if (!rawInsert || typeof rawInsert !== 'object') {
    return NextResponse.json({ error: 'insert مطلوب ويجب أن يحتوي project_id' }, { status: 400 });
  }
  for (const field of FORBIDDEN_DUST_PROFILE_FIELDS) delete (rawInsert as Record<string, unknown>)[field];

  const parsed = DustProfileInsertSchema.safeParse(rawInsert);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'حمولة النشاط غير صالحة', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const insert: Record<string, unknown> = parsed.data;

  // خطأ أمني مكتشَف ومُصلَح (طلب صريح من المستخدم) — راجع تعليق
  // REGULATORY_ACTIVITY_EXPECTED_TYPE أعلاه: activity_type يجب أن يطابق
  // النوع الوحيد الجائز فعلياً للـregulatory_activity المُرسَل معه، إن
  // كان الأخير من الأنشطة التسعة ذات النوع المعروف (لا ENTRY_EXIT/OTHER).
  if (typeof insert.regulatory_activity === 'string') {
    const expectedActivityType =
      REGULATORY_ACTIVITY_EXPECTED_TYPE[insert.regulatory_activity as (typeof REGULATORY_ACTIVITY_VALUES)[number]];
    if (expectedActivityType && insert.activity_type !== expectedActivityType) {
      return NextResponse.json(
        {
          error: `activity_type (${insert.activity_type}) لا يتوافق مع regulatory_activity (${insert.regulatory_activity}) — يجب أن يكون ${expectedActivityType}`,
        },
        { status: 400 }
      );
    }
  }

  // خطأ أمني مكتشَف ومُصلَح (طلب صريح من المستخدم) — راجع تعليق
  // FORBIDDEN_DUST_PROFILE_FIELDS أعلاه: مُشتَق ثابتاً true دائماً، بلا أي
  // مدخل من العميل (كان FORBIDDEN_DUST_PROFILE_FIELDS يحذف الحقل إن أُرسل
  // فقط — لكن بلا هذا السطر، غيابه كان يترك العمود على القيمة الافتراضية
  // في قاعدة البيانات نفسها بدل قيمة صريحة مضمونة من التطبيق).
  insert.is_dust_generating = true;

  const owns = await verifyProjectOwnership(insert.project_id as string, auth.userId);
  if (!owns) return NextResponse.json({ error: 'لا تملك هذا المشروع' }, { status: 403 });

  // خطأ معماري مكتشَف ومُصلَح (القسم 12.2/12.3 من "دليل الإصلاح الجذري
  // لمنظومة مرقاب" — "الأفضل ألا يقبل api/dust-profiles قيمة activity_
  // group_id حرة من العميل"): كان العميل (AddActivityModal.tsx) يرسل
  // activity_group_id=null أحياناً فعلياً (قبل توليده محلياً لأول نشاط في
  // الجلسة)، بلا أي fallback خادمي يضمن قيمة قبل الإدراج — قيد NOT NULL/FK
  // المركّب على activity_group_id (activity_groups(project_id, id)) كان
  // سيكسر هذا التدفق الصحيح فعلياً. الإصلاح: الخادم يولّد المعرّف دائماً
  // إن غاب من العميل، ويُسجَّل صراحة في activity_groups (هوية المجموعة)
  // قبل إدراج صف النشاط نفسه — يضمن استيفاء FK المركّب دائماً بلا استثناء.
  const activityGroupId =
    typeof insert.activity_group_id === 'string' && insert.activity_group_id.trim()
      ? insert.activity_group_id.trim()
      : crypto.randomUUID();
  insert.activity_group_id = activityGroupId;

  const { error: groupError } = await supabaseAdmin
    .from('activity_groups')
    .upsert({ project_id: insert.project_id as string, id: activityGroupId }, { onConflict: 'project_id,id', ignoreDuplicates: true });
  if (groupError) {
    return NextResponse.json({ error: safeErrorResponse(groupError, 'activity_groups upsert failed') }, { status: 500 });
  }

  // منع جدولة نشاط في تاريخ ماضٍ على مستوى السيرفر أيضاً (لا نعتمد على فحص
  // الواجهة وحده) — تقييم DVI/الامتثال يعتمد على توقّع طقس ساعي لا يخدم
  // الماضي، فنشاط بتاريخ سابق لا يملك بيانات ساعية. المقارنة بتوقيت الرياض
  // (+03:00) حتى لا يختلف يوم "اليوم" حسب منطقة السيرفر الزمنية.
  if (insert.planned_date) {
    const todayRiyadh = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
    if (String(insert.planned_date) < todayRiyadh) {
      return NextResponse.json({ error: 'لا يمكن جدولة نشاط في تاريخ سابق لليوم.' }, { status: 400 });
    }
  }

  // خطأ مكتشَف ومُصلَح: تحقق أوقات الدوام هنا كان يستخدم project_shifts
  // خطأً (جدول ورديات فرعية اختيارية، منفصل تماماً) — المصدر الحقيقي
  // work_hours_start/work_hours_end على projects نفسه (نفس ما تتحقق منه
  // الواجهة بالفعل في AddActivityModal/index.tsx). هذا التحقق الخادمي كان
  // غائباً تماماً قبل ذلك (الواجهة وحدها كانت تمنع، قابل للتجاوز بطلب API
  // مباشر) — الآن مطابق فعلياً لنفس المصدر الذي تعرضه الواجهة، ومكرَّر أيضاً
  // عند التعديل في app/api/activities/route.ts.
  if (insert.planned_time && typeof insert.duration_hours === 'number') {
    const { data: projectRow } = await supabaseAdmin
      .from('projects')
      .select('work_hours_start, work_hours_end')
      .eq('id', insert.project_id as string)
      .maybeSingle();
    const ws = projectRow?.work_hours_start ?? null;
    const we = projectRow?.work_hours_end ?? null;
    if (
      !isActivityTimeWithinWorkHours(
        ws,
        we,
        String(insert.planned_time),
        insert.duration_hours,
        typeof insert.daily_duration_hours === 'number' ? insert.daily_duration_hours : null
      )
    ) {
      return NextResponse.json(
        { error: `وقت النشاط اليومي يجب أن يقع ضمن أوقات دوام المشروع (${String(ws).slice(0, 5)} – ${String(we).slice(0, 5)}).` },
        { status: 400 }
      );
    }
  }

  // الربط بمحطة الرصد تلقائي بالكامل (أقرب جهاز نشط لموقع النشاط) — لا
  // اختيار من العميل (device_id محذوف أعلاه من FORBIDDEN_DUST_PROFILE_FIELDS).
  insert.device_id = await resolveNearestActiveDeviceId(
    insert.project_id as string,
    insert.activity_lat as number | null | undefined,
    insert.activity_lng as number | null | undefined
  );

  const { error } = await supabaseAdmin.from('project_dust_profiles').insert(insert);
  if (error) return NextResponse.json({ error: safeErrorResponse(error, 'dust-profiles insert failed') }, { status: 500 });
  return NextResponse.json({ success: true });
}
