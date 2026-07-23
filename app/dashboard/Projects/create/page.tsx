// app/dashboard/Projects/create/page.tsx
'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/app/lib/supabase';
import { apiClient } from '@/app/lib/apiClient';
import dynamic from 'next/dynamic';
import { toast } from 'react-hot-toast';
import { Gauge, AlertTriangle } from 'lucide-react';

// استيراد مكوّن رسم منطقة المشروع (zone) بالكامل ديناميكياً مع إيقاف SSR —
// يحل محل MapComponent (نقطة واحدة) بمضلع/دائرة كاملة
const ZonePicker = dynamic(() => import('@/app/components/dashborad/ZonePicker'), {
  ssr: false,
  loading: () => <div className="flex h-full w-full items-center justify-center bg-gray-200 text-[#061B40] text-sm font-semibold">جاري تحميل الخريطة...</div>
});
import type { ZonePickerValue } from '@/app/components/dashborad/ZonePicker';
import { polygonCentroid, projectZoneAreaM2, isPointInProjectZone } from '@/app/utils/geo/zone';
import { parseKmlPolygon, parseKmlPoints, KmlParseError } from '@/app/utils/geo/kml';
import { isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';

// أيام الأسبوع بمعرّفات ثابتة تطابق getDay() في JS (0=الأحد ... 6=السبت)
const WEEK_DAYS: { id: string; label: string }[] = [
  { id: 'sun', label: 'الأحد' },
  { id: 'mon', label: 'الاثنين' },
  { id: 'tue', label: 'الثلاثاء' },
  { id: 'wed', label: 'الأربعاء' },
  { id: 'thu', label: 'الخميس' },
  { id: 'fri', label: 'الجمعة' },
  { id: 'sat', label: 'السبت' },
];

// رقم هاتف من أي دولة — نعتمد على libphonenumber-js (قواعد Google
// libphonenumber الرسمية لكل الدول: طول الرقم، الصيغة، مفتاح الخط) بدل نمط
// محلي واحد. الرقم يجب أن يبدأ بمفتاح الدولة الدولي (+966، +971، +20...)
// ليُفحص بلا افتراض دولة افتراضية — رقم محلي بلا + يُرفض عمداً لأنه غامض
// (لا نعرف الدولة المقصودة).
function isValidInternationalPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('+')) return false;
  try {
    return isValidPhoneNumber(trimmed);
  } catch {
    return false;
  }
}

