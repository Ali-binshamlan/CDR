// =============================================================
// Riyadh Dust Compliance Engine — Rules Catalog (Reference Only)
// نسخة مرجعية ثابتة (نصوص/عتبات) لكل قواعد rulebook.ts وبوابات
// engine.ts، لعرضها في صفحة "قواعد الامتثال" الإدارية. هذا الملف لا
// يُستخدم في منطق القرار الفعلي (evaluateDustCompliance) إطلاقاً —
// القرار الحقيقي يبقى حصراً من rulebook.ts/engine.ts. أي تعديل على
// نص أو عتبة قاعدة هناك يجب أن يُعكَس هنا يدوياً حتى تبقى الصفحة
// المرجعية مطابقة لما يُطبَّق فعلياً.
// =============================================================

import { RULEBOOK_VERSION } from './rulebook';
import type { DustComplianceDecisionCategory } from './types';

export interface RuleCatalogEntry {
  code: string;
  severity: DustComplianceDecisionCategory;
  messageAr: string;
  actionAr: string;
  /** ملاحظة سياق اختيارية: عتبة رقمية، مصدر تنظيمي، أو شرط تفعيل مختصر */
  noteAr?: string;
}

export interface RuleCatalogSection {
  id: string;
  titleAr: string;
  descriptionAr?: string;
  rules: RuleCatalogEntry[];
}

export { RULEBOOK_VERSION };

