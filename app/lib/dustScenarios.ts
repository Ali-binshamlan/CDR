// تعريف سيناريوهات اختبار محرك الامتثال — كل سيناريو سلسلة مراحل زمنية
// (stages) تُرسَل كقراءات telemetry حقيقية إلى جهاز ThingsBoard فعلي (نفس
// نمط scripts/local-thingsboard-*-scenario.mjs)، بدل توليد عشوائي كامل —
// حتى تُعيد كل مرحلة إنتاج حد/بوابة محدد في dust-compliance-engine بدقة.
// مشترك بين واجهة لوحة السيناريوهات (app/dashboard/dust-scenarios) ومسار
// التشغيل الخلفي (app/api/dust-scenarios/run/route.ts) — تعريف واحد فقط
// لكل سيناريو، لا نسخة مكررة في كل طرف.

export interface DustScenarioStage {
  labelAr: string;
  minutes: number;
  windSpeedKmh: [number, number];
  windGustKmh: [number, number];
  pm10: [number, number];
  visibilityM: [number, number];
}

export interface DustScenarioDefinition {
  id: string;
  titleAr: string;
  descriptionAr: string;
  // القاعدة/البوابة التي يستهدفها هذا السيناريو تحديداً — نص مرجعي للعرض فقط.
  targetRuleAr: string;
  stages: DustScenarioStage[];
}

// قيم ثابتة معتدلة لا تتداخل مع أي بوابة غير مستهدَفة بالسيناريو (نفس مبدأ
// FIXED_VISIBILITY_M في local-thingsboard-violation-then-allow-scenario.mjs).
const CALM_WIND: [number, number] = [5, 10];
const CALM_GUST: [number, number] = [10, 15];
const NORMAL_PM10: [number, number] = [80, 120];
const CLEAR_VISIBILITY: [number, number] = [3000, 5000];

