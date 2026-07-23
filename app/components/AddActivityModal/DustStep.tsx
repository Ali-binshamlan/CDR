'use client';

import { useMemo, useState, useEffect } from 'react';
import { Wind, Plus, Trash2, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { DUST_FORM_DEFAULTS, getInputClass, labelClass, sectionTitleClass, REGULATORY_ACTIVITY_LABEL_AR } from './constants';
import type { BatchingUnit, IdleSurfaceUnit, CrusherUnit, RegulatoryActivityFields, RegulatoryActivityItem } from './constants';
import type { ProjectLite } from './types';
import { MultiActivityMapPicker, buildMapPoints } from './MultiActivityMapPicker';
import type { MapPoint } from './MultiActivityMapPicker';
import { buildProjectZoneFromRow } from '@/app/utils/geo/zone';

type DustForm = typeof DUST_FORM_DEFAULTS;

interface DustStepProps {
  project: ProjectLite;
  isMounted: boolean;
  dustForm: DustForm;
  updateDustField: (field: keyof DustForm, value: any) => void;
  dustLoading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  regulatoryActivities: RegulatoryActivityItem[];
  expandedActivityIds: Set<string>;
  toggleRegulatoryActivityExpanded: (itemId: string) => void;
  removeRegulatoryActivity: (itemId: string) => void;
  updateRegulatoryActivityField: (itemId: string, field: keyof RegulatoryActivityFields, value: any) => void;
  updateRegulatoryActivityLocation: (itemId: string, lat: number | null, lng: number | null) => void;
  updateRegulatoryActivityTiming: (itemId: string, field: 'startDate' | 'endDate' | 'customStartTime' | 'customEndTime', value: string) => void;
  updateRegulatoryActivityTimingMode: (itemId: string, timingMode: 'shift' | 'custom') => void;
  updateRegulatoryActivityShift: (itemId: string, shiftId: string | null) => void;
  updateBatchingUnit: (itemId: string, index: number, field: keyof BatchingUnit, value: any) => void;
  addBatchingUnit: (itemId: string) => void;
  removeBatchingUnit: (itemId: string, index: number) => void;
  updateIdleSurfaceUnit: (itemId: string, index: number, field: keyof IdleSurfaceUnit, value: any) => void;
  addIdleSurfaceUnit: (itemId: string) => void;
  removeIdleSurfaceUnit: (itemId: string, index: number) => void;
  updateCrusherUnit: (itemId: string, index: number, field: keyof CrusherUnit, value: any) => void;
  addCrusherUnit: (itemId: string) => void;
  removeCrusherUnit: (itemId: string, index: number) => void;
}

// ملاحظة: من بين الحقول ضمن DUST_CONTROL_CHECKBOXES، dustScreensAvailable فقط
// تُستخدم فعلياً في قواعد الامتثال التنظيمي (rulebook.ts).
const DUST_CONTROL_CHECKBOXES: { key: keyof DustForm; label: string }[] = [
  { key: 'wateringAvailable', label: 'رش الطرق متوفر' },
  { key: 'stockpilesCovered', label: 'الأكوام مغطاة' },
  { key: 'speedLimitApplied', label: 'تحديد سرعة داخلي' },
  { key: 'wheelWashAvailable', label: 'مغسلة إطارات متوفرة' },
  { key: 'dustScreensAvailable', label: 'شاشات غبار متوفرة' },
  { key: 'fieldMonitoringAvailable', label: 'مراقبة ميدانية فعّالة' },
];
const COMPLIANCE_RELEVANT_CONTROL_KEYS = new Set<keyof DustForm>(['dustScreensAvailable']);
// مخفي مؤقتاً: هذه الحقول تؤثر فقط على محرك DVI الفيزيائي (mitigationScore
// في dust-engine/engine.ts)، ولا علاقة لها بمحرك الامتثال التنظيمي إطلاقاً.
const SHOW_CONTROL_MEASURES_SECTION = false;

const SENSITIVE_REGULATORY_ACTIVITIES = new Set(['DEMOLITION', 'CRUSHER', 'STONE_CUTTING']);

// -----------------------------------------------------------------------
// تنبيهات عامة (نصية فقط، لا إدخال) لكل نشاط تنظيمي — بديل حقول الضوابط
// التفصيلية التي كانت تُدخَل يدوياً سابقاً. حُذف تأثيرها من قرار الامتثال
// فعلياً في dust-compliance-engine/rulebook.ts (القواعد المرتبطة بهذه
// الحقول أُزيلت من applyActivityRules)، فهذا النص توعوي بحت لا يُغذّي أي
// قاعدة — القرار الفعلي يعتمد فقط على الحقول التي بقيت مدخلات حقيقية
// (المواقع، والحقول الرقمية العتبية القليلة أدناه لكل نشاط).
const GENERAL_ALERTS_AR: Record<string, string[]> = {
  EARTHWORKS: [
    'رشّ التربة إلزامي أثناء الحفر والتحميل والتفريغ.',
    'ارتفاع تفريغ التربة يجب ألا يتجاوز 1.5م اعتيادياً، أو 1م أثناء رياح ≥15 كم/س.',
    'دكّ التربة مباشرة بعد الحفر، وتخصيص مسارات مغطاة لعبور الشاحنات.',
    'عند توقف الأعمال أكثر من 5 أيام، استخدم مواد مثبتة للغبار على السطح المكشوف.',
  ],
  SITE_TRAFFIC: [
    'رشّ الطرق غير المسفلتة يومياً، وتثبيت لافتات تحدد السرعة (10 كم/س للطرق غير المسفلتة، 20 كم/س للمسفلتة).',
    'تغطية جميع الحمولات والحاويات قبل التحرك وفحصها قبل المغادرة.',
    'وحدة غسيل إطارات عاملة عند المخرج، وكنس الطرق المجاورة آلياً بانتظام.',
    'تنظيف أي انسكاب خلال 15 دقيقة من وقوعه.',
  ],
  MATERIAL_HANDLING_STOCKPILE: [
    'تخزين مركزي للمواد بدل توزيعها في مواقع متفرقة، وتغطية الأكوام غير المستخدمة يومياً.',
    'رشّ المواد فوراً بعد التنزيل، وشكل الأكوام منخفض ومستدير لتقليل انجراف الغبار.',
    'الإسمنت في صوامع محكمة الإغلاق مزودة بفلاتر PM10.',
    'السيور الناقلة مغلقة وتستخدم رشاً آلياً، ومصدات رياح بمحاذاة اتجاه الريح السائد.',
  ],
  DEMOLITION: [
    'رش رذاذ مستمر أو مدفع رذاذ (مدى 20-30م) طوال أعمال الهدم.',
    'تغطية الكسارات المستخدمة في الهدم، ونقاط التحميل/التنزيل مزودة برشاشات.',
    'استخدام مناشير مزودة بالمياه أو أنظمة شفط بدل الأدوات العادية للقطع.',
    'الضغط الرملي (إن استُخدم) يجب أن يتم داخل صندوق مغلق فقط.',
  ],
  CRUSHER: [
    'تغطية وحدات الكسارة بالكامل، ونقاط التحميل/التنزيل مزودة برشاشات أو أنظمة ضباب.',
    'مدافع رذاذ حول الكسارة، وناقلات مغطاة، وتقليل ارتفاع نقاط التفريغ.',
    'أنظمة شفط وفلترة مطلوبة للكسارة غير المغلقة.',
  ],
  BATCHING_PLANT: [
    'صيانة دورية لفلاتر PM10 وفحص موانع التسرب دورياً.',
    'فحص أنظمة تثبيط الغبار يومياً، وحظر الكنس اليدوي الجاف والهواء المضغوط صراحة في إجراءات الموقع.',
    'الحفاظ على رطوبة النفايات وتغطيتها أثناء النقل.',
  ],
  STONE_CUTTING: [
    'قطع مبلل بتبريد مائي مستمر، أو شفط هواء HEPA ضمن تشغيل مغلق.',
    'تنظيف مخلفات وبودرة القطع فور الانتهاء من كل عملية.',
    'إيقاف القطع المكشوف عند تجاوز سرعة الرياح 15 كم/س يُحسب تلقائياً من بيانات الرياح الحية.',
  ],
  CD_WASTE_TRANSPORT: [
    'رش المخلفات قبل التحميل والتفريغ، وتخزينها في منطقة مركزية واحدة.',
    'إزالة يومية للمخلفات، أو تغطيتها بأغطية محكمة إن لم تُزل.',
    'تغطية جميع شاحنات النقل، وعدم تجاوز الحمولة السعة الاستيعابية.',
  ],
  IDLE_SURFACE: [
    'تثبيت السطح غير النشط بمواد مناسبة (بوليمرات أو أغطية واقية) عند توقف العمل عليه.',
    'التحقق من سلامة الغطاء دورياً، خاصة عند رياح ≥20 كم/س.',
    'حواجز رياح قرب مناطق تجميع المواد، وجدولة استئناف البناء مباشرة بعد التجهيز لتقليل مدة التعرض.',
  ],
  OTHER: [
    'طبّق ضوابط الحد من الغبار العامة المناسبة لطبيعة هذا النشاط حسب دليل RCRC/NCEC.',
  ],
};

export function DustStep({
  project, isMounted,
  dustForm, updateDustField, dustLoading, onSubmit,
  regulatoryActivities, expandedActivityIds, toggleRegulatoryActivityExpanded, removeRegulatoryActivity,
  updateRegulatoryActivityField, updateRegulatoryActivityLocation, updateRegulatoryActivityTiming, updateRegulatoryActivityTimingMode, updateRegulatoryActivityShift,
  updateBatchingUnit, addBatchingUnit, removeBatchingUnit,
  updateIdleSurfaceUnit, addIdleSurfaceUnit, removeIdleSurfaceUnit,
  updateCrusherUnit, addCrusherUnit, removeCrusherUnit,
}: DustStepProps) {
  const mapCenterLat = project.latitude || 24.7136;
  const mapCenterLng = project.longitude || 46.6753;
  const projectZone = useMemo(() => buildProjectZoneFromRow(project as any), [project]);
  const projectShifts = Array.isArray(project.shifts) ? project.shifts : [];

  // النقطة النشِطة حالياً على الخريطة الموحدة (نشاط عادي، أو وحدة
  // خلاطة/كسارة محددة) — النقر على الخريطة يحدد موقع هذه النقطة تحديداً.
  // تبدأ بأول نقطة متاحة، وتتبع أي تغيير في قائمة النقاط إن لم تعد النقطة
  // الحالية موجودة (نشاط/وحدة حُذفت).
  const mapPoints = buildMapPoints(regulatoryActivities);
  const [activeMapPointId, setActiveMapPointId] = useState<string | null>(mapPoints[0]?.id ?? null);
  useEffect(() => {
    if (!mapPoints.some((p) => p.id === activeMapPointId)) {
      setActiveMapPointId(mapPoints[0]?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regulatoryActivities.length, activeMapPointId]);

  const handlePointLocationChange = (point: MapPoint, lat: number, lng: number) => {
    const idParts = point.id.split(':');
    if (idParts.length === 3 && idParts[1] === 'batching') {
      updateBatchingUnit(point.itemId, Number(idParts[2]), 'batchingLat', lat);
      updateBatchingUnit(point.itemId, Number(idParts[2]), 'batchingLng', lng);
    } else if (idParts.length === 3 && idParts[1] === 'crusher') {
      updateCrusherUnit(point.itemId, Number(idParts[2]), 'crusherLat', lat);
      updateCrusherUnit(point.itemId, Number(idParts[2]), 'crusherLng', lng);
    } else {
      updateRegulatoryActivityLocation(point.itemId, lat, lng);
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <form onSubmit={onSubmit} className="space-y-5">

        {/* كل نشاط تنظيمي مُختار في الشاشة السابقة يصبح بطاقة أكورديون
            مستقلة هنا — موقعها يُحدَّد من الخريطة الموحدة أدناه، وتوقيتها
            الخاص (بداية/نهاية)، وتنبيهات عامة بدل حقول إدخال تفصيلية
            (باستثناء عدد قليل من الحقول الحرجة الباقية كمدخلات حقيقية —
            راجع GENERAL_ALERTS_AR أعلاه). */}
        <div className="space-y-3 border-t border-[#061B40]/10 pt-4">
          <h3 className={sectionTitleClass + ' flex items-center gap-1.5'}>
            الأنشطة التنظيمية ({regulatoryActivities.length})
          </h3>

          {/* خريطة واحدة موحدة لكل الأنشطة معاً — نقطة لكل نشاط عادي، أو
              نقطة لكل وحدة خلاطة/كسارة */}
          {regulatoryActivities.length > 0 && (
            <MultiActivityMapPicker
              items={regulatoryActivities}
              activePointId={activeMapPointId}
              onActivate={(pointId) => {
                setActiveMapPointId(pointId);
                const itemId = pointId.split(':')[0];
                if (!expandedActivityIds.has(itemId)) toggleRegulatoryActivityExpanded(itemId);
              }}
              onPointLocationChange={handlePointLocationChange}
              isMounted={isMounted}
              centerLat={mapCenterLat}
              centerLng={mapCenterLng}
              projectZone={projectZone}
            />
          )}

          <div className="space-y-2">
            {regulatoryActivities.map((item, index) => {
              const isExpanded = expandedActivityIds.has(item.id);
              const isSensitive = SENSITIVE_REGULATORY_ACTIVITIES.has(item.fields.regulatoryActivity as string);
              const alerts = GENERAL_ALERTS_AR[item.fields.regulatoryActivity as string] ?? [];
              const hasLocation = typeof item.lat === 'number' && typeof item.lng === 'number';

              return (
                <div key={item.id} className="rounded-xl border border-[#061B40]/10 overflow-hidden">
                  <div className="flex items-center justify-between bg-[#F4F7FB] px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleRegulatoryActivityExpanded(item.id)}
                      className="flex items-center gap-2 flex-1 text-right"
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-[#061B40]/60" /> : <ChevronDown className="w-4 h-4 text-[#061B40]/60" />}
                      <span className="text-sm font-bold text-[#061B40]">
                        {index + 1}. {REGULATORY_ACTIVITY_LABEL_AR[item.fields.regulatoryActivity] || item.fields.regulatoryActivity}
                      </span>
                      {!hasLocation && (
                        <span className="text-[10px] font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> بلا موقع
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRegulatoryActivity(item.id)}
                      className="text-red-500 hover:text-red-600 shrink-0"
                      title="حذف هذا النشاط"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="p-4 space-y-4 bg-white">
                      {/* موقع هذا النشاط يُحدَّد من الخريطة الموحدة أعلاه —
                          هذا الزر فقط ينشّط النشاط عليها إن لم يكن مفعّلاً.
                          لا يظهر لأنشطة الخلاطة/الكسارة — موقعها يأتي من
                          موقع الوحدة الأولى ضمن أقسامها أدناه مباشرة. */}
                      {item.fields.regulatoryActivity !== 'BATCHING_PLANT' && item.fields.regulatoryActivity !== 'CRUSHER' && (
                        <div className="flex items-center justify-between rounded-lg border border-[#061B40]/10 bg-[#F4F7FB] px-3 py-2">
                          <span className="text-xs font-bold text-[#061B40]">
                            {hasLocation ? `الموقع محدَّد (${item.lat!.toFixed(5)}, ${item.lng!.toFixed(5)})` : 'لم يُحدَّد الموقع بعد'}
                          </span>
                          <button
                            type="button"
                            onClick={() => setActiveMapPointId(item.id)}
                            className={`text-xs font-bold px-3 py-1 rounded-full border transition-colors ${
                              activeMapPointId === item.id
                                ? 'bg-[#3995FF] text-white border-[#3995FF]'
                                : 'bg-white text-[#3995FF] border-[#3995FF]/40 hover:bg-blue-50'
                            }`}
                          >
                            {activeMapPointId === item.id ? 'نشِط على الخريطة أعلاه' : 'حدّد موقعه على الخريطة'}
                          </button>
                        </div>
                      )}

                      {/* توقيت هذا النشاط تحديداً — مدى تاريخ مستقل (قد يمتد
                          لأيام/أشهر)، وساعات عمل يومية تنطبق على كل يوم ضمن
                          هذا المدى: إما وردية جاهزة أو وقت مخصص، خيار واحد
                          فقط لا الاثنين معاً. */}
                      <div className="space-y-3">
                        <p className="text-[11px] font-bold text-[#061B40]/50">
                          هذا التوقيت خاص بهذا النشاط التنظيمي فقط.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className={labelClass}>تاريخ بداية النشاط</label>
                            <input
                              required
                              type="date"
                              value={item.startDate}
                              onChange={(e) => updateRegulatoryActivityTiming(item.id, 'startDate', e.target.value)}
                              className={getInputClass(false)}
                            />
                          </div>
                          <div>
                            <label className={labelClass}>تاريخ نهاية النشاط</label>
                            <input
                              required
                              type="date"
                              min={item.startDate || undefined}
                              value={item.endDate}
                              onChange={(e) => updateRegulatoryActivityTiming(item.id, 'endDate', e.target.value)}
                              className={getInputClass(false)}
                            />
                          </div>
                        </div>

                        {/* اختيار نوع الساعات اليومية — وردية جاهزة أو وقت
                            مخصص، خيار واحد فقط. لا يظهر اختيار الوردية إن لم
                            تُعرَّف ورديات فعلية على المشروع أصلاً. */}
                        {projectShifts.length > 0 && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => updateRegulatoryActivityTimingMode(item.id, 'shift')}
                              className={`flex-1 text-xs font-bold px-3 py-2 rounded-lg border transition-colors ${
                                item.timingMode === 'shift'
                                  ? 'bg-[#3995FF] text-white border-[#3995FF]'
                                  : 'bg-white text-[#061B40] border-[#061B40]/20 hover:bg-gray-50'
                              }`}
                            >
                              وردية جاهزة
                            </button>
                            <button
                              type="button"
                              onClick={() => updateRegulatoryActivityTimingMode(item.id, 'custom')}
                              className={`flex-1 text-xs font-bold px-3 py-2 rounded-lg border transition-colors ${
                                item.timingMode === 'custom'
                                  ? 'bg-[#3995FF] text-white border-[#3995FF]'
                                  : 'bg-white text-[#061B40] border-[#061B40]/20 hover:bg-gray-50'
                              }`}
                            >
                              وقت مخصص
                            </button>
                          </div>
                        )}

                        {item.timingMode === 'shift' && projectShifts.length > 0 ? (
                          <div>
                            <label className={labelClass}>أي وردية يتبع هذا النشاط؟</label>
                            <select
                              required
                              value={item.shiftId ?? ''}
                              onChange={(e) => updateRegulatoryActivityShift(item.id, e.target.value || null)}
                              className={getInputClass(false)}
                            >
                              <option value="">اختر وردية...</option>
                              {projectShifts.map((s: any) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({s.start_time.slice(0, 5)} – {s.end_time.slice(0, 5)})
                                </option>
                              ))}
                            </select>
                            <p className="text-[11px] text-[#061B40]/50 mt-1">وقت النشاط اليومي = وقت الوردية نفسه، لا حاجة لإدخال إضافي.</p>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className={labelClass}>وقت البداية اليومي</label>
                              <input
                                required
                                type="time"
                                value={item.customStartTime}
                                min={project.work_hours_start ? project.work_hours_start.slice(0, 5) : undefined}
                                max={project.work_hours_end ? project.work_hours_end.slice(0, 5) : undefined}
                                onChange={(e) => updateRegulatoryActivityTiming(item.id, 'customStartTime', e.target.value)}
                                className={getInputClass(false)}
                              />
                            </div>
                            <div>
                              <label className={labelClass}>وقت النهاية اليومي</label>
                              <input
                                required
                                type="time"
                                value={item.customEndTime}
                                min={project.work_hours_start ? project.work_hours_start.slice(0, 5) : undefined}
                                max={project.work_hours_end ? project.work_hours_end.slice(0, 5) : undefined}
                                onChange={(e) => updateRegulatoryActivityTiming(item.id, 'customEndTime', e.target.value)}
                                className={getInputClass(false)}
                              />
                            </div>
                            {project.work_hours_start && project.work_hours_end && (
                              <p className="text-[11px] text-[#061B40]/50 md:col-span-2">
                                يجب أن يقع الوقت ضمن دوام المشروع: <span dir="ltr" className="font-bold">{project.work_hours_start.slice(0, 5)} – {project.work_hours_end.slice(0, 5)}</span>
                              </p>
                            )}
                          </div>
                        )}

                        {/* المدة الإجمالية — معلوماتية فقط، تُحسب تلقائياً
                            (ساعات اليوم × عدد أيام العمل ضمن المدى) */}
                        {(() => {
                          const daily =
                            item.timingMode === 'shift'
                              ? (() => {
                                  const s = projectShifts.find((sh: any) => sh.id === item.shiftId);
                                  return s ? { start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) } : null;
                                })()
                              : item.customStartTime && item.customEndTime
                              ? { start: item.customStartTime, end: item.customEndTime }
                              : null;
                          if (!daily || !item.startDate || !item.endDate) return null;
                          const toMin = (hhmm: string) => {
                            const [h, m] = hhmm.split(':').map(Number);
                            return (h || 0) * 60 + (m || 0);
                          };
                          const dailyHours = (toMin(daily.end) - toMin(daily.start)) / 60;
                          if (dailyHours <= 0) return null;
                          const start = new Date(`${item.startDate}T00:00:00`);
                          const end = new Date(`${item.endDate}T00:00:00`);
                          if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return null;
                          const workDays = project.work_days_list;
                          let days = 0;
                          for (let i = 0, d = new Date(start); d <= end && i < 370; d.setDate(d.getDate() + 1), i++) {
                            if (Array.isArray(workDays) && workDays.length > 0) {
                              const WEEK_DAY_IDS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
                              if (!workDays.includes(WEEK_DAY_IDS[d.getDay()])) continue;
                            }
                            days++;
                          }
                          if (days <= 0) return null;
                          const totalHours = dailyHours * days;
                          return (
                            <p className="text-[11px] font-bold text-[#061B40]/70 bg-[#F4F7FB] rounded-lg px-3 py-2">
                              المدة الإجمالية المحسوبة: {dailyHours} ساعة/يوم × {days} يوم عمل = <span className="text-[#3995FF]">{totalHours.toFixed(1)} ساعة</span>
                            </p>
                          );
                        })()}
                      </div>

                      {/* التنبيهات العامة — نص توعوي بحت، لا يُغذّي أي قاعدة
                          امتثال (حُذف تأثير هذه الضوابط من rulebook.ts فعلياً) */}
                      {alerts.length > 0 && (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
                          <p className="text-[11px] font-black text-amber-800 flex items-center gap-1.5">
                            <AlertTriangle className="w-3.5 h-3.5" /> تنبيهات عامة — متطلبات الامتثال لهذا النشاط
                          </p>
                          {alerts.map((a, i) => (
                            <p key={i} className="text-[12px] text-amber-900 pr-4">⚠ {a}</p>
                          ))}
                        </div>
                      )}

                      {/* الحقول التي بقيت مدخلات حقيقية — راجع التعليق أعلى
                          GENERAL_ALERTS_AR لتبرير الإبقاء عليها تحديداً */}
                      {item.fields.regulatoryActivity === 'BATCHING_PLANT' && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold text-[#061B40]">بيانات محطات الخلط (وحدة لكل محطة/صومعة)</h4>
                            <button type="button" onClick={() => addBatchingUnit(item.id)} className="flex items-center gap-1 text-xs font-bold text-orange-600 hover:text-orange-700 bg-orange-50 px-3 py-1.5 rounded-full border border-orange-200">
                              <Plus className="w-3.5 h-3.5" /> إضافة محطة أخرى
                            </button>
                          </div>
                          {item.batchingUnits.map((unit, i) => (
                            <div key={i} className="p-3 rounded-xl border border-orange-200 bg-orange-50/40 space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-orange-700">محطة/صومعة رقم {i + 1}</span>
                                {item.batchingUnits.length > 1 && (
                                  <button type="button" onClick={() => removeBatchingUnit(item.id, i)} className="text-red-500 hover:text-red-600">
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                              {(() => {
                                const pointId = `${item.id}:batching:${i}`;
                                const hasUnitLocation = typeof unit.batchingLat === 'number' && typeof unit.batchingLng === 'number';
                                return (
                                  <div className="flex items-center justify-between rounded-lg border border-orange-200 bg-white px-3 py-2">
                                    <span className="text-xs font-bold text-[#061B40]">
                                      {hasUnitLocation ? `الموقع محدَّد (${Number(unit.batchingLat).toFixed(5)}, ${Number(unit.batchingLng).toFixed(5)})` : 'لم يُحدَّد الموقع بعد'}
                                      {i === 0 && <span className="text-[10px] text-[#061B40]/50"> — هذا الموقع هو نفسه موقع النشاط</span>}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setActiveMapPointId(pointId)}
                                      className={`text-xs font-bold px-3 py-1 rounded-full border transition-colors shrink-0 ${
                                        activeMapPointId === pointId
                                          ? 'bg-orange-500 text-white border-orange-500'
                                          : 'bg-white text-orange-600 border-orange-300 hover:bg-orange-50'
                                      }`}
                                    >
                                      {activeMapPointId === pointId ? 'نشِط على الخريطة أعلاه' : 'حدّد موقعها على الخريطة'}
                                    </button>
                                  </div>
                                );
                              })()}
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                  <label className={labelClass}>هل الصوامع محكمة الإغلاق؟ <span className="text-red-500">*</span></label>
                                  <select required value={String(unit.silosSealed)} onChange={(e) => updateBatchingUnit(item.id, i, 'silosSealed', e.target.value === 'true')} className={getInputClass(false)}>
                                    <option value="true">نعم، محكمة الإغلاق</option>
                                    <option value="false">لا</option>
                                  </select>
                                </div>
                                <div>
                                  <label className={labelClass}>كفاءة فلتر PM10 (%) <span className="text-red-500">*</span></label>
                                  <input required type="number" step="0.1" min={0} max={100} placeholder="مثال: 99.5" value={unit.pm10FilterEfficiencyPercent} onChange={(e) => updateBatchingUnit(item.id, i, 'pm10FilterEfficiencyPercent', e.target.value)} className={getInputClass(false)} />
                                </div>
                                <div>
                                  <label className={labelClass}>هل رُصد تسرب من الصومعة/النقل؟ <span className="text-red-500">*</span></label>
                                  <select required value={String(unit.leakDetected)} onChange={(e) => updateBatchingUnit(item.id, i, 'leakDetected', e.target.value === 'true')} className={getInputClass(false)}>
                                    <option value="false">لا يوجد تسرب</option>
                                    <option value="true">نعم، يوجد تسرب</option>
                                  </select>
                                </div>
                                <div>
                                  <label className={labelClass}>هل استُخدم الكنس الجاف/النفخ بالهواء المضغوط؟ <span className="text-red-500">*</span></label>
                                  <select required value={String(unit.dryCleaningMethodUsed)} onChange={(e) => updateBatchingUnit(item.id, i, 'dryCleaningMethodUsed', e.target.value === 'true')} className={getInputClass(false)}>
                                    <option value="false">لا (شفط/تنظيف رطب)</option>
                                    <option value="true">نعم (ممنوع تنظيمياً)</option>
                                  </select>
                                </div>
                                <div className="flex items-center gap-2">
                                  <input id={`batching-suppression-${item.id}-${i}`} type="checkbox" checked={!!unit.dustSuppressionSystemOperational} onChange={(e) => updateBatchingUnit(item.id, i, 'dustSuppressionSystemOperational', e.target.checked)} className="w-4 h-4 accent-orange-500" />
                                  <label htmlFor={`batching-suppression-${item.id}-${i}`} className="text-sm text-[#061B40]">نظام تثبيط الغبار عامل عند هذه المحطة</label>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {item.fields.regulatoryActivity === 'IDLE_SURFACE' && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold text-[#061B40]">بيانات الأسطح غير النشطة (وحدة لكل سطح)</h4>
                            <button type="button" onClick={() => addIdleSurfaceUnit(item.id)} className="flex items-center gap-1 text-xs font-bold text-orange-600 hover:text-orange-700 bg-orange-50 px-3 py-1.5 rounded-full border border-orange-200">
                              <Plus className="w-3.5 h-3.5" /> إضافة سطح آخر
                            </button>
                          </div>
                          {item.idleSurfaceUnits.map((unit, i) => (
                            <div key={i} className="p-3 rounded-xl border border-orange-200 bg-orange-50/40 space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-orange-700">سطح رقم {i + 1}</span>
                                {item.idleSurfaceUnits.length > 1 && (
                                  <button type="button" onClick={() => removeIdleSurfaceUnit(item.id, i)} className="text-red-500 hover:text-red-600">
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div>
                                  <label className={labelClass}>عدد أيام التوقف عن العمل <span className="text-red-500">*</span></label>
                                  <input required type="number" min={0} placeholder="مثال: 7" value={unit.idleDays} onChange={(e) => updateIdleSurfaceUnit(item.id, i, 'idleDays', e.target.value)} className={getInputClass(false)} />
                                </div>
                                <div>
                                  <label className={labelClass}>هل السطح مثبت؟ <span className="text-red-500">*</span></label>
                                  <select required value={String(unit.idleSurfaceStabilized)} onChange={(e) => updateIdleSurfaceUnit(item.id, i, 'idleSurfaceStabilized', e.target.value === 'true')} className={getInputClass(false)}>
                                    <option value="true">نعم، مثبت</option>
                                    <option value="false">لا</option>
                                  </select>
                                </div>
                                <div>
                                  <label className={labelClass}>هل غطاء السطح سليم؟ <span className="text-red-500">*</span></label>
                                  <select required value={String(unit.idleSurfaceCoverIntact)} onChange={(e) => updateIdleSurfaceUnit(item.id, i, 'idleSurfaceCoverIntact', e.target.value === 'true')} className={getInputClass(false)}>
                                    <option value="true">نعم، سليم</option>
                                    <option value="false">لا، تالف أو غير موجود</option>
                                  </select>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {item.fields.regulatoryActivity === 'CRUSHER' && (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold text-[#061B40]">بيانات الكسارات (وحدة لكل كسارة)</h4>
                            <button type="button" onClick={() => addCrusherUnit(item.id)} className="flex items-center gap-1 text-xs font-bold text-orange-600 hover:text-orange-700 bg-orange-50 px-3 py-1.5 rounded-full border border-orange-200">
                              <Plus className="w-3.5 h-3.5" /> إضافة كسارة أخرى
                            </button>
                          </div>
                          {item.crusherUnits.map((unit, i) => (
                            <div key={i} className="p-3 rounded-xl border border-orange-200 bg-orange-50/40 space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-orange-700">كسارة رقم {i + 1}</span>
                                {item.crusherUnits.length > 1 && (
                                  <button type="button" onClick={() => removeCrusherUnit(item.id, i)} className="text-red-500 hover:text-red-600">
                                    <Trash2 className="w-4 h-4" />
                                  </button>
                                )}
                              </div>
                              {(() => {
                                const pointId = `${item.id}:crusher:${i}`;
                                const hasUnitLocation = typeof unit.crusherLat === 'number' && typeof unit.crusherLng === 'number';
                                return (
                                  <div className="flex items-center justify-between rounded-lg border border-orange-200 bg-white px-3 py-2">
                                    <span className="text-xs font-bold text-[#061B40]">
                                      {hasUnitLocation ? `الموقع محدَّد (${Number(unit.crusherLat).toFixed(5)}, ${Number(unit.crusherLng).toFixed(5)})` : 'لم يُحدَّد الموقع بعد'}
                                      {i === 0 && <span className="text-[10px] text-[#061B40]/50"> — هذا الموقع هو نفسه موقع النشاط</span>}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => setActiveMapPointId(pointId)}
                                      className={`text-xs font-bold px-3 py-1 rounded-full border transition-colors shrink-0 ${
                                        activeMapPointId === pointId
                                          ? 'bg-orange-500 text-white border-orange-500'
                                          : 'bg-white text-orange-600 border-orange-300 hover:bg-orange-50'
                                      }`}
                                    >
                                      {activeMapPointId === pointId ? 'نشِط على الخريطة أعلاه' : 'حدّد موقعها على الخريطة'}
                                    </button>
                                  </div>
                                );
                              })()}
                              <p className="text-[11px] text-[#061B40]/50">تُحسب مسافة الكسارة عن أقرب مستقبل حساس (مدرسة/مستشفى/سكني) تلقائياً من هذا الموقع.</p>
                              <div>
                                <label className={labelClass}>مسافة الكسارة من أقرب مستقبل حساس (م) — احتياطي يدوي إن تعذّر التحديد على الخريطة</label>
                                <input type="number" placeholder="اتركه فارغًا" value={unit.crusherDistanceToReceptorM} onChange={(e) => updateCrusherUnit(item.id, i, 'crusherDistanceToReceptorM', e.target.value)} className={getInputClass(false)} />
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* isEnclosedOperation يبقى مدخلاً حقيقياً (لا تنبيهاً
                          نصياً) لأنه يتحكم مباشرة في بوابة إيقاف إلزامي مرتبطة
                          ببيانات الرياح الحية (GATE-WIND-ABOVE-25-004،
                          DEMO-WIND-STOP-001، وقواعد الكسارة/قطع الأحجار) — هذا
                          سؤال بنيوي عن طبيعة العملية نفسها، وليس تفصيل ضبط
                          يمكن تعميمه كتنبيه عام. */}
                      {isSensitive && (
                        <div className="flex items-center gap-2">
                          <input
                            id={`enclosed-${item.id}`}
                            type="checkbox"
                            checked={item.fields.isEnclosedOperation}
                            onChange={(e) => updateRegulatoryActivityField(item.id, 'isEnclosedOperation', e.target.checked)}
                            className="w-4 h-4 accent-orange-500"
                          />
                          <label htmlFor={`enclosed-${item.id}`} className="text-sm text-[#061B40]">
                            عملية مغلقة (محكمة الإغلاق)
                          </label>
                        </div>
                      )}

                      {isSensitive && item.fields.regulatoryActivity === 'DEMOLITION' && (
                        <div>
                          <label className={labelClass}>مساحة الهدم النشطة (م²)</label>
                          <input type="number" placeholder="اتركه فارغًا" value={item.fields.demolitionActiveAreaM2} onChange={(e) => updateRegulatoryActivityField(item.id, 'demolitionActiveAreaM2', e.target.value)} className={getInputClass(false)} />
                          <p className="text-[11px] text-[#061B40]/50 mt-1">الحد التنظيمي: 100 م² للمرة الواحدة.</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {SHOW_CONTROL_MEASURES_SECTION && (
        <div className="space-y-3 border-t border-[#061B40]/10 pt-4">
          <h3 className={sectionTitleClass}>إجراءات التحكم المتوفرة</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {DUST_CONTROL_CHECKBOXES.filter((item) => COMPLIANCE_RELEVANT_CONTROL_KEYS.has(item.key)).map((item) => (
              <label key={item.key} className="flex items-center gap-2 text-sm text-[#061B40] bg-[#F4F7FB]/50 rounded-lg border border-[#061B40]/10 p-2 cursor-pointer hover:bg-gray-50">
                <input type="checkbox" checked={dustForm[item.key] as boolean} onChange={(e) => updateDustField(item.key, e.target.checked)} className="w-4 h-4 accent-orange-500" />
                {item.label}
              </label>
            ))}
          </div>
        </div>
        )}

        <div className="flex gap-3 pt-2">
          <button type="submit" disabled={dustLoading || regulatoryActivities.length === 0} className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white font-bold py-3.5 rounded-xl text-sm flex items-center justify-center gap-2 transition-colors shadow-sm">
            <Wind className="w-5 h-5" />
            {dustLoading
              ? 'جاري التقييم...'
              : `حفظ وتقييم كل الأنشطة (${regulatoryActivities.length})`}
          </button>
        </div>
      </form>
    </div>
  );
}
