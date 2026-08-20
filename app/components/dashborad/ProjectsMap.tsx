"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvent } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { apiClient } from '@/app/lib/apiClient';
import { SAUDI_BOUNDS, SAUDI_CENTER } from '@/app/utils/geo/countryBounds';
import type { Decision } from '@/app/lib/decisionMeta';

// طلب مستخدم صريح: كانت هذه نسخة محلية مستقلة عن decisionMeta.ts (نفس
// القيم الخمس القديمة معاد كتابتها هنا) — خطر انحراف صامت لو عُدِّل مصدر
// الحقيقة هناك بلا تحديث هذا الملف بالتزامن (بالضبط ما حصل عند تبسيط
// Decision لـ3 مستويات). الآن يستورد النوع مباشرة، والألوان مطابقة لنفس
// 3 المستويات (سماح/مراقبة/إيقاف).
export type { Decision };

const decisionColor: Record<Decision, string> = {
  safe: '#10b981',
  restricted: '#f59e0b',
  stopped: '#b91c1c',
};

const PROJECT_STATUS_LABEL_AR: Record<string, string> = {
  not_started: 'لم يبدأ',
  in_progress: 'جاري',
};

// أيقونة دائرية مخصصة بدل أيقونة Leaflet الافتراضية (اللي تنكسر مع Next.js/webpack)
function makeIcon(color: string) {
  return L.divIcon({
    className: '',
    html: `<div style="width:18px;height:18px;border-radius:9999px;background:${color};border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.35)"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

// يضبط تكبير/تمركز الخريطة تلقائياً بحيث تظهر كل نقاط المشاريع — لكن دون
// تجاوز حدود المملكة الصلبة (SAUDI_BOUNDS)، فلا "يهرب" التكبير التلقائي
// خارج المنطقة المسموحة حتى لو وُجدت نقاط مشاريع خارجها فعلياً.
function FitBounds({ points }: { points: { latitude: number; longitude: number }[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;
    const saudi = L.latLngBounds(SAUDI_BOUNDS);
    const withinSaudi = points.filter((p) => saudi.contains([p.latitude, p.longitude]));
    if (withinSaudi.length === 0) return;
    if (withinSaudi.length === 1) {
      map.setView([withinSaudi[0].latitude, withinSaudi[0].longitude], 11);
    } else {
      const bounds = L.latLngBounds(withinSaudi.map((p) => [p.latitude, p.longitude] as [number, number]));
      map.fitBounds(bounds, { padding: [40, 40] });
    }
  }, [points, map]);

  return null;
}

// يغلق البطاقة المثبَّتة عند النقر على أي جزء آخر من الخريطة (خلفية بلا
// نقطة مشروع) — إغلاق click على العلامة نفسه يُعالَج مباشرة في eventHandlers
// أعلاه، هذا فقط للنقر خارج أي علامة.
function CloseCardOnMapClick({ onClose }: { onClose: () => void }) {
  useMapEvent('click', onClose);
  return null;
}

export interface ProjectPoint {
  id: string;
  name: string;
  city?: string;
  latitude: number;
  longitude: number;
  // null = لا يوجد نشاط جارٍ الآن لهذا المشروع، فلا يوجد قرار لعرضه —
  // النقطة تُرسم بلون محايد بلا أي دلالة خطر/أمان (بطلب صريح من المستخدم:
  // "اذا لا يوجد نشاط لا تظهر قرارات"). القرار عند وجوده هو "القرار الموحد
  // للنشاط" (DVI + الامتثال التنظيمي)، راجع computeUnifiedActivityDecision
  // في app/lib/dustEvaluation.ts وliveActivityByProjectId في route.ts.
  decision: Decision | null;
  projectStatus?: string | null;
  todayActivitiesCount?: number;
  hasLiveActivity?: boolean;
  statusLabel?: string;
  statusReason?: string;
  /** لحظة تسجيل القرار الحالي (final_decisions.evaluated_at) — طلب صريح من
   * جهة المراقبة: تعرض "متى سُجّلت هذه المخالفة" لا وقت التحميل الحالي. */
  decisionEvaluatedAt?: string | null;
  /** القراءة الفعلية التي أنتجت هذا القرار تحديداً (device_readings_history
   * الأقرب لـ decisionEvaluatedAt)، لا القراءة الحية الآن — قد تختلفان
   * تماماً لو تغيّرت الظروف منذ لحظة التسجيل. */
  decisionReadingPm10UgM3?: number | null;
  decisionReadingWindSpeedKmh?: number | null;
}

const decisionLabelAr: Record<Decision, string> = {
  safe: 'سماح',
  restricted: 'مراقبة',
  stopped: 'إيقاف',
};

// رمادي محايد — لا نشاط جارٍ الآن فلا قرار لعرضه إطلاقاً
const NO_ACTIVITY_COLOR = '#94a3b8';
const NO_ACTIVITY_LABEL_AR = 'لا يوجد نشاط جارٍ حالياً';

interface LiveWeather {
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  pm10: number | null;
  pm25: number | null;
}

// يحوّل درجة اتجاه الرياح (خط الشمال = صفر، اتجاه دوران الساعة) إلى نص
// بوصلة عربي مختصر — أسهل قراءة سريعة من رقم الدرجات وحده
function degToCompassAr(deg: number): string {
  const directions = ['شمالية', 'شمالية شرقية', 'شرقية', 'جنوبية شرقية', 'جنوبية', 'جنوبية غربية', 'غربية', 'شمالية غربية'];
  const index = Math.round(deg / 45) % 8;
  return directions[index];
}

// وقت تسجيل القرار — بتوقيت الرياض، بصيغة تاريخ+ساعة مختصرة تكفي لسياق
// فقاعة الهوفر (لا حاجة لثوانٍ).
function formatDecisionTimeAr(iso: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh', calendar: 'gregory' });
  const timePart = d.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh', calendar: 'gregory' });
  return `${datePart} — ${timePart}`;
}

// بطاقة معلومات لنقطة مشروع — موضعة بإحداثيات شاشة ثابتة (screenPosition)
// بدل Popup الافتراضي لأن الأخير لا يدعم "تتبع الفأرة" بسلاسة عند الهوفر.
// قراءات الطقس الحية (رياح/PM10/PM2.5) تُجلب كسولاً هنا فقط عند فتح البطاقة
// فعلياً — لا دفعة واحدة لكل مشاريع الخريطة — عبر /api/weather (استثناء
// متعمَّد لقاعدة "لا نعرض رقماً خاماً" في dust-engine، مبرَّر هنا لأنها نظرة
// عامة على الخريطة لا شاشة قرار تشغيلي لنشاط محدد).
//
// خطأ إتاحة مكتشَف ومُصلَح ("الخريطة تعتمد على hover، ما يضعف استخدامها
// باللمس ولوحة المفاتيح"): كانت هذه البطاقة تظهر حصراً عبر mouseover/
// mousemove/mouseout — بلا أي مسار بديل عبر اللمس (لا يُطلق هذه الأحداث
// إطلاقاً) أو لوحة المفاتيح (التركيز كان يصل فقط لمعالج click، لا للهوفر).
// الآن تُفتح بالنقر/الضغط، أو بالتركيز عبر لوحة المفاتيح (Tab)، أو بـEnter/
// Space على العلامة نفسها، وتُغلق بالنقر خارجها، Escape، أو زر الإغلاق
// الصريح داخلها — نفس المحتوى بلا استثناء آلية الوصول.
function HoverCard({
  point,
  screenPosition,
  hideRawReadings = false,
  minimal = false,
  onSelect,
  onClose,
}: {
  point: ProjectPoint;
  screenPosition: { x: number; y: number };
  // طلب صريح من المستخدم: جهة الرصد لا تُعرض لها القراءات الحية الخام
  // (رياح/PM10/PM2.5) — الاسم/الموقع/لون وحالة القرار/سبب الحالة يبقى
  // ظاهراً كما هو. حين مفعَّل، لا يُستدعى /api/weather إطلاقاً (لا فقط
  // إخفاء العرض بعد الجلب) — توفير طلب شبكة لا داعي له.
  hideRawReadings?: boolean;
  // طلب صريح لاحق من المستخدم (جهة المراقبة فقط): لا يظهر بالفقاعة سوى
  // اسم المشروع/المدينة وحالة المخالفة — تُخفى كل التفاصيل الأخرى (سبب
  // الحالة، الحالة الإدارية، عدد أنشطة اليوم، وقراءات الطقس بالكامل).
  minimal?: boolean;
  // زر "عرض التفاصيل" داخل البطاقة — النقرة الأولى على العلامة تفتح
  // البطاقة (بديل الهوفر)، لا تنقل مباشرة؛ الانتقال الفعلي لصفحة المشروع
  // يتم فقط من هذا الزر الصريح داخل البطاقة.
  onSelect?: () => void;
  onClose: () => void;
}) {
  const [weather, setWeather] = useState<LiveWeather | null>(null);
  // القيمة الابتدائية تعكس ما إذا كان الطلب سيُطلَق فعلياً — hideRawReadings/
  // minimal يمنعان الجلب كلياً (راجع الشرط أدناه)، فلا داعي أن تبدأ true ثم
  // تُصحَّح لاحقاً false داخل الـEffect.
  const [isLoadingWeather, setIsLoadingWeather] = useState(!hideRawReadings && !minimal);

  useEffect(() => {
    if (hideRawReadings || minimal) return;
    let cancelled = false;
    // جدولة عبر microtask بدل استدعاء setWeather/setIsLoadingWeather مباشرة
    // من جسم الـEffect — تعديل حالة متزامن مباشر داخل Effect (نفس السبب
    // الموثَّق في fetchDevices/fetchHistory بصفحات المشروع).
    void Promise.resolve().then(() => {
      if (cancelled) return;
      setWeather(null);
      setIsLoadingWeather(true);
      apiClient
        .get('/weather', { params: { lat: point.latitude, lng: point.longitude } })
        .then(({ data }) => {
          if (!cancelled) setWeather(data?.data ?? null);
        })
        .catch(() => {
          if (!cancelled) setWeather(null);
        })
        .finally(() => {
          if (!cancelled) setIsLoadingWeather(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [point.id, point.latitude, point.longitude, hideRawReadings, minimal]);

  return (
    <div
      role="dialog"
      aria-label={`تفاصيل ${point.name}`}
      className="absolute z-[1000] bg-white rounded-xl shadow-lg border border-slate-200 p-3 min-w-[220px]"
      style={{ left: screenPosition.x + 14, top: screenPosition.y - 14, transform: 'translateY(-100%)' }}
      dir="rtl"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="font-black text-[#061B40] text-sm">{point.name}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="إغلاق"
          className="shrink-0 text-slate-400 hover:text-slate-600 text-xs font-bold leading-none w-4 h-4 flex items-center justify-center"
        >
          ✕
        </button>
      </div>
      {point.city && <div className="text-xs text-slate-500 mb-2">{point.city}</div>}
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: point.decision ? decisionColor[point.decision] : NO_ACTIVITY_COLOR }}
        />
        <span className="text-xs font-bold text-slate-700">
          {point.decision ? point.statusLabel || decisionLabelAr[point.decision] : NO_ACTIVITY_LABEL_AR}
        </span>
      </div>
      {!minimal && point.hasLiveActivity && point.statusReason && (
        <div className="text-[11px] text-slate-500 mb-1.5 leading-relaxed">{point.statusReason}</div>
      )}

      {/* طلب صريح من جهة المراقبة: وقت تسجيل المخالفة + القراءات الفعلية
          وقت التسجيل تحديداً (لا القراءة الحية الآن) — تظهر حتى في وضع
          minimal، بخلاف بقية التفاصيل المخفاة عمداً لهذا الوضع. */}
      {point.hasLiveActivity && point.decisionEvaluatedAt && (
        <div className="text-[11px] text-slate-500 mb-1.5 pt-1.5 border-t border-slate-100 space-y-0.5">
          <div>
            وقت التسجيل: <span className="font-bold text-slate-700">{formatDecisionTimeAr(point.decisionEvaluatedAt)}</span>
          </div>
          {(point.decisionReadingPm10UgM3 !== null && point.decisionReadingPm10UgM3 !== undefined) && (
            <div>
              PM10 وقت التسجيل: <span className="font-bold text-slate-700">{point.decisionReadingPm10UgM3} µg/m³</span>
            </div>
          )}
          {(point.decisionReadingWindSpeedKmh !== null && point.decisionReadingWindSpeedKmh !== undefined) && (
            <div>
              الرياح وقت التسجيل: <span className="font-bold text-slate-700">{point.decisionReadingWindSpeedKmh} كم/س</span>
            </div>
          )}
        </div>
      )}

      {!minimal && (
        <div className="text-[11px] text-slate-500">
          الحالة الإدارية: <span className="font-bold text-slate-700">{PROJECT_STATUS_LABEL_AR[point.projectStatus || ''] || 'غير محدد'}</span>
        </div>
      )}
      {!minimal && (
        <div className="text-[11px] text-slate-500 mb-2">
          أنشطة اليوم: <span className="font-bold text-slate-700">{point.todayActivitiesCount ?? 0}</span>
        </div>
      )}

      {!hideRawReadings && !minimal && (
        <div className="pt-2 border-t border-slate-100 space-y-1">
          {isLoadingWeather ? (
            <div className="text-[11px] text-slate-400">جاري جلب قراءات الطقس...</div>
          ) : weather ? (
            <>
              <div className="text-[11px] text-slate-500">
                الرياح:{' '}
                <span className="font-bold text-slate-700">
                  {weather.windSpeedKmh != null ? `${weather.windSpeedKmh} كم/س` : '—'}
                  {weather.windDirectionDeg != null ? ` (${degToCompassAr(weather.windDirectionDeg)})` : ''}
                </span>
              </div>
              <div className="text-[11px] text-slate-500">
                PM10: <span className="font-bold text-slate-700">{weather.pm10 != null ? `${weather.pm10} µg/m³` : '—'}</span>
              </div>
              <div className="text-[11px] text-slate-500">
                PM2.5: <span className="font-bold text-slate-700">{weather.pm25 != null ? `${weather.pm25} µg/m³` : '—'}</span>
              </div>
            </>
          ) : (
            <div className="text-[11px] text-slate-400">تعذّر جلب قراءات الطقس</div>
          )}
        </div>
      )}

      {onSelect && (
        <button
          type="button"
          onClick={onSelect}
          className="mt-2 pt-2 border-t border-slate-100 w-full text-center text-[11px] font-bold text-[#0176FB] hover:underline"
        >
          عرض التفاصيل
        </button>
      )}
    </div>
  );
}

interface ActiveCardState {
  point: ProjectPoint;
  screenPosition: { x: number; y: number };
  pinned: boolean;
}

type SetActiveCard = Dispatch<SetStateAction<ActiveCardState | null>>;

// علامة مشروع واحدة على الخريطة. مُستخرَجة كمكوّن مستقل (بدل Marker مضمَّن
// مباشرة في الحلقة) لأن ربط حدث 'focus' يحتاج وصولاً مباشراً لكائن
// L.Marker عبر ref — 'focus' مدعوم فعلياً وقت التشغيل في Leaflet (marker
// icon قابل للتركيز افتراضياً، tabIndex=0 + role=button) لكنه غير موجود
// إطلاقاً في نوع LeafletEventHandlerFnMap المستخدَم في prop eventHandlers،
// فلا يمكن تمريره عبرها مباشرة بأمان من ناحية الأنواع.
function ProjectMarker({ point: p, setActiveCard }: { point: ProjectPoint; setActiveCard: SetActiveCard }) {
  const markerRef = useRef<L.Marker | null>(null);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const handleFocus = () => {
      const map = (marker as unknown as { _map: L.Map })._map;
      const containerPoint = map.latLngToContainerPoint(marker.getLatLng());
      setActiveCard({ point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: true });
    };
    marker.on('focus', handleFocus);
    return () => {
      marker.off('focus', handleFocus);
    };
  }, [p, setActiveCard]);

  return (
    <Marker
      ref={markerRef}
      position={[p.latitude, p.longitude]}
      icon={makeIcon(p.decision ? decisionColor[p.decision] : NO_ACTIVITY_COLOR)}
      eventHandlers={{
        // النقر/الضغط (وكذلك Enter/Space عبر لوحة المفاتيح، أو Tab للتركيز
        // — راجع marker.on('focus', ...) أعلاه) يفتح بطاقة المعلومات نفسها
        // المعروضة سابقاً بالهوفر فقط — بديل متكافئ يعمل باللمس ولوحة
        // المفاتيح معاً. نقرة ثانية على نفس النقطة (أو زر الإغلاق داخل
        // البطاقة) تُغلقها. زر "عرض التفاصيل" داخل البطاقة هو المسار الوحيد
        // للتنقل الفعلي لصفحة المشروع (onSelect) — يختفي تلقائياً في وضع
        // minimal لأن onSelect غير مُمرَّرة أصلاً من الأب في تلك الحالة.
        click: (e) => {
          // منع وصول الحدث لمعالج نقر الخريطة (CloseCardOnMapClick) — بدونه،
          // نقر العلامة كان سيفتح البطاقة ثم يغلقها فوراً بنفس النقرة عبر
          // فقاعة الحدث للخريطة.
          L.DomEvent.stopPropagation(e);
          const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
          setActiveCard((prev) =>
            prev?.pinned && prev.point.id === p.id
              ? null
              : { point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: true }
          );
        },
        keypress: (e) => {
          const key = e.originalEvent.key;
          if (key !== 'Enter' && key !== ' ') return;
          const containerPoint = e.target._map.latLngToContainerPoint(e.target.getLatLng());
          setActiveCard({ point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: true });
        },
        keydown: (e) => {
          if (e.originalEvent.key !== 'Escape') return;
          setActiveCard((prev) => (prev?.point.id === p.id ? null : prev));
        },
        // عمداً بلا معالج blur لإغلاق البطاقة — البطاقة تُرسم خارج شجرة DOM
        // الخاصة بالعلامة (موضع مطلق فوق الخريطة)، فـTab من العلامة للوصول
        // لأزرارها (إغلاق/عرض التفاصيل) لا يمر عبر "تركيز العلامة نفسها" بل
        // يقفز للعنصر التالي في تسلسل الصفحة. لو أُغلقت البطاقة عند blur، لن
        // يصل أي مستخدم لوحة مفاتيح لتلك الأزرار إطلاقاً. البطاقة تبقى
        // مفتوحة حتى إغلاق صريح (زر الإغلاق، Escape، أو النقر خارجها عبر
        // CloseCardOnMapClick).
        //
        // الهوفر يبقى معاينة سريعة إضافية لمستخدمي الفأرة فقط — لا يُبدّل
        // بطاقة مثبَّتة بالفعل بالنقر/التركيز لنقطة أخرى.
        mouseover: (e) => {
          setActiveCard((prev) => {
            if (prev?.pinned) return prev;
            const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
            return { point: p, screenPosition: { x: containerPoint.x, y: containerPoint.y }, pinned: false };
          });
        },
        mousemove: (e) => {
          const containerPoint = e.target._map.latLngToContainerPoint(e.latlng);
          setActiveCard((prev) =>
            prev && !prev.pinned && prev.point.id === p.id
              ? { ...prev, screenPosition: { x: containerPoint.x, y: containerPoint.y } }
              : prev
          );
        },
        mouseout: () => setActiveCard((prev) => (prev?.pinned ? prev : null)),
      }}
    />
  );
}

export default function ProjectsMap({
  points,
  onSelect,
  hideRawReadings = false,
  minimal = false,
}: {
  points: ProjectPoint[];
  onSelect?: (id: string) => void;
  hideRawReadings?: boolean;
  // طلب صريح من المستخدم: بفقاعة جهة المراقبة لا يظهر سوى اسم المشروع/
  // المدينة وحالة القرار — كل التفاصيل الأخرى مخفاة (راجع HoverCard أعلاه).
  minimal?: boolean;
}) {
  // activeCard: بطاقة "مثبَّتة" (pinned=true) فُتحت بالنقر/الضغط أو التركيز
  // بلوحة المفاتيح — تبقى ظاهرة حتى تُغلَق صراحة (زر الإغلاق، Escape، أو
  // النقر خارجها)، على عكس الهوفر اللحظي (pinned=false) الذي يختفي عند
  // mouseout كمعاينة سريعة فقط، ولا يستبدل أي بطاقة مثبَّتة بالفعل.
  const [activeCard, setActiveCard] = useState<ActiveCardState | null>(null);

  return (
    <div className="relative w-full h-full">
      <MapContainer
        center={SAUDI_CENTER}
        zoom={6}
        minZoom={5}
        scrollWheelZoom
        maxBounds={SAUDI_BOUNDS}
        maxBoundsViscosity={1.0}
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <FitBounds points={points} />
        <CloseCardOnMapClick onClose={() => setActiveCard((prev) => (prev?.pinned ? null : prev))} />
        {points.map((p) => (
          <ProjectMarker key={p.id} point={p} setActiveCard={setActiveCard} />
        ))}
      </MapContainer>
      {activeCard && (
        <HoverCard
          point={activeCard.point}
          screenPosition={activeCard.screenPosition}
          hideRawReadings={hideRawReadings}
          minimal={minimal}
          onSelect={onSelect ? () => onSelect(activeCard.point.id) : undefined}
          onClose={() => setActiveCard(null)}
        />
      )}
    </div>
  );
}
