'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/app/lib/apiClient';
import { toast } from 'react-hot-toast';
import { X, Plus, CheckCircle2 } from 'lucide-react';

import { evaluateDustVisibilityWindow } from '@/app/utils/dust-engine';
import type { DustEngineInput, DviEvaluationResult, DustWindowEvaluation, ActivityCategory } from '@/app/utils/dust-engine/types';

import { evaluateAei } from '@/app/utils/aei-engine';
import type { AeiEvaluationResult } from '@/app/utils/aei-engine/types';

import { ActivityTypeStep } from './ActivityTypeStep';
import { DustStep } from './DustStep';
import { DUST_FORM_DEFAULTS, BATCHING_UNIT_DEFAULTS, IDLE_SURFACE_UNIT_DEFAULTS, CRUSHER_UNIT_DEFAULTS, REGULATORY_ACTIVITY_FIELDS_DEFAULTS, REGULATORY_ACTIVITY_OPTIONS, INDICATOR_LABEL_AR, labelClass, getInputClass } from './constants';
import type { BatchingUnit, IdleSurfaceUnit, CrusherUnit, RegulatoryActivityFields, RegulatoryActivityItem, RegulatoryActivityKey } from './constants';
import type { ActivityStep, AddActivityModalProps, IndicatorTab } from './types';

