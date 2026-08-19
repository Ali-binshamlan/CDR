'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { toast } from 'react-hot-toast';
import { ArrowRight, Trash2, Save, AlertTriangle, Gauge, Radar, Wifi, X, Compass } from 'lucide-react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { useNow } from '@/app/lib/useNow';
import { isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';
import ConnectProviderModal from './ConnectProviderModal';

// تنقّل صلب حقيقي (يفرض تحميل الصفحة بالكامل من الصفر، لا Router Cache
// جزئي — راجع تعليق الاستدعاء أدناه للسبب الكامل). دالة معرَّفة خارج
// المكوّن عمداً: React Compiler يرفض التعديل المباشر على window.location
// من كود داخل مكوّن/hook (يُعامله كقيمة خارجية غير قابلة للتعديل من هناك)؛
// هذا الفصل يبقي التعديل الفعلي خارج نطاق تحليل المكوّن تماماً.
function hardNavigate(href: string): void {
  window.location.href = href;
}

// يستخرج رسالة خطأ آمنة للعرض من استجابة apiClient (axios) الفاشلة، أو من
// أي خطأ JS عادي — بلا افتراض شكل any. نفس منطق app/login/page.tsx.
function getApiErrorMessage(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object'
  ) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  if (error instanceof Error) return error.message;
  return undefined;
}

// أيام الأسبوع بمعرّفات ثابتة تطابق getDay() (0=الأحد ... 6=السبت)
const WEEK_DAYS: { id: string; label: string }[] = [
  { id: 'sun', label: 'الأحد' },
  { id: 'mon', label: 'الاثنين' },
  { id: 'tue', label: 'الثلاثاء' },
  { id: 'wed', label: 'الأربعاء' },
  { id: 'thu', label: 'الخميس' },
  { id: 'fri', label: 'الجمعة' },
  { id: 'sat', label: 'السبت' },
];

// رقم هاتف من أي دولة عبر libphonenumber-js — نفس التحقق المستخدم في
// create/page.tsx بالضبط. الرقم يجب أن يبدأ بمفتاح الدولة الدولي (+).
function isValidInternationalPhone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('+')) return false;
  try {
    return isValidPhoneNumber(trimmed);
  } catch {
    return false;
  }
}

// استيراد مكوّن عرض منطقة المشروع (zone) بالكامل ديناميكياً مع إيقاف SSR —
// للعرض فقط هنا (readOnly)، لأن موقع/منطقة المشروع مقفلة بعد التأسيس
const ZonePicker = dynamic(() => import('@/app/components/dashborad/ZonePicker'), {
  ssr: false,
  loading: () => <div className="flex h-full w-full items-center justify-center bg-gray-200 text-[#061B40] text-sm font-semibold">جاري تحميل الخريطة...</div>
});
import type { ZonePickerValue } from '@/app/components/dashborad/ZonePicker';
import { buildProjectZoneFromRow } from '@/app/utils/geo/zone';

interface SettingsPageProps {
  params: Promise<{ id: string }>;
}