export const DUST_RULES_CATALOG: RuleCatalogSection[] = [
  {
    id: 'gates',
    titleAr: 'بوابات الأولوية القصوى (تُفحص أولاً على كل نشاط)',
    descriptionAr: 'تُطبَّق بصرف النظر عن النشاط التنظيمي المحدد — أي منها يكفي وحده لإصدار القرار الأشد.',
    rules: [
      {
        code: 'GATE-DMP-001',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي: نشاط غبار نشط/مخطط بلا موافقة معتمدة على خطة إدارة الغبار (DMP)',
        actionAr: 'أوقف النشاط حتى تصدر موافقة معتمدة على خطة إدارة الغبار (DMP) من الجهة المختصة',
        noteAr: 'لا تُطبَّق إن كانت حالة DMP غير معروفة (UNKNOWN) — تمنع القرار الأخضر بدل فرض إيقاف كاذب',
      },
      {
        code: 'GATE-DVI-002',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي تنظيمي: تجاوز خطر فوري في تركيز الغبار أو انعدام الرؤية بموقع النشاط — النص المعروض فعلياً يستبدل هذه الجملة بسبب DVI المحدَّد (مثال: PM10 = ...) عند توفره',
        actionAr: 'أخلِ منطقة العمل وانتظر تحسّن حالة الجو (الرؤية وتركيز الغبار) — لا يمكن استئناف العمل بإجراء تنظيمي',
        noteAr: 'مصدر العتبة الفيزيائي محرك DVI (قياس مباشر للرؤية/تركيز الغبار)، والقرار الناتج ملزم تنظيمياً بنفس درجة بقية بوابات هذا القسم',
      },
      {
        code: 'GATE-SUPPRESSION-003',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي: نظام تثبيط الغبار غير عامل على نشاط مولّد للغبار',
        actionAr: 'أعد تشغيل نظام تثبيط الغبار وتحقق من عمله فعلياً قبل استئناف النشاط',
      },
      {
        code: 'GATE-WIND-ABOVE-25-004',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'إيقاف الأنشطة المكشوفة المولّدة للغبار: سرعة الرياح تتجاوز 25 كم/س',
        actionAr: 'أوقف الأنشطة المكشوفة وأمّن المواد السائبة، وانتظر انخفاض سرعة الرياح إلى ما دون 25 كم/س',
        noteAr: 'تُستثنى العمليات المغلقة (isEnclosedOperation)؛ محطة الخلط (BATCHING_PLANT) تحديداً تحتاج أيضاً كفاءة فلتر PM10 ≥ 99%',
      },
      {
        code: 'GATE-WIND-15-25-ENHANCED-005',
        severity: 'ALLOW_WITH_CONTROLS',
        messageAr: 'تثبيط معزز مطلوب: سرعة الرياح بين 15-25 كم/س',
        actionAr: 'فعّل الرش الساعي، غطِّ الأكوام، اخفض ارتفاع التفريغ إلى متر واحد، وشدّد تنظيف الطرق وغسيل الإطارات',
        noteAr: 'لا تُطبَّق على العمليات المغلقة أو غير المولّدة للغبار',
      },
      {
        code: 'GATE-WIND-GUST-SAFETY',
        severity: 'ALLOW_WITH_CONTROLS',
        messageAr: 'هبة رياح قوية عابرة — احتراز سلامة إضافي، ليست مخالفة بموجب بروتوكول الملحق أ',
        actionAr: 'أمّن المواد السائبة والمعدات الخفيفة فوراً حتى تهدأ الهبة، وراقب استقرار سرعة الرياح المستدامة',
        noteAr: 'لا تُطبَّق على العمليات المغلقة أو غير المولّدة للغبار',
      },
    ],
  },
  {
    id: 'pm10',
    titleAr: 'حدود PM10 التنظيمية العامة',
    descriptionAr: 'مستقلة عن بوابات DVI الفيزيائية — عتبات رسمية من الدليل التنظيمي مباشرة.',
    rules: [
      {
        code: 'PM10-PRECAUTION-009',
        severity: 'PRECAUTION',
        messageAr: 'حالة احتراز: تركيز PM10 ضمن نطاق الإنذار المبكر (151-250 ميكروجرام/م³)',
        actionAr: 'زِد وتيرة المراقبة ومتابعة القراءة — لا يتطلب إجراءً تصحيحياً فورياً ما لم يستمر الارتفاع',
      },
      {
        code: 'PM10-WARNING-008',
        severity: 'ALLOW_WITH_CONTROLS',
        messageAr: 'تحذير: تركيز PM10 تجاوز حد التحذير (251-320 ميكروجرام/م³)',
        actionAr: 'فعّل التثبيط المعزز (رش ساعي، تغطية الأكوام) وراقب التركيز عن كثب',
      },
      {
        code: 'PM10-RED-RESTRICT-010',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'تقييد شديد: تركيز PM10 ضمن النطاق الأحمر (321-340 ميكروجرام/م³)',
        actionAr: 'فعّل التثبيط المعزز فوراً وقلّص واجهات العمل استعداداً لاحتمال بلوغ حد المخالفة',
      },
      {
        code: 'PM10-VIOLATION-STOP-006',
        severity: 'MANDATORY_STOP',
        messageAr: 'مخالفة تنظيمية مؤكدة: تركيز PM10 تجاوز حد المخالفة (340 ميكروجرام/م³) لأكثر من دقيقتين متتاليتين',
        actionAr: 'أوقف النشاط المسبب للغبار فوراً وفعّل إجراءات التصحيح (تقليل واجهات العمل، خفض ارتفاع التفريغ، تقييد حركة الشاحنات، زيادة الرش) حتى يزول التجاوز — إيقاف إلزامي غير قابل للتجاوز',
        noteAr: 'يتطلب استمرار القراءة ≥340 لأكثر من دقيقتين متتاليتين بمصدر جهاز حي؛ قبل ذلك يُصنَّف MRQ-PM10-BLACK-PENDING-104 (معلَّق)',
      },
      {
        code: 'MRQ-PM10-BLACK-PENDING-104',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'تعليق مؤقت (معلَّق): تركيز PM10 تجاوز حد المخالفة (340 ميكروجرام/م³) — بانتظار استمرار القراءة أكثر من دقيقتين',
        actionAr: 'أوقف النشاط فوراً احترازياً وراقب استمرار القراءة — سيُصبح إيقافاً إلزامياً غير قابل للتجاوز إن استمر التجاوز أكثر من دقيقتين',
      },
      {
        code: 'RCRC-PM10-30M-SUSPENSION-012',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'تعليق النشاط: تركيز PM10 استمر عند 250 ميكروجرام/م³ أو أكثر لمدة 30 دقيقة متواصلة',
        actionAr: 'علّق النشاط المسبب للغبار حتى ينخفض التركيز ويستقر دون الحد لفترة كافية، وفعّل التثبيط المعزز فوراً',
        noteAr: 'مستقلة عن PM10-VIOLATION-STOP-006/MRQ-PM10-BLACK-PENDING-104 — قد تتحقق معاً، ويُختار الأشد',
      },
    ],
  },
  {
    id: 'earthworks',
    titleAr: 'أعمال الحفر والترابية (EARTHWORKS)',
    rules: [
      {
        code: 'EARTHWORKS-DROP-002',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'ارتفاع تفريغ التربة يتجاوز الحد المسموح أثناء الرياح النشطة (1 م)',
        actionAr: 'خفّض ارتفاع تفريغ التربة إلى 1 م أو أقل طوال فترة الرياح النشطة',
        noteAr: 'يُطبَّق عند رياح ≥15 كم/س',
      },
      {
        code: 'EARTHWORKS-DROP-003',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'ارتفاع تفريغ التربة يتجاوز الحد الاعتيادي (1.5 م)',
        actionAr: 'خفّض ارتفاع تفريغ التربة إلى 1.5 م أو أقل',
        noteAr: 'يُطبَّق عند رياح أقل من 15 كم/س',
      },
    ],
  },
  {
    id: 'demolition',
    titleAr: 'الهدم والترميم (DEMOLITION)',
    rules: [
      {
        code: 'DEMO-WIND-STOP-001',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي: أعمال هدم مكشوفة أثناء رياح ≥15 كم/س (الحد الأقصى التنظيمي 15 كم/س لأعمال الهدم)',
        actionAr: 'أوقف أعمال الهدم المكشوفة فوراً حتى تنخفض سرعة الرياح إلى ما دون 15 كم/س، أو حوّلها لعملية مغلقة',
      },
      {
        code: 'DEMO-AREA-002',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'مساحة الهدم النشطة تتجاوز الحد المسموح (100 م² في المرة الواحدة)',
        actionAr: 'قسّم أعمال الهدم إلى مراحل بحيث لا تتجاوز المساحة النشطة 100 م² في المرة الواحدة',
      },
    ],
  },
  {
    id: 'crusher',
    titleAr: 'الكسارة (CRUSHER)',
    rules: [
      {
        code: 'CRUSHER-CATEGORY-001',
        severity: 'MANDATORY_STOP',
        messageAr: 'الكسارات مسموحة فقط في مشاريع الفئة الثالثة (عالية المخاطر)',
        actionAr: 'أوقف تشغيل الكسارة — غير مسموح بها إلا في مشاريع الفئة الثالثة (عالية المخاطر)',
      },
      {
        code: 'CRUSHER-DISTANCE-200-002B',
        severity: 'MANDATORY_STOP',
        messageAr: 'مسافة الكسارة عن أقرب مستقبل حساس أقل من الحد الأدنى (200 م)',
        actionAr: 'أوقف تشغيل الكسارة أو انقلها لمسافة لا تقل عن 200 م عن أقرب مستقبل حساس',
        noteAr: 'المسافة تُحسب تلقائياً (Haversine) من موقع الكسارة على الخريطة؛ الحقل اليدوي احتياطي فقط عند غياب الموقع',
      },
      {
        code: 'CRUSHER-DISTANCE-500-002C',
        severity: 'MANDATORY_STOP',
        messageAr: 'مسافة الكسارة عن سكني/مدارس/مستشفيات أقل من الحد الأدنى (500 م)',
        actionAr: 'أوقف تشغيل الكسارة أو انقلها لمسافة لا تقل عن 500 م عن أقرب منطقة سكنية/مدرسة/مستشفى',
        noteAr: 'نفس مبدأ الحساب التلقائي أعلاه، لمستقبِلات سكني/مدرسي/صحي تحديداً',
      },
      {
        code: 'MRQ-RECEPTOR-DOWNWIND-120',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'تصعيد الاستجابة: مستقبِل حساس (سكني/مدرسي/صحي) يقع فعلياً باتجاه هبوب الرياح الحالي من الكسارة',
        actionAr: 'قيّد تشغيل الكسارة وزد إجراءات التثبيط فوراً طالما استمر اتجاه الرياح نحو المستقبِل الحساس، حتى يتغيّر الاتجاه أو تنخفض شدة النشاط',
        noteAr: 'لا يتكرر مع CRUSHER-DISTANCE-500-002C — تلك تفحص أقرب مستقبِل بصرف النظر عن الاتجاه؛ هذه تفحص اتجاه الرياح تحديداً (تصعيد إضافي، لا مخالفة مسافة مستقلة)',
      },
    ],
  },
  {
    id: 'batching',
    titleAr: 'محطة خلط الخرسانة (BATCHING_PLANT)',
    rules: [
      {
        code: 'BATCHING-SILO-001',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي: صوامع الإسمنت غير محكمة الإغلاق',
        actionAr: 'أوقف التشغيل حتى يتم إحكام إغلاق صوامع الإسمنت بالكامل',
      },
      {
        code: 'BATCHING-FILTER-002',
        severity: 'MANDATORY_STOP',
        messageAr: 'كفاءة فلتر الجسيمات العالقة أقل من الحد الأدنى (99%)',
        actionAr: 'استبدل أو اصلح فلتر الجسيمات العالقة حتى تصل كفاءته إلى 99% على الأقل',
        noteAr: 'نفس حد الكفاءة (99%) مطلوب أيضاً لإعفاء محطة الخلط المغلقة من بوابة رياح >25 كم/س',
      },
      {
        code: 'BATCHING-LEAK-003',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'تسرب مرصود من صومعة الإسمنت أو نظام النقل',
        actionAr: 'أصلح مصدر التسرب في الصومعة أو نظام النقل فوراً',
      },
      {
        code: 'BATCHING-DRYCLEAN-004',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'استخدام الكنس الجاف أو النفخ بالهواء المضغوط ممنوع؛ يلزم الشفط أو التنظيف الرطب',
        actionAr: 'استبدل الكنس الجاف/الهواء المضغوط بالشفط أو التنظيف الرطب',
      },
      {
        code: 'BATCHING-SUPPRESSION-005',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'نظام تثبيط الغبار غير مُشغَّل عند محطة الخلط',
        actionAr: 'شغّل نظام تثبيط الغبار عند محطة الخلط قبل الاستئناف',
      },
      {
        code: 'BATCHING-DISTANCE-MISSING',
        severity: 'FIELD_VERIFICATION_REQUIRED',
        messageAr: 'تعذر إثبات مسافة محطة الخلط عن أقرب مستقبل حساس (لا إحداثيات مُدخلة لموقع المحطة)',
        actionAr: 'حدّد موقع محطة الخلط على الخريطة للتحقق التلقائي من مسافتها عن أقرب مستقبِل حساس',
      },
      {
        code: 'BATCHING-DISTANCE-200',
        severity: 'MANDATORY_STOP',
        messageAr: 'مسافة محطة الخلط عن أقرب مستقبل حساس أقل من الحد الأدنى (200 م)',
        actionAr: 'أوقف تشغيل محطة الخلط أو انقلها لمسافة لا تقل عن 200 م عن أقرب مستقبِل حساس (مدرسة/مستشفى/مسجد/منطقة سكنية)',
        noteAr: 'المسافة تُحسب تلقائياً (Haversine) عند توفر موقع محطة الخلط على الخريطة',
      },
    ],
  },
  {
    id: 'stonecutting',
    titleAr: 'قطع الأحجار والصخور (STONE_CUTTING)',
    rules: [
      {
        code: 'STONECUT-WIND-STOP-003',
        severity: 'MANDATORY_STOP',
        messageAr: 'إيقاف إلزامي: قطع أحجار مكشوف أثناء رياح تتجاوز الحد المسموح (15 كم/س)',
        actionAr: 'أوقف القطع المكشوف فوراً حتى تنخفض سرعة الرياح إلى ما دون 15 كم/س، أو حوّله لتشغيل مغلق',
      },
    ],
  },
  {
    id: 'entry_exit',
    titleAr: 'نقاط الدخول والخروج (ENTRY_EXIT)',
    rules: [
      {
        code: 'ENTRY-WHEELWASH-001',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'وحدة غسيل الإطارات غير متوفرة أو غير عاملة',
        actionAr: 'شغّل وحدة غسيل الإطارات أو وفّر بديلاً عاملاً قبل السماح بخروج الشاحنات',
      },
      {
        code: 'ENTRY-TRACKOUT-002',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'أتربة منقولة مرئية تتجاوز 15 متراً من بوابة الخروج',
        actionAr: 'نظّف الأتربة المنقولة خارج البوابة فوراً وعالج سبب انتقالها',
      },
      {
        code: 'ENTRY-INSPECTION-003',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'لم يُسجَّل فحص وحدة غسيل الإطارات كل ساعة أثناء الرياح 15-25 كم/س',
        actionAr: 'سجّل فحصاً موثقاً لوحدة غسيل الإطارات كل ساعة طوال فترة الرياح 15-25 كم/س',
      },
      {
        code: 'ENTRY-POINT-MISSING-004',
        severity: 'FIELD_VERIFICATION_REQUIRED',
        messageAr: 'لم يتم تحديد نقطة دخول المشروع على الخريطة',
        actionAr: 'حدّد نقطة دخول المشروع على الخريطة في بيانات النشاط',
      },
      {
        code: 'ENTRY-EXITPOINT-MISSING-005',
        severity: 'FIELD_VERIFICATION_REQUIRED',
        messageAr: 'لم يتم تحديد نقطة خروج المشروع على الخريطة',
        actionAr: 'حدّد نقطة خروج المشروع على الخريطة في بيانات النشاط',
      },
      {
        code: 'ENTRY-ROADPAVED-006',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'الطريق المؤدي للمدخل غير مسفلت أو غير ممهد',
        actionAr: 'اسفلت الطريق المؤدي للمدخل أو مهّده بمادة تمنع تطاير الغبار',
      },
      {
        code: 'ENTRY-SANDTRAP-007',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'لا توجد مصيدة رمال في وحدة غسيل الإطارات',
        actionAr: 'ركّب مصيدة رمال في وحدة غسيل الإطارات',
        noteAr: 'فرع "وحدة غسيل" (WHEEL_WASH) فقط',
      },
      {
        code: 'ENTRY-OILSEP-008',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'لا يوجد فاصل زيوت في وحدة غسيل الإطارات',
        actionAr: 'ركّب فاصل زيوت في وحدة غسيل الإطارات',
        noteAr: 'فرع "وحدة غسيل" (WHEEL_WASH) فقط',
      },
      {
        code: 'ENTRY-WASHCYCLE-009',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'مدة دورة غسيل الإطارات أقل من 20 ثانية لكل محور',
        actionAr: 'اضبط مدة دورة الغسيل على 20 ثانية على الأقل لكل محور',
        noteAr: 'فرع "وحدة غسيل" (WHEEL_WASH) فقط',
      },
      {
        code: 'ENTRY-WASHREUSE-010',
        severity: 'ALLOW_WITH_CONTROLS',
        messageAr: 'يُفضَّل إعادة استخدام مياه غسيل الإطارات',
        actionAr: 'أضف نظام إعادة استخدام لمياه غسيل الإطارات',
        noteAr: 'فرع "وحدة غسيل" (WHEEL_WASH) فقط',
      },
      {
        code: 'ENTRY-IMMERSION-MESH-011',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'لا توجد شبكة مانعة للانزلاق في منطقة غمر الإطارات',
        actionAr: 'ركّب شبكة مانعة للانزلاق في منطقة غمر الإطارات',
        noteAr: 'فرع "غمر بالمياه" (WATER_IMMERSION) فقط',
      },
      {
        code: 'ENTRY-IMMERSION-LENGTH-012',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'طول منطقة غمر الإطارات أقل من 8 أمتار',
        actionAr: 'وسّع منطقة غمر الإطارات إلى 8 أمتار على الأقل',
        noteAr: 'فرع "غمر بالمياه" (WATER_IMMERSION) فقط',
      },
      {
        code: 'ENTRY-BASIN-013',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'لا يوجد حوض سفلي لتجميع مخلفات غمر الإطارات',
        actionAr: 'أنشئ حوضاً سفلياً لتجميع مخلفات غمر الإطارات',
        noteAr: 'فرع "غمر بالمياه" (WATER_IMMERSION) فقط',
      },
      {
        code: 'ENTRY-PATHCLEAN-014',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'لم يتم تنظيف مسار الشاحنات خلال 15 دقيقة',
        actionAr: 'نظّف مسار الشاحنات خلال 15 دقيقة من كل عملية عبور',
      },
      {
        code: 'ENTRY-WATERTRACE-015',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'آثار مياه أو مخلفات ظاهرة على بعد 15 متراً من البوابة',
        actionAr: 'أزل آثار المياه والمخلفات حول البوابة وقلّل كمية المياه المستخدمة في الغسيل',
      },
    ],
  },
  {
    id: 'site_traffic',
    titleAr: 'حركة الشاحنات والطرق الداخلية (SITE_TRAFFIC)',
    rules: [
      {
        code: 'TRAFFIC-LOAD-004',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'حمولة نقل التربة/المواد غير مغطاة — يُمنع خروج أي شاحنة بحمولة مكشوفة من الموقع',
        actionAr: 'أوقف خروج الشاحنات حتى يتم تغطية الحمولة بالكامل، والتزم بتغطية كل حمولة لاحقة قبل الخروج',
      },
      {
        code: 'TRAFFIC-UNPAVED-002',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'سرعة الطرق غير المسفلتة تتجاوز الحد (10 كم/س)',
        actionAr: 'اخفض السرعة على الطرق غير المسفلتة إلى 10 كم/س أو أقل',
      },
      {
        code: 'TRAFFIC-PAVED-003',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'سرعة الطرق المسفلتة تتجاوز الحد (20 كم/س)',
        actionAr: 'اخفض السرعة على الطرق المسفلتة إلى 20 كم/س أو أقل',
      },
      {
        code: 'TRAFFIC-SPILL-005',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'تنظيف المواد المنسكبة تجاوز الحد الزمني (15 دقيقة)',
        actionAr: 'قلّص زمن تنظيف المواد المنسكبة إلى 15 دقيقة أو أقل',
      },
    ],
  },
  {
    id: 'cd_waste',
    titleAr: 'نقل مخلفات الهدم والبناء (CD_WASTE_TRANSPORT)',
    rules: [
      {
        code: 'CDWASTE-PILEHEIGHT-003',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'ارتفاع أكوام المخلفات يتجاوز الحد (3 م)',
        actionAr: 'اخفض ارتفاع أكوام المخلفات إلى 3 م أو أقل',
      },
    ],
  },
  {
    id: 'stockpile',
    titleAr: 'الأكوام والمناولة (MATERIAL_HANDLING_STOCKPILE)',
    rules: [
      {
        code: 'STOCKPILE-HEIGHT-001',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'ارتفاع الأكوام يتجاوز الحد المسموح لفئة المشروع',
        actionAr: 'اخفض ارتفاع الأكوام إلى الحد المسموح لفئة المشروع',
        noteAr: 'الحد: 1 م للفئة الأولى، 3 م للفئتين الثانية والثالثة',
      },
      {
        code: 'STOCKPILE-DISTANCE-002',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'مسافة الأكوام/محطة الخلط من المستقبِل الحساس أقل من الحد المسموح (200 م)',
        actionAr: 'انقل الأكوام/محطة الخلط إلى مسافة لا تقل عن 200 م عن أقرب مستقبل حساس',
        noteAr: 'المسافة تُحسب تلقائياً (Haversine) عند توفر موقع الأكوام على الخريطة',
      },
      {
        code: 'STOCKPILE-DROP-004',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'ارتفاع تفريغ المواد يتجاوز الحد المسموح أثناء الرياح النشطة (1 م)',
        actionAr: 'خفّض ارتفاع تفريغ المواد إلى 1 م أو أقل طوال فترة الرياح النشطة',
        noteAr: 'يُطبَّق عند رياح ≥15 كم/س',
      },
      {
        code: 'STOCKPILE-DROP-005',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'ارتفاع تفريغ المواد يتجاوز الحد الاعتيادي (1.5 م)',
        actionAr: 'خفّض ارتفاع تفريغ المواد إلى 1.5 م أو أقل',
        noteAr: 'يُطبَّق عند رياح أقل من 15 كم/س',
      },
    ],
  },
  {
    id: 'idle_surface',
    titleAr: 'الأسطح المكشوفة غير النشطة (IDLE_SURFACE)',
    rules: [
      {
        code: 'IDLE-STABILIZE-001',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'سطح غير نشط لأكثر من 5 أيام دون تثبيت',
        actionAr: 'ثبّت السطح غير النشط بمواد تثبيت أو أغطية واقية',
      },
      {
        code: 'IDLE-COVER-002',
        severity: 'RESTRICT_ACTIVITY',
        messageAr: 'غطاء السطح غير النشط غير سليم أو تالف',
        actionAr: 'أصلح أو استبدل غطاء السطح غير النشط التالف',
      },
      {
        code: 'IDLE-COVER-WIND-003',
        severity: 'FIELD_VERIFICATION_REQUIRED',
        messageAr: 'رياح تجاوزت 20 كم/س — يلزم فحص أغطية الأسطح غير النشطة وإصلاحها فوراً',
        actionAr: 'انزل للموقع وافحص أغطية الأسطح غير النشطة الآن، وأصلح أي غطاء تضرر من الرياح',
      },
    ],
  },
  {
    id: 'decision_layer',
    titleAr: 'قواعد القرار العامة (بعد تقييم القواعد أعلاه)',
    descriptionAr: 'تُفحص بعد كل قواعد الأنشطة أعلاه — تُطبَّق بناءً على القرار المحسوب أو حالة الاستئناف/الثقة، لا على نشاط تنظيمي محدد.',
    rules: [
      {
        code: 'GATE-WIND-ABOVE-25-RESUME-HOLD',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'الإيقاف السابق كان بسبب رياح تجاوزت 25 كم/س — الاستئناف يتطلب انخفاضها إلى ما دون 25 كم/س صراحة، لا مجرد العودة إلى 25 بالضبط',
        actionAr: 'انتظر انخفاض سرعة الرياح إلى ما دون 25 كم/س صراحة قبل الاستئناف',
        noteAr: 'غير قابلة للتجاوز — تُطبَّق فقط إن كان الإيقاف السابق ناتجاً عن GATE-WIND-ABOVE-25-004 تحديداً',
      },
      {
        code: 'RESUME-STABILITY-HOLD',
        severity: 'STOP_AFFECTED_ACTIVITY',
        messageAr: 'الظروف تحسّنت لكن لم يمضِ وقت كافٍ على استقرارها بعد آخر إيقاف — بانتظار استقرار القراءة (10 دقائق) قبل الاستئناف',
        actionAr: 'أبقِ النشاط موقوفاً حتى تستقر القراءة الجيدة لمدة 10 دقائق متواصلة قبل الاستئناف',
        noteAr: 'قابلة للتجاوز (احترازية زمنية بحتة، لا مخالفة تنظيمية مؤكَّدة) — تُطبَّق فقط بعد قرار سابق موقِف (MANDATORY_STOP أو STOP_AFFECTED_ACTIVITY)',
      },
      {
        code: 'LOW-CONFIDENCE-VERIFICATION',
        severity: 'FIELD_VERIFICATION_REQUIRED',
        messageAr: 'مستوى الثقة في القرار أقل من الحد الأدنى المطلوب للسماح التلقائي (70)',
        actionAr: 'راجع البيانات الناقصة/غير المؤكدة ميدانياً قبل اعتماد القرار كسماح كامل',
        noteAr: 'تُطبَّق فقط حين يكون القرار المحسوب ALLOW مع ثقة أقل من 70 — لا تُخفِّض قراراً أشد قائماً',
      },
    ],
  },
];

export const SEVERITY_LABEL_AR: Record<DustComplianceDecisionCategory, string> = {
  ALLOW: 'مسموح',
  PRECAUTION: 'احتراز — زيادة المراقبة',
  ALLOW_WITH_CONTROLS: 'مسموح مع ضوابط',
  FIELD_VERIFICATION_REQUIRED: 'يتطلب تحقق ميداني',
  RESTRICT_ACTIVITY: 'تقييد النشاط',
  STOP_AFFECTED_ACTIVITY: 'إيقاف النشاط المتأثر',
  MANDATORY_STOP: 'إيقاف إلزامي',
};