export default function CreateProjectPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [submitStage, setSubmitStage] = useState<string>('');
  // يصبح true بعد أول محاولة حفظ — يُستخدم لتلوين حدود الحقول الإلزامية
  // الفارغة بالأحمر دون إزعاج المستخدم بها قبل أن يحاول الحفظ فعلياً
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  // رقم التواصل مقصور على السعودية (+966 ثابت، لا قائمة دول) — الرقم
  // المحلي المُدخَل هنا يُدمج مع مفتاح +966 لبناء projectForm.contact_number
  // الكامل (E.164) عند الحفظ.
  const [contactLocalNumber, setContactLocalNumber] = useState('');

  // بيانات المشروع الأساسية فقط
  const [projectForm, setProjectForm] = useState({
    name: '',
    client_name: '',
    city: '',
    neighborhood: '',
    project_status: 'not_started' as 'not_started' | 'in_progress',
    project_type: 'أبراج وإنشاءات',
    site_nature: '',
    // طبيعة الأرض (نوع التربة) — قائمة اختيار محددة بدل النص الحر القديم
    soil_type: '' as '' | 'SANDY_FINE' | 'SANDY_COARSE' | 'CLAY' | 'MIXED',
    latitude: 24.7136,
    longitude: 46.6753,
    terrain_type: 'suburban',

    // بيانات الموقع الإضافية (حسب مخطط صفحة تفاصيل المشروع)
    site_location_nature: '',
    wind_exposure: 'medium',

    // الجدولة والعمل
    start_date: '',
    end_date: '',
    work_days: 'الأحد - الخميس',
    work_days_list: ['sun', 'mon', 'tue', 'wed', 'thu'] as string[],
    work_hours_start: '07:00',
    work_hours_end: '17:00',
    project_manager: '',
    contact_number: '',

    // ملف امتثال الغبار التنظيمي (اختياري) — يُستخدم لتصنيف فئة مخاطر
    // المشروع (الفئة 1/2/3) في محرك الامتثال التنظيمي للرياض. اتركها فارغة
    // إن لم تُعرف بعد؛ نقص البيانات يُعالَج كـ "غير مصنَّف" وليس فئة منخفضة.
    site_area_m2: '' as string | number,
    daily_truck_movements: '' as string | number,
    has_onsite_crusher: false,
    has_onsite_batching_plant: false,
    // حالة خطة إدارة الغبار (DMP) — تُعرض للمستخدم بمصطلحين واضحين فقط
    // ("لديه خطة" / "ليس لديه خطة بعد")، لكنها تبقى داخلياً بنفس القيم
    // التي يفهمها محرك الامتثال (dmpApprovalStatus): UNKNOWN لا يوقف شيئاً
    // (حقل لم يُملأ بعد لمشروع لم يبدأ)، APPROVED لا يوقف، وأي قيمة أخرى
    // (NOT_STARTED هنا) توقف النشاط فعلياً إن كان المشروع "جاري".
    dmp_approval_status: 'UNKNOWN' as
      | 'NOT_REQUIRED' | 'NOT_STARTED' | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'UNKNOWN',
    monitoring_station_count: '' as string | number,

    // إقرار المستخدم بصحة البيانات وتحمّل المسؤولية الكاملة عنها
    data_accuracy_confirmed: false,
  });

  // مساحة الموقع — تُحسب تلقائياً من منطقة المشروع المرسومة (KML)، لكن
  // تبقى قابلة للتعديل اليدوي إن اختلفت المساحة الفعلية عن المحسوبة.
  const [siteAreaAutoFilled, setSiteAreaAutoFilled] = useState(false);

  // مواقع محطات رصد الغبار — نقطة واحدة لكل محطة، تُدخَل يدوياً (رقمين)
  // أو تُستورد دفعة واحدة من ملف KML يحتوي نقاطاً (Placemark من نوع Point).
  interface MonitoringStation { lat: string; lng: string; label: string }
  const [monitoringStations, setMonitoringStations] = useState<MonitoringStation[]>([]);

  // ورديات عمل حقيقية (اختياري) — إضافية بحتة على "بداية/نهاية الدوام"
  // أعلاه، اللذين يبقيان الدوام الافتراضي لمشروع لا يريد ورديات متعددة.
  // بلا ورديات معرَّفة هنا، يسلك كل شيء (AddActivityModal ومحركا الغبار/
  // الحرارة) بالضبط المسار القديم (نافذة work_hours واحدة).
  interface ProjectShiftForm { name: string; start_time: string; end_time: string }
  const [shifts, setShifts] = useState<ProjectShiftForm[]>([]);
  const addShift = () => setShifts((prev) => [...prev, { name: '', start_time: '', end_time: '' }]);
  const removeShift = (index: number) => setShifts((prev) => prev.filter((_, i) => i !== index));
  const updateShift = (index: number, field: keyof ProjectShiftForm, value: string) => {
    setShifts((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };

  // تحقق ورديات العمل — كل صف بدأ المستخدم بتعبئته يصبح إلزامي الحقول
  // الثلاثة (لا يُحفظ صف ناقص بصمت)، ونهاية الوردية يجب أن تكون بعد بدايتها
  // (لا ورديات عابرة لمنتصف الليل في هذا الإصدار، نفس قيد work_hours الحالي).
  // كل وردية يجب أن تقع بالكامل ضمن نطاق الدوام الرسمي (بداية/نهاية الدوام
  // أعلاه) — الورديات تفصيل لساعات العمل ضمن الدوام المعتمد، لا توسيع له؛
  // بلا هذا القيد يمكن تسجيل وردية 04:00-22:00 رغم أن الدوام الرسمي
  // 07:00-17:00 فقط، فتفقد "بداية/نهاية الدوام" معناها كحد أعلى فعلي.
  const validateShifts = (): string[] => {
    const errors: string[] = [];
    const officialStart = projectForm.work_hours_start;
    const officialEnd = projectForm.work_hours_end;
    shifts.forEach((s, i) => {
      const hasAny = s.name.trim() || s.start_time || s.end_time;
      if (!hasAny) return;
      if (!s.name.trim() || !s.start_time || !s.end_time) {
        errors.push(`الوردية ${i + 1}: أكمل الاسم ووقتي البداية والنهاية، أو احذف الصف.`);
        return;
      }
      if (s.end_time <= s.start_time) {
        errors.push(`الوردية ${i + 1} ("${s.name}"): وقت النهاية يجب أن يكون بعد وقت البداية (لا وردية تمتد لليوم التالي).`);
        return;
      }
      if (officialStart && officialEnd && (s.start_time < officialStart || s.end_time > officialEnd)) {
        errors.push(`الوردية ${i + 1} ("${s.name}"): يجب أن تقع ضمن نطاق الدوام الرسمي (${officialStart.slice(0, 5)} – ${officialEnd.slice(0, 5)}).`);
      }
    });
    return errors;
  };

  // منطقة المشروع الكاملة (zone) — مضلع أو دائرة، بدل نقطة واحدة فقط.
  // latitude/longitude في projectForm أعلاه يبقيان كـ"نقطة تمثيلية"
  // (centroid المضلع أو مركز الدائرة) لأن كل الكود الحالي (محركات
  // الحرارة/الغبار/الرافعات، جلب الطقس) يعتمد عليهما مباشرة.
  const [zoneValue, setZoneValue] = useState<ZonePickerValue>({
    zoneType: 'point',
    polygon: null,
    circleCenter: null,
    circleRadiusM: null,
  });

  // عند تغيّر المنطقة المرسومة: نحدّث latitude/longitude كنقطة تمثيلية،
  // ونجلب المدينة/الحي تلقائياً (نفس سلوك النقر السابق على الخريطة)، ونملأ
  // مساحة الموقع تلقائياً من هندسة المنطقة (إلا إن عدّلها المستخدم يدوياً)
  const handleZoneChange = async (value: ZonePickerValue) => {
    setZoneValue(value);

    const areaM2 = projectZoneAreaM2(value);
    if (areaM2 !== null) {
      setProjectForm((prev) =>
        // لا نستبدل قيمة أدخلها المستخدم يدوياً بنفسه بعد آخر تعبئة تلقائية
        siteAreaAutoFilled || prev.site_area_m2 === ''
          ? { ...prev, site_area_m2: Math.round(areaM2) }
          : prev
      );
      setSiteAreaAutoFilled(true);
    }

    let repLat: number | null = null;
    let repLng: number | null = null;
    if (value.zoneType === 'polygon' && value.polygon && value.polygon.length >= 3) {
      const c = polygonCentroid(value.polygon);
      repLat = c.lat;
      repLng = c.lng;
    } else if (value.zoneType === 'circle' && value.circleCenter) {
      repLat = value.circleCenter.lat;
      repLng = value.circleCenter.lng;
    }
    if (repLat === null || repLng === null) return;

    const newLat = Number(repLat.toFixed(6));
    const newLng = Number(repLng.toFixed(6));
    setProjectForm((prev) => ({ ...prev, latitude: newLat, longitude: newLng }));

    try {
      const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${newLat}&lon=${newLng}&accept-language=ar`);
      if (!response.ok) throw new Error('فشل الاتصال بخدمة الخرائط');
      const data = await response.json();
      if (data && data.address) {
        const fetchedCity = data.address.city || data.address.town || data.address.village || data.address.state || '';
        const fetchedNeighborhood = data.address.neighbourhood || data.address.suburb || data.address.residential || '';
        setProjectForm((prev) => ({
          ...prev,
          city: fetchedCity || prev.city,
          neighborhood: fetchedNeighborhood || prev.neighborhood,
        }));
        if (fetchedCity) {
          toast.success(`تم التحديد في: ${fetchedCity} ${fetchedNeighborhood ? `، ${fetchedNeighborhood}` : ''}`);
        }
      }
    } catch (error) {
      console.error('🚨 فشل في جلب بيانات المدينة:', error);
      toast.error('تم تحديث المنطقة، لكن تعذّر جلب اسم المدينة تلقائياً.');
    }
  };

  // منطقة المشروع تُحدَّد حصراً عبر KML — إما رفع ملف .kml جاهز، أو لصق
  // نص KML خام مباشرة. كلا المسارين يمران بنفس دالة التحليل والمعالجة
  // (parseKmlPolygon ثم handleZoneChange) لتفادي أي ازدواجية منطق.
  const [kmlSourceName, setKmlSourceName] = useState<string | null>(null);
  const [kmlPasteText, setKmlPasteText] = useState('');

  const applyParsedKml = async (text: string, sourceLabel: string) => {
    try {
      const { polygon, name } = parseKmlPolygon(text);
      await handleZoneChange({ zoneType: 'polygon', polygon, circleCenter: null, circleRadiusM: null });
      setKmlSourceName(name || sourceLabel);
      toast.success('تم استيراد منطقة المشروع من KML بنجاح.');
    } catch (error) {
      const message = error instanceof KmlParseError ? error.message : 'تعذّر قراءة KML — تأكد أن المحتوى بصيغة صحيحة.';
      console.error('🚨 فشل استيراد KML:', error);
      toast.error(message);
    }
  };

  const handleKmlUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // يسمح برفع نفس الملف مرة أخرى إن احتاج المستخدم
    if (!file) return;
    const text = await file.text();
    await applyParsedKml(text, file.name);
  };

  const handleKmlPasteSubmit = async () => {
    if (!kmlPasteText.trim()) {
      toast.error('الصق نص KML أولاً.');
      return;
    }
    await applyParsedKml(kmlPasteText, 'نص KML ملصوق');
  };

  // تبديل يوم عمل واحد (checkbox) — يبني أيضاً النص العربي work_days
  // للتوافق مع أي عرض قديم يعتمد عليه
  const toggleWorkDay = (dayId: string) => {
    setProjectForm((prev) => {
      const list = prev.work_days_list.includes(dayId)
        ? prev.work_days_list.filter((d) => d !== dayId)
        : [...prev.work_days_list, dayId];
      // نرتّب القائمة حسب ترتيب الأسبوع الطبيعي
      const ordered = WEEK_DAYS.filter((d) => list.includes(d.id)).map((d) => d.id);
      const arabic = WEEK_DAYS.filter((d) => ordered.includes(d.id)).map((d) => d.label).join('، ');
      return { ...prev, work_days_list: ordered, work_days: arabic };
    });
  };

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const handleProjectChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setProjectForm(prev => ({
      ...prev,
      [name]: type === 'number' ? (value === '' ? 0 : parseFloat(value) || 0) : value
    }));
  };

  // يعيد بناء contact_number (E.164 كامل، مثال: +966501234567) من الرقم
  // المحلي المُدخَل مع مفتاح السعودية الثابت (+966)، عبر
  // parsePhoneNumberFromString التي تتعامل تلقائياً مع الصفر البادئ المحلي
  // (05... تصبح +9665...). إن تعذّر التحليل (رقم غير مكتمل أثناء الكتابة)،
  // نحفظ القيمة الخام كما هي بدل تفريغ الحقل فجأة أثناء الكتابة.
  const handleContactLocalNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // رقم الجوال السعودي بعد +966 يتكون من 9 أرقام فقط (5XXXXXXXX) — نمنع
    // الأرقام الإضافية والحروف عند الكتابة مباشرة بدل الانتظار لرسالة خطأ
    // عند الحفظ.
    const localNumber = e.target.value.replace(/\D/g, '').slice(0, 9);
    setContactLocalNumber(localNumber);
    if (!localNumber.trim()) {
      setProjectForm((prev) => ({ ...prev, contact_number: '' }));
      return;
    }
    const parsed = parsePhoneNumberFromString(localNumber, 'SA');
    setProjectForm((prev) => ({ ...prev, contact_number: parsed ? parsed.number : localNumber }));
  };

  // حقول امتثال الغبار التنظيمي الاختيارية — منفصلة عن handleProjectChange
  // لأن الفراغ هنا يعني "غير معروف" (وليس صفر)، بعكس الحقول الرقمية الأخرى
  // في النموذج (مثل latitude/longitude) التي تُصفَّر عند الفراغ.
  // ملاحظة: site_area_m2 لم يعد له حقل إدخال في الواجهة أصلاً — يُعرض
  // للقراءة فقط أسفل زر استيراد KML، ويُملأ حصراً عبر handleZoneChange.
  const handleComplianceFieldChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    if (type === 'checkbox') {
      const checked = (e.target as HTMLInputElement).checked;
      setProjectForm(prev => ({ ...prev, [name]: checked }));
      return;
    }
    setProjectForm(prev => ({ ...prev, [name]: value }));
  };

  // عدد محطات الرصد المُدخَل يدوياً يتحكم بعدد صفوف الإحداثيات المعروضة —
  // يضيف/يحذف صفوفاً فارغة عند تغييره، مع الحفاظ على ما أُدخل مسبقاً.
  const handleStationCountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setProjectForm((prev) => ({ ...prev, monitoring_station_count: raw }));
    const count = raw === '' ? 0 : Math.max(0, Math.min(20, parseInt(raw, 10) || 0));
    setMonitoringStations((prev) => {
      if (count === prev.length) return prev;
      if (count < prev.length) return prev.slice(0, count);
      return [...prev, ...Array.from({ length: count - prev.length }, () => ({ lat: '', lng: '', label: '' }))];
    });
  };

  const updateMonitoringStation = (index: number, field: keyof MonitoringStation, value: string) => {
    setMonitoringStations((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));

    // تنبيه فوري إن اكتملت الإحداثيات (خط عرض + خط طول) لهذه المحطة ووقعت
    // خارج منطقة المشروع المرسومة — محطة رصد خارج الحدود لا تعكس ظروف
    // الموقع فعلياً، فيجب تنبيه المستخدم فور الإدخال لا عند الحفظ فقط.
    if ((field === 'lat' || field === 'lng') && zoneValue.zoneType !== 'point') {
      const station = monitoringStations[index];
      const lat = Number(field === 'lat' ? value : station?.lat);
      const lng = Number(field === 'lng' ? value : station?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng) && !isPointInProjectZone({ lat, lng }, zoneValue)) {
        toast.error(`إحداثيات محطة الرصد ${index + 1} تقع خارج حدود منطقة المشروع.`);
      }
    }
  };

  const handleMonitoringKmlUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const points = parseKmlPoints(text);
      const stations = points.map((p) => ({ lat: String(p.lat), lng: String(p.lng), label: p.label || '' }));
      setMonitoringStations(stations);
      setProjectForm((prev) => ({ ...prev, monitoring_station_count: stations.length }));
      toast.success(`تم استيراد ${stations.length} محطة رصد من ملف KML.`);

      // نفس فحص الحدود أعلاه، مطبَّقاً دفعة واحدة على كل نقاط KML المستوردة —
      // ملف قد يحوي نقاطاً خارج الموقع بالخطأ (نسخة قديمة، رفع ملف خاطئ...).
      if (zoneValue.zoneType !== 'point') {
        const outsideCount = points.filter((p) => !isPointInProjectZone({ lat: p.lat, lng: p.lng }, zoneValue)).length;
        if (outsideCount > 0) {
          toast.error(`${outsideCount} من محطات الرصد المستوردة تقع خارج حدود منطقة المشروع.`);
        }
      }
    } catch (error) {
      const message = error instanceof KmlParseError ? error.message : 'تعذّر قراءة ملف KML لمحطات الرصد.';
      console.error('🚨 فشل استيراد KML لمحطات الرصد:', error);
      toast.error(message);
    }
  };

  // فحص امتثال الغبار التنظيمي المشترك — نفس منطق تصنيف الفئة والتزامات
  // الرصد الموجود فعلياً في dust-compliance-engine (classifyProject +
  // buildMonitoringObligations)، معاد استخدامه هنا حرفياً لأغراض التنبيه
  // المبكر في نموذج الإنشاء قبل وصول البيانات لذلك المحرك أصلاً. يُستخدم
  // لكل من العرض الحي (تنبيهات صفراء) والتحقق الإلزامي عند الحفظ.
  const complianceCheck = () => {
    const areaM2 = projectForm.site_area_m2 === '' ? null : Number(projectForm.site_area_m2);
    const truckMovements = projectForm.daily_truck_movements === '' ? null : Number(projectForm.daily_truck_movements);
    const stationCount = projectForm.monitoring_station_count === '' ? null : Number(projectForm.monitoring_station_count);

    // نفس ترتيب الأولوية بالضبط في classifyProject (rulebook.ts) — بما فيه
    // نفس "حماية التصنيف الكاذب": نقص بيانات محفزات الفئة الثالثة تحديداً
    // (حركة الشاحنات/الكسارة/الخلاطة) يمنع فقط استبعاد الفئة الثالثة، ولا
    // يمنع تصنيف الفئة الثانية بالمساحة وحدها إن كانت معروفة فعلياً — كان
    // الشرط هنا يفرض UNCLASSIFIED دائماً بمجرد ترك حركة الشاحنات فارغة
    // (حقل اختياري غالباً ما يُترك فارغاً)، فيُخفي تنبيه محطة الرصد للفئة
    // الثانية زوراً حتى مع مساحة مُدخلة بوضوح بين 2000 و5000.
    let riskClass: 'CATEGORY_I_LOW' | 'CATEGORY_II_MEDIUM' | 'CATEGORY_III_HIGH' | 'UNCLASSIFIED';
    if (areaM2 !== null && areaM2 > 5000) riskClass = 'CATEGORY_III_HIGH';
    else if (truckMovements !== null && truckMovements > 50) riskClass = 'CATEGORY_III_HIGH';
    else if (projectForm.has_onsite_crusher) riskClass = 'CATEGORY_III_HIGH';
    else if (projectForm.has_onsite_batching_plant) riskClass = 'CATEGORY_III_HIGH';
    else if (areaM2 === null) riskClass = 'UNCLASSIFIED';
    else if (areaM2 >= 2000) riskClass = 'CATEGORY_II_MEDIUM';
    else riskClass = 'CATEGORY_I_LOW';

    // الحد الأدنى لمحطات الرصد: لا حاجة للفئة الأولى، محطة واحدة للثانية،
    // محطتان للثالثة — لا يُفرض شيء إن كانت الفئة غير مصنَّفة بعد (بيانات ناقصة)
    const minStations =
      riskClass === 'CATEGORY_III_HIGH' ? 2 : riskClass === 'CATEGORY_II_MEDIUM' ? 1 : 0;

    const warnings: string[] = [];

    // بيانات ناقصة تمنع تصنيف فئة المشروع أصلاً — تحذير مباشر لأن الحقول
    // إلزامية تنظيمياً وليست اختيارية، حتى قبل الوصول لأي حد أو عتبة.
    if (areaM2 === null) {
      warnings.push('مساحة الموقع غير مُدخلة — مطلوبة لتصنيف فئة مخاطر الغبار للمشروع.');
    }
    if (truckMovements === null) {
      warnings.push('حركة الشاحنات اليومية غير مُدخلة — مطلوبة لتصنيف فئة مخاطر الغبار للمشروع.');
    }

    if (minStations > 0 && (stationCount === null || stationCount < minStations)) {
      warnings.push(`الحد الأدنى التنظيمي لعدد محطات رصد الغبار لهذه الفئة هو ${minStations} — ${stationCount === null ? 'لم يُدخَل عدد بعد' : `لديك حالياً ${stationCount}`}.`);
    }
    if (truckMovements !== null && truckMovements > 50) {
      warnings.push(`حركة الشاحنات اليومية (${truckMovements} رحلة) تتجاوز 50 رحلة -يتطلب محطتي رصد على الاقل.`);
    }
    // أي حركة شاحنات فعلية (بصرف النظر عن الحد الأعلى) تعني وجود دخول
    // وخروج فعلي للموقع تخضع لقواعد ENTRY_EXIT التنظيمية — راجع
    // entryExitRules في rulebook.ts. لا نطلب من المستخدم هنا تحديد نقاط
    // دخول/خروج (خاصية على مستوى المشروع ترتبط بكل الأنشطة، لا بنشاط
    // مستقل يُدخَل في نموذج منفصل) — فقط تنبيه بالمتطلبات التشغيلية.
    if (truckMovements !== null && truckMovements > 0) {
      warnings.push('حركة الشاحنات المُدخلة تعني وجود دخول وخروج فعلي للموقع، ويتطلب تنظيمياً: وحدة غسيل إطارات عاملة عند البوابة، وعدم ظهور أتربة متتبَّعة على بعد يتجاوز 15 متراً خارج البوابة.');
    }
    if (projectForm.has_onsite_crusher) {
      warnings.push('وجود كسارة داخل الموقع  — يتطلب محطتي رصد على الأقل.');
    }
    if (projectForm.has_onsite_batching_plant) {
      warnings.push('وجود محطة خلط خرساني (خلاطة) داخل الموقع — يتطلب محطتي رصد على الأقل.');
    }
    const dmpMissing = projectForm.dmp_approval_status !== 'APPROVED' && projectForm.dmp_approval_status !== 'NOT_REQUIRED';
    if (dmpMissing) {
      warnings.push('لا توجد خطة معتمدة لإدارة الغبار (DMP) — مطلوبة قبل بدء العمل الفعلي في الموقع.');
    }

    // التزامات الرصد التنظيمية — تنبيهات عامة توعوية فقط، لا تمنع الحفظ في
    // أي حالة مشروع (بخلاف warnings أعلاه التي تصبح إلزامية لحالة "جاري"
    // عبر validateBasicFields). لا تُدخَل بيانات لها في هذه الصفحة (حُذفت
    // حقول الإدخال المنفصلة)، فتُعرض كتذكير ثابت بالأرقام التنظيمية
    // المطلوبة فعلياً (نفس الحدود في buildMonitoringObligations،
    // dust-compliance-engine/engine.ts) بمجرد اعتماد DMP، حتى يعرف
    // المستخدم متطلبات الرصد قبل بدء العمل الفعلي بصرف النظر عن مكان
    // إدخالها لاحقاً — لذا تُرجَع في مصفوفة منفصلة (infoNotices) بدل
    // warnings، فلا تُصبَغ حمراء ولا يُوصَف بها "إلزامي — يمنع الحفظ".
    const infoNotices: string[] = [];
    if (projectForm.dmp_approval_status === 'APPROVED') {
      // نقطة الرصد الأساسي (14 يوماً) تظهر فقط لحالة "لم يبدأ": هذا الرصد
      // يجب أن يسبق بدء الأعمال فعلياً، فبمجرد أن يصبح المشروع "جاري" تكون
      // نافذة تسجيله قد فاتت أو انتهت أصلاً — تكراره كتنبيه حينها مضلِّل
      // (يوحي بأنه ما زال ممكناً تنفيذه قبل البدء بينما البدء وقع بالفعل).
      if (projectForm.project_status === 'not_started') {
        infoNotices.push('رصد أساسي لا يقل عن 14 يوماً على حدود ملكية المشروع قبل بدء الأعمال.');
      }
      infoNotices.push('تسجيل بيانات الرصد كل دقيقة واحدة أو أقل.');
      infoNotices.push('ارتفاع مقياس سرعة الرياح بين 2 و3 أمتار فوق سطح الأرض.');
      infoNotices.push('كاميرات عند نقاط الدخول/الخروج مع حفظ المقاطع 90 يوماً على الأقل.');
      infoNotices.push('خريطة حساسية بيئية (GIS) مُعدة.');
    }

    return { riskClass, minStations, stationCount, dmpMissing, warnings, infoNotices };
  };

  // الحقول الأربعة الأساسية (اسم/منطقة KML/يوم عمل/الإقرار) إلزامية دائماً
  // بصرف النظر عن حالة المشروع — لا معنى لمشروع بلا اسم أو موقع. بقية
  // الحقول (بيانات الموقع، امتثال الغبار، الجدولة التفصيلية) تصبح إلزامية
  // فقط عند حالة "جاري" (العمل بدأ فعلياً في الموقع)؛ لحالة "لم يبدأ" تبقى
  // تحذيرية فقط (حدود حمراء بصرية عبر complianceInputClass) ولا تمنع الحفظ،
  // للسماح بحفظ بيانات أولية ناقصة لحين اكتمالها لاحقاً.
  const validateBasicFields = (): string[] => {
    const errors: string[] = [];

    if (!projectForm.name.trim()) errors.push('اسم المشروع مطلوب.');
    if (zoneValue.zoneType === 'point') {
      errors.push('الرجاء تحديد منطقة المشروع عبر رفع ملف KML أو لصق نصه.');
    }
    if (projectForm.work_days_list.length === 0) errors.push('اختر يوم عمل واحداً على الأقل.');
    if (!projectForm.data_accuracy_confirmed) {
      errors.push('يجب الإقرار بصحة البيانات المُدخلة وتحمّل المسؤولية الكاملة عنها قبل الحفظ.');
    }

    if (
      typeof projectForm.latitude !== 'number' ||
      typeof projectForm.longitude !== 'number' ||
      Number.isNaN(projectForm.latitude) ||
      Number.isNaN(projectForm.longitude)
    ) {
      errors.push('إحداثيات الموقع غير صالحة، الرجاء استيراد منطقة المشروع من ملف KML.');
    }

    if (
      projectForm.start_date &&
      projectForm.end_date &&
      new Date(projectForm.end_date).getTime() < new Date(projectForm.start_date).getTime()
    ) {
      errors.push('تاريخ الانتهاء المتوقع لا يمكن أن يكون قبل تاريخ البدء.');
    }

    // محطات رصد خارج حدود منطقة المشروع لا تمثّل ظروف الموقع فعلياً — تمنع
    // الحفظ فعلياً (لا مجرد تنبيه بصري) لأن قرار الامتثال يعتمد على قراءات
    // هذه المحطات، وقراءة خارج الحدود تُفسد الأساس الذي يُبنى عليه القرار.
    if (zoneValue.zoneType !== 'point') {
      const outsideStations = monitoringStations.filter((s) => {
        const lat = Number(s.lat);
        const lng = Number(s.lng);
        return Number.isFinite(lat) && Number.isFinite(lng) && !isPointInProjectZone({ lat, lng }, zoneValue);
      });
      if (outsideStations.length > 0) {
        errors.push(`${outsideStations.length} من محطات رصد الغبار تقع خارج حدود منطقة المشروع — صحّح إحداثياتها أو احذفها قبل الحفظ.`);
      }
    }

    errors.push(...validateShifts());

    // مشروع "جاري" فعلياً يعني أن العمل بدأ في الموقع — لا يجوز أن يبدأ
    // ببيانات ناقصة أياً كانت. "لم يبدأ" يسمح بحفظ بيانات أولية ناقصة.
    if (projectForm.project_status === 'in_progress') {
      if (!projectForm.client_name.trim()) errors.push('اسم العميل مطلوب.');
      if (!projectForm.city.trim()) errors.push('المدينة مطلوبة — حدّد منطقة المشروع عبر KML ليُستنتج اسم المدينة تلقائياً.');
      if (!projectForm.soil_type) errors.push('طبيعة الأرض (نوع التربة) مطلوبة.');
      if (!projectForm.site_location_nature) errors.push('طبيعة الموقع مطلوبة.');
      if (!projectForm.project_manager.trim()) errors.push('اسم مدير المشروع مطلوب.');
      if (!projectForm.contact_number.trim()) {
        errors.push('رقم التواصل (للطوارئ) مطلوب.');
      } else if (!isValidInternationalPhone(projectForm.contact_number)) {
        errors.push('رقم التواصل (للطوارئ) يجب أن يكون رقم هاتف صحيح مع مفتاح الدولة (مثال: 966501234567+).');
      }

      const { minStations, stationCount, dmpMissing } = complianceCheck();
      if (projectForm.site_area_m2 === '') errors.push('مساحة الموقع (م²) مطلوبة.');
      if (projectForm.daily_truck_movements === '') errors.push('حركة الشاحنات اليومية مطلوبة.');
      if (dmpMissing) {
        errors.push('لا يمكن إنشاء مشروع بحالة "جاري" بلا خطة معتمدة لإدارة الغبار (DMP) — حدّث حالة اعتماد DMP أو اختر حالة "لم يبدأ".');
      }
      if (minStations > 0 && (stationCount === null || stationCount < minStations)) {
        errors.push(`لا يمكن إنشاء مشروع بحالة "جاري" بعدد محطات رصد أقل من الحد التنظيمي (${minStations} لهذه الفئة) — أضف بيانات المحطات أو اختر حالة "لم يبدأ".`);
      }
    }

    return errors;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttemptedSubmit(true);

    const validationErrors = validateBasicFields();
    if (validationErrors.length > 0) {
      validationErrors.forEach((msg) => toast.error(msg));
      return;
    }

    setLoading(true);
    setSubmitStage('جاري التحقق من جلسة الدخول...');

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) {
        throw new Error(`تعذّر التحقق من هوية المستخدم: ${userError.message}`);
      }
      const user = userData?.user;
      if (!user) {
        throw new Error('يجب تسجيل الدخول أولاً للمنظومة');
      }

      setSubmitStage('جاري حفظ بيانات المشروع...');

      const { data: projectResp } = await apiClient.post('/projects', {
        project: {
          name: projectForm.name,
          client_name: projectForm.client_name,
          city: projectForm.city,
          neighborhood: projectForm.neighborhood,
          project_status: projectForm.project_status,
          site_nature: projectForm.site_nature,
          soil_type: projectForm.soil_type || null,
          project_type: projectForm.project_type,
          latitude: projectForm.latitude,
          longitude: projectForm.longitude,
          coordinates: `${projectForm.latitude}, ${projectForm.longitude}`,

          // منطقة المشروع الكاملة (zone) — مضلع أو دائرة
          zone_type: zoneValue.zoneType === 'point' ? null : zoneValue.zoneType,
          zone_polygon: zoneValue.zoneType === 'polygon' ? zoneValue.polygon : null,
          zone_radius_m: zoneValue.zoneType === 'circle' ? zoneValue.circleRadiusM : null,

          site_location_nature: projectForm.site_location_nature,
          wind_exposure: projectForm.wind_exposure,

          start_date: projectForm.start_date || null,
          end_date: projectForm.end_date || null,
          work_days: projectForm.work_days,
          work_days_list: projectForm.work_days_list,
          work_hours_start: projectForm.work_hours_start,
          work_hours_end: projectForm.work_hours_end,
          // ورديات عمل حقيقية (اختياري) — فقط الصفوف المكتملة (validateShifts
          // يمنع الحفظ أصلاً لو بقي صف ناقص)، جدول project_shifts منفصل
          // (راجع POST /api/projects لآلية الإدراج بعد إنشاء المشروع).
          shifts: shifts.filter((s) => s.name.trim() && s.start_time && s.end_time),
          project_manager: projectForm.project_manager,
          contact_number: projectForm.contact_number,

          // ملف امتثال الغبار التنظيمي — راجع dust-compliance-engine
          site_area_m2: projectForm.site_area_m2 === '' ? null : Number(projectForm.site_area_m2),
          daily_truck_movements: projectForm.daily_truck_movements === '' ? null : Number(projectForm.daily_truck_movements),
          has_onsite_crusher: projectForm.has_onsite_crusher,
          has_onsite_batching_plant: projectForm.has_onsite_batching_plant,
          dmp_approval_status: projectForm.dmp_approval_status,
          monitoring_station_count:
            projectForm.monitoring_station_count === '' ? null : Number(projectForm.monitoring_station_count),
          monitoring_station_locations: monitoringStations
            .filter((s) => s.lat !== '' && s.lng !== '' && Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng)))
            .map((s) => ({ lat: Number(s.lat), lng: Number(s.lng), label: s.label || null })),
          // التزامات الرصد التنظيمية (رصد أساسي/فترة تسجيل/ارتفاع
          // المقياس/كاميرات الدخول-الخروج/خريطة الحساسية) لم تعد تُدخَل في
          // هذه الصفحة — تُعرض كتذكير نصي ثابت فقط (راجع complianceCheck)،
          // وتبقى null/false هنا حتى تُستوفى لاحقاً من مكان آخر إن احتاج
          // المشروع ذلك.
          baseline_monitoring_days: null,
          monitoring_logging_interval_minutes: null,
          anemometer_height_m: null,
          entry_exit_cameras_installed: false,
          camera_retention_days: null,
          sensitivity_map_prepared: false,

          data_accuracy_confirmed: projectForm.data_accuracy_confirmed,
          data_accuracy_confirmed_at: projectForm.data_accuracy_confirmed ? new Date().toISOString() : null,
        },
      });

      const insertedProject = projectResp?.data;
      if (!insertedProject || !insertedProject.id) {
        throw new Error('تم إرسال طلب حفظ المشروع لكن لم يتم استلام بيانات المشروع المُنشأ من قاعدة البيانات.');
      }

      toast.success('تم تأسيس بيانات المشروع الأساسية بنجاح!');
      router.push(`/dashboard/Projects/${insertedProject.id}`);

    } catch (error: any) {
      console.error('🚨 خطأ أثناء التنفيذ:', error);
      toast.error(`حدث خطأ: ${error?.response?.data?.error || error?.message || 'مشكلة برمجية غير متوقعة'}`);
    } finally {
      setLoading(false);
      setSubmitStage('');
    }
  };

  const inputClass = "w-full bg-[#F4F7FB] border border-[#061B40]/20 rounded-lg p-2 text-sm text-[#061B40] focus:outline-none focus:ring-1 focus:ring-[#3995FF] focus:border-[#3995FF] transition-all";
  const labelClass = "block text-xs font-semibold text-[#061B40]/70 mb-1";
  const sectionTitleClass = "text-sm font-bold text-[#061B40] border-r-4 border-[#3995FF] pr-2 bg-[#F4F7FB] py-1.5 rounded-l-md shadow-sm mb-3";

  // حدود حمراء لحقول امتثال الغبار التنظيمي الإلزامية إذا تُركت فارغة بعد
  // أول محاولة حفظ — تحذير بصري فقط، لا يمنع الإرسال (راجع complianceCheck)
  const complianceInputClass = (isEmpty: boolean) =>
    `${inputClass} ${attemptedSubmit && isEmpty ? 'border-red-400 focus:ring-red-400 focus:border-red-400 bg-red-50/40' : ''}`;

  return (
    <div className="min-h-screen bg-[#F4F7FB] text-[#061B40] p-4 md:p-8 flex flex-col items-center justify-center font-sans" dir="rtl">
      <div className="w-full max-w-7xl bg-white border border-[#061B40]/10 rounded-2xl shadow-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">

        <form onSubmit={handleSubmit} className="p-6 space-y-6 lg:col-span-8 border-l border-[#061B40]/10 h-[85vh] overflow-y-auto custom-scrollbar">
          <div>
            <h1 className="text-2xl font-black text-[#061B40]">تأسيس مشروع جديد</h1>
            <p className="text-xs text-[#061B40]/60 mt-1">
              أدخل البيانات الأساسية فقط الآن. بعد إنشاء المشروع، يمكنك إضافة الرافعات وبيانات الغبار والتأثير البيئي
              من خلال زر <span className="font-bold text-[#3995FF]">"إضافة أنشطة"</span> داخل صفحة المشروع.
            </p>
          </div>

          {/* القسم 1: البيانات الأساسية والموقع */}
          <div className="space-y-3">
            <h2 className={sectionTitleClass}>أولاً: البيانات الأساسية والموقع</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>اسم المشروع</label>
                <input required type="text" name="name" value={projectForm.name} onChange={handleProjectChange} className={complianceInputClass(!projectForm.name.trim())} />
                {attemptedSubmit && !projectForm.name.trim() && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                )}
              </div>
              <div>
                <label className={labelClass}>اسم العميل</label>
                <input type="text" name="client_name" value={projectForm.client_name} onChange={handleProjectChange} className={complianceInputClass(!projectForm.client_name.trim())} />
                {attemptedSubmit && !projectForm.client_name.trim() && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                )}
              </div>
              <div>
                <label className={labelClass}>حالة المشروع</label>
                <select name="project_status" value={projectForm.project_status} onChange={handleProjectChange} className={inputClass}>
                  <option value="not_started">لم يبدأ</option>
                  <option value="in_progress">جاري</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex flex-col gap-2">
                <label className="text-[12px] font-bold text-[#ADADAD]">المدينة</label>
                <input
                  type="text"
                  name="city"
                  value={projectForm.city} 
                  readOnly 
                  className="px-4 py-2 rounded-xl border border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed focus:outline-none text-sm"
                  placeholder="يتم تحديد المدينة تلقائياً"
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="text-[12px] font-bold text-[#ADADAD]">الحي</label>
                <input
                  type="text"
                  name="district"
                  value={projectForm.neighborhood}
                  readOnly
                  className="px-4 py-2 rounded-xl border border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed focus:outline-none text-sm"
                  placeholder="يتم تحديد الحي تلقائياً"
                />
              </div>
              <div>
                <label className={labelClass}>طبيعة الأرض (نوع التربة)</label>
                <select name="soil_type" value={projectForm.soil_type} onChange={handleProjectChange} className={complianceInputClass(!projectForm.soil_type)}>
                  <option value="">اختر نوع التربة...</option>
                  <option value="SANDY_FINE">تربة رملية ناعمة</option>
                  <option value="SANDY_COARSE">تربة رملية خشنة</option>
                  <option value="CLAY">تربة طينية</option>
                  <option value="MIXED">تربة مختلطة</option>
                </select>
                {attemptedSubmit && !projectForm.soil_type && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className={labelClass}>تضاريس المنطقة (لحساب قص الرياح)</label>
                <select name="terrain_type" value={projectForm.terrain_type} onChange={handleProjectChange} className={inputClass}>
                  <option value="open_desert">صحراء مفتوحة</option>
                  <option value="suburban">ضواحي / شبه عمرانية</option>
                  <option value="urban">مناطق سكنية مرتفعة</option>
                  <option value="dense_urban">أبراج ناطحات سحاب</option>
                </select>
              </div>
            </div>

            {/* بيانات الموقع الإضافية حسب مخطط صفحة تفاصيل المشروع */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>طبيعة الموقع</label>
                <select name="site_location_nature" value={projectForm.site_location_nature} onChange={handleProjectChange} className={complianceInputClass(!projectForm.site_location_nature)}>
                  <option value="">اختر طبيعة الموقع...</option>
                  <option value="open_full">موقع مفتوح بالكامل</option>
                  <option value="urban_area">موقع داخل منطقة عمرانية</option>
                  <option value="high_rise_between">موقع بين مبانٍ مرتفعة</option>
                  <option value="near_highway">موقع قريب من طريق سريع</option>
                  <option value="near_desert">موقع قريب من منطقة صحراوية</option>
                  <option value="coastal">موقع ساحلي</option>
                  <option value="mountainous">موقع جبلي أو مرتفع</option>
                  <option value="existing_facility">موقع داخل منشأة قائمة</option>
                </select>
                {attemptedSubmit && !projectForm.site_location_nature && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                )}
              </div>
              <div>
                <label className={labelClass}>مدى تعرض الموقع للرياح</label>
                <select name="wind_exposure" value={projectForm.wind_exposure} onChange={handleProjectChange} className={inputClass}>
                  <option value="low">منخفض</option>
                  <option value="medium">متوسط</option>
                  <option value="high">مرتفع</option>
                  <option value="very_high">مرتفع جدًا</option>
                </select>
              </div>
            </div>
          </div>

          {/* القسم الإضافي: ملف امتثال الغبار التنظيمي للمشروع — إلزامي
              فعلياً (يمنع الحفظ) فقط عند حالة المشروع "جاري"؛ لحالة "لم
              يبدأ" يبقى تحذيرياً فقط عبر complianceInputClass، للسماح بحفظ
              بيانات أولية ناقصة لحين اكتمالها لاحقاً. */}
          <div className="space-y-3 pt-3 border-t border-[#061B40]/5">
            <div className="flex items-center justify-between mb-1">
              <h2 className={`text-sm font-bold text-[#061B40] border-r-4 pr-2 bg-[#F4F7FB] py-1.5 rounded-l-md shadow-sm flex items-center gap-2 ${projectForm.project_status === 'in_progress' ? 'border-red-500' : 'border-amber-500'}`}>
                <Gauge className={`w-4 h-4 ${projectForm.project_status === 'in_progress' ? 'text-red-500' : 'text-amber-500'}`} />
                امتثال الغبار التنظيمي للمشروع
              </h2>
              
            </div>
            <p className="text-[11px] font-semibold text-[#061B40]/50 -mt-1">
              {projectForm.project_status === 'in_progress'
                ? 'مشروع "جاري" يعني أن العمل بدأ فعلياً في الموقع — لا يمكن حفظه ببيانات امتثال ناقصة.'
                : 'مطلوبة بموجب لوائح الغبار التنظيمية للرياض لتصنيف فئة مخاطر المشروع. تركها فارغة لا يمنع الحفظ الآن (المشروع لم يبدأ بعد)، لكنه يُظهر تحذيراً أدناه ويُبقي المشروع "غير مصنَّف".'}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>حركة الشاحنات اليومية (رحلة/يوم)</label>
                <input type="number" name="daily_truck_movements" placeholder="مثال: 20" value={projectForm.daily_truck_movements} onChange={handleComplianceFieldChange} className={complianceInputClass(projectForm.daily_truck_movements === '')} />
                {attemptedSubmit && projectForm.daily_truck_movements === '' && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                )}
              </div>
              <div>
                <label className={labelClass}>خطة إدارة الغبار (DMP)</label>
                <select
                  name="dmp_approval_status"
                  value={projectForm.dmp_approval_status === 'APPROVED' ? 'APPROVED' : 'NOT_STARTED'}
                  onChange={handleComplianceFieldChange}
                  className={complianceInputClass(projectForm.dmp_approval_status !== 'APPROVED')}
                >
                  <option value="NOT_STARTED">ليس لديه خطة بعد</option>
                  <option value="APPROVED">لديه خطة</option>
                </select>
                {projectForm.project_status === 'not_started' && (
                  <p className="text-[10px] font-bold text-[#061B40]/40 mt-1">غير إلزامية الآن — لكنها مطلوبة قبل بدء المشروع فعلياً.</p>
                )}
              </div>
              <div className="flex flex-col gap-2 justify-end">
                <label className="flex items-center gap-2 text-sm text-[#061B40]">
                  <input type="checkbox" name="has_onsite_crusher" checked={projectForm.has_onsite_crusher} onChange={handleComplianceFieldChange} className="w-4 h-4 accent-[#3995FF]" />
                  يوجد كسارة داخل الموقع
                </label>
                <label className="flex items-center gap-2 text-sm text-[#061B40]">
                  <input type="checkbox" name="has_onsite_batching_plant" checked={projectForm.has_onsite_batching_plant} onChange={handleComplianceFieldChange} className="w-4 h-4 accent-[#3995FF]" />
                  يوجد محطة خلط خرساني (خلاطة) داخل الموقع
                </label>
              </div>
            </div>

            {/* محطات رصد الغبار/PM10 — مقفلة حتى تُحدَّد منطقة المشروع (KML)
                أولاً: بلا حدود مرسومة لا يمكن التحقق أن إحداثيات المحطة
                داخل الموقع فعلاً، فلا معنى لإدخالها قبل ذلك. الشرط الثاني
                (DMP معتمد) يبقى كما هو — لا معنى لمحطات رصد بلا خطة أصلاً. */}
            {zoneValue.zoneType === 'point' ? (
              <p className="text-[11px] font-bold text-[#061B40]/40 bg-[#F4F7FB] border border-dashed border-[#061B40]/15 rounded-lg p-3">
                حدّد منطقة المشروع (KML) أولاً من اللوحة المقابلة لإظهار حقول محطات الرصد.
              </p>
            ) : projectForm.dmp_approval_status === 'APPROVED' ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
                  <div>
                    <label className={labelClass}>عدد محطات رصد الغبار</label>
                    <input type="number" min={0} max={20} placeholder="مثال: 2" value={projectForm.monitoring_station_count} onChange={handleStationCountChange} className={inputClass} />
                  </div>
                  <div className="md:col-span-3 flex items-end gap-3">
                    <label className="flex-1 flex items-center justify-center gap-2 bg-[#F4F7FB] hover:bg-[#e8eef7] text-[#061B40] text-xs font-bold px-3 py-2.5 rounded-lg border border-dashed border-[#061B40]/20 cursor-pointer transition-colors">
                      <span className="text-[#3995FF]">📁</span>
                      استيراد مواقع المحطات من ملف KML
                      <input type="file" accept=".kml" onChange={handleMonitoringKmlUpload} className="hidden" />
                    </label>
                  </div>
                </div>

                {monitoringStations.length > 0 && (
                  <div className="space-y-2">
                    {monitoringStations.map((station, idx) => {
                      const lat = Number(station.lat);
                      const lng = Number(station.lng);
                      const isOutside =
                        Number.isFinite(lat) && Number.isFinite(lng) &&
                        !isPointInProjectZone({ lat, lng }, zoneValue);
                      return (
                        <div key={idx}>
                          <div className={`grid grid-cols-3 gap-2 p-2 rounded-lg border ${isOutside ? 'bg-red-50 border-red-300' : 'bg-[#F4F7FB] border-[#061B40]/10'}`}>
                            <input type="text" placeholder={`اسم/رقم المحطة ${idx + 1}`} value={station.label} onChange={(e) => updateMonitoringStation(idx, 'label', e.target.value)} className={inputClass} />
                            <input type="number" step="0.000001" placeholder="خط العرض" value={station.lat} onChange={(e) => updateMonitoringStation(idx, 'lat', e.target.value)} className={`${inputClass} ${isOutside ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''}`} />
                            <input type="number" step="0.000001" placeholder="خط الطول" value={station.lng} onChange={(e) => updateMonitoringStation(idx, 'lng', e.target.value)} className={`${inputClass} ${isOutside ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''}`} />
                          </div>
                          {isOutside && (
                            <p className="text-[10px] font-bold text-red-500 mt-1">تقع هذه الإحداثيات خارج حدود منطقة المشروع.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <p className="text-[11px] font-bold text-[#061B40]/40 bg-[#F4F7FB] border border-dashed border-[#061B40]/15 rounded-lg p-3">
                حدّد "لديه خطة" لخطة إدارة الغبار (DMP) أعلاه أولاً لإظهار حقول محطات الرصد.
              </p>
            )}


            {/* تنبيهات مرجعية بنفس منطق تصنيف الفئة والتزامات الرصد المعتمد
                في محرك الامتثال التنظيمي — تصبح إلزامية (تمنع الحفظ فعلياً
                عبر validateBasicFields) عند اختيار حالة المشروع "جاري"،
                وتبقى توعية غير مانعة لحالة "لم يبدأ". */}
            {(() => {
              const { warnings } = complianceCheck();
              if (warnings.length === 0) return null;
              const isMandatory = projectForm.project_status === 'in_progress';
              return (
                <div className={`rounded-lg p-3 space-y-1.5 border ${isMandatory ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                  <p className={`text-[10px] font-black uppercase tracking-wide flex items-center gap-1.5 ${isMandatory ? 'text-red-700' : 'text-amber-700'}`}>
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {isMandatory
                      ? 'إلزامي — يمنع حفظ المشروع "جاري" حتى استيفائه الشروط التالية'
                      : 'تنبيه مرجعي — سيصبح إلزامياً في  حالة ان المشروع "جاري"'}
                  </p>
                  {warnings.map((w, i) => (
                    <p key={i} className={`text-[11px] font-bold pr-5 ${isMandatory ? 'text-red-700' : 'text-amber-700'}`}>⚠ {w}</p>
                  ))}
                </div>
              );
            })()}

            {/* التزامات الرصد التنظيمية — تنبيهات عامة توعوية فقط، لا تمنع
                الحفظ في أي حالة مشروع (بخلاف الصندوق أعلاه) — لذا تُعرض دوماً
                بتصميم محايد (رمادي/أزرق فاتح)، لا أحمر ولا نص "إلزامي". */}
            {(() => {
              const { infoNotices } = complianceCheck();
              if (infoNotices.length === 0) return null;
              return (
                <div className="rounded-lg p-3 space-y-1.5 border bg-slate-50 border-slate-200">
                  <p className="text-[10px] font-black uppercase tracking-wide flex items-center gap-1.5 text-slate-500">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    تنبيهات عامة — التزامات الرصد التنظيمية
                  </p>
                  {infoNotices.map((w, i) => (
                    <p key={i} className="text-[11px] font-bold pr-5 text-slate-600">⚠ {w}</p>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* القسم 2: الجدولة وإدارة المشروع */}
          <div className="space-y-3 pt-3 border-t border-[#061B40]/5">
            <h2 className={sectionTitleClass}>ثانياً: الجدولة وفريق العمل للمشروع</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className={labelClass}>تاريخ البدء</label>
                <input
                  type="date"
                  name="start_date"
                  value={projectForm.start_date}
                  onChange={handleProjectChange}
                  disabled={projectForm.project_status === 'not_started'}
                  className={`${inputClass} ${projectForm.project_status === 'not_started' ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
                {projectForm.project_status === 'not_started' && (
                  <p className="text-[10px] font-bold text-[#061B40]/40 mt-1">يُفعَّل بعد اختيار حالة المشروع "جاري".</p>
                )}
              </div>
              <div>
                <label className={labelClass}>تاريخ الانتهاء المتوقع</label>
                <input
                  type="date"
                  name="end_date"
                  value={projectForm.end_date}
                  onChange={handleProjectChange}
                  disabled={projectForm.project_status === 'not_started'}
                  className={`${inputClass} ${projectForm.project_status === 'not_started' ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
                {projectForm.project_status === 'not_started' && (
                  <p className="text-[10px] font-bold text-[#061B40]/40 mt-1">يُفعَّل بعد اختيار حالة المشروع "جاري".</p>
                )}
              </div>
              <div className="col-span-2">
                <label className={labelClass}>مدير المشروع</label>
                <input type="text" name="project_manager" value={projectForm.project_manager} onChange={handleProjectChange} className={complianceInputClass(!projectForm.project_manager.trim())} />
                {attemptedSubmit && !projectForm.project_manager.trim() && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                )}
              </div>
            </div>

            {/* أيام العمل — اختيار الأيام المحددة (يُخزَّن كقائمة منظّمة يعتمد
                عليها منع اقتراح/إدخال أنشطة في أيام خارج الدوام في كل المؤشرات) */}
            <div>
              <label className={labelClass}>أيام العمل</label>
              <div className="flex flex-wrap gap-2 mt-1">
                {WEEK_DAYS.map((day) => {
                  const active = projectForm.work_days_list.includes(day.id);
                  return (
                    <button
                      key={day.id}
                      type="button"
                      onClick={() => toggleWorkDay(day.id)}
                      className={`px-4 py-2 rounded-lg text-sm font-bold border transition-all ${
                        active
                          ? 'bg-[#3995FF] text-white border-[#3995FF] shadow-sm'
                          : 'bg-[#F4F7FB] text-[#061B40]/60 border-[#061B40]/15 hover:border-[#3995FF]/40'
                      }`}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
              {projectForm.work_days_list.length === 0 && (
                <p className="text-[11px] font-bold text-red-500 mt-1">اختر يوم عمل واحداً على الأقل.</p>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className={labelClass}>بداية الدوام</label>
                <input type="time" name="work_hours_start" value={projectForm.work_hours_start} onChange={handleProjectChange} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>نهاية الدوام</label>
                <input type="time" name="work_hours_end" value={projectForm.work_hours_end} onChange={handleProjectChange} className={inputClass} />
              </div>
              <div className="md:col-span-2">
                <label className={labelClass}>رقم التواصل (للطوارئ)</label>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 inline-flex items-center px-3 h-full rounded-lg bg-[#F4F7FB] border border-[#061B40]/15 text-sm font-bold text-[#061B40]/60" dir="ltr">
                    +966
                  </span>
                  <input
                    type="tel"
                    placeholder="5XXXXXXXX"
                    dir="ltr"
                    maxLength={9}
                    value={contactLocalNumber}
                    onChange={handleContactLocalNumberChange}
                    className={complianceInputClass(!projectForm.contact_number.trim())}
                  />
                </div>
                <p className="text-[10px] font-bold text-[#061B40]/40 mt-1">صيغة الرقم: 5XXXXXXXX (بدون صفر أو رمز الدولة) — مثال: 512345678</p>
                {attemptedSubmit && !projectForm.contact_number.trim() && (
                  <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                )}
              </div>
            </div>

            {/* ورديات العمل (اختياري) — إضافية بحتة على بداية/نهاية الدوام
                أعلاه. تُستخدم لاحقاً عند إضافة نشاط لاختيار أي وردية يتبعها
                (AddActivityModal)، ولتقييم محركي الغبار/الحرارة كل وردية على
                حدة بدل نافذة دوام واحدة متصلة. */}
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between">
                <label className={labelClass}>ورديات العمل (اختياري)</label>
                <button
                  type="button"
                  onClick={addShift}
                  className="text-xs font-bold text-[#3995FF] hover:underline bg-blue-50 px-3 py-1 rounded-full"
                >
                  + إضافة وردية
                </button>
              </div>
              {shifts.length === 0 ? (
                <p className="text-[11px] font-bold text-[#061B40]/40 bg-[#F4F7FB] border border-dashed border-[#061B40]/15 rounded-lg p-3">
                  بلا ورديات معرَّفة، يُعتمد على بداية/نهاية الدوام أعلاه كنافذة عمل واحدة لكل النشاطات. أضف ورديات إن كان العمل يتوزع على فترات منفصلة (مثال: صباحية ومسائية لتفادي ذروة الحرارة/الغبار الظهرية) — يجب أن تقع كل وردية ضمن نطاق الدوام الرسمي.
                </p>
              ) : (
                <div className="space-y-2">
                  {shifts.map((shift, i) => {
                    // تنبيه فوري لحظة الإدخال (لا ينتظر محاولة الحفظ): وردية
                    // خارج نطاق الدوام الرسمي أو نهايتها قبل بدايتها.
                    const officialStart = projectForm.work_hours_start;
                    const officialEnd = projectForm.work_hours_end;
                    const hasBothTimes = !!shift.start_time && !!shift.end_time;
                    const endBeforeStart = hasBothTimes && shift.end_time <= shift.start_time;
                    const outsideOfficialHours =
                      hasBothTimes && !endBeforeStart && !!officialStart && !!officialEnd &&
                      (shift.start_time < officialStart || shift.end_time > officialEnd);
                    const rowError = endBeforeStart
                      ? 'وقت النهاية يجب أن يكون بعد وقت البداية.'
                      : outsideOfficialHours
                      ? `خارج نطاق الدوام الرسمي (${officialStart!.slice(0, 5)} – ${officialEnd!.slice(0, 5)}).`
                      : null;
                    return (
                      <div key={i}>
                        <div className={`grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr_auto] gap-2 items-start p-2 rounded-lg border ${rowError ? 'bg-red-50 border-red-300' : 'bg-[#F4F7FB] border-[#061B40]/10'}`}>
                          <input
                            type="text"
                            placeholder="اسم الوردية (مثال: الوردية الصباحية)"
                            value={shift.name}
                            onChange={(e) => updateShift(i, 'name', e.target.value)}
                            className={inputClass}
                          />
                          <input type="time" value={shift.start_time} onChange={(e) => updateShift(i, 'start_time', e.target.value)} className={`${inputClass} ${rowError ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''}`} />
                          <input type="time" value={shift.end_time} onChange={(e) => updateShift(i, 'end_time', e.target.value)} className={`${inputClass} ${rowError ? 'border-red-400 focus:ring-red-400 focus:border-red-400' : ''}`} />
                          <button
                            type="button"
                            onClick={() => removeShift(i)}
                            className="text-red-500 hover:bg-red-50 px-3 py-2.5 rounded-lg text-sm font-bold"
                            title="حذف الوردية"
                          >
                            ✕
                          </button>
                        </div>
                        {rowError && (
                          <p className="text-[10px] font-bold text-red-500 mt-1">⚠ {rowError}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {attemptedSubmit && validateShifts().map((err, i) => (
                <p key={i} className="text-[10px] font-bold text-red-500">{err}</p>
              ))}
            </div>
          </div>

          {/* إقرار المستخدم بصحة البيانات وتحمّل المسؤولية الكاملة عنها —
              إلزامي، يمنع الحفظ حتى يُفعَّل (راجع validateBasicFields) */}
          <div className="pt-3 border-t border-[#061B40]/5">
            <label className={`flex items-start gap-2.5 rounded-lg p-3 cursor-pointer border ${attemptedSubmit && !projectForm.data_accuracy_confirmed ? 'bg-red-50 border-red-400' : 'bg-amber-50 border-amber-200'}`}>
              <input
                type="checkbox"
                checked={projectForm.data_accuracy_confirmed}
                onChange={(e) => setProjectForm((prev) => ({ ...prev, data_accuracy_confirmed: e.target.checked }))}
                className="w-4 h-4 mt-0.5 accent-amber-600 shrink-0"
              />
              <span className={`text-[12px] font-bold leading-relaxed ${attemptedSubmit && !projectForm.data_accuracy_confirmed ? 'text-red-700' : 'text-amber-800'}`}>
                أقرّ بأن جميع البيانات المُدخلة أعلاه صحيحة وموثوقة، وأتحمّل المسؤولية الكاملة عن دقتها وأي قرارات تُبنى عليها.
              </span>
            </label>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#3995FF] hover:bg-[#3995FF]/90 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg shadow-[#3995FF]/30 text-sm mt-4"
          >
            {loading ? (submitStage || 'جاري الحفظ...') : 'تأسيس المشروع'}
          </button>
        </form>

        {/* منطقة المشروع — تُحدَّد حصراً عبر KML (رفع ملف أو لصق نص) */}
        <div className={`lg:col-span-4 h-[350px] lg:h-[85vh] flex flex-col bg-gray-100 border-r ${attemptedSubmit && zoneValue.zoneType === 'point' ? 'border-red-400' : 'border-[#061B40]/10'}`}>
          <div className="p-4 space-y-3 bg-white border-b border-[#061B40]/10">
            <h2 className="text-sm font-bold text-[#061B40] flex items-center gap-1.5">
              <span className="text-[#3995FF]">📍</span> منطقة المشروع (KML)
            </h2>

            {attemptedSubmit && zoneValue.zoneType === 'point' && (
              <p className="text-[10px] font-bold text-red-500 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                حقل إلزامي — حدّد منطقة المشروع عبر رفع ملف KML أو لصق نصه.
              </p>
            )}

            <label className={`w-full flex items-center justify-center gap-2 bg-[#F4F7FB] hover:bg-[#e8eef7] text-[#061B40] text-xs font-bold px-3 py-2.5 rounded-lg border border-dashed cursor-pointer transition-colors ${attemptedSubmit && zoneValue.zoneType === 'point' ? 'border-red-400' : 'border-[#061B40]/20'}`}>
              <span className="text-[#3995FF]">📁</span>
              رفع ملف KML
              <input type="file" accept=".kml" onChange={handleKmlUpload} className="hidden" />
            </label>

            <div className="flex items-center gap-2 text-[10px] text-[#061B40]/40 font-bold">
              <div className="flex-1 h-px bg-[#061B40]/10" /> أو <div className="flex-1 h-px bg-[#061B40]/10" />
            </div>

            <div className="space-y-1.5">
              <textarea
                value={kmlPasteText}
                onChange={(e) => setKmlPasteText(e.target.value)}
                placeholder="الصق محتوى KML هنا مباشرة..."
                rows={3}
                className="w-full text-[11px] font-mono bg-[#F4F7FB] border border-[#061B40]/15 rounded-lg p-2 text-[#061B40] focus:outline-none focus:ring-1 focus:ring-[#3995FF] resize-none"
              />
              <button
                type="button"
                onClick={handleKmlPasteSubmit}
                className="w-full bg-[#061B40] hover:bg-[#061B40]/90 text-white text-xs font-bold py-2 rounded-lg transition-colors"
              >
                استيراد من النص الملصق
              </button>
              <p className="text-[11px] font-bold text-[#061B40]/60">
                مساحة الموقع: {projectForm.site_area_m2 === '' ? '—' : `${projectForm.site_area_m2} م²`}
              </p>
            </div>

            {kmlSourceName && (
              <div className="bg-emerald-50 text-emerald-700 text-[11px] font-bold px-3 py-1.5 rounded-lg border border-emerald-200 truncate">
                ✅ تم الاستيراد من: {kmlSourceName}
              </div>
            )}
          </div>

          <div className="flex-1 relative z-10">
            {mounted && (
              <ZonePicker
                initialCenter={{ lat: projectForm.latitude, lng: projectForm.longitude }}
                value={zoneValue}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}