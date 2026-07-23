// AddActivityModal/types.ts
// أنواع خاصة بمودل إضافة الأنشطة (نسخة DCR: غبار وامتثال تنظيمي + AEI فقط،
// بلا رافعات ولا إجهاد حراري)

// 'choose': اختيار الأنشطة التنظيمية (اختيار متعدد عبر ActivityTypeStep)
// 'indicators': شاشة عرض تقييم الغبار للنشاط المختار
export type ActivityStep =
  | 'choose'
  | 'time_location' // جديد
  | 'resources'     // جديد
  | 'specific_details' // جديد
  | 'indicators'
  | 'dust';

// المؤشر الوحيد المتاح في DCR — الغبار فقط (لا رافعة ولا حرارة)
export type IndicatorTab = 'dust';

// شكل مبسّط للمشروع كما يُستخدم داخل المودل (الحقول اللي فعليًا محتاجينها هنا فقط)
export interface ProjectLite {
  id: string;
  latitude: number;
  longitude: number;
  terrain_type?: string | null;
  dust_causing_activities?: string | null;
  exposed_dust_area_size?: string | null;
  dust_mitigation_measures?: string | null;
  // أوقات دوام المشروع (HH:MM) — يُمنع إدخال نشاط خارجها. تبقى الدوام
  // الافتراضي/القديم المستخدَم فقط عند غياب ورديات (shifts) فعلية أدناه.
  work_hours_start?: string | null;
  work_hours_end?: string | null;
  // ورديات عمل حقيقية معرَّفة على مستوى المشروع (project_shifts) — إن
  // وُجدت، يختار المستخدم أي وردية يتبعها النشاط بدل الاعتماد فقط على
  // work_hours_start/end كنافذة واحدة. مصفوفة فارغة/undefined = لا ورديات.
  shifts?: { id: string; name: string; start_time: string; end_time: string }[] | null;
  // أيام العمل (معرّفات: sun..sat) — يُمنع إدخال نشاط في يوم خارجها
  work_days_list?: string[] | null;
  // منطقة المشروع الكاملة (zone) — تُستخدم لقصّ موقع النشاط داخلها فقط.
  // مشاريع قديمة بلا zone (null) تُعامل كدائرة افتراضية حول latitude/longitude.
  zone_type?: 'polygon' | 'circle' | null;
  zone_polygon?: { lat: number; lng: number }[] | null;
  zone_radius_m?: number | null;
  [key: string]: any;
}

export interface AddActivityModalProps {
  project: ProjectLite;
}