export const DUST_SCENARIOS: DustScenarioDefinition[] = [
  {
    id: 'wind-above-25-stop',
    titleAr: 'بوابة الرياح — إيقاف فوق 25 كم/س',
    descriptionAr: 'رياح تتجاوز 25 كم/س على نشاط مكشوف مولّد للغبار — إيقاف الأنشطة المكشوفة (GATE-WIND-ABOVE-25-004).',
    targetRuleAr: 'GATE-WIND-ABOVE-25-004',
    stages: [
      { labelAr: 'قبل الإيقاف — رياح هادئة', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'رياح فوق 25 كم/س', minutes: 3, windSpeedKmh: [28, 35], windGustKmh: [30, 40], pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'wind-15-25-enhanced',
    titleAr: 'الرياح 15-25 — تثبيط معزز',
    descriptionAr: 'رياح بين 15 و25 كم/س — تثبيط معزز دون إيقاف كامل (GATE-WIND-15-25-ENHANCED-005).',
    targetRuleAr: 'GATE-WIND-15-25-ENHANCED-005',
    stages: [
      { labelAr: 'قبل — رياح هادئة', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'رياح 15-25 كم/س', minutes: 3, windSpeedKmh: [16, 24], windGustKmh: [18, 26], pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'wind-gust-safety',
    titleAr: 'هبّة رياح قوية عابرة',
    descriptionAr: 'هبّة تتجاوز 50 كم/س بسرعة مستدامة منخفضة — تنبيه سلامة (GATE-WIND-GUST-SAFETY)، لا مخالفة تنظيمية.',
    targetRuleAr: 'GATE-WIND-GUST-SAFETY',
    stages: [
      { labelAr: 'قبل — هبّات عادية', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'هبّة فوق 50 كم/س', minutes: 2, windSpeedKmh: [10, 15], windGustKmh: [52, 65], pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'pm10-precaution',
    titleAr: 'PM10 — احتراز (201-250)',
    descriptionAr: 'تركيز PM10 ضمن نطاق الإنذار المبكر — حالة احتراز (PM10-PRECAUTION-009)، لا يتطلب إجراءً فورياً.',
    targetRuleAr: 'PM10-PRECAUTION-009',
    stages: [
      { labelAr: 'طبيعي (≤200)', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [150, 190], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'احتراز (201-250)', minutes: 3, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [210, 245], visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'pm10-warning',
    titleAr: 'PM10 — تحذير (251-320)',
    descriptionAr: 'تركيز PM10 تجاوز حد التحذير التنظيمي — ضوابط إلزامية (PM10-WARNING-008).',
    targetRuleAr: 'PM10-WARNING-008',
    stages: [
      { labelAr: 'طبيعي', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [150, 190], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'تحذير (251-320)', minutes: 3, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [260, 310], visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'pm10-red-restrict',
    titleAr: 'PM10 — تقييد شديد (321-340)',
    descriptionAr: 'تركيز PM10 ضمن النطاق الأحمر قبل حد المخالفة — تقييد شديد (PM10-RED-RESTRICT-010).',
    targetRuleAr: 'PM10-RED-RESTRICT-010',
    stages: [
      { labelAr: 'طبيعي', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [150, 190], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'تقييد شديد (321-340)', minutes: 3, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [325, 339], visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'pm10-pending-then-confirmed',
    titleAr: 'PM10 — معلَّق ثم مخالفة مؤكَّدة',
    descriptionAr: 'تجاوز حد المخالفة (>340): أول أكثر من دقيقتين "معلَّق" (MRQ-PM10-BLACK-PENDING-104)، ثم "مؤكَّد" (PM10-VIOLATION-STOP-006) بعد استمرار الاستمرار.',
    targetRuleAr: 'MRQ-PM10-BLACK-PENDING-104 → PM10-VIOLATION-STOP-006',
    stages: [
      { labelAr: 'طبيعي', minutes: 1, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [150, 190], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'تجاوز 340 — معلَّق (أول دقيقتين)', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [350, 420], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'استمرار التجاوز — يتأكد الآن', minutes: 4, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [350, 420], visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'pm10-suspension-30min',
    titleAr: 'PM10 — تعليق نشاط بعد 30 دقيقة',
    descriptionAr: 'استمرار PM10 عند حد التحذير (≥251) فأكثر لمدة 30 دقيقة متواصلة — تعليق كامل للنشاط (RCRC-PM10-30M-SUSPENSION-012). سيناريو طويل (~34 دقيقة فعلية).',
    targetRuleAr: 'RCRC-PM10-30M-SUSPENSION-012',
    stages: [
      { labelAr: 'طبيعي', minutes: 1, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [150, 190], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'تحذير مستمر (≥251) — 32 دقيقة', minutes: 32, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [255, 300], visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'violation-then-resume-hold',
    titleAr: 'مخالفة مؤكَّدة ثم استئناف مع فترة استقرار',
    descriptionAr: 'مخالفة PM10 مؤكَّدة (>340 لأكثر من دقيقتين)، ثم عودة لنطاق مسموح — يبقى القرار موقوفاً حتى تستقر القراءة الجيدة 10 دقائق (RESUME-STABILITY-HOLD) قبل عرض ALLOW فعلياً.',
    targetRuleAr: 'PM10-VIOLATION-STOP-006 → RESUME-STABILITY-HOLD → ALLOW',
    stages: [
      { labelAr: 'مخالفة مؤكَّدة (>340)', minutes: 5, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [350, 450], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'نطاق مسموح — بانتظار استقرار 10 دقائق', minutes: 13, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [150, 200], visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'critical-visibility-mandatory-stop',
    titleAr: 'رؤية حرجة — إيقاف إلزامي فوري',
    descriptionAr: 'رؤية منعدمة تقريباً (خطر فيزيائي مباشر) — إيقاف إلزامي فوري (GATE-DVI-002) بلا انتظار استمرار، بخلاف مسار PM10 المعلَّق.',
    targetRuleAr: 'GATE-DVI-002 (رؤية)',
    stages: [
      { labelAr: 'رؤية طبيعية', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'رؤية حرجة (<500م)', minutes: 3, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: [100, 400] },
    ],
  },
  {
    id: 'clean-allow-baseline',
    titleAr: 'خط أساس — مسموح نظيف',
    descriptionAr: 'كل القراءات ضمن الحدود الطبيعية — لا قواعد تُفعَّل، القرار ALLOW نظيف (لتأكيد عدم وجود إيجابيات كاذبة).',
    targetRuleAr: 'ALLOW (بلا قواعد)',
    stages: [
      { labelAr: 'طبيعي مستقر', minutes: 5, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: NORMAL_PM10, visibilityM: CLEAR_VISIBILITY },
    ],
  },
  {
    id: 'full-ladder',
    titleAr: 'السلّم الكامل — من الطبيعي حتى المخالفة المؤكَّدة',
    descriptionAr: 'يمر تصاعدياً بكل نطاقات PM10 الخمسة بالتتابع (طبيعي → احتراز → تحذير → تقييد شديد → مخالفة مؤكَّدة) — لمراجعة تصاعد القرار خطوة بخطوة.',
    targetRuleAr: 'كل نطاقات pm10ThresholdRule بالتتابع',
    stages: [
      { labelAr: 'طبيعي (≤200)', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [150, 190], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'احتراز (201-250)', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [210, 245], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'تحذير (251-320)', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [260, 310], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'تقييد شديد (321-340)', minutes: 2, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [325, 339], visibilityM: CLEAR_VISIBILITY },
      { labelAr: 'مخالفة مؤكَّدة (>340)', minutes: 4, windSpeedKmh: CALM_WIND, windGustKmh: CALM_GUST, pm10: [350, 420], visibilityM: CLEAR_VISIBILITY },
    ],
  },
];

export function findDustScenario(id: string): DustScenarioDefinition | undefined {
  return DUST_SCENARIOS.find((s) => s.id === id);
}

export function scenarioTotalMinutes(scenario: DustScenarioDefinition): number {
  return scenario.stages.reduce((sum, s) => sum + s.minutes, 0);
}