export default function ProjectSettingsPage({ params }: SettingsPageProps) {
  const router = useRouter();
  const resolvedParams = React.use(params);
  const projectId = resolvedParams.id;

  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [mounted, setMounted] = useState(false);
  // "الآن" لعرض عمر آخر قراءة جهاز (deviceReadingAgeLabel/isDeviceReadingStale
  // أدناه) — تحديث كل دقيقة يكفي لهذا العرض التحذيري فقط.
  const nowTs = useNow(60000);
  const [submitStage, setSubmitStage] = useState<string>('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // يصبح true بعد أول محاولة حفظ — يُستخدم لتلوين حدود الحقول الإلزامية
  // الفارغة بالأحمر دون إزعاج المستخدم بها قبل أن يحاول الحفظ فعلياً
  const [attemptedSubmit, setAttemptedSubmit] = useState(false);

  // رقم التواصل مقصور على السعودية (+966 ثابت، لا قائمة دول) — نفس منطق
  // create/page.tsx بالضبط. contactLocalNumber تُملأ من contact_number
  // المحفوظ عند تحميل بيانات المشروع (راجع useEffect أدناه).
  const [contactLocalNumber, setContactLocalNumber] = useState('');

  // منطقة المشروع الكاملة (zone) — للعرض فقط هنا (مقفلة بعد التأسيس، نفس
  // قفل latitude/longitude الحالي). مشاريع قديمة بلا zone تُعرض كدائرة
  // افتراضية حول النقطة القديمة (buildProjectZoneFromRow).
  const [zoneValue, setZoneValue] = useState<ZonePickerValue>({
    zoneType: 'point',
    polygon: null,
    circleCenter: null,
    circleRadiusM: null,
  });

  // أجهزة الرصد الحية (project_devices) — مورد فرعي مستقل تماماً عن نموذج
  // المشروع الرئيسي: جلبه وإضافته وإلغاؤه كلها نداءات API فورية خاصة به،
  // لا تُجمَّع مع زر "حفظ التعديلات" العام. نفس مبدأ صفحات إدارة مفاتيح
  // GitHub/Stripe — مورد أمني/تشغيلي حي، لا حقل وصفي في نموذج واحد.
  interface ProjectDevice {
    id: string;
    name: string;
    lat: number | null;
    lng: number | null;
    api_key_prefix: string;
    is_active: boolean;
    last_reading_at: string | null;
    last_wind_speed_kmh: number | null;
    // خطأ مكتشَف ومُصلَح (مراجعة كود خارجي — القسم د: "لا توجد قراءة اتجاه"
    // تصنيف ثالث منفصل عن موثق/غير موثق): كان الحقل مفقوداً من الواجهة رغم
    // وجوده في DEVICE_LIST_COLUMNS فعلياً — لا كان ممكناً التمييز بين "غير
    // موثَّق لكن يرسل اتجاهاً" و"لا يرسل اتجاهاً إطلاقاً".
    last_wind_direction_deg: number | null;
    last_pm10: number | null;
    last_pm25: number | null;
    last_visibility_m: number | null;
    // توثيق الشمال الحقيقي (migration 202608190002) — راجع تعليق
    // WindDirectionEvidence الكامل في dust-compliance-engine/types.ts
    // للسبب الكامل: اتجاه رياح جهاز غير موثَّق لا يدخل تحليل الانتشار
    // المكاني (قاعدة المستقبل باتجاه الرياح)، يبقى قراءة خام للعرض فقط.
    true_north_alignment_documented: boolean | null;
    true_north_alignment_type: 'TRUE_NORTH' | 'MAGNETIC_NORTH' | null;
    true_north_verification_method: string | null;
    true_north_verified_by: string | null;
    true_north_verified_at: string | null;
    true_north_deviation_deg: number | null;
    true_north_evidence_url: string | null;
  }
  const [devices, setDevices] = useState<ProjectDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);

  // حالة ربط مصدر بيانات خارجي (provider_connections) لكل جهاز — خريطة
  // deviceId → معلومات الربط (أو undefined إن لم يُربط بعد). تُملأ بعد
  // fetchDevices (جهاز بجهاز، عدد الأجهزة صغير عادة فلا داعي لمسار مُجمَّع).
  interface ProviderConnectionInfo {
    provider: string;
    vendorStationName: string | null;
    lastPullAt: string | null;
    lastPullSuccess: boolean | null;
    lastPullError: string | null;
  }
  const [connections, setConnections] = useState<Record<string, ProviderConnectionInfo>>({});
  const [connectModalDeviceId, setConnectModalDeviceId] = useState<string | null>(null);

  const [newDeviceName, setNewDeviceName] = useState('');
  // إحداثيات موقع الجهاز الفعلي — إجبارية (طلب صريح: الربط التلقائي بأقرب
  // جهاز عند إنشاء نشاط يحتاج موقعاً فعلياً لكل جهاز، وإلا يُستبعد صامتاً من
  // الحساب — راجع resolveNearestActiveDeviceId في dust-profiles/route.ts)،
  // نص خام (لا رقم) حتى يقبل حقل فارغ أثناء الكتابة.
  const [newDeviceLat, setNewDeviceLat] = useState('');
  const [newDeviceLng, setNewDeviceLng] = useState('');
  const [addingDevice, setAddingDevice] = useState(false);
  // المفتاح الخام يُعرض هنا مرة واحدة فقط بعد الإنشاء مباشرة — لا يُخزَّن في
  // أي مكان آخر ولا يُعاد جلبه لاحقاً من الخادم (غير مسترجَع أصلاً).
  const [revealedApiKey, setRevealedApiKey] = useState<string | null>(null);

  const fetchDevices = async () => {
    setDevicesLoading(true);
    try {
      // خطأ أداء مكتشَف: كان يُطلَق طلب GET منفصل لكل جهاز (N+1) لجلب حالة
      // اتصال المزوّد الخاص به — /devices الآن يُرجع connectionsByDeviceId
      // مجمَّعة بطلب شبكة واحد إضافي فقط (راجع devices/route.ts).
      const { data } = await apiClient.get(`/projects/${projectId}/devices`);
      const list: ProjectDevice[] = data?.devices || [];
      setDevices(list);

      const connectionsByDeviceId: Record<
        string,
        { provider: string; vendor_station_name: string | null; last_pull_at: string | null; last_pull_success: boolean | null; last_pull_error: string | null }
      > = data?.connectionsByDeviceId || {};
      const next: Record<string, ProviderConnectionInfo> = {};
      for (const d of list) {
        const c = connectionsByDeviceId[d.id];
        if (c) {
          next[d.id] = {
            provider: c.provider,
            vendorStationName: c.vendor_station_name,
            lastPullAt: c.last_pull_at,
            lastPullSuccess: c.last_pull_success,
            lastPullError: c.last_pull_error,
          };
        }
      }
      setConnections(next);
    } catch (error) {
      console.error('فشل جلب أجهزة الرصد:', error);
    } finally {
      setDevicesLoading(false);
    }
  };

  useEffect(() => {
    // جدولة عبر microtask بدل استدعاء fetchDevices مباشرة من جسم الـEffect —
    // نفس الإصلاح المُطبَّق في بقية هذا الملف/الصفحات المشابهة.
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) fetchDevices(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleAddDevice = async () => {
    const name = newDeviceName.trim();
    if (!name) {
      toast.error('اسم الجهاز مطلوب');
      return;
    }
    // إحداثيات إجبارية — لا يُسمح بحفظ جهاز بلا موقع فعلي (طلب صريح).
    const latTrim = newDeviceLat.trim();
    const lngTrim = newDeviceLng.trim();
    if (!latTrim || !lngTrim) {
      toast.error('إحداثيات الجهاز (خط العرض وخط الطول) مطلوبة.');
      return;
    }
    const lat = Number(latTrim);
    const lng = Number(lngTrim);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      toast.error('إحداثيات غير صالحة.');
      return;
    }

    setAddingDevice(true);
    try {
      const { data } = await apiClient.post(`/projects/${projectId}/devices`, { name, lat, lng });
      setRevealedApiKey(data.apiKey);
      setNewDeviceName('');
      setNewDeviceLat('');
      setNewDeviceLng('');
      await fetchDevices();
      toast.success('تم إنشاء الجهاز بنجاح');
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل إنشاء الجهاز');
    } finally {
      setAddingDevice(false);
    }
  };

  const handleToggleDevice = async (device: ProjectDevice) => {
    try {
      await apiClient.patch(`/projects/${projectId}/devices/${device.id}`, { is_active: !device.is_active });
      await fetchDevices();
      toast.success(device.is_active ? 'تم إلغاء الجهاز' : 'تم إعادة تفعيل الجهاز');
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل تحديث حالة الجهاز');
    }
  };

  const handleDeleteDevice = async (device: ProjectDevice) => {
    try {
      await apiClient.delete(`/projects/${projectId}/devices/${device.id}`);
      await fetchDevices();
      toast.success('تم حذف الجهاز');
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل حذف الجهاز');
    }
  };

  // توثيق الشمال الحقيقي (migration 202608190002) — نافذة تحرير منفصلة لكل
  // جهاز على حدة (لا تُجمَّع مع نموذج المشروع الرئيسي، نفس مبدأ بقية إدارة
  // الأجهزة في هذا الملف). trueNorthDraft يحمل حالة النموذج مؤقتاً أثناء
  // التحرير فقط، لا يُستهلَك في أي مكان آخر.
  const [trueNorthModalDeviceId, setTrueNorthModalDeviceId] = useState<string | null>(null);
  const [trueNorthDraft, setTrueNorthDraft] = useState<{
    documented: boolean;
    alignmentType: 'TRUE_NORTH' | 'MAGNETIC_NORTH';
    verificationMethod: string;
    verifiedBy: string;
    verifiedAt: string;
    deviationDeg: string;
    evidenceUrl: string;
  }>({
    documented: false,
    alignmentType: 'TRUE_NORTH',
    verificationMethod: '',
    verifiedBy: '',
    verifiedAt: '',
    deviationDeg: '',
    evidenceUrl: '',
  });
  const [savingTrueNorth, setSavingTrueNorth] = useState(false);

  const openTrueNorthModal = (device: ProjectDevice) => {
    setTrueNorthDraft({
      documented: device.true_north_alignment_documented === true,
      alignmentType: device.true_north_alignment_type ?? 'TRUE_NORTH',
      verificationMethod: device.true_north_verification_method ?? '',
      verifiedBy: device.true_north_verified_by ?? '',
      verifiedAt: device.true_north_verified_at ? device.true_north_verified_at.slice(0, 10) : '',
      deviationDeg: device.true_north_deviation_deg != null ? String(device.true_north_deviation_deg) : '',
      evidenceUrl: device.true_north_evidence_url ?? '',
    });
    setTrueNorthModalDeviceId(device.id);
  };

  const handleSaveTrueNorth = async () => {
    if (!trueNorthModalDeviceId) return;
    if (
      trueNorthDraft.documented &&
      (!trueNorthDraft.verificationMethod.trim() || !trueNorthDraft.verifiedBy.trim() || !trueNorthDraft.verifiedAt)
    ) {
      toast.error('توثيق الشمال الحقيقي غير مكتمل — طريقة التحقق ومن قام به وتاريخه مطلوبة جميعاً');
      return;
    }
    setSavingTrueNorth(true);
    try {
      await apiClient.patch(`/projects/${projectId}/devices/${trueNorthModalDeviceId}`, {
        true_north_alignment_documented: trueNorthDraft.documented,
        true_north_alignment_type: trueNorthDraft.alignmentType,
        true_north_verification_method: trueNorthDraft.verificationMethod,
        true_north_verified_by: trueNorthDraft.verifiedBy,
        true_north_verified_at: trueNorthDraft.verifiedAt ? new Date(trueNorthDraft.verifiedAt).toISOString() : null,
        true_north_deviation_deg: trueNorthDraft.deviationDeg.trim() ? Number(trueNorthDraft.deviationDeg) : null,
        true_north_evidence_url: trueNorthDraft.evidenceUrl,
      });
      await fetchDevices();
      setTrueNorthModalDeviceId(null);
      toast.success('تم تحديث توثيق الشمال الحقيقي');
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل تحديث التوثيق');
    } finally {
      setSavingTrueNorth(false);
    }
  };

  const deviceReadingAgeLabel = (isoTime: string | null): string => {
    if (!isoTime) return 'لا توجد قراءات بعد';
    const ageMinutes = Math.round((nowTs - new Date(isoTime).getTime()) / 60000);
    if (ageMinutes < 1) return 'الآن';
    if (ageMinutes < 60) return `منذ ${ageMinutes} د`;
    const hours = Math.round(ageMinutes / 60);
    return `منذ ${hours} س`;
  };
  // نفس عتبة الحداثة DEVICE_READING_FRESHNESS_MINUTES في app/lib/dustEvaluation.ts —
  // للعرض التحذيري فقط هنا (القيمة الفعلية المستخدمة في التقييم محسوبة في السيرفر).
  const isDeviceReadingStale = (isoTime: string | null): boolean => {
    if (!isoTime) return true;
    return (nowTs - new Date(isoTime).getTime()) / 60000 > 20;
  };

  // ورديات عمل حقيقية (اختياري) — نفس بنية create/page.tsx بالضبط، لكن
  // تُملأ من project.shifts المُرجَعة من GET /api/projects/[id] (قادمة من
  // جدول project_shifts المنفصل) بدل البدء فارغة دائماً.
  interface ProjectShiftForm { id?: string; name: string; start_time: string; end_time: string }
  const [shifts, setShifts] = useState<ProjectShiftForm[]>([]);
  const addShift = () => setShifts((prev) => [...prev, { name: '', start_time: '', end_time: '' }]);
  const removeShift = (index: number) => setShifts((prev) => prev.filter((_, i) => i !== index));
  const updateShift = (index: number, field: keyof ProjectShiftForm, value: string) => {
    setShifts((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };
  // كل وردية يجب أن تقع بالكامل ضمن نطاق الدوام الرسمي (بداية/نهاية الدوام)
  // — نفس القيد المطبَّق في create/page.tsx تماماً.
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

  const [projectForm, setProjectForm] = useState({
    name: '',
    client_name: '',
    city: '',
    neighborhood: '',
    project_status: 'not_started' as 'not_started' | 'in_progress',
    project_type: 'أبراج وإنشاءات',
    // طبيعة الأرض (نوع التربة) — نفس create/page.tsx
    soil_type: '' as '' | 'SANDY_FINE' | 'SANDY_COARSE' | 'CLAY' | 'MIXED',
    latitude: 24.7136,
    longitude: 46.6753,
    terrain_type: 'suburban',
    site_location_nature: '',
    wind_exposure: 'medium',
    start_date: '',
    end_date: '',
    work_days: '',
    work_days_list: [] as string[],
    work_hours_start: '',
    work_hours_end: '',
    project_manager: '',
    contact_number: '',

    // ملف امتثال الغبار التنظيمي (اختياري) — راجع dust-compliance-engine
    site_area_m2: '' as string | number,
    daily_truck_movements: '' as string | number,
    has_onsite_crusher: false,
    has_onsite_batching_plant: false,
    dmp_approval_status: 'UNKNOWN' as
      | 'NOT_REQUIRED' | 'NOT_STARTED' | 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'UNKNOWN',

    // التزامات الرصد التنظيمية (اختياري) — تؤثر فقط على درجة الثقة
    // (confidenceScore) في قرار الامتثال لمشاريع الفئة الثانية/الثالثة؛
    // تركها فارغاً يعني "غير معروف" وليس مخالفة، لكنه قد يخفض الثقة تحت 70
    // فيتحول قرار "مسموح" تلقائياً إلى "يتطلب تحقق ميداني".
    baseline_monitoring_days: '' as string | number,
    monitoring_logging_interval_minutes: '' as string | number,
    anemometer_height_m: '' as string | number,
    entry_exit_cameras_installed: false,
    camera_retention_days: '' as string | number,
    sensitivity_map_prepared: false,

    // إقرار المستخدم بصحة البيانات وتحمّل المسؤولية الكاملة عنها — نفس
    // create/page.tsx
    data_accuracy_confirmed: false,
  });

  useEffect(() => {
    // جدولة عبر microtask بدل استدعاء setMounted مباشرة من جسم الـEffect —
    // تعديل حالة متزامن مباشر داخل Effect (راجع نفس الإصلاح في fetchHistory
    // بصفحة readings/page.tsx وfetchDashboardData بصفحة [id]/page.tsx).
    let cancelledMount = false;
    void Promise.resolve().then(() => { if (!cancelledMount) setMounted(true); });

    // 1. جلب بيانات المشروع عبر الـ API
    const fetchProjectData = async () => {
      try {
        // مسار خفيف مخصص (settings-summary، لا GET /projects/[projectId]
        // الثقيل) — خطأ أداء مكتشَف: صفحة الإعدادات كانت تدفع تكلفة حساب
        // DVI/امتثال/OSM الكاملة (المخصصة للوحة المشروع) رغم أنها لا تعرض
        // أياً من تلك النتائج، فقط حقول نموذج بسيطة من صف projects الخام.
        // راجع app/api/projects/[projectId]/settings-summary/route.ts.
        const { data } = await apiClient.get(`/projects/${projectId}/settings-summary`);
        const projectData = data.project; // استخراج كائن المشروع من الاستجابة

        if (projectData) {
          // توحيد حالة المشروع مع create/page.tsx: "لم يبدأ"/"جاري" فقط.
          // مشاريع قديمة محفوظة بقيم تفصيلية سابقة (site_prep، excavation،
          // إلخ) تُعامَل كـ"جاري" (العمل بدأ فعلياً)، وnot_started/فارغ يبقى
          // "لم يبدأ" — بلا فقدان أي بيانات فعلية (project_status الأصلية
          // القديمة لا تُقرأ في أي مكان آخر بعد هذا التوحيد).
          const normalizedStatus: 'not_started' | 'in_progress' =
            !projectData.project_status || projectData.project_status === 'not_started'
              ? 'not_started'
              : 'in_progress';

          setProjectForm({
            name: projectData.name || '',
            client_name: projectData.client_name || '',
            city: projectData.city || '',
            neighborhood: projectData.neighborhood || '',
            project_status: normalizedStatus,
            project_type: projectData.project_type || 'أبراج وإنشاءات',
            soil_type: projectData.soil_type || '',
            latitude: projectData.latitude || 24.7136,
            longitude: projectData.longitude || 46.6753,
            terrain_type: projectData.terrain_type || 'suburban',
            site_location_nature: projectData.site_location_nature || '',
            wind_exposure: projectData.wind_exposure || 'medium',
            start_date: projectData.start_date || '',
            end_date: projectData.end_date || '',
            work_days: projectData.work_days || '',
            work_days_list: Array.isArray(projectData.work_days_list) ? projectData.work_days_list : ['sun', 'mon', 'tue', 'wed', 'thu'],
            work_hours_start: projectData.work_hours_start || '',
            work_hours_end: projectData.work_hours_end || '',
            project_manager: projectData.project_manager || '',
            contact_number: projectData.contact_number || '',

            site_area_m2: projectData.site_area_m2 ?? '',
            daily_truck_movements: projectData.daily_truck_movements ?? '',
            has_onsite_crusher: !!projectData.has_onsite_crusher,
            has_onsite_batching_plant: !!projectData.has_onsite_batching_plant,
            dmp_approval_status: projectData.dmp_approval_status || 'UNKNOWN',

            baseline_monitoring_days: projectData.baseline_monitoring_days ?? '',
            monitoring_logging_interval_minutes: projectData.monitoring_logging_interval_minutes ?? '',
            anemometer_height_m: projectData.anemometer_height_m ?? '',
            entry_exit_cameras_installed: !!projectData.entry_exit_cameras_installed,
            camera_retention_days: projectData.camera_retention_days ?? '',
            sensitivity_map_prepared: !!projectData.sensitivity_map_prepared,

            data_accuracy_confirmed: !!projectData.data_accuracy_confirmed,
          });

          // فصل contact_number المحفوظ (E.164 كامل، مثال: +966501234567) إلى
          // الرقم المحلي فقط لتعبئة حقل الإدخال (مفتاح +966 ثابت في الواجهة).
          if (projectData.contact_number) {
            const parsedPhone = parsePhoneNumberFromString(projectData.contact_number, 'SA');
            // مشروع قديم برقم من دولة أخرى (قبل تقييد الحقل بالسعودية فقط):
            // يُعرض الرقم المحفوظ كاملاً كما هو بدل فقدانه أو بتره خطأً.
            setContactLocalNumber(
              parsedPhone && parsedPhone.country === 'SA' ? parsedPhone.nationalNumber : projectData.contact_number
            );
          }

          // ورديات العمل — project.shifts مرفَقة من route.ts (GET) من جدول
          // project_shifts المنفصل، مرتّبة بـ sort_order أصلاً.
          if (Array.isArray(projectData.shifts)) {
            setShifts(
              projectData.shifts.map((s: { id?: string; name?: string; start_time?: string; end_time?: string }) => ({
                id: s.id,
                name: s.name || '',
                start_time: s.start_time ? String(s.start_time).slice(0, 5) : '',
                end_time: s.end_time ? String(s.end_time).slice(0, 5) : '',
              }))
            );
          }

          // buildProjectZoneFromRow يُرجع دائرة افتراضية (100م) حول النقطة
          // القديمة تلقائياً لأي مشروع بلا zone_type محفوظ، ما دام لديه
          // latitude/longitude — لا يبقى 'point' فعلياً إلا بغياب الإحداثيات.
          const zone = buildProjectZoneFromRow(projectData);
          setZoneValue({
            zoneType: zone.zoneType,
            polygon: zone.polygon,
            circleCenter: zone.circleCenter,
            circleRadiusM: zone.circleRadiusM,
          });
        }
      } catch (error) {
        toast.error('حدث خطأ أثناء جلب بيانات المشروع');
        console.error(error);
      } finally {
        setFetching(false);
      }
    };

    fetchProjectData();
    return () => {
      cancelledMount = true;
      setMounted(false);
    };
  }, [projectId]);

  const handleProjectChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setProjectForm(prev => ({
      ...prev,
      [name]: type === 'number' ? (value === '' ? 0 : parseFloat(value) || 0) : value
    }));
  };

  // يعيد بناء contact_number (E.164 كامل) من الرقم المحلي مع مفتاح السعودية
  // الثابت (+966) — نفس منطق create/page.tsx بالضبط.
  const handleContactLocalNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // رقم الجوال السعودي بعد +966 يتكون من 9 أرقام فقط (5XXXXXXXX) — نفس
    // منطق create/page.tsx بالضبط.
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
  // لأن الفراغ هنا يعني "غير معروف" (وليس صفر)، ولأنها تشمل checkboxes.
  const handleComplianceFieldChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    if (type === 'checkbox') {
      const checked = (e.target as HTMLInputElement).checked;
      setProjectForm(prev => ({ ...prev, [name]: checked }));
      return;
    }
    setProjectForm(prev => ({ ...prev, [name]: value }));
  };

  const toggleWorkDay = (dayId: string) => {
    setProjectForm((prev) => {
      const list = prev.work_days_list.includes(dayId)
        ? prev.work_days_list.filter((d) => d !== dayId)
        : [...prev.work_days_list, dayId];
      const ordered = WEEK_DAYS.filter((d) => list.includes(d.id)).map((d) => d.id);
      const arabic = WEEK_DAYS.filter((d) => ordered.includes(d.id)).map((d) => d.label).join('، ');
      return { ...prev, work_days_list: ordered, work_days: arabic };
    });
  };

  // فحص امتثال الغبار التنظيمي المرجعي — نفس منطق تصنيف الفئة في
  // dust-compliance-engine (classifyProject). بخلاف create/page.tsx (توعوي
  // فقط هناك لأن الأجهزة لا يمكن أن توجد قبل حفظ المشروع)، هذا هو المكان
  // الوحيد الذي توجد فيه أجهزة رصد حقيقية (project_devices) للتحقق منها،
  // فالفحص هنا إلزامي فعلاً لحالة "جاري" (راجع validateBasicFields أدناه).
  // stationCount = عدد الأجهزة *النشطة* فقط (devices.filter(is_active)) —
  // جهاز مُلغى لا يقدر يرسل قراءات (requireDeviceApiKey يرفضه)، فعدّه ضمن
  // الحد الأدنى يعطي إشارة امتثال زائفة.
  const complianceCheck = () => {
    const areaM2 = projectForm.site_area_m2 === '' ? null : Number(projectForm.site_area_m2);
    const truckMovements = projectForm.daily_truck_movements === '' ? null : Number(projectForm.daily_truck_movements);
    const stationCount = devices.filter((d) => d.is_active).length;

    let riskClass: 'CATEGORY_I_LOW' | 'CATEGORY_II_MEDIUM' | 'CATEGORY_III_HIGH' | 'UNCLASSIFIED';
    if (areaM2 !== null && areaM2 > 5000) riskClass = 'CATEGORY_III_HIGH';
    else if (truckMovements !== null && truckMovements > 50) riskClass = 'CATEGORY_III_HIGH';
    else if (projectForm.has_onsite_crusher) riskClass = 'CATEGORY_III_HIGH';
    else if (projectForm.has_onsite_batching_plant) riskClass = 'CATEGORY_III_HIGH';
    else if (areaM2 === null) riskClass = 'UNCLASSIFIED';
    else if (areaM2 >= 2000) riskClass = 'CATEGORY_II_MEDIUM';
    else riskClass = 'CATEGORY_I_LOW';

    // نفس صيغة buildMonitoringObligations (dust-compliance-engine/engine.ts)
    // حرفياً — بوابة monitoringApplies أولاً، ثم الرقم الفعلي.
    const monitoringApplies = riskClass === 'CATEGORY_II_MEDIUM' || riskClass === 'CATEGORY_III_HIGH';
    const minStations = monitoringApplies ? (riskClass === 'CATEGORY_III_HIGH' ? 2 : 1) : 0;

    const warnings: string[] = [];

    // بيانات ناقصة تمنع تصنيف فئة المشروع أصلاً — تحذير مباشر لأن الحقول
    // إلزامية تنظيمياً وليست اختيارية، حتى قبل الوصول لأي حد أو عتبة.
    if (areaM2 === null) {
      warnings.push('مساحة الموقع غير مُدخلة — مطلوبة لتصنيف فئة مخاطر الغبار للمشروع.');
    }
    if (truckMovements === null) {
      warnings.push('حركة الشاحنات اليومية غير مُدخلة — مطلوبة لتصنيف فئة مخاطر الغبار للمشروع.');
    }
    if (minStations > 0 && stationCount < minStations) {
      warnings.push(`الحد الأدنى التنظيمي لعدد أجهزة الرصد لهذه الفئة هو ${minStations} — لديك حالياً ${stationCount} جهاز نشط.`);
    }
    if (truckMovements !== null && truckMovements > 50) {
      warnings.push(`حركة الشاحنات اليومية (${truckMovements} رحلة) تتجاوز 50 رحلة — يتطلب جهازي رصد على الأقل.`);
    }
    if (projectForm.has_onsite_crusher) {
      warnings.push('وجود كسارة داخل الموقع — يتطلب جهازي رصد على الأقل.');
    }
    if (projectForm.has_onsite_batching_plant) {
      warnings.push('وجود محطة خلط خرساني (خلاطة) داخل الموقع — يتطلب جهازي رصد على الأقل.');
    }
    const dmpMissing = projectForm.dmp_approval_status !== 'APPROVED' && projectForm.dmp_approval_status !== 'NOT_REQUIRED';
    if (dmpMissing) {
      warnings.push('لا توجد خطة معتمدة لإدارة الغبار (DMP) — مطلوبة قبل بدء العمل الفعلي في الموقع.');
    }

    return { riskClass, minStations, stationCount, dmpMissing, warnings };
  };

  // الحقول الأربعة الأساسية (اسم/يوم عمل/الإقرار — بلا منطقة KML هنا لأنها
  // مقفلة بعد التأسيس) إلزامية دائماً. بقية الحقول (بيانات الموقع، امتثال
  // الغبار) تصبح إلزامية فقط عند حالة "جاري"، بنفس منطق create/page.tsx
  // تماماً.
  const validateBasicFields = (): string[] => {
    const errors: string[] = [];

    if (!projectForm.name.trim()) errors.push('اسم المشروع مطلوب.');
    if (projectForm.work_days_list.length === 0) errors.push('اختر يوم عمل واحداً على الأقل.');
    if (!projectForm.data_accuracy_confirmed) {
      errors.push('يجب الإقرار بصحة البيانات المُدخلة وتحمّل المسؤولية الكاملة عنها قبل الحفظ.');
    }

    if (
      projectForm.start_date &&
      projectForm.end_date &&
      new Date(projectForm.end_date).getTime() < new Date(projectForm.start_date).getTime()
    ) {
      errors.push('تاريخ الانتهاء المتوقع لا يمكن أن يكون قبل تاريخ البدء.');
    }

    errors.push(...validateShifts());

    if (projectForm.project_status === 'in_progress') {
      if (!projectForm.client_name.trim()) errors.push('اسم العميل مطلوب.');
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
        errors.push('لا يمكن حفظ مشروع بحالة "جاري" بلا خطة معتمدة لإدارة الغبار (DMP) — حدّث حالة اعتماد DMP أو اختر حالة "لم يبدأ".');
      }
      if (minStations > 0 && stationCount < minStations) {
        errors.push(`لا يمكن حفظ مشروع بحالة "جاري" بعدد أجهزة رصد نشطة أقل من الحد التنظيمي (${minStations} لهذه الفئة، لديك ${stationCount}) — أضف أجهزة من قسم "أجهزة الرصد الحية" أدناه، أو اختر حالة "لم يبدأ".`);
      }
    }

    return errors;
  };

  // 2. تحديث بيانات المشروع عبر الـ API
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttemptedSubmit(true);

    const validationErrors = validateBasicFields();
    if (validationErrors.length > 0) {
      validationErrors.forEach((msg) => toast.error(msg));
      return;
    }

    setLoading(true);
    setSubmitStage('جاري حفظ التعديلات...');

    try {
      const updatePayload: Record<string, unknown> = {
        ...projectForm,
        site_area_m2: projectForm.site_area_m2 === '' ? null : Number(projectForm.site_area_m2),
        daily_truck_movements: projectForm.daily_truck_movements === '' ? null : Number(projectForm.daily_truck_movements),
        baseline_monitoring_days: projectForm.baseline_monitoring_days === '' ? null : Number(projectForm.baseline_monitoring_days),
        monitoring_logging_interval_minutes: projectForm.monitoring_logging_interval_minutes === '' ? null : Number(projectForm.monitoring_logging_interval_minutes),
        anemometer_height_m: projectForm.anemometer_height_m === '' ? null : Number(projectForm.anemometer_height_m),
        camera_retention_days: projectForm.camera_retention_days === '' ? null : Number(projectForm.camera_retention_days),
        // أجهزة الرصد (project_devices) لم تعد جزءاً من هذا الـ payload —
        // تُدار بنداءات API فورية مستقلة من قسم "أجهزة الرصد الحية" أدناه.
        // ورديات العمل — مصفوفة صريحة (حتى لو فارغة []) تعني "استبدل كل
        // ورديات المشروع بهذه القائمة" في PATCH /api/projects/[id] (راجع
        // معالجة shifts هناك: تمييز [] الصريحة عن غياب المفتاح تماماً).
        shifts: shifts.filter((s) => s.name.trim() && s.start_time && s.end_time),
        soil_type: projectForm.soil_type || null,
        data_accuracy_confirmed_at: projectForm.data_accuracy_confirmed ? new Date().toISOString() : null,
      };

      // تنظيف البيانات (لا نحذف المصفوفات — فقط النصوص/القيم الفارغة)
      Object.keys(updatePayload).forEach((key) => {
        const v = updatePayload[key];
        if (!Array.isArray(v) && (v === '' || v === null || v === undefined)) {
          delete updatePayload[key];
        }
      });

      await apiClient.patch(`/projects/${projectId}`, updatePayload);

      toast.success('تم تحديث بيانات المشروع بنجاح');
      // خطأ مكتشَف ومُصلَح (طلب مستخدم صريح — "ساعات العمل ما تنحفظ"، ثم
      // تأكيد أن حتى اسم المشروع/العميل لا يتحدثان: المشكلة عامة لكل الحقول،
      // لا خاصة بحقل واحد): هذه الصفحة "use client" بالكامل، وبيانات
      // المشروع تُجلَب داخل useEffect بلا اعتماد على تغيّر projectId (mount
      // واحد فقط). العودة لاحقاً لصفحة الإعدادات (بعد الانتقال لصفحة
      // التفاصيل) كانت تُعيد استخدام Next.js Router Cache لنفس المكوّن بدل
      // إعادة تركيبه (remount) وإعادة تنفيذ ذلك الـuseEffect من الصفر — فتظل
      // القيم القديمة معروضة رغم نجاح الحفظ الفعلي بقاعدة البيانات.
      // router.refresh() وحدها لا تكفي (تُبطل كاش Server Components فقط، لا
      // تفرض remount على مكوّن client). الحل القاطع: تنقّل صلب حقيقي
      // (window.location.href) يفرض تحميل الصفحة بالكامل من الصفر — لا mount
      // جزئي، فتُجلب بيانات المشروع الطازجة دائماً عند أي عودة لاحقة.
      hardNavigate(`/dashboard/Projects/${projectId}`);
      return;

    } catch (error) {
      toast.error(`فشل التحديث: ${getApiErrorMessage(error) || 'خطأ غير متوقع'}`);
    } finally {
      setLoading(false);
      setSubmitStage('');
    }
  };

  // 3. أرشفة المشروع عبر الـ API — لم يعد حذفاً فعلياً (راجع تعليق DELETE
  // في app/api/projects/[projectId]/route.ts): المشروع يُخفى من القوائم
  // النشطة، لكن كل الأدلة المرتبطة (تنبيهات/قرارات/تقييمات) تبقى محفوظة
  // بالكامل لأغراض التدقيق. نفس نقطة النهاية (DELETE /projects/:id)، فقط
  // السلوك الفعلي خلفها تغيّر.
  const handleDelete = async () => {
    setLoading(true);
    try {
      await apiClient.delete(`/projects/${projectId}`);
      toast.success('تمت أرشفة المشروع بنجاح');
      router.push('/dashboard/Projects');
    } catch (error) {
      const message = getApiErrorMessage(error) || 'فشل الأرشفة من الخادم';
      toast.error(`فشل الأرشفة: ${message}`);
      setLoading(false);
    }
  };

  if (fetching) {
    return <div className="min-h-screen flex items-center justify-center bg-[#F4F7FB] text-[#061B40] font-bold">جاري تحميل الإعدادات...</div>;
  }

  const inputClass = "w-full bg-[#F4F7FB] border border-[#061B40]/20 rounded-lg p-2 text-sm text-[#061B40] focus:outline-none focus:ring-1 focus:ring-[#3995FF] focus:border-[#3995FF] transition-all";
  const lockedInputClass = "w-full bg-slate-100 border border-slate-200 rounded-lg p-2 text-sm text-slate-500 cursor-not-allowed focus:outline-none";
  const labelClass = "block text-xs font-semibold text-[#061B40]/70 mb-1";
  const sectionTitleClass = "text-sm font-bold text-[#061B40] border-r-4 border-[#3995FF] pr-2 bg-[#F4F7FB] py-1.5 rounded-l-md shadow-sm mb-3 flex items-center justify-between";

  // حدود حمراء لحقول امتثال الغبار التنظيمي الإلزامية إذا تُركت فارغة بعد
  // أول محاولة حفظ — تحذير بصري فقط، لا يمنع الإرسال (راجع complianceCheck)
  const complianceInputClass = (isEmpty: boolean) =>
    `${inputClass} ${attemptedSubmit && isEmpty ? 'border-red-400 focus:ring-red-400 focus:border-red-400 bg-red-50/40' : ''}`;

  return (
    // ... الواجهة تبقى كما هي تماماً بدون تغيير
    <div className="min-h-screen bg-[#F4F7FB] text-[#061B40] p-4 md:p-8 flex flex-col items-center justify-center font-sans" dir="rtl">
      <div className="w-full max-w-7xl bg-white border border-[#061B40]/10 rounded-2xl shadow-xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">

        <div className="p-6 space-y-6 lg:col-span-8 border-l border-[#061B40]/10 h-[85vh] overflow-y-auto custom-scrollbar flex flex-col justify-between">
          
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-2xl font-black text-[#061B40]">إعدادات المشروع</h1>
                <p className="text-xs text-[#061B40]/60 mt-1">تعديل البيانات الأساسية وإدارة المشروع.</p>
              </div>
              <Link
                href={`/dashboard/Projects/${projectId}`}
                className="bg-white border border-slate-200 hover:bg-[#F4F7FB] text-[#061B40] px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all"
              >
                <ArrowRight className="w-4 h-4 text-[#3995FF]" /> عودة
              </Link>
            </div>

            {/* القسم 1: البيانات الأساسية والموقع */}
            <div className="space-y-3">
              <h2 className={sectionTitleClass}>البيانات الأساسية والموقع</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className={labelClass}>اسم المشروع</label>
                  <input required type="text" name="name" value={projectForm.name} onChange={handleProjectChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>اسم العميل</label>
                  <input type="text" name="client_name" value={projectForm.client_name} onChange={handleProjectChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>حالة المشروع</label>
                  <select name="project_status" value={projectForm.project_status} onChange={handleProjectChange} className={inputClass}>
                    <option value="not_started">لم يبدأ</option>
                    <option value="in_progress">جاري</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="flex flex-col gap-2">
                  <label className={labelClass}>المدينة <span className="text-[10px] text-red-500">(مقفلة)</span></label>
                  <input type="text" name="city" value={projectForm.city} readOnly className={lockedInputClass} />
                </div>
                <div className="flex flex-col gap-2">
                  <label className={labelClass}>الحي <span className="text-[10px] text-red-500">(مقفلة)</span></label>
                  <input type="text" name="neighborhood" value={projectForm.neighborhood} readOnly className={lockedInputClass} />
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

            {/* قسم امتثال الغبار التنظيمي — إلزامي فعلياً (يمنع الحفظ) فقط
                عند حالة المشروع "جاري"؛ لحالة "لم يبدأ" يبقى تحذيرياً فقط،
                بنفس منطق create/page.tsx تماماً. */}
            <div className="space-y-3 pt-3 border-t border-[#061B40]/5">
              <div className="flex items-center justify-between mb-1">
                <h2 className={`text-sm font-bold text-[#061B40] border-r-4 pr-2 bg-[#F4F7FB] py-1.5 rounded-l-md shadow-sm flex items-center gap-2 ${projectForm.project_status === 'in_progress' ? 'border-red-500' : 'border-amber-500'}`}>
                  <Gauge className={`w-4 h-4 ${projectForm.project_status === 'in_progress' ? 'text-red-500' : 'text-amber-500'}`} />
                  امتثال الغبار التنظيمي
                </h2>
                <span className={`text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1 ${projectForm.project_status === 'in_progress' ? 'text-red-700 bg-red-100' : 'text-amber-700 bg-amber-100'}`}>
                  <AlertTriangle className="w-3 h-3" />
                  {projectForm.project_status === 'in_progress' ? 'إلزامي — يمنع الحفظ' : 'إلزامي تنظيمياً'}
                </span>
              </div>
              <p className="text-[11px] font-semibold text-[#061B40]/50 -mt-1">
                {projectForm.project_status === 'in_progress'
                  ? 'مشروع "جاري" يعني أن العمل بدأ فعلياً في الموقع — لا يمكن حفظه ببيانات امتثال ناقصة.'
                  : 'مطلوبة بموجب لوائح الغبار التنظيمية للرياض لتصنيف فئة مخاطر المشروع. تركها فارغة لا يمنع الحفظ الآن، لكنه يُظهر تحذيراً أدناه ويُبقي المشروع "غير مصنَّف".'}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
               
                <div>
                  <label className={labelClass}>حركة الشاحنات اليومية (رحلة/يوم)</label>
                  <input type="number" name="daily_truck_movements" placeholder="مثال: 20" value={projectForm.daily_truck_movements} onChange={handleComplianceFieldChange} className={complianceInputClass(projectForm.daily_truck_movements === '')} />
                  {attemptedSubmit && projectForm.daily_truck_movements === '' && (
                    <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي تنظيمياً — تركه فارغاً يُبقي المشروع &quot;غير مصنَّف&quot;.</p>
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
                    يوجد محطة خلط خرساني داخل الموقع
                  </label>
                </div>
              </div>

              {/* تنبيهات مرجعية بنفس منطق تصنيف الفئة والتزامات الرصد المعتمد
                  في محرك الامتثال التنظيمي — تصبح إلزامية (تمنع الحفظ فعلياً
                  عبر validateBasicFields) عند اختيار حالة المشروع "جاري"،
                  وتبقى توعية غير مانعة لحالة "لم يبدأ"، بنفس منطق
                  create/page.tsx تماماً. */}
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
                        : 'تنبيه مرجعي — سيصبح إلزامياً عند اختيار حالة "جاري"'}
                    </p>
                    {warnings.map((w, i) => (
                      <p key={i} className={`text-[11px] font-bold pr-5 ${isMandatory ? 'text-red-700' : 'text-amber-700'}`}>⚠ {w}</p>
                    ))}
                  </div>
                );
              })()}
            </div>

           
            {/* القسم 2: الجدولة وإدارة المشروع */}
            <div className="space-y-3 pt-3 border-t border-[#061B40]/5">
              <h2 className={sectionTitleClass}>الجدولة وفريق العمل</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <label className={labelClass}>تاريخ البدء</label>
                  <input type="date" name="start_date" value={projectForm.start_date} onChange={handleProjectChange} className={inputClass} />
                </div>
                <div>
                  <label className={labelClass}>تاريخ الانتهاء</label>
                  <input type="date" name="end_date" value={projectForm.end_date} onChange={handleProjectChange} className={inputClass} />
                </div>
                <div className="md:col-span-2 lg:col-span-3">
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
                <div>
                  <label className={labelClass}>مدير المشروع</label>
                  <input type="text" name="project_manager" value={projectForm.project_manager} onChange={handleProjectChange} className={complianceInputClass(!projectForm.project_manager.trim())} />
                  {attemptedSubmit && !projectForm.project_manager.trim() && (
                    <p className="text-[10px] font-bold text-red-500 mt-1">حقل إلزامي.</p>
                  )}
                </div>
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

              {/* ورديات العمل (اختياري) — نفس منطق create/page.tsx تماماً. */}
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
                    بلا ورديات معرَّفة، يُعتمد على بداية/نهاية الدوام أعلاه كنافذة عمل واحدة لكل النشاطات — يجب أن تقع كل وردية ضمن نطاق الدوام الرسمي.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {shifts.map((shift, i) => {
                      // تنبيه فوري لحظة الإدخال (لا ينتظر محاولة الحفظ) —
                      // نفس منطق create/page.tsx تماماً.
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
                        <div key={shift.id ?? i}>
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
 {/* أجهزة الرصد الحية — مورد فرعي مستقل عن نموذج المشروع (نداءات
              API فورية خاصة به، لا تُجمَّع مع "حفظ التعديلات" أعلاه). كل
              جهاز يرسل قراءات لحظية عبر POST /api/devices/ingest بمفتاحه
              الخاص، وتُستخدم هذه القراءات في محرك DVI بأولوية أعلى من
              القيم اليدوية وتقدير الطقس (راجع computeDviResult). */}
          <div className="mt-8 pt-6 border-t border-[#061B40]/10">
            <h2 className={sectionTitleClass}>
              <span className="flex items-center gap-2"><Radar className="w-4 h-4 text-[#3995FF]" /> أجهزة الرصد الحية</span>
            </h2>
            <p className="text-[11px] font-bold text-[#061B40]/50 mb-3">
              كل جهاز يحصل على مفتاح خاص لإرسال قراءات لحظية (سرعة/اتجاه الرياح، PM10، PM2.5، الرؤية) عبر
              <code dir="ltr" className="mx-1 px-1.5 py-0.5 bg-[#F4F7FB] rounded text-[10px]">POST /api/devices/ingest</code>
              — تحل هذه القراءات محل بيانات الطقس التقديرية طالما كانت حديثة (خلال آخر 10 دقائق).
              {' '}
              <Link href="/api-docs/devices" target="_blank" className="text-[#3995FF] hover:underline font-black">
                توثيق ربط الأجهزة (لمورّد المحطة) ←
              </Link>
            </p>

            {/* تحذير حي بعدد الأجهزة النشطة مقابل الحد التنظيمي — يتحدّث
                فوراً مع كل إضافة/إلغاء جهاز، بلا انتظار محاولة حفظ الفورم
                الكبير. نفس complianceCheck() المستخدمة في التحقق الإلزامي
                أدناه، فلا يمكن أن يختلف العرضان أبداً. */}
            {(() => {
              const { minStations, stationCount } = complianceCheck();
              if (minStations === 0 || stationCount >= minStations) return null;
              return (
                <div className="mb-4 rounded-lg p-3 border bg-amber-50 border-amber-200">
                  <p className="text-[11px] font-bold text-amber-700 flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {stationCount} من {minStations} جهاز رصد نشط مطلوب لفئة هذا المشروع — لن يمكن حفظ حالة &quot;جاري&quot; حتى يكتمل العدد.
                  </p>
                </div>
              );
            })()}

            {revealedApiKey && (
              <div className="mb-4 bg-amber-50 border-2 border-amber-300 rounded-xl p-4 space-y-2">
                <p className="text-[12px] font-bold text-amber-800">
                  ⚠ احفظ هذا المفتاح الآن — لن يُعرض مرة أخرى بعد إغلاق هذه الرسالة.
                </p>
                <div className="flex items-center gap-2">
                  <code dir="ltr" className="flex-1 bg-white border border-amber-200 rounded-lg px-3 py-2 text-[12px] font-mono text-[#061B40] overflow-x-auto">
                    {revealedApiKey}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(revealedApiKey);
                      toast.success('تم نسخ المفتاح');
                    }}
                    className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold px-3 py-2 rounded-lg transition-all"
                  >
                    نسخ
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setRevealedApiKey(null)}
                  className="text-[11px] font-bold text-amber-700 hover:underline"
                >
                  حفظتُ المفتاح، إغلاق
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr_auto] gap-2 items-end mb-1">
              <div>
                <label className={labelClass}>اسم الجهاز الجديد</label>
                <input
                  type="text"
                  placeholder="مثال: محطة الرصد الشمالية"
                  value={newDeviceName}
                  onChange={(e) => setNewDeviceName(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>خط العرض</label>
                <input
                  type="number"
                  step="0.000001"
                  placeholder="24.7136"
                  value={newDeviceLat}
                  onChange={(e) => setNewDeviceLat(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>خط الطول</label>
                <input
                  type="number"
                  step="0.000001"
                  placeholder="46.6753"
                  value={newDeviceLng}
                  onChange={(e) => setNewDeviceLng(e.target.value)}
                  className={inputClass}
                />
              </div>
              <button
                type="button"
                onClick={handleAddDevice}
                disabled={addingDevice}
                className="shrink-0 bg-[#3995FF] hover:bg-[#3995FF]/90 disabled:bg-gray-300 text-white text-xs font-bold px-4 py-2.5 rounded-lg transition-all"
              >
                {addingDevice ? 'جارٍ الإنشاء...' : '+ إضافة جهاز'}
              </button>
            </div>
            <p className="text-[10px] font-bold text-[#061B40]/40 mb-4">
              حدّد موقع الجهاز الفعلي (نفس إحداثيات موقع المشروع تقريباً) — مطلوب دائماً حتى يُربط الجهاز تلقائياً بأقرب نشاط عند إنشائه.
            </p>

            {devicesLoading ? (
              <p className="text-[12px] font-bold text-[#061B40]/40">جاري تحميل الأجهزة...</p>
            ) : devices.length === 0 ? (
              <p className="text-[11px] font-bold text-[#061B40]/40 bg-[#F4F7FB] border border-dashed border-[#061B40]/15 rounded-lg p-3">
                لا توجد أجهزة رصد مسجَّلة لهذا المشروع بعد.
              </p>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => {
                  const stale = isDeviceReadingStale(device.last_reading_at);
                  return (
                    <div
                      key={device.id}
                      className={`grid grid-cols-1 md:grid-cols-[1.5fr_1fr_1fr_auto] gap-2 items-center p-3 rounded-lg border ${
                        !device.is_active ? 'bg-slate-50 border-slate-200 opacity-60' : 'bg-[#F4F7FB] border-[#061B40]/10'
                      }`}
                    >
                      <div>
                        <div className="text-sm font-bold text-[#061B40]">{device.name}</div>
                        <div className="text-[10px] font-mono text-[#061B40]/40" dir="ltr">{device.api_key_prefix}…</div>
                        {device.lat != null && device.lng != null ? (
                          <div className="text-[10px] font-bold text-[#061B40]/40" dir="ltr">{device.lat.toFixed(5)}, {device.lng.toFixed(5)}</div>
                        ) : (
                          <div className="text-[10px] font-bold text-[#061B40]/30">بلا موقع محدد</div>
                        )}
                        {connections[device.id] && (
                          <div className="mt-1 flex items-center gap-1 text-[10px] font-bold">
                            <Wifi className="w-3 h-3 text-[#3995FF]" />
                            <span className="text-[#3995FF]">
                              {connections[device.id].provider === 'mock' ? 'محطة تجريبية' : connections[device.id].provider}
                              {connections[device.id].vendorStationName ? ` — ${connections[device.id].vendorStationName}` : ''}
                            </span>
                            {connections[device.id].lastPullError && (
                              <span className="text-red-500">⚠ {connections[device.id].lastPullError}</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="text-[11px] font-bold">
                        <span className={stale ? 'text-amber-600' : 'text-emerald-600'}>
                          {stale ? '⚠ ' : '● '}{deviceReadingAgeLabel(device.last_reading_at)}
                        </span>
                        {!device.is_active && <span className="block text-red-500">مُلغى</span>}
                      </div>
                      <div className="text-[10px] font-bold text-[#061B40]/60 leading-relaxed">
                        {device.last_wind_speed_kmh != null && <div>رياح: {device.last_wind_speed_kmh} كم/س</div>}
                        {device.last_pm10 != null && <div>PM10: {device.last_pm10}</div>}
                        {device.last_pm25 != null && <div>PM2.5: {device.last_pm25}</div>}
                        {/* توثيق الشمال الحقيقي (migration 202608190002) — راجع
                            resolveWindDirectionEvidence في dustEvaluation.ts.
                            ثلاث حالات منفصلة (لا اثنتان): لا توجد قراءة اتجاه
                            إطلاقاً (لا معنى للتوثيق بلا قراءة أصلاً) — تختلف
                            عن "يرسل اتجاهاً لكن غير موثَّق" (القراءة موجودة،
                            لكن لن تدخل تحليل الانتشار حتى يُوثَّق الجهاز). */}
                        {device.last_wind_direction_deg == null ? (
                          <div className="text-slate-400">لا توجد قراءة اتجاه</div>
                        ) : device.true_north_alignment_documented === true ? (
                          <div className="text-emerald-600">✓ موثق للشمال الحقيقي</div>
                        ) : (
                          <div className="text-amber-600">⚠ غير موثق — لن يُستخدم اتجاه الرياح في تحليل الانتشار</div>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0 flex-wrap justify-end">
                        <button
                          type="button"
                          onClick={() => openTrueNorthModal(device)}
                          className="text-[11px] font-bold text-[#3995FF] hover:underline px-2 py-1"
                        >
                          توثيق الشمال الحقيقي
                        </button>
                        <button
                          type="button"
                          onClick={() => setConnectModalDeviceId(device.id)}
                          className="text-[11px] font-bold text-[#3995FF] hover:underline px-2 py-1"
                        >
                          ربط مصدر بيانات
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleDevice(device)}
                          className="text-[11px] font-bold text-[#3995FF] hover:underline px-2 py-1"
                        >
                          {device.is_active ? 'إلغاء' : 'تفعيل'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteDevice(device)}
                          className="text-[11px] font-bold text-red-500 hover:underline px-2 py-1"
                        >
                          حذف
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {connectModalDeviceId && (
            <ConnectProviderModal
              projectId={projectId}
              deviceId={connectModalDeviceId}
              deviceName={devices.find((d) => d.id === connectModalDeviceId)?.name || ''}
              onClose={() => setConnectModalDeviceId(null)}
              onConnected={fetchDevices}
            />
          )}

          {/* توثيق الشمال الحقيقي (migration 202608190002) — راجع تعليق
              WindDirectionEvidence الكامل في dust-compliance-engine/types.ts.
              اتجاه رياح غير موثَّق لا يدخل تحليل الانتشار المكاني إطلاقاً؛
              هذه النافذة هي الطريقة الوحيدة لتوثيقه لكل جهاز على حدة. */}
          {trueNorthModalDeviceId && (
            // طلب مستخدم صريح: يملأ الشاشة بالكامل (inset-0 بلا p-4/items-
            // center الذي كان يحصر البطاقة في المنتصف بمساحة محدودة). كما
            // أن الحاوية الخارجية للمودال تقع فعلياً داخل شجرة <form
            // onSubmit={handleSubmit}> الصفحة (السطر ~805) في DOM — بلا
            // onKeyDown هنا، الضغط على Enter داخل أي حقل نصي بالمودال كان
            // يُطلق submit الفورم الخارجي بالكامل ("حفظ التعديلات") بدل زر
            // "حفظ" الخاص بالمودال، لأن Enter في حقل نصي داخل form يُطلق
            // submit أقرب form أصل له في DOM بصرف النظر عن الترتيب البصري
            // (z-index/position لا علاقة له بهذا السلوك، فقط شجرة DOM).
            // preventDefault هنا يوقف ذلك الالتقاط قبل وصوله للفورم الخارجي؛
            // لا يمنع أي تعامل طبيعي آخر مع لوحة المفاتيح داخل المودال.
            <div
              className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
              dir="rtl"
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            >
              <div className="bg-white w-full h-full overflow-y-auto p-6 sm:rounded-2xl sm:p-8 sm:max-w-lg sm:h-auto sm:max-h-[90vh] shadow-2xl">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-bold text-[#061B40] flex items-center gap-2">
                    <Compass className="w-5 h-5 text-[#3995FF]" /> توثيق الشمال الحقيقي
                  </h3>
                  <button type="button" onClick={() => setTrueNorthModalDeviceId(null)} className="text-[#061B40]/40 hover:text-[#061B40]">
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <p className="text-[12px] font-bold text-[#061B40]/70 mb-2">
                  هل تم توجيه حساس اتجاه الرياح إلى الشمال الحقيقي؟
                </p>

                {/* طلب مستخدم صريح: إزالة كود القاعدة التقني الداخلي
                    (MRQ-RECEPTOR-DOWNWIND-120) من النص الظاهر للمستخدم —
                    لا فائدة له لمستخدم لا يعرف أكواد القواعد الداخلية،
                    الشرح بلغة مفهومة يكفي. عدم التوثيق لا يعطل الجهاز، ولا
                    يمنع أي قراءة أخرى؛ يعطل فقط التحليل المعتمد على اتجاه
                    الرياح تحديداً. */}
                <p className="text-[11px] font-bold text-[#061B40]/50 mb-1">
                  عدم التوثيق لا يعطل الجهاز، ولا يمنع:
                </p>
                <ul className="text-[11px] font-bold text-[#061B40]/50 mb-3 space-y-0.5 pr-4 list-disc">
                  <li>قراءة PM10.</li>
                  <li>سرعة الرياح.</li>
                  <li>الهبات.</li>
                  <li>الرؤية.</li>
                  <li>الحرارة والرطوبة.</li>
                </ul>
                <p className="text-[11px] font-bold text-amber-600 mb-4 leading-relaxed">
                  بل يعطل فقط تحليل هل يقع مستقبِل حساس (سكني/مدرسي/صحي) فعلياً باتجاه هبوب الرياح.
                </p>

                <div className="space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={trueNorthDraft.documented}
                      onChange={(e) => setTrueNorthDraft((prev) => ({ ...prev, documented: e.target.checked }))}
                      className="w-4 h-4 accent-[#3995FF]"
                    />
                    <span className="text-sm font-bold text-[#061B40]">موثَّق للشمال الحقيقي</span>
                  </label>

                  {trueNorthDraft.documented && (
                    <>
                      <div>
                        <label className="text-[11px] font-bold text-[#061B40]/60 block mb-1">نوع المرجع</label>
                        <select
                          value={trueNorthDraft.alignmentType}
                          onChange={(e) =>
                            setTrueNorthDraft((prev) => ({ ...prev, alignmentType: e.target.value as 'TRUE_NORTH' | 'MAGNETIC_NORTH' }))
                          }
                          className="w-full border border-[#061B40]/15 rounded-lg px-3 py-2 text-sm font-bold"
                        >
                          <option value="TRUE_NORTH">الشمال الحقيقي</option>
                          <option value="MAGNETIC_NORTH">الشمال المغناطيسي</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[11px] font-bold text-[#061B40]/60 block mb-1">طريقة التحقق</label>
                        <input
                          type="text"
                          value={trueNorthDraft.verificationMethod}
                          onChange={(e) => setTrueNorthDraft((prev) => ({ ...prev, verificationMethod: e.target.value }))}
                          placeholder="مثال: مساحة GPS، بوصلة معايَرة"
                          className="w-full border border-[#061B40]/15 rounded-lg px-3 py-2 text-sm font-bold"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-bold text-[#061B40]/60 block mb-1">من قام بالتحقق</label>
                        <input
                          type="text"
                          value={trueNorthDraft.verifiedBy}
                          onChange={(e) => setTrueNorthDraft((prev) => ({ ...prev, verifiedBy: e.target.value }))}
                          className="w-full border border-[#061B40]/15 rounded-lg px-3 py-2 text-sm font-bold"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-bold text-[#061B40]/60 block mb-1">تاريخ التحقق</label>
                        <input
                          type="date"
                          value={trueNorthDraft.verifiedAt}
                          onChange={(e) => setTrueNorthDraft((prev) => ({ ...prev, verifiedAt: e.target.value }))}
                          className="w-full border border-[#061B40]/15 rounded-lg px-3 py-2 text-sm font-bold"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-bold text-[#061B40]/60 block mb-1">الانحراف المطبق (بالدرجات، اختياري)</label>
                        <input
                          type="number"
                          value={trueNorthDraft.deviationDeg}
                          onChange={(e) => setTrueNorthDraft((prev) => ({ ...prev, deviationDeg: e.target.value }))}
                          className="w-full border border-[#061B40]/15 rounded-lg px-3 py-2 text-sm font-bold"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-bold text-[#061B40]/60 block mb-1">مرجع أو صورة الإثبات (رابط، اختياري)</label>
                        <input
                          type="text"
                          value={trueNorthDraft.evidenceUrl}
                          onChange={(e) => setTrueNorthDraft((prev) => ({ ...prev, evidenceUrl: e.target.value }))}
                          className="w-full border border-[#061B40]/15 rounded-lg px-3 py-2 text-sm font-bold"
                        />
                      </div>
                    </>
                  )}
                </div>

                <div className="flex gap-3 mt-6">
                  <button
                    type="button"
                    onClick={handleSaveTrueNorth}
                    disabled={savingTrueNorth}
                    className="flex-1 bg-[#3995FF] hover:bg-[#3995FF]/90 disabled:bg-gray-300 text-white font-bold py-2.5 rounded-lg text-sm transition-all"
                  >
                    {savingTrueNorth ? 'جارٍ الحفظ...' : 'حفظ'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setTrueNorthModalDeviceId(null)}
                    disabled={savingTrueNorth}
                    className="flex-1 bg-white border border-[#061B40]/15 text-[#061B40] font-bold py-2.5 rounded-lg text-sm transition-all"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            </div>
          )}

            {/* إقرار المستخدم بصحة البيانات وتحمّل المسؤولية الكاملة عنها —
                إلزامي، يمنع الحفظ حتى يُفعَّل (راجع validateBasicFields)،
                نفس create/page.tsx تماماً. */}
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
              className="w-full bg-[#3995FF] hover:bg-[#3995FF]/90 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-xl transition-all shadow-lg flex items-center justify-center gap-2 text-sm mt-4"
            >
              <Save className="w-5 h-5" />
              {loading && submitStage ? submitStage : 'حفظ التعديلات'}
            </button>
          </form>

         

          {/* منطقة الخطر - الأرشفة (لم تعد حذفاً فعلياً، راجع handleDelete أعلاه) */}
          <div className="mt-8 pt-6 border-t border-red-100">
            <h2 className="text-sm font-bold text-red-600 mb-2 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> منطقة الخطر
            </h2>
            {showDeleteConfirm ? (
              <div className="bg-red-50 p-4 rounded-xl border border-red-200">
                <p className="text-sm font-bold text-red-800 mb-3">هل أنت متأكد من رغبتك في أرشفة هذا المشروع؟ سيختفي من قوائمك النشطة، لكن كل التنبيهات والقرارات والتقييمات المرتبطة به تبقى محفوظة لأغراض التدقيق.</p>
                <div className="flex gap-3">
                  <button onClick={handleDelete} disabled={loading} className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-bold transition-all">
                    نعم، أرشف المشروع
                  </button>
                  <button onClick={() => setShowDeleteConfirm(false)} disabled={loading} className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-bold transition-all">
                    إلغاء
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="bg-white border border-red-200 hover:bg-red-50 text-red-600 font-bold py-2.5 px-4 rounded-xl transition-all flex items-center justify-center gap-2 text-sm w-full md:w-auto"
              >
                <Trash2 className="w-4 h-4" /> أرشفة المشروع
              </button>
            )}
          </div>

        </div>

        {/* الخريطة (للعرض فقط) — منطقة المشروع الكاملة مقفلة بعد التأسيس */}
        <div className="lg:col-span-4 h-[350px] lg:h-[85vh] relative z-10 bg-gray-100">
          <div className="absolute top-4 right-4 z-[1000] bg-white/95 text-red-600 text-[11px] p-3 rounded-xl border border-red-100 shadow-lg pointer-events-none font-bold flex items-center gap-1.5">
            <span className="text-red-500 text-lg leading-none align-middle">🔒</span>
            منطقة المشروع الجغرافية مقفلة ولا يمكن تعديلها
          </div>

          {mounted && (
            <ZonePicker
              initialCenter={{ lat: projectForm.latitude, lng: projectForm.longitude }}
              value={zoneValue}
              onChange={() => { /* عرض فقط — القفل مطبَّق عبر readOnly */ }}
              readOnly
            />
          )}
        </div>
      </div>
    </div>
  );
}