import { describe, it, expect, vi, beforeEach } from 'vitest';

// نموّه supabaseAdmin — يغطي: التحقق من الملكية (خارج هذا الملف عبر
// requireUserId/verifyProjectOwnership)، قراءة work_hours لتحقق أوقات
// الدوام، قراءة project_devices لحساب device_id التلقائي، وأخيراً استدعاء
// RPC الذرية insert_dust_profile_atomic (نلتقط الحمولة النهائية p_insert
// للتحقق من is_dust_generating/activity_type — راجع تعليق mockRpcError
// أدناه لسبب تحويل activity_groups + project_dust_profiles لRPC واحدة).
type TableResult = { data: unknown; error: { message: string } | null };
const tableResults: Record<string, TableResult> = {};
let lastDustProfileInsert: Record<string, unknown> | null = null;
let lastRpcCall: { name: string; args: Record<string, unknown> } | null = null;
// خطأ RPC اختياري — لاختبار مسار الفشل الخادمي (مثال: قيد قاعدة بيانات)
// بمعزل عن أي تحقق سابق ناجح، يثبت أن lastDustProfileInsert لا يُحفَظ محلياً
// إلا بعد أن "تنجح" RPC فعلياً في هذا المموّه (لا قبلها).
let mockRpcError: { message: string; code?: string } | null = null;

function makeChain(tableName: string) {
  const result = tableResults[tableName] ?? { data: null, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
    then: (resolve: (value: { data: unknown; error: unknown }) => void) =>
      resolve({ data: result.data ?? null, error: result.error ?? null }),
  };
  return chain;
}

vi.mock('@/app/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (tableName: string) => makeChain(tableName),
    rpc: async (name: string, args: Record<string, unknown>) => {
      lastRpcCall = { name, args };
      if (mockRpcError) return { data: null, error: mockRpcError };
      if (name === 'insert_dust_profile_atomic') {
        lastDustProfileInsert = args.p_insert as Record<string, unknown>;
        return { data: { id: 'dust-profile-1', ...(args.p_insert as Record<string, unknown>) }, error: null };
      }
      return { data: null, error: null };
    },
  },
}));

let mockRequireUserIdResult: { userId: string } | { error: Response } = { userId: 'user-1' };
let mockOwnershipResult = true;

vi.mock('@/app/lib/apiAuth', () => ({
  requireUserId: async () => mockRequireUserIdResult,
  verifyProjectOwnership: async () => mockOwnershipResult,
}));

// خطأ مكتشَف ومُصلَح (المستخدم لاحظ: يمكن الحفظ قبل ظهور تنبيه precheck
// بالواجهة) — الحارس الحقيقي أصبح مطبَّقاً هنا في route.ts نفسه أيضاً
// لأنشطة CRUSHER/BATCHING_PLANT، يستدعي buildOsmProximityWarning (نداء
// شبكة Overpass حقيقي بلا هذا التمويه). موقع افتراضي "آمن" (لا تحذير) —
// اختبارات الحارس الجديد الصريحة أدناه تُغيّر mockOsmWarning.
let mockOsmWarning: string | null = null;
vi.mock('@/app/utils/geo/overpassReceptors', () => ({
  buildOsmProximityWarning: async () => mockOsmWarning,
}));

vi.mock('@/app/utils/dust-compliance-engine', async () => {
  const actual = await vi.importActual('@/app/utils/dust-compliance-engine');
  return {
    ...actual,
    refreshRuleParameters: vi.fn(async () => undefined),
  };
});

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest(insert: Record<string, unknown>): Request {
  return new Request('http://localhost/api/dust-profiles', {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ insert }),
  });
}

// حمولة أساسية صالحة — كسارة (CRUSHER) بـactivity_type المتوافق فعلياً
// (HEAVY_EQUIPMENT_MOVEMENT)، مع كل الحقول الإلزامية.
function baseInsert(overrides: Record<string, unknown> = {}) {
  return {
    project_id: PROJECT_ID,
    activity_type: 'HEAVY_EQUIPMENT_MOVEMENT',
    regulatory_activity: 'CRUSHER',
    planned_date: '2999-01-01',
    planned_time: '09:00',
    duration_hours: 2,
    ...overrides,
  };
}