export default function AddActivityModal({ project }: AddActivityModalProps) {
  const router = useRouter();

  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => { setIsMounted(true); }, []);

  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<ActivityStep>('choose');

  const [selectedActivityLabel, setSelectedActivityLabel] = useState('');
  const [activeIndicators, setActiveIndicators] = useState<IndicatorTab[]>([]);
  const [activeIndicatorTab, setActiveIndicatorTab] = useState<IndicatorTab>('dust');
  const [completedIndicators, setCompletedIndicators] = useState<IndicatorTab[]>([]);
  const [currentActivityGroupId, setCurrentActivityGroupId] = useState<string | null>(null);

  // كل نشاط تنظيمي يختار ورديته الخاصة (RegulatoryActivityItem.shiftId) —
  // null يعني "بلا وردية محددة" (يُعتمد على الدوام الافتراضي
  // work_hours_start/end للمشروع). اختياري حتى لو وُجدت ورديات معرَّفة.
  const projectShifts = Array.isArray(project.shifts) ? project.shifts : [];

  // التحقق أن النشاط بالكامل (البداية والنهاية) يقع ضمن أوقات دوام
  // المشروع — يُرجع رسالة خطأ نصية إن كان خارجها، أو null إن كان صالحاً.
  // النشاط الذي يمتد لليوم التالي (النهاية زمنياً قبل البداية) يُرفض حتماً
  // لأنه يتجاوز نهاية الدوام. لو لم تُضبط أوقات دوام للمشروع، لا نمنع شيئاً.
  const WEEK_DAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const WEEK_DAY_LABELS_AR: Record<string, string> = {
    sun: 'الأحد', mon: 'الاثنين', tue: 'الثلاثاء', wed: 'الأربعاء', thu: 'الخميس', fri: 'الجمعة', sat: 'السبت',
  };

  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.slice(0, 5).split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };

  // تتحقق من نشاط يمتد من startDate إلى endDate (قد يمتد لأيام/أشهر)، بساعات
  // يومية ثابتة (dailyStartTime–dailyEndTime) تنطبق على كل يوم ضمن المدى —
  // إما من وردية مختارة (shiftId) أو وقت مخصص. ترجع رسالة خطأ أو null.
  const validateWorkHours = (
    startDate: string,
    endDate: string,
    dailyStartTime: string,
    dailyEndTime: string,
    shiftId: string | null
  ): string | null => {
    if (!startDate || !endDate) return null;
    if (endDate < startDate) return 'تاريخ النهاية يجب أن يكون بعد تاريخ البداية أو يساويه.';

    // 1) فحص أيام العمل: كل الأيام ضمن مدى النشاط يجب أن تقع ضمن أيام عمل
    // المشروع — نتحقق من كل تاريخ بين startDate وendDate (بحد أقصى معقول
    // لتفادي حلقة طويلة جداً لمدى خاطئ بالغلط).
    const workDays = project.work_days_list;
    if (Array.isArray(workDays) && workDays.length > 0) {
      const start = new Date(`${startDate}T00:00:00`);
      const end = new Date(`${endDate}T00:00:00`);
      const maxDaysToCheck = 370;
      let violatingDay: string | null = null;
      for (let i = 0, d = new Date(start); d <= end && i < maxDaysToCheck; d.setDate(d.getDate() + 1), i++) {
        const dayId = WEEK_DAY_IDS[d.getDay()];
        if (!workDays.includes(dayId)) {
          violatingDay = WEEK_DAY_LABELS_AR[dayId] || dayId;
          break;
        }
      }
      if (violatingDay) {
        const allowed = workDays.map((d) => WEEK_DAY_LABELS_AR[d] || d).join('، ');
        return `مدى النشاط يشمل يوم ${violatingDay} الذي ليس من أيام عمل المشروع. أيام العمل: ${allowed}.`;
      }
    }

    // 2) فحص الساعات اليومية
    if (!dailyStartTime || !dailyEndTime) return null;
    const startMin = toMin(dailyStartTime);
    const endMin = toMin(dailyEndTime);
    if (endMin <= startMin) {
      return 'وقت النهاية اليومي يجب أن يكون بعد وقت البداية.';
    }

    if (projectShifts.length > 0) {
      const selectedShift = projectShifts.find((s: any) => s.id === shiftId) || null;
      if (!selectedShift) return 'الرجاء اختيار وردية.';
      // الوقت مأخوذ مباشرة من الوردية، فهو صالح دائماً بالتعريف — لا حاجة
      // لفحص إضافي هنا (يبقى الفحص فقط عند timingMode === 'custom' أدناه).
      return null;
    }

    const ws = project.work_hours_start;
    const we = project.work_hours_end;
    if (!ws || !we) return null; // لا قيود إن غابت البيانات

    const workStart = toMin(ws);
    const workEnd = toMin(we);
    if (startMin < workStart || endMin > workEnd) {
      return `الوقت اليومي (${dailyStartTime} – ${dailyEndTime}) خارج أوقات دوام المشروع (${ws.slice(0, 5)} – ${we.slice(0, 5)}).`;
    }
    return null;
  };

  const [loading, setLoading] = useState(false);
  const [submitStage, setSubmitStage] = useState('');

  const [dustForm, setDustForm] = useState({ ...DUST_FORM_DEFAULTS });
  const [dustResult, setDustResult] = useState<DviEvaluationResult | null>(null);
  const [dustWindow, setDustWindow] = useState<DustWindowEvaluation | null>(null);
  const [aeiResult, setAeiResult] = useState<AeiEvaluationResult | null>(null);
  const [dustLoading, setDustLoading] = useState(false);

  // الأنشطة التنظيمية (Riyadh Dust Compliance) — قائمة مسطّحة واحدة، كل
  // عنصر بطاقة أكورديون مستقلة بموقعها وتوقيتها الخاصين (بدل "مسودة حالية +
  // قائمة انتظار" سابقاً). تُبنى دفعة واحدة من اختيار المستخدم في
  // ActivityTypeStep عبر handleRegulatoryActivitiesContinue، وكل عنصر يُحفظ
  // كصف/صفوف مستقلة في project_dust_profiles عند الحفظ النهائي.
  const [regulatoryActivities, setRegulatoryActivities] = useState<RegulatoryActivityItem[]>([]);
  // أي بطاقة أكورديون مفتوحة حالياً — الأولى تُفتح تلقائياً بعد الاختيار،
  // والمستخدم يفتح غيرها يدوياً (يسمح بفتح أكثر من بطاقة معاً).
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(new Set());

  const updateDustField = (field: keyof typeof DUST_FORM_DEFAULTS, value: any) => { setDustForm((prev) => ({ ...prev, [field]: value })); };

  const generateActivityItemId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') { try { return crypto.randomUUID(); } catch {} }
    return 'ra-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  };

  // تحديث حقل عام (fields) لنشاط تنظيمي واحد ضمن القائمة عبر id — يستبدل
  // updateRegulatoryField القديمة (كانت تحدّث "المسودة" الوحيدة فقط).
  const updateRegulatoryActivityField = (itemId: string, field: keyof RegulatoryActivityFields, value: any) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, fields: { ...item.fields, [field]: value } } : item))
    );
  };

  const updateRegulatoryActivityLocation = (itemId: string, lat: number | null, lng: number | null) => {
    setRegulatoryActivities((prev) => prev.map((item) => (item.id === itemId ? { ...item, lat, lng } : item)));
  };

  const updateRegulatoryActivityTiming = (
    itemId: string,
    field: 'startDate' | 'endDate' | 'customStartTime' | 'customEndTime',
    value: string
  ) => {
    setRegulatoryActivities((prev) => prev.map((item) => (item.id === itemId ? { ...item, [field]: value } : item)));
  };

  const updateRegulatoryActivityTimingMode = (itemId: string, timingMode: 'shift' | 'custom') => {
    setRegulatoryActivities((prev) => prev.map((item) => (item.id === itemId ? { ...item, timingMode } : item)));
  };

  const updateRegulatoryActivityShift = (itemId: string, shiftId: string | null) => {
    setRegulatoryActivities((prev) => prev.map((item) => (item.id === itemId ? { ...item, shiftId } : item)));
  };

  const removeRegulatoryActivity = (itemId: string) => {
    setRegulatoryActivities((prev) => prev.filter((item) => item.id !== itemId));
    setExpandedActivityIds((prev) => {
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
  };

  const toggleRegulatoryActivityExpanded = (itemId: string) => {
    setExpandedActivityIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  // موقع النشاط العام (item.lat/lng) لأنشطة الخلاطة/الكسارة يتبع تلقائياً
  // موقع الوحدة الأولى — لا خريطة منفصلة "لموقع النشاط" مقابل "موقع
  // الوحدة" لهذين النوعين، فكلاهما نفس الشيء (راجع RegulatoryActivityItem).
  const syncItemLocationFromUnit = (lat: string | number, lng: string | number) => {
    const numLat = typeof lat === 'number' ? lat : Number(lat);
    const numLng = typeof lng === 'number' ? lng : Number(lng);
    return Number.isFinite(numLat) && Number.isFinite(numLng) ? { lat: numLat, lng: numLng } : {};
  };

  const updateBatchingUnit = (itemId: string, index: number, field: keyof BatchingUnit, value: any) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        const batchingUnits = item.batchingUnits.map((u, i) => (i === index ? { ...u, [field]: value } : u));
        const syncLoc =
          index === 0 && (field === 'batchingLat' || field === 'batchingLng')
            ? syncItemLocationFromUnit(
                field === 'batchingLat' ? value : batchingUnits[0].batchingLat,
                field === 'batchingLng' ? value : batchingUnits[0].batchingLng
              )
            : {};
        return { ...item, batchingUnits, ...syncLoc };
      })
    );
  };
  const addBatchingUnit = (itemId: string) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, batchingUnits: [...item.batchingUnits, { ...BATCHING_UNIT_DEFAULTS }] } : item))
    );
  };
  const removeBatchingUnit = (itemId: string, index: number) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => {
        if (item.id !== itemId || item.batchingUnits.length <= 1) return item;
        const batchingUnits = item.batchingUnits.filter((_, i) => i !== index);
        const syncLoc = index === 0 ? syncItemLocationFromUnit(batchingUnits[0].batchingLat, batchingUnits[0].batchingLng) : {};
        return { ...item, batchingUnits, ...syncLoc };
      })
    );
  };

  const updateIdleSurfaceUnit = (itemId: string, index: number, field: keyof IdleSurfaceUnit, value: any) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? { ...item, idleSurfaceUnits: item.idleSurfaceUnits.map((u, i) => (i === index ? { ...u, [field]: value } : u)) }
          : item
      )
    );
  };
  const addIdleSurfaceUnit = (itemId: string) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, idleSurfaceUnits: [...item.idleSurfaceUnits, { ...IDLE_SURFACE_UNIT_DEFAULTS }] } : item))
    );
  };
  const removeIdleSurfaceUnit = (itemId: string, index: number) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) =>
        item.id === itemId && item.idleSurfaceUnits.length > 1
          ? { ...item, idleSurfaceUnits: item.idleSurfaceUnits.filter((_, i) => i !== index) }
          : item
      )
    );
  };

  const updateCrusherUnit = (itemId: string, index: number, field: keyof CrusherUnit, value: any) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => {
        if (item.id !== itemId) return item;
        const crusherUnits = item.crusherUnits.map((u, i) => (i === index ? { ...u, [field]: value } : u));
        const syncLoc =
          index === 0 && (field === 'crusherLat' || field === 'crusherLng')
            ? syncItemLocationFromUnit(
                field === 'crusherLat' ? value : crusherUnits[0].crusherLat,
                field === 'crusherLng' ? value : crusherUnits[0].crusherLng
              )
            : {};
        return { ...item, crusherUnits, ...syncLoc };
      })
    );
  };
  const addCrusherUnit = (itemId: string) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => (item.id === itemId ? { ...item, crusherUnits: [...item.crusherUnits, { ...CRUSHER_UNIT_DEFAULTS }] } : item))
    );
  };
  const removeCrusherUnit = (itemId: string, index: number) => {
    setRegulatoryActivities((prev) =>
      prev.map((item) => {
        if (item.id !== itemId || item.crusherUnits.length <= 1) return item;
        const crusherUnits = item.crusherUnits.filter((_, i) => i !== index);
        const syncLoc = index === 0 ? syncItemLocationFromUnit(crusherUnits[0].crusherLat, crusherUnits[0].crusherLng) : {};
        return { ...item, crusherUnits, ...syncLoc };
      })
    );
  };

  const resetAndClose = () => {
    setIsOpen(false);
    setStep('choose');
    setSubmitStage('');
    setDustForm({ ...DUST_FORM_DEFAULTS });
    setDustResult(null);
    setDustWindow(null);
    setAeiResult(null);
    setRegulatoryActivities([]);
    setExpandedActivityIds(new Set());
    setSelectedActivityLabel('');
    setActiveIndicators([]);
    setActiveIndicatorTab('dust');
    setCompletedIndicators([]);
    setCurrentActivityGroupId(null);
  };

  const closeAndRefresh = () => {
    resetAndClose();
    router.refresh();
  };

  // شاشة اختيار النشاط أصبحت قائمة أنشطة امتثال تنظيمي (Riyadh Dust
  // Compliance)، لا نوع نشاط فيزيائي واحد. كل مفتاح مختار يصبح بطاقة
  // أكورديون مستقلة بموقعها وتوقيتها الخاصين (راجع RegulatoryActivityItem)،
  // لا "مسودة + قائمة انتظار" كما سابقاً. كل الأنشطة تُفعّل مؤشر الغبار
  // (المؤشر الوحيد في DCR). البطاقة الأولى تُفتح تلقائياً (expandedActivityIds).
  const handleRegulatoryActivitiesContinue = (activityKeys: RegulatoryActivityKey[]) => {
    if (activityKeys.length === 0) return;

    const firstOption = REGULATORY_ACTIVITY_OPTIONS.find((o) => o.key === activityKeys[0])!;

    setSelectedActivityLabel(firstOption.label);
    setActiveIndicators(['dust']);
    setActiveIndicatorTab('dust');
    setCompletedIndicators([]);
    // مؤشر واحد (غبار) → مجموعة نشاط واحدة تربط كل الصفوف معاً
    setCurrentActivityGroupId(generateActivityGroupId());

    // فئة DVI الفيزيائية (تُستخدم داخلياً لمحرك الغبار فقط، لا حقل واجهة
    // بعد حذف قسم "أ. التصنيف الدقيق للنشاط") تُؤخذ من النشاط الأول تلقائياً.
    setDustForm((prev) => ({ ...prev, activityType: firstOption.dviCategory as ActivityCategory }));

    const today = new Date().toISOString().slice(0, 10);
    const newItems: RegulatoryActivityItem[] = activityKeys.map((key) => ({
      id: generateActivityItemId(),
      fields: { ...REGULATORY_ACTIVITY_FIELDS_DEFAULTS, regulatoryActivity: key },
      batchingUnits: [{ ...BATCHING_UNIT_DEFAULTS }],
      idleSurfaceUnits: [{ ...IDLE_SURFACE_UNIT_DEFAULTS }],
      crusherUnits: [{ ...CRUSHER_UNIT_DEFAULTS }],
      lat: null,
      lng: null,
      startDate: today,
      endDate: today,
      timingMode: projectShifts.length > 0 ? 'shift' : 'custom',
      shiftId: null,
      customStartTime: '',
      customEndTime: '',
    }));
    setRegulatoryActivities(newItems);
    // البطاقة الأولى فقط مفتوحة تلقائياً — "افتح خيارات النشاط الأول ثم
    // افتح خيارات النشاط الثاني" يعني فتحاً تسلسلياً بقرار المستخدم، لا
    // فتح الكل دفعة واحدة.
    setExpandedActivityIds(new Set(newItems.length > 0 ? [newItems[0].id] : []));

    setStep('indicators');
  };

  const finishIndicator = (indicator: IndicatorTab) => {
    if (activeIndicators.length > 1) {
      const updatedCompleted = completedIndicators.includes(indicator) ? completedIndicators : [...completedIndicators, indicator];
      setCompletedIndicators(updatedCompleted);

      const remaining = activeIndicators.filter((i) => !updatedCompleted.includes(i));
      if (remaining.length > 0) {
        setActiveIndicatorTab(remaining[0]);
        toast.success('تم الحفظ، أكمل بيانات باقي المؤشرات للنشاط.');
        router.refresh();
      } else {
        closeAndRefresh();
      }
    } else {
      closeAndRefresh();
    }
  };

  const generateActivityGroupId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') { try { return crypto.randomUUID(); } catch {} }
    return 'agid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  };

  // التحقق الإلزامي لحقول A6 (محطة خلط) أو A4 (سطح غير نشط) لكل وحدة — هذه
  // الحقول تحديداً تبقى مدخلات حقيقية (لا تحوّلت إلى تنبيهات نصية عامة مثل
  // بقية حقول الضوابط) لأنها تُغذّي قواعد MANDATORY_STOP/RESTRICT_ACTIVITY
  // في rulebook.ts مباشرة (إحكام إغلاق الصوامع، كفاءة فلتر PM10، تسرب،
  // أسلوب التنظيف، أيام التوقف وحالة التثبيت) — تحويلها لنص عام كان سيعني
  // فقدان القدرة على اكتشاف مخالفة فعلية بلا أي بديل. يُستدعى لكل عنصر ضمن
  // regulatoryActivities عند الحفظ النهائي.
  const validateRegulatoryUnits = (
    fields: RegulatoryActivityFields,
    units: { batchingUnits: BatchingUnit[]; idleSurfaceUnits: IdleSurfaceUnit[]; crusherUnits: CrusherUnit[] }
  ): string | null => {
    if (fields.regulatoryActivity === 'BATCHING_PLANT') {
      for (let i = 0; i < units.batchingUnits.length; i++) {
        const u = units.batchingUnits[i];
        if (u.batchingLat === '' || u.batchingLng === '') return `المحطة ${i + 1}: حدد موقع محطة الخلط على الخريطة.`;
        if (u.silosSealed === null) return `الوحدة ${i + 1}: حدد حالة إحكام إغلاق الصوامع.`;
        if (u.pm10FilterEfficiencyPercent === '') return `الوحدة ${i + 1}: أدخل كفاءة فلتر PM10.`;
        if (u.leakDetected === null) return `الوحدة ${i + 1}: حدد حالة رصد التسرب.`;
        if (u.dryCleaningMethodUsed === null) return `الوحدة ${i + 1}: حدد أسلوب التنظيف المستخدم.`;
      }
    }
    if (fields.regulatoryActivity === 'IDLE_SURFACE') {
      for (let i = 0; i < units.idleSurfaceUnits.length; i++) {
        const u = units.idleSurfaceUnits[i];
        if (u.idleDays === '') return `الوحدة ${i + 1}: أدخل عدد أيام التوقف.`;
        if (u.idleSurfaceStabilized === null) return `الوحدة ${i + 1}: حدد حالة تثبيت السطح.`;
        if (u.idleSurfaceCoverIntact === null) return `الوحدة ${i + 1}: حدد حالة سلامة الغطاء.`;
      }
    }
    if (fields.regulatoryActivity === 'CRUSHER') {
      for (let i = 0; i < units.crusherUnits.length; i++) {
        const u = units.crusherUnits[i];
        if (u.crusherLat === '' || u.crusherLng === '') return `الكسارة ${i + 1}: حدد موقعها على الخريطة.`;
      }
    }
    return null;
  };

  // يحل ساعات العمل اليومية الفعلية لنشاط تنظيمي — إما من الوردية المختارة
  // (timingMode === 'shift') أو من الوقت المخصص الذي أدخله المستخدم
  // (timingMode === 'custom'، مقيَّد بدوام المشروع في الواجهة). يرجع null
  // إن لم يكتمل الاختيار بعد.
  const resolveDailyTimeRange = (item: RegulatoryActivityItem): { start: string; end: string } | null => {
    if (item.timingMode === 'shift') {
      const shift = projectShifts.find((s: any) => s.id === item.shiftId);
      if (!shift) return null;
      return { start: shift.start_time.slice(0, 5), end: shift.end_time.slice(0, 5) };
    }
    if (!item.customStartTime || !item.customEndTime) return null;
    return { start: item.customStartTime, end: item.customEndTime };
  };

  // يبني حمولة insert لصف project_dust_profiles واحد من حقول DVI المشتركة
  // + حقول نشاط تنظيمي محدد (regulatoryFields) — بلا وحدات A6/A4 بعد.
  // الموقع والتوقيت يأتيان الآن من النشاط (item) نفسه لا من الحالة المشتركة
  // للمودال — كل نشاط تنظيمي له موقعه وتوقيته الخاصان (راجع RegulatoryActivityItem).
  const buildDustBaseInsert = (
    item: RegulatoryActivityItem,
    dailyStartTime: string,
    durationHours: number,
    aeiScore: number,
    aeiStatus: string
  ) => {
   const regulatoryFields = item.fields;
   return ({
    project_id: project.id, activity_group_id: currentActivityGroupId, activity_type: dustForm.activityType,
    activity_lat: item.lat, activity_lng: item.lng,
    planned_date: item.startDate, planned_time: dailyStartTime, duration_hours: durationHours,
    shift_id: item.shiftId,
    has_earthworks: dustForm.hasEarthworks, internal_dirt_roads: dustForm.internalDirtRoads, heavy_equipment_movement: dustForm.heavyEquipmentMovement, loose_materials: dustForm.looseMaterials, large_exposed_area: dustForm.largeExposedArea, dry_surface: dustForm.drySurface, surface_wet: dustForm.surfaceWet, watering_available: dustForm.wateringAvailable, stockpiles_covered: dustForm.stockpilesCovered, speed_limit_applied: dustForm.speedLimitApplied, wheel_wash_available: dustForm.wheelWashAvailable, dust_screens_available: dustForm.dustScreensAvailable, field_monitoring_available: dustForm.fieldMonitoringAvailable, receptor_type: dustForm.receptorType, receptor_distance: dustForm.receptorDistance, receptor_is_downwind: dustForm.receptorIsDownwind, visible_dust_plume_reported: dustForm.visibleDustPlumeReported, open_concrete_pour: dustForm.openConcretePour, onsite_visibility_m: dustForm.onsiteVisibilityM === '' ? null : Number(dustForm.onsiteVisibilityM), onsite_pm10: dustForm.onsitePm10 === '' ? null : Number(dustForm.onsitePm10), onsite_pm25: dustForm.onsitePm25 === '' ? null : Number(dustForm.onsitePm25), aei_score: aeiScore, aei_status: aeiStatus,
    // حقول محرك الامتثال التنظيمي (Riyadh Dust Compliance) — لا تؤثر على
    // حساب DVI أعلاه.
    regulatory_activity: regulatoryFields.regulatoryActivity,
    is_enclosed_operation: regulatoryFields.isEnclosedOperation,
    dust_suppression_system_operational: regulatoryFields.dustSuppressionSystemOperational,
    continuous_misting: regulatoryFields.continuousMisting,
    spray_cannon_available: regulatoryFields.sprayCannonAvailable,
    wet_cutting_active: regulatoryFields.wetCuttingActive,
    hepa_extraction_active: regulatoryFields.hepaExtractionActive,
    demolition_active_area_m2: regulatoryFields.demolitionActiveAreaM2 === '' ? null : Number(regulatoryFields.demolitionActiveAreaM2),
    surface_watered: regulatoryFields.surfaceWatered,
    drop_height_m: regulatoryFields.dropHeightM === '' ? null : Number(regulatoryFields.dropHeightM),
    exposed_soil_area_m2: regulatoryFields.exposedSoilAreaM2 === '' ? null : Number(regulatoryFields.exposedSoilAreaM2),

    // A1 — استكمال
    truck_routes_designated: regulatoryFields.truckRoutesDesignated,
    path_cover_material: regulatoryFields.pathCoverMaterial,
    water_spray_method: regulatoryFields.waterSprayMethod,
    soil_compacted_after_excavation: regulatoryFields.soilCompactedAfterExcavation,
    stabilizer_used_during_pause: regulatoryFields.stabilizerUsedDuringPause,
    pause_duration_over_5_days: regulatoryFields.pauseDurationOver5Days,
    spray_used_during_soil_unloading: regulatoryFields.sprayUsedDuringSoilUnloading,
    work_area_phased: regulatoryFields.workAreaPhased,

    // A2 — النقل والطرق الخدمية
    unpaved_roads_watered_daily: regulatoryFields.unpavedRoadsWateredDaily,
    dust_control_method: regulatoryFields.dustControlMethod,
    unpaved_speed_kmh: regulatoryFields.unpavedSpeedKmh === '' ? null : Number(regulatoryFields.unpavedSpeedKmh),
    paved_speed_kmh: regulatoryFields.pavedSpeedKmh === '' ? null : Number(regulatoryFields.pavedSpeedKmh),
    speed_limit_signs_posted: regulatoryFields.speedLimitSignsPosted,
    containers_covered_before_moving: regulatoryFields.containersCoveredBeforeMoving,
    containers_inspected_before_departure: regulatoryFields.containersInspectedBeforeDeparture,
    load_height_exceeds_container_limit: regulatoryFields.loadHeightExceedsContainerLimit,
    adjacent_roads_swept_mechanically: regulatoryFields.adjacentRoadsSweptMechanically,
    sweep_frequency_band: regulatoryFields.sweepFrequencyBand,
    wheel_wash_at_exit: regulatoryFields.wheelWashAtExit,
    wheel_wash_maintained_regularly: regulatoryFields.wheelWashMaintainedRegularly,
    wash_water_recycled: regulatoryFields.washWaterRecycled,
    all_loads_covered: regulatoryFields.allLoadsCovered,
    trucks_inspected_before_departure: regulatoryFields.trucksInspectedBeforeDeparture,
    load_side_coverage_adequate: regulatoryFields.loadSideCoverageAdequate,
    spill_cleanup_minutes: regulatoryFields.spillCleanupMinutes === '' ? null : Number(regulatoryFields.spillCleanupMinutes),
    public_roads_vacuum_swept_daily: regulatoryFields.publicRoadsVacuumSweptDaily,
    water_used_routinely_for_cleaning: regulatoryFields.waterUsedRoutinelyForCleaning,
    load_covered: regulatoryFields.loadCovered,

    // A3 — الدخول والخروج
    entry_point_lat: regulatoryFields.entryPointLat === '' ? null : Number(regulatoryFields.entryPointLat),
    entry_point_lng: regulatoryFields.entryPointLng === '' ? null : Number(regulatoryFields.entryPointLng),
    exit_point_lat: regulatoryFields.exitPointLat === '' ? null : Number(regulatoryFields.exitPointLat),
    exit_point_lng: regulatoryFields.exitPointLng === '' ? null : Number(regulatoryFields.exitPointLng),
    access_road_paved: regulatoryFields.accessRoadPaved,
    tire_cleaning_method: regulatoryFields.tireCleaningMethod,
    sand_trap_present: regulatoryFields.sandTrapPresent,
    oil_separator_present: regulatoryFields.oilSeparatorPresent,
    wash_cycle_duration_adequate: regulatoryFields.washCycleDurationAdequate,
    wheel_wash_operation_method: regulatoryFields.wheelWashOperationMethod,
    wash_water_reused: regulatoryFields.washWaterReused,
    anti_slip_mesh_present: regulatoryFields.antiSlipMeshPresent,
    immersion_zone_length_adequate: regulatoryFields.immersionZoneLengthAdequate,
    collection_basin_present: regulatoryFields.collectionBasinPresent,
    truck_path_cleaned_within_15_min: regulatoryFields.truckPathCleanedWithin15Min,
    water_traces_beyond_15m_from_gate: regulatoryFields.waterTracesBeyond15mFromGate,

    // A4 — تخفيف تطاير الغبار الناتج عن هبوب الرياح
    exposed_area_currently_idle: regulatoryFields.exposedAreaCurrentlyIdle,
    stabilization_method: regulatoryFields.stabilizationMethod,
    stockpile_area_exists: regulatoryFields.stockpileAreaExists,
    suppressant_used_at_stockpile_area: regulatoryFields.suppressantUsedAtStockpileArea,
    wind_barriers_near_stockpiles: regulatoryFields.windBarriersNearStockpiles,
    construction_scheduled_immediately_after_prep: regulatoryFields.constructionScheduledImmediatelyAfterPrep,

    // A5 — تحميل/تنزيل/تخزين المواد. stockpile_lat/lng لم يعودا حقل إدخال
    // منفصلاً في الواجهة — تُستخدم إحداثيات موقع النشاط نفسه (item.lat/lng،
    // الخريطة الوحيدة المعروضة أعلى كل بطاقة أكورديون) حتى تستمر قاعدة
    // المسافة التلقائية عن أقرب مستقبل حساس (STOCKPILE-DISTANCE-002) بالعمل
    // بلا خريطة مكررة لنفس النشاط.
    stockpile_height_m: regulatoryFields.stockpileHeightM === '' ? null : Number(regulatoryFields.stockpileHeightM),
    stockpile_batching_distance_to_receptor_m: regulatoryFields.stockpileBatchingDistanceToReceptorM === '' ? null : Number(regulatoryFields.stockpileBatchingDistanceToReceptorM),
    stockpile_lat: item.lat,
    stockpile_lng: item.lng,
    centralized_storage: regulatoryFields.centralizedStorage,
    distributed_across_multiple_locations: regulatoryFields.distributedAcrossMultipleLocations,
    sprayed_immediately_after_unloading: regulatoryFields.sprayedImmediatelyAfterUnloading,
    full_submersion_of_piles: regulatoryFields.fullSubmersionOfPiles,
    stockpile_shape_low_rounded: regulatoryFields.stockpileShapeLowRounded,
    unused_piles_covered_daily: regulatoryFields.unusedPilesCoveredDaily,
    cement_in_sealed_silos: regulatoryFields.cementInSealedSilos,
    silos_have_pm10_filters: regulatoryFields.silosHavePm10Filters,
    piles_behind_wind_barriers: regulatoryFields.pilesBehindWindBarriers,
    conveyors_enclosed: regulatoryFields.conveyorsEnclosed,
    conveyors_use_auto_spray: regulatoryFields.conveyorsUseAutoSpray,
    wind_barriers_aligned_with_prevailing_wind: regulatoryFields.windBarriersAlignedWithPrevailingWind,
    barrier_distance_ratio_compliant: regulatoryFields.barrierDistanceRatioCompliant,

    // مصادر الغبار الأخرى
    filter_maintenance_performed_regularly: regulatoryFields.filterMaintenancePerformedRegularly,
    leak_prevention_inspected_regularly: regulatoryFields.leakPreventionInspectedRegularly,
    suppression_system_checked_daily: regulatoryFields.suppressionSystemCheckedDaily,
    manual_dry_sweeping_banned: regulatoryFields.manualDrySweepingBanned,
    compressed_air_banned: regulatoryFields.compressedAirBanned,
    site_cleaning_method: regulatoryFields.siteCleaningMethod,
    waste_humidity_maintained_during_transport: regulatoryFields.wasteHumidityMaintainedDuringTransport,
    waste_loads_covered: regulatoryFields.wasteLoadsCovered,

    // الهدم — استكمال
    spray_cannon_range_band: regulatoryFields.sprayCannonRangeBand,
    crushers_covered_demolition: regulatoryFields.crushersCoveredDemolition,
    loading_points_have_sprinklers: regulatoryFields.loadingPointsHaveSprinklers,
    demolition_cutting_method: regulatoryFields.demolitionCuttingMethod,
    sandblasting_used: regulatoryFields.sandblastingUsed,
    sandblasting_in_enclosed_box: regulatoryFields.sandblastingInEnclosedBox,

    // قطع الأحجار — استكمال
    cutting_residues_cleaned_after_completion: regulatoryFields.cuttingResiduesCleanedAfterCompletion,

    // نقل مخلفات الهدم والبناء
    debris_sprayed_before_loading: regulatoryFields.debrisSprayedBeforeLoading,
    central_storage_area: regulatoryFields.centralStorageArea,
    small_piles_dispersed_multiple_locations: regulatoryFields.smallPilesDispersedMultipleLocations,
    daily_removal: regulatoryFields.dailyRemoval,
    covered_if_not_removed_daily: regulatoryFields.coveredIfNotRemovedDaily,
    debris_compacted: regulatoryFields.debrisCompacted,
    only_active_section_sprayed: regulatoryFields.onlyActiveSectionSprayed,
    load_exceeds_capacity: regulatoryFields.loadExceedsCapacity,
    debris_pile_height_m: regulatoryFields.debrisPileHeightM === '' ? null : Number(regulatoryFields.debrisPileHeightM),
   });
  };

  // يرسل صف/صفوف project_dust_profiles لعنصر نشاط تنظيمي واحد — يوزّع
  // على وحدات A6 (خلاطات)/A4/كسارات إن وُجدت، أو يرسل صفاً واحداً لبقية
  // الأنشطة. كل وحدة كسارة/خلاطة تُحفظ كصف مستقل بموقعها الخاص، بنفس نمط
  // الحفظ متعدد الصفوف المستخدم أصلاً للخلاطات وأسطح التوقف.
  const submitRegulatoryEntry = async (
    item: RegulatoryActivityItem,
    dailyStartTime: string,
    durationHours: number,
    aeiScore: number,
    aeiStatus: string
  ) => {
    const fields = item.fields;
    const units = { batchingUnits: item.batchingUnits, idleSurfaceUnits: item.idleSurfaceUnits, crusherUnits: item.crusherUnits };
    const baseInsert = buildDustBaseInsert(item, dailyStartTime, durationHours, aeiScore, aeiStatus);
    if (fields.regulatoryActivity === 'BATCHING_PLANT') {
      for (const unit of units.batchingUnits) {
        await apiClient.post('/dust-profiles', {
          insert: {
            ...baseInsert,
            batching_lat: unit.batchingLat === '' ? null : Number(unit.batchingLat),
            batching_lng: unit.batchingLng === '' ? null : Number(unit.batchingLng),
            silos_sealed: unit.silosSealed,
            pm10_filter_efficiency_percent: unit.pm10FilterEfficiencyPercent === '' ? null : Number(unit.pm10FilterEfficiencyPercent),
            leak_detected: unit.leakDetected,
            dry_cleaning_method_used: unit.dryCleaningMethodUsed,
            dust_suppression_system_operational: unit.dustSuppressionSystemOperational,
          },
        });
      }
    } else if (fields.regulatoryActivity === 'IDLE_SURFACE') {
      for (const unit of units.idleSurfaceUnits) {
        await apiClient.post('/dust-profiles', {
          insert: {
            ...baseInsert,
            idle_days: unit.idleDays === '' ? null : Number(unit.idleDays),
            idle_surface_stabilized: unit.idleSurfaceStabilized,
            idle_surface_cover_intact: unit.idleSurfaceCoverIntact,
          },
        });
      }
    } else if (fields.regulatoryActivity === 'CRUSHER') {
      for (const unit of units.crusherUnits) {
        await apiClient.post('/dust-profiles', {
          insert: {
            ...baseInsert,
            crusher_lat: unit.crusherLat === '' ? null : Number(unit.crusherLat),
            crusher_lng: unit.crusherLng === '' ? null : Number(unit.crusherLng),
            crusher_distance_to_receptor_m: unit.crusherDistanceToReceptorM === '' ? null : Number(unit.crusherDistanceToReceptorM),
            crusher_units_fully_covered: unit.crusherUnitsFullyCovered,
            loading_points_have_spray_systems: unit.loadingPointsHaveSpraySystems,
            spray_cannons_around_crusher: unit.sprayCannonsAroundCrusher,
            conveyors_covered_crusher: unit.conveyorsCoveredCrusher,
            drop_height_reduced_at_crusher: unit.dropHeightReducedAtCrusher,
            suction_and_filtration_systems_present: unit.suctionAndFiltrationSystemsPresent,
            critical_schedule_applies: unit.criticalScheduleApplies,
          },
        });
      }
    } else {
      await apiClient.post('/dust-profiles', { insert: baseInsert });
    }
  };

  // كل نشاط تنظيمي له الآن موقعه وتوقيته الخاصان (RegulatoryActivityItem)،
  // بعكس النموذج القديم (موقع/توقيت مشترك واحد لكل الأنشطة) — لذا لم يعد
  // ممكناً تقييم DVI/AEI مرة واحدة واستخدام نفس النتيجة للجميع؛ نتيجة
  // محسوبة في مكان/وقت نشاط ما لا تعكس نشاطاً آخر في موقع أو وقت مختلف.
  // نُقيّم كل نشاط على حدة داخل الحلقة أدناه، ونعرض نتيجة آخر نشاط تم
  // تقييمه في بطاقة DVI العلوية (dustResult/aeiResult) كملخص تمثيلي فقط.
  const validateRegulatoryActivityLocations = (): string | null => {
    for (let i = 0; i < regulatoryActivities.length; i++) {
      const item = regulatoryActivities[i];
      if (typeof item.lat !== 'number' || typeof item.lng !== 'number') {
        return `النشاط ${i + 1}: حدد موقعه على الخريطة قبل الحفظ.`;
      }
    }
    return null;
  };

  // عدد الأيام ضمن مدى [startDate, endDate] شاملاً الطرفين، مقيَّداً بأيام
  // عمل المشروع إن كانت معرَّفة (الأيام خارج أيام العمل لا تُحتسب ضمن
  // المدة الفعلية للنشاط رغم وقوعها ضمن المدى الزمني).
  const countActiveDaysInRange = (startDate: string, endDate: string): number => {
    const start = new Date(`${startDate}T00:00:00`);
    const end = new Date(`${endDate}T00:00:00`);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return 0;
    const workDays = project.work_days_list;
    let count = 0;
    const maxDaysToCheck = 370;
    for (let i = 0, d = new Date(start); d <= end && i < maxDaysToCheck; d.setDate(d.getDate() + 1), i++) {
      if (Array.isArray(workDays) && workDays.length > 0) {
        const dayId = WEEK_DAY_IDS[d.getDay()];
        if (!workDays.includes(dayId)) continue;
      }
      count++;
    }
    return count;
  };

  // مدة النشاط الإجمالية بالساعات = ساعات اليوم الواحد (من الوردية أو الوقت
  // المخصص) × عدد أيام العمل ضمن مدى [startDate, endDate] — لا تُدخَل يدوياً.
  // ترجع null إن لم تكتمل بيانات التوقيت بعد.
  const computeDurationHours = (item: RegulatoryActivityItem): number | null => {
    const daily = resolveDailyTimeRange(item);
    if (!daily) return null;
    const dailyHours = (toMin(daily.end) - toMin(daily.start)) / 60;
    if (dailyHours <= 0) return null;
    const activeDays = countActiveDaysInRange(item.startDate, item.endDate);
    if (activeDays <= 0) return null;
    return dailyHours * activeDays;
  };

  const handleDustSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (regulatoryActivities.length === 0) { toast.error('أضف نشاطاً تنظيمياً واحداً على الأقل.'); return; }
    { const locError = validateRegulatoryActivityLocations(); if (locError) { toast.error(locError); return; } }
    for (let i = 0; i < regulatoryActivities.length; i++) {
      const item = regulatoryActivities[i];
      if (!item.startDate || !item.endDate) { toast.error(`النشاط ${i + 1}: حدد تاريخ البداية والنهاية.`); return; }
      const daily = resolveDailyTimeRange(item);
      if (!daily) {
        toast.error(
          item.timingMode === 'shift'
            ? `النشاط ${i + 1}: اختر وردية.`
            : `النشاط ${i + 1}: حدد وقت البداية والنهاية اليومي.`
        );
        return;
      }
      const whError = validateWorkHours(item.startDate, item.endDate, daily.start, daily.end, item.shiftId);
      if (whError) { toast.error(`النشاط ${i + 1}: ${whError}`); return; }
      const durationHours = computeDurationHours(item);
      if (durationHours === null) { toast.error(`النشاط ${i + 1}: تعذّر حساب مدة النشاط — تحقق من التاريخ والوقت.`); return; }
      const unitsError = validateRegulatoryUnits(item.fields, { batchingUnits: item.batchingUnits, idleSurfaceUnits: item.idleSurfaceUnits, crusherUnits: item.crusherUnits });
      if (unitsError) { toast.error(`النشاط ${i + 1}: ${unitsError}`); return; }
    }

    setDustLoading(true); setDustResult(null); setDustWindow(null); setAeiResult(null);
    toast.loading('جاري التقييم...', { id: 'dvi-calc' });

    try {
      for (const item of regulatoryActivities) {
        const daily = resolveDailyTimeRange(item) as { start: string; end: string };
        const durationHours = computeDurationHours(item) as number;
        // تقييم DVI الحي يعتمد على توقّع طقس ساعي متاح لأيام قليلة قادمة
        // فقط — لنشاط يمتد لأسابيع/أشهر، يُقيَّم اليوم الأول فقط (بساعاته
        // اليومية) كممثل، والمدة الإجمالية المحفوظة (duration_hours) تبقى
        // إجمالي كل الأيام كما هي.
        const dailyHours = (toMin(daily.end) - toMin(daily.start)) / 60;
        const engineInput: DustEngineInput = {
          activityType: dustForm.activityType, latitude: item.lat as number, longitude: item.lng as number,
          site: { hasEarthworks: dustForm.hasEarthworks, internalDirtRoads: dustForm.internalDirtRoads, heavyEquipmentMovement: dustForm.heavyEquipmentMovement, looseMaterials: dustForm.looseMaterials, largeExposedArea: dustForm.largeExposedArea, drySurface: dustForm.drySurface, surfaceWet: dustForm.surfaceWet, wateringAvailable: dustForm.wateringAvailable, stockpilesCovered: dustForm.stockpilesCovered, speedLimitApplied: dustForm.speedLimitApplied, wheelWashAvailable: dustForm.wheelWashAvailable, dustScreensAvailable: dustForm.dustScreensAvailable, fieldMonitoringAvailable: dustForm.fieldMonitoringAvailable, receptorType: dustForm.receptorType, receptorDistance: dustForm.receptorDistance, receptorIsDownwind: dustForm.receptorIsDownwind, visibleDustPlumeReported: dustForm.visibleDustPlumeReported, openConcretePour: dustForm.openConcretePour },
          onsiteVisibilityM: dustForm.onsiteVisibilityM === '' ? null : Number(dustForm.onsiteVisibilityM), onsitePm10: dustForm.onsitePm10 === '' ? null : Number(dustForm.onsitePm10), onsitePm25: dustForm.onsitePm25 === '' ? null : Number(dustForm.onsitePm25),
        };

        const windowStartIso = new Date(`${item.startDate}T${daily.start}:00`).toISOString();
        const windowEval = await evaluateDustVisibilityWindow(engineInput, windowStartIso, dailyHours);
        const result = windowEval.worst;
        setDustResult(result); setDustWindow(windowEval);
        const aei = evaluateAei(result, dustForm.activityType);
        setAeiResult(aei);

        try {
          await submitRegulatoryEntry(item, daily.start, durationHours, aei.score, aei.status);
        } catch {
          throw new Error('مشكلة أثناء الحفظ.');
        }
      }
      toast.success(`تم التقييم والحفظ بنجاح (${regulatoryActivities.length} نشاط تنظيمي).`, { id: 'dvi-calc' });
      finishIndicator('dust');
    } catch (error: any) { toast.error(error?.message || 'حدث خطأ', { id: 'dvi-calc' }); } finally { setDustLoading(false); }
  };

  return (
    <>
      <button onClick={() => setIsOpen(true)} className="bg-[#3995FF] hover:bg-[#3995FF]/90 text-white font-bold px-5 py-2.5 rounded-xl text-sm flex items-center gap-2 shadow-sm shadow-[#3995FF]/30 transition-colors">
        <Plus className="w-4 h-4" /> إضافة أنشطة
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4" dir="rtl">
          <div className="bg-white w-full max-w-5xl rounded-2xl shadow-2xl max-h-[95vh] overflow-y-auto custom-scrollbar flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-[#061B40]/10 sticky top-0 bg-white z-20">
              <h2 className="text-lg font-black text-[#061B40]">
                {step === 'choose' && 'إضافة نشاط جديد للمشروع'}
                {step === 'indicators' && `تقييم نشاط: ${selectedActivityLabel}`}
                {step === 'dust' && 'تقييم الرؤية والغبار'}
              </h2>
              <button onClick={resetAndClose} className="text-[#061B40]/50 hover:text-[#061B40] transition-colors"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-6 flex-1">
              {step === 'choose' && <ActivityTypeStep onContinue={handleRegulatoryActivitiesContinue} />}

              {step === 'indicators' && (
                <div className="space-y-6">

                  {/* لا يوجد قسم توقيت/موقع/وردية مشترك بعد الآن — كل نشاط
                      تنظيمي له موقعه وتوقيته ووردية العمل الخاصة به داخل
                      DustStep. */}
                  <div className="flex justify-end">
                    <button type="button" onClick={() => setStep('choose')} className="text-xs font-bold text-[#3995FF] hover:underline bg-blue-50 px-3 py-1 rounded-full">تغيير النشاط</button>
                  </div>

                  {/* --- تبويبات المؤشرات (بدون أي مدخلات وقت) --- */}
                  {activeIndicators.length > 1 && (
                    <div className="flex gap-2 border-b border-[#061B40]/10 pb-2 flex-wrap pt-2">
                      {activeIndicators.map((ind) => (
                        <button key={ind} type="button" onClick={() => setActiveIndicatorTab(ind)} className={`px-5 py-2.5 rounded-t-xl text-sm font-bold transition-all flex items-center gap-2 border-b-4 ${activeIndicatorTab === ind ? 'bg-white text-[#3995FF] border-[#3995FF]' : 'text-gray-500 hover:bg-white/50 border-transparent hover:border-gray-300'}`}>
                          {completedIndicators.includes(ind) && <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                          {INDICATOR_LABEL_AR[ind]}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="pt-2 bg-white rounded-b-xl shadow-sm border border-t-0 border-[#061B40]/5 p-5">
                    {activeIndicatorTab === 'dust' && (
                      <DustStep
                        project={project}
                        isMounted={isMounted}
                        dustForm={dustForm}
                        updateDustField={updateDustField}
                        dustLoading={dustLoading}
                        onSubmit={handleDustSubmit}
                        regulatoryActivities={regulatoryActivities}
                        expandedActivityIds={expandedActivityIds}
                        toggleRegulatoryActivityExpanded={toggleRegulatoryActivityExpanded}
                        removeRegulatoryActivity={removeRegulatoryActivity}
                        updateRegulatoryActivityField={updateRegulatoryActivityField}
                        updateRegulatoryActivityLocation={updateRegulatoryActivityLocation}
                        updateRegulatoryActivityTiming={updateRegulatoryActivityTiming}
                        updateRegulatoryActivityTimingMode={updateRegulatoryActivityTimingMode}
                        updateRegulatoryActivityShift={updateRegulatoryActivityShift}
                        updateBatchingUnit={updateBatchingUnit}
                        addBatchingUnit={addBatchingUnit}
                        removeBatchingUnit={removeBatchingUnit}
                        updateIdleSurfaceUnit={updateIdleSurfaceUnit}
                        addIdleSurfaceUnit={addIdleSurfaceUnit}
                        removeIdleSurfaceUnit={removeIdleSurfaceUnit}
                        updateCrusherUnit={updateCrusherUnit}
                        addCrusherUnit={addCrusherUnit}
                        removeCrusherUnit={removeCrusherUnit}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