describe('POST /api/dust-profiles', () => {
  beforeEach(() => {
    for (const key of Object.keys(tableResults)) delete tableResults[key];
    lastDustProfileInsert = null;
    lastRpcCall = null;
    mockRpcError = null;
    mockRequireUserIdResult = { userId: 'user-1' };
    mockOwnershipResult = true;
    tableResults.projects = { data: { work_hours_start: null, work_hours_end: null }, error: null };
    tableResults.project_devices = { data: [], error: null };
    tableResults.sensitive_receptors = { data: [], error: null };
    mockOsmWarning = null;
  });

  it('يرفض بلا مصادقة', async () => {
    mockRequireUserIdResult = { error: new Response(null, { status: 401 }) };
    const { POST } = await import('./route');
    const res = await POST(makeRequest(baseInsert()) as never);
    expect(res.status).toBe(401);
  });

  it('يرفض المستخدم غير مالك المشروع', async () => {
    mockOwnershipResult = false;
    const { POST } = await import('./route');
    const res = await POST(makeRequest(baseInsert()) as never);
    expect(res.status).toBe(403);
  });

  // خطأ أمني مكتشَف ومُصلَح — طلب صريح من المستخدم.
  describe('is_dust_generating لا يمكن التحكم به من العميل', () => {
    it('is_dust_generating=false مُرسَلة من العميل → تُتجاهَل، الصف يُحفَظ true دائماً', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert({ is_dust_generating: false })) as never);
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert?.is_dust_generating).toBe(true);
    });

    it('is_dust_generating غير مُرسَلة إطلاقاً → لا تزال true صراحةً في الحمولة النهائية', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert()) as never);
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert?.is_dust_generating).toBe(true);
    });
  });

  // خطأ أمني مكتشَف ومُصلَح — طلب صريح من المستخدم: activity_type يجب أن
  // يطابق النوع الجائز فعلياً لـregulatory_activity المُرسَل معه.
  describe('تحقق تناسب activity_type مع regulatory_activity', () => {
    it('CRUSHER مع activity_type مطابق (HEAVY_EQUIPMENT_MOVEMENT) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert()) as never);
      expect(res.status).toBe(200);
    });

    it('CRUSHER مع activity_type مخالف (INDOOR_WORK) → 400، لا يُحفَظ شيء', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert({ activity_type: 'INDOOR_WORK' })) as never);
      expect(res.status).toBe(400);
      expect(lastDustProfileInsert).toBeNull();
    });

    it('DEMOLITION مع activity_type مطابق (HEAVY_EQUIPMENT_MOVEMENT) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'DEMOLITION', activity_type: 'HEAVY_EQUIPMENT_MOVEMENT' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('EARTHWORKS مع activity_type مطابق (GRADING) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'EARTHWORKS', activity_type: 'GRADING' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('EARTHWORKS مع activity_type مخالف (CRANE_LIFTING) → 400', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'EARTHWORKS', activity_type: 'CRANE_LIFTING' })) as never
      );
      expect(res.status).toBe(400);
    });

    it('BATCHING_PLANT مع activity_type مطابق (CONCRETE_POURING) → 200', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'BATCHING_PLANT', activity_type: 'CONCRETE_POURING' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('OTHER بلا نوع متوقَّع محدد → أي activity_type صالح يُقبَل بلا رفض تناسب', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'OTHER', activity_type: 'OFFICE_WORK' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('ENTRY_EXIT (صف قديم، غير قابل للإنشاء من الواجهة الحالية) بلا نوع متوقَّع محدد → لا رفض تناسب', async () => {
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'ENTRY_EXIT', activity_type: 'MATERIAL_TRANSPORT' })) as never
      );
      expect(res.status).toBe(200);
    });

    it('regulatory_activity غائبة تماماً → لا تحقق تناسب (اختيارية في الـschema)', async () => {
      const insert = baseInsert();
      delete (insert as Record<string, unknown>).regulatory_activity;
      const { POST } = await import('./route');
      const res = await POST(makeRequest(insert) as never);
      expect(res.status).toBe(200);
    });
  });

  it('device_id المُرسَل من العميل يُتجاهَل، يُشتَق تلقائياً من أقرب جهاز نشط', async () => {
    tableResults.project_devices = {
      data: [{ id: 'device-near', lat: 24.7, lng: 46.6, is_active: true }],
      error: null,
    };
    const { POST } = await import('./route');
    // regulatory_activity=EARTHWORKS عمداً (لا CRUSHER/BATCHING_PLANT) —
    // هذا الاختبار يقصد device_id فقط، ولا يجوز أن يصطدم بحارس الكسارة/
    // محطة الخلط الجديد (يتطلب site_area_m2 كافياً لتصنيف الفئة، لا علاقة
    // له بموضوع هذا الاختبار).
    const res = await POST(
      makeRequest(
        baseInsert({
          regulatory_activity: 'EARTHWORKS',
          activity_type: 'GRADING',
          device_id: 'device-spoofed',
          activity_lat: 24.7,
          activity_lng: 46.6,
        })
      ) as never
    );
    expect(res.status).toBe(200);
    expect(lastDustProfileInsert?.device_id).toBe('device-near');
  });

  // خطأ حرج مكتشَف ومُصلَح (طلب صريح من المستخدم — "لو كانت وحدة في الشرق
  // وأخرى في الغرب، هل كل وحدة سترتبط بجهازها؟"): كان device_id يُحسَب دائماً
  // من activity_lat/activity_lng — الحقل المشترك على مستوى النشاط كله الذي
  // يتبع موقع الوحدة الأولى فقط في الواجهة (AddActivityModal/index.tsx). لنشاط
  // متعدد الوحدات (كسارتان/محطتا خلط متباعدتان جغرافياً)، كل صف وحدة كان
  // يُربَط بنفس جهاز الوحدة الأولى بصرف النظر عن موقعه الفعلي الخاص —
  // اختبارات هذه المجموعة تثبت أن crusher_lat/crusher_lng وbatching_lat/
  // batching_lng (إحداثيات الوحدة الفعلية) تُفضَّل الآن على activity_lat/lng
  // المشترك عند حل الجهاز، لا فقط عند التحقق من صحة الموقع (placement).
  describe('حل device_id للوحدات متعددة المواقع (كسارة/محطة خلط) — يعتمد على إحداثيات الوحدة الفعلية لا موقع النشاط المشترك', () => {
    it('كسارة: crusher_lat/lng (شرق) تختلف عن activity_lat/lng (غرب، موقع الوحدة الأولى) → device_id يُحسَب من crusher_lat/lng', async () => {
      tableResults.projects = { data: { site_area_m2: 6000, daily_truck_movements: 10 }, error: null };
      tableResults.project_devices = {
        data: [
          { id: 'device-east', lat: 24.71, lng: 46.70, is_active: true },
          { id: 'device-west', lat: 24.71, lng: 46.50, is_active: true },
        ],
        error: null,
      };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(
          baseInsert({
            // موقع النشاط المشترك (يتبع الوحدة الأولى في الواجهة) — غرب،
            // قريب من device-west.
            activity_lat: 24.71,
            activity_lng: 46.50,
            // هذه الوحدة تحديداً (كسارة ثانية مثلاً) في الشرق فعلياً —
            // قريبة من device-east.
            crusher_lat: 24.71,
            crusher_lng: 46.70,
          })
        ) as never
      );
      expect(res.status).toBe(200);
      // يجب أن يُختار device-east (الأقرب لموقع الوحدة الفعلي)، لا
      // device-west (الأقرب لموقع النشاط المشترك/الوحدة الأولى).
      expect(lastDustProfileInsert?.device_id).toBe('device-east');
    });

    it('محطة خلط: batching_lat/lng (شرق) تختلف عن activity_lat/lng (غرب) → device_id يُحسَب من batching_lat/lng', async () => {
      tableResults.project_devices = {
        data: [
          { id: 'device-east', lat: 24.71, lng: 46.70, is_active: true },
          { id: 'device-west', lat: 24.71, lng: 46.50, is_active: true },
        ],
        error: null,
      };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(
          baseInsert({
            regulatory_activity: 'BATCHING_PLANT',
            activity_type: 'CONCRETE_POURING',
            activity_lat: 24.71,
            activity_lng: 46.50,
            batching_lat: 24.71,
            batching_lng: 46.70,
          })
        ) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert?.device_id).toBe('device-east');
    });

    it('كسارة بلا crusher_lat/lng (غير مُرسَلة) → يرجع للـfallback activity_lat/lng كما كان دائماً', async () => {
      tableResults.projects = { data: { site_area_m2: 6000, daily_truck_movements: 10 }, error: null };
      tableResults.project_devices = {
        data: [{ id: 'device-near', lat: 24.7, lng: 46.6, is_active: true }],
        error: null,
      };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ activity_lat: 24.7, activity_lng: 46.6 })) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert?.device_id).toBe('device-near');
    });
  });

  // قرار مُعاد النظر فيه بالكامل (طلب صريح من المستخدم — "المستقبلات الحساسة
  // لا تدخل ضمن قرارات الإيقاف"، يشمل صراحة منع حفظ الموقع على الخريطة): حارس
  // PLACEMENT_BLOCKED هنا (وفي crusher-precheck/batching-precheck بالواجهة)
  // لم يعد يمنع الحفظ أبداً — validateDustUnitPlacement تُرجع blocked:false
  // دائماً الآن (راجع dustPlacementValidation.ts)، فكل سيناريوهات هذه
  // المجموعة تنتهي بـ200 (يُحفَظ) بدل 422.
  describe('فحص موقع الكسارة/محطة الخلط عند الحفظ الفعلي (تنبيه توعوي فقط، لا يمنع الحفظ)', () => {
    it('كسارة في مشروع دون الفئة الثالثة (site_area_m2 صغيرة) → 200 (يُحفَظ، تنبيه توعوي فقط)', async () => {
      tableResults.projects = { data: { site_area_m2: 1000, daily_truck_movements: 5 }, error: null };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ activity_lat: 24.7, activity_lng: 46.6 })) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert).not.toBeNull();
    });

    it('كسارة في مشروع فئة ثالثة + مستقبل سكني على 100م (sensitive_receptors يدوي) → 200 (يُحفَظ، تنبيه توعوي فقط)', async () => {
      tableResults.projects = { data: { site_area_m2: 6000, daily_truck_movements: 10 }, error: null };
      tableResults.sensitive_receptors = {
        data: [{ id: 'r1', name: 'حي سكني', receptor_type: 'RESIDENTIAL', lat: 24.7009, lng: 46.6 }],
        error: null,
      };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ activity_lat: 24.7, activity_lng: 46.6 })) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert).not.toBeNull();
    });

    it('كسارة في مشروع فئة ثالثة + OSM يكتشف مسجداً قريباً (sensitive_receptors فارغ) → 200 (يُحفَظ، تنبيه توعوي فقط)', async () => {
      tableResults.projects = { data: { site_area_m2: 6000, daily_truck_movements: 10 }, error: null };
      mockOsmWarning = 'تحذير: تم اكتشاف معلَم قريب محتمل الحساسية عبر خرائط OpenStreetMap.';
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ activity_lat: 24.7, activity_lng: 46.6 })) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert).not.toBeNull();
    });

    it('كسارة في مشروع فئة ثالثة + لا مستقبلات (يدوية أو OSM) → 200 (يُحفَظ)', async () => {
      tableResults.projects = { data: { site_area_m2: 6000, daily_truck_movements: 10 }, error: null };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ activity_lat: 24.7, activity_lng: 46.6 })) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert).not.toBeNull();
    });

    it('محطة خلط + مسجد على 100م (أقل من 200م) → 200 (يُحفَظ، تنبيه توعوي فقط)', async () => {
      tableResults.sensitive_receptors = {
        data: [{ id: 'r1', name: 'مسجد', receptor_type: 'MOSQUE', lat: 24.7009, lng: 46.6 }],
        error: null,
      };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(
          baseInsert({
            regulatory_activity: 'BATCHING_PLANT',
            activity_type: 'CONCRETE_POURING',
            activity_lat: 24.7,
            activity_lng: 46.6,
          })
        ) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert).not.toBeNull();
    });

    it('محطة خلط + OSM يكتشف معلَماً قريباً → 200 (يُحفَظ، تنبيه توعوي فقط)', async () => {
      mockOsmWarning = 'تحذير: تم اكتشاف معلَم قريب محتمل الحساسية عبر خرائط OpenStreetMap.';
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(
          baseInsert({
            regulatory_activity: 'BATCHING_PLANT',
            activity_type: 'CONCRETE_POURING',
            activity_lat: 24.7,
            activity_lng: 46.6,
          })
        ) as never
      );
      expect(res.status).toBe(200);
      expect(lastDustProfileInsert).not.toBeNull();
    });

    it('كسارة بلا إحداثيات (activity_lat/lng غائبة) → لا يُطبَّق الحارس، القرار النهائي يبقى للتقييم اللاحق', async () => {
      tableResults.projects = { data: { site_area_m2: 1000 }, error: null };
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert()) as never);
      expect(res.status).toBe(200);
    });
  });

  // اختبارا قبول صريحان (طلب المستخدم — تقرير المراجعة الخارجي: "إنشاء
  // نشاط الغبار ليس معاملة واحدة"): activity_groups لم يعد يُكتَب مباشرة من
  // route.ts بمعزل عن باقي التحققات — الكتابة الوحيدة الآن هي RPC واحدة
  // (insert_dust_profile_atomic) تُنشئ activity_groups وproject_dust_profiles
  // معاً، ولا تُستدعى إطلاقاً قبل نجاح كل تحقق سابق (تاريخ/أوقات دوام/تناسب
  // activity_type). فشل أي تحقق لاحق يعني عدم استدعاء RPC مطلقاً — لا صف
  // مجموعة يتيم ممكن.
  //
  // ملاحظة: فحص موقع الكسارة/محطة الخلط لم يعد يمنع الحفظ (راجع describe
  // أعلاه — "تنبيه توعوي فقط، لا يمنع الحفظ")، فلم يعد مصدراً صالحاً لسيناريو
  // "فشل تحقق لاحق" هنا؛ استُبدل بتحقق تناسب activity_type (لا يزال حارساً
  // حقيقياً يمنع الحفظ قبل RPC).
  describe('لا كتابة على activity_groups قبل نجاح كل التحققات (اختبار قبول صريح)', () => {
    it('فشل تناسب activity_type مع regulatory_activity → RPC الذرية لا تُستدعى إطلاقاً', async () => {
      const { POST } = await import('./route');
      const res = await POST(makeRequest(baseInsert({ activity_type: 'INDOOR_WORK' })) as never);
      expect(res.status).toBe(400);
      expect(lastRpcCall).toBeNull();
    });

    it('نجاح كل التحققات → RPC واحدة فقط تُستدعى، تحمل activity_group_id وحمولة النشاط معاً (لا كتابتان منفصلتان)', async () => {
      tableResults.projects = { data: { site_area_m2: 6000, daily_truck_movements: 10 }, error: null };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ activity_lat: 24.7, activity_lng: 46.6 })) as never
      );
      expect(res.status).toBe(200);
      expect(lastRpcCall?.name).toBe('insert_dust_profile_atomic');
      expect(typeof lastRpcCall?.args.p_activity_group_id).toBe('string');
      expect((lastRpcCall?.args.p_insert as Record<string, unknown>)?.project_id).toBe(PROJECT_ID);
    });

    it('فشل RPC الذرية خادمياً (مثال: قيد قاعدة بيانات) → 500 صريح، لا نجاح كاذب', async () => {
      tableResults.projects = { data: { work_hours_start: null, work_hours_end: null }, error: null };
      mockRpcError = { message: 'constraint violation' };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(baseInsert({ regulatory_activity: 'EARTHWORKS', activity_type: 'GRADING' })) as never
      );
      expect(res.status).toBe(500);
    });

    // خطأ حرج مكتشَف ومُصلَح (migration 202608160001): activity_group_id
    // كان يُقبَل من العميل بلا أي تحقق تنسيق أو تصادم — استدعاء API مباشر
    // (لا AddActivityModal) يرسل معرّفاً مستخدَماً مسبقاً في نفس المشروع
    // (بلا لاحقة -uN، أو نفس اللاحقة مكرَّرة) كان يُعيد فتح سباق CAS الذي
    // صُمِّمت آلية -uN أصلاً لإغلاقه. insert_dust_profile_atomic ترفض الآن
    // هذا التصادم بكود 23505 — الخادم يترجمه لـ409 صريح (خطأ طلب لا خطأ
    // خادم)، لا 500 عام يوهم بخطأ داخلي.
    it('activity_group_id مستخدَم مسبقاً في نفس المشروع (تصادم/تجاوز صيغة -uN) → 409 صريح', async () => {
      tableResults.projects = { data: { work_hours_start: null, work_hours_end: null }, error: null };
      mockRpcError = { message: 'duplicate key value violates unique constraint', code: '23505' };
      const { POST } = await import('./route');
      const res = await POST(
        makeRequest(
          baseInsert({
            regulatory_activity: 'EARTHWORKS',
            activity_type: 'GRADING',
            activity_group_id: 'reused-group-id',
          })
        ) as never
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('ACTIVITY_GROUP_ID_ALREADY_USED');
    });
  });
});
