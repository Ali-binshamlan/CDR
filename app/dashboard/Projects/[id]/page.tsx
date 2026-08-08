'use client';

import { use, useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';
import { supabase } from '@/app/lib/supabase';
import { useNow } from '@/app/lib/useNow';
import { isLiveDataV2Enabled } from '@/app/lib/liveData/featureFlag';
import { useLiveDeviceData } from '@/app/lib/liveData/useLiveDeviceData';

import ProjectHeader from '@/app/components/dashborad/Projects/[id]/components/ProjectHeader';
import DashboardFilters from '@/app/components/dashborad/Projects/[id]/components/DashboardFilters';
import LiveDataIndicator from '@/app/components/dashborad/Projects/[id]/components/LiveDataIndicator';
import MultiIndicatorActivityBox, {
  IndicatorSummary,
  UnifiedDecisionTarget,
} from '@/app/components/dashborad/projectdashborad/MultiIndicatorActivityBox';
import DustWidgetCard from '@/app/components/dashborad/projectdashborad/Dustwidgetcard';
import ComplianceWidgetCard from '@/app/components/dashborad/projectdashborad/Compliancewidgetcard';
import type { ProjectRow } from '@/app/lib/dustEvaluation';

// ---------------------------------------------------------------------
// عقد البيانات المتوقّع من الـ API لكل نشاط مُجمّع (activity group).
// هذا هو الشكل الذي يجب أن يُرجعه route.ts داخل مصفوفة recentActivities
// حتى يعمل هذا الربط فعلياً — راجع التعليق أسفل الملف لتفاصيل كل حقل.
// DCR: مؤشر واحد فقط (dust) — لا heat ولا crane إطلاقاً.
// ---------------------------------------------------------------------
interface RecentActivityItem {
  activityGroupId: string;
  activityTitle: string;
  kinds: Array<'dust'>; // المؤشرات المرتبطة بهذا النشاط، تُستخدم في الفلترة
  summaries: IndicatorSummary[];
  decisionTargets: UnifiedDecisionTarget[];
  mandatoryStop: boolean;
  isFutureActivity: boolean;
  windowStartIso?: string;
  windowEndIso?: string;
  durationMinutes?: number;
}

// عنصر مصفوفة dustResults المُعادة من GET — يطابق dustResultsGrouped في
// app/api/projects/[projectId]/route.ts، بشكل مبسَّط هنا (props فعلية
// تحتاجها DustWidgetCard/ComplianceWidgetCard فقط) بدل استيراد الأنواع
// الكاملة من dustEvaluation.ts (ملف خادم فقط) داخل حزمة العميل.
interface DustResultDisplayItem {
  activityId: string;
  activityGroupId: string;
  activityType: string;
  windowEval: React.ComponentProps<typeof DustWidgetCard>['windowEval'];
  aei: React.ComponentProps<typeof DustWidgetCard>['aei'];
  hourlyForecasts?: React.ComponentProps<typeof DustWidgetCard>['hourlyForecasts'];
  complianceList?: React.ComponentProps<typeof ComplianceWidgetCard>['complianceList'];
  complianceHourly?: React.ComponentProps<typeof ComplianceWidgetCard>['complianceHourly'];
  unitReceptors?: React.ComponentProps<typeof ComplianceWidgetCard>['unitReceptors'];
}

// المسار الأساسي والموثوق للتحديث اللايف: polling كل 3 ثوانٍ — بعد فصل
// evaluate الثقيل عن هذا الـpolling (راجع skipEvaluate في fetchDashboardData)
// أصبح كل تكرار GET خفيفاً (قراءة قرار محفوظ فقط، بلا إعادة حساب)، لكن
// فاصل نصف ثانية تبيّن أنه عدواني جداً بالتطوير المحلي (Next dev غير
// محسَّن للأداء) ويضغط السيرفر بما يكفي لتعليق طلبات أخرى (مثل مودال سجل
// القراءات). 3 ثوانٍ توازن جيد بين سرعة محسوسة وحمل معقول. اشتراك Supabase
// Realtime أدناه (final_decisions) تحسين إضافي فقط — إن نجح يُحدّث فوراً
// بلا انتظار الفاصل، وإن فشل فهذا الـpolling يبقى المسار المضمون.
const DASHBOARD_POLL_INTERVAL_MS = 3 * 1000;

export default function ProjectDetailsPage({
  params,
}: {
  params: Promise<{ id: string }>; // يطابق اسم مجلد الصفحة الفعلي [id]
}) {
  const { id } = use(params);

  const searchParams = useSearchParams();
  // الفلترة حسب حالة النشاط (all / started / scheduled / ended) — يطابق
  // روابط DashboardFilters التي تكتب ?status=... ، وليس حسب نوع المؤشر
  const activeStatus = searchParams.get('status') || 'all';

  const [data, setData] = useState<{ project: ProjectRow & { id: string; name: string; city?: string | null }; nearbySensitiveReceptors?: React.ComponentProps<typeof ComplianceWidgetCard>['nearbySensitiveReceptors'] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // "الآن" لتصنيف حالة كل نشاط (لم تبدأ/جارية/منتهية) أدناه — يكفي تحديث كل
  // 30 ثانية، أسرع بكثير أصلاً بفضل تحديث recentActivities الدوري (polling).
  const nowTs = useNow(30000);
  // "الآن" بدقة أعلى (كل ثانية) لمؤشر LiveDataIndicator وحده — عرض "منذ N
  // ثانية" الحي يحتاج تحديثاً أسرع من 30 ثانية، بمعزل عن nowTs أعلاه (لا
  // تغيير على منطق تصنيف حالة النشاط الحالي).
  const liveIndicatorNowTs = useNow(1000);

  // Live Data Layer (2026-08-08) — خلف Feature Flag فقط، بلا أي أثر على
  // fetchDashboardData/polling/Realtime أدناه إن كانت الراية مطفأة (القيمة
  // الافتراضية). projectId يُمرَّر null صراحة عند إطفاء الراية بدل تخطي
  // استدعاء الـhook — قواعد React تمنع استدعاء hooks بشكل شرطي.
  const liveDataV2Enabled = isLiveDataV2Enabled();
  const { snapshots: liveSnapshots, connectionStatus: liveConnectionStatus } = useLiveDeviceData(
    liveDataV2Enabled ? id : null
  );

  // نسخة محلية قابلة للتعديل من الأنشطة، حتى نقدر نحذف عنصر من الواجهة
  // فور نجاح الحذف داخل MultiIndicatorActivityBox دون الحاجة لإعادة جلب الصفحة كاملة
  const [recentActivities, setRecentActivities] = useState<RecentActivityItem[]>([]);
  // نتائج محرك الغبار الحي لكل نشاط، القادمة من الـ API، تُغذّي بطاقات
  // التفاصيل الدقيقة داخل كل نشاط موحّد
  const [dustResults, setDustResults] = useState<DustResultDisplayItem[]>([]);

  // silent=true للتحديث الدوري التلقائي: لا نُظهر شاشة تحميل كاملة أو نمسح
  // البيانات المعروضة حالياً أثناء إعادة الجلب الخلفية — فقط الجلب الأول
  // عند فتح الصفحة يُظهر شاشة "جاري التحميل".
  //
  // waitForEvaluate=true: يجعل POST /evaluate يُنتظَر (await) قبل GET، بدل
  // fire-and-forget بالتوازي معه. مطلوب تحديداً عند استدعاء عدّاد PM10 عند
  // انتهاء مهلته (onCountdownElapsed) — لو نفّذنا GET فوراً بالتوازي مع
  // POST، قد يصل GET ويقرأ القرار القديم من القاعدة قبل أن يُنهي POST إعادة
  // الحساب/الكتابة فعلياً (لا ترتيب مضمون بين طلبين متوازيين)، فتظهر
  // الواجهة "لم تتحدث" رغم انتهاء الوقت فعلاً، وتنتظر لحد اشتراك Realtime/
  // دورة polling الاحتياطية التالية (راجع DASHBOARD_POLL_INTERVAL_MS أعلاه)
  // حتى تلتقط القرار الجديد بالصدفة. انتظار POST أولاً هنا يضمن أن GET
  // التالي يقرأ القرار المُعاد حسابه فعلياً، لا نسخة سابقة له.
  // skipEvaluate=true: لا يستدعي POST /evaluate إطلاقاً — قراءة بحتة لآخر
  // قرار محفوظ فقط. يُستخدم بالـpolling السريع المتكرر (DASHBOARD_POLL_
  // INTERVAL_MS) لأن evaluate استدعاء ثقيل فعلياً (يعيد حساب DVI+Compliance+
  // FinalDecision ويكتب 5 جداول عبر RPC لكل نشاط) — تكراره كل ثانيتين كان
  // يضغط السيرفر بلا داعٍ، بما أن الـcron الخارجي (كل دقيقة) هو من يكتب
  // القرارات الجديدة أصلاً؛ الـpolling السريع هنا مسؤوليته الوحيدة عرض
  // آخر ما كُتب، لا إعادة حسابه.
  const fetchDashboardData = async (silent = false, waitForEvaluate = false, skipEvaluate = false) => {
    // await فوري (microtask) قبل أول setState — يفصل الاستدعاء المباشر من
    // جسم الـEffect عن أول تعديل حالة متزامن، بلا تأخير محسوس.
    await Promise.resolve();
    try {
      if (!silent) setLoading(true);

      // يكتب التقييمات الجديدة لقاعدة البيانات (dust_evaluations/
      // current_dust_compliance_decisions إلخ) — GET نفسه أصبح قراءة بحتة
      // بلا أثر جانبي (راجع app/api/projects/[projectId]/evaluate/route.ts).
      // هذا الاستدعاء أيضاً من يُسجّل قراءة PM10 جديدة في
      // pm10_readings_history (قراءات onsite/open-meteo) — تكراره هو ما
      // يُحدّث "استمرار" القراءة تلقائياً بلا أي إعادة ضبط للمؤقتات (سجل
      // إضافة فقط، لا حذف/تعديل، فكل استدعاء يُمدّد السلسلة الحالية بدل
      // تصفيرها).
      const evaluatePromise = skipEvaluate ? null : apiClient.post(`/projects/${id}/evaluate`).catch(() => {});
      if (waitForEvaluate && evaluatePromise) await evaluatePromise;

      // apiClient (axios) يرفق تلقائياً Authorization: Bearer <session token>
      // — المسار أصبح يتطلب مصادقة وتحقق ملكية فعلياً (راجع GET في
      // app/api/projects/[projectId]/route.ts)، بعكس fetch() الخام السابق.
      const { data: result } = await apiClient.get(`/projects/${id}`);
      setData(result);
      setRecentActivities(result.recentActivities || []);
      setDustResults(result.dustResults || []);

      // غير waitForEvaluate: fire-and-forget عمداً كما كان — فشل الكتابة لا
      // يجوز أن يمنع عرض البيانات المقروءة أصلاً بنجاح.
      if (!waitForEvaluate) evaluatePromise?.catch(() => {});
    } catch (err: unknown) {
      if (silent) return; // فشل التحديث الخلفي الصامت لا يُظهر شاشة خطأ فوق بيانات معروضة بنجاح
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      if (e?.response?.status === 404) { notFound(); return; }
      setError(e?.response?.data?.error || 'حدث خطأ أثناء جلب بيانات المشروع');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    // خطأ أداء مكتشَف: الدخول الأول لهذه الصفحة كان يُطلق POST /evaluate
    // (ثقيل جداً — يعيد حساب DVI+Compliance+FinalDecision ويكتب 5 جداول
    // عبر RPC لكل نشاط) بالتوازي مع GET (ثقيل بذاته أيضاً، ويبني نفس
    // dustResults/compliance من الصفر لعرض البطاقات). كلا الطلبين يحسبان
    // نفس الشيء تقريباً بشكل مستقل ومتزامن، فيُضاعف زمن التحميل الأول بلا
    // فائدة فعلية: GET يقرأ current_dust_decisions/current_dust_compliance_
    // decisions/final_decisions الفعلية من القاعدة وقت الطلب على أي حال،
    // وscheduler-tick الجديد (كل دقيقتين، راجع app/api/cron/scheduler-tick/
    // route.ts) يكتب قرارات جديدة في الخلفية باستمرار بصرف النظر عن هذه
    // الصفحة. skipEvaluate=true هنا يكتفي بـGET وحده للتحميل الأول (أسرع
    // بمقدار الحساب المكرر) — evaluate يبقى يعمل عند الطلب اليدوي الفعلي
    // (handleEdited بعد تعديل نشاط، handleCountdownElapsed بعد انتهاء
    // مهلة عدّاد PM10) حيث تغيّر حقيقي في المدخلات يستدعي إعادة حساب فورية.
    //
    // جدولة عبر microtask بدل استدعاء fetchDashboardData مباشرة من جسم
    // الـEffect — نفس السبب الموثَّق أعلى الدالة (تعديل حالة متزامن داخل Effect).
    void Promise.resolve().then(() => { if (!cancelled) fetchDashboardData(false, false, true); });

    const intervalId = window.setInterval(() => {
      if (!cancelled) fetchDashboardData(true, false, true);
    }, DASHBOARD_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
    // fetchDashboardData عمداً خارج القائمة — دالة عادية مُعاد إنشاؤها كل
    // render، تعتمد فقط على id ضمن نطاقها؛ إدراجها كان سيعيد تركيب
    // setInterval بلا داعٍ في كل تحديث حالة.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // تحديث لايف فوري: اشتراك Supabase Realtime على final_decisions (نفس
  // نمط اشتراك alerts في Sidebar.tsx) — يستدعي fetchDashboardData(true)
  // لحظة كتابة أي قرار نهائي جديد لهذا المشروع تحديداً (INSERT فقط، الجدول
  // append-only أصلاً فلا UPDATE/DELETE ممكنة)، بدل انتظار دورة الـpolling
  // البطيئة أعلاه. يتطلب policy SELECT صريحة على final_decisions لصالح
  // authenticated (راجع supabase/migrations/202608020002_final_decisions_
  // realtime_policy.sql) — بدونها الاشتراك يبقى صامتاً بلا أي حدث يصل
  // إطلاقاً (RLS تُطبَّق على Realtime تماماً كأي SELECT عادي).
  //
  // setAuth(access_token) قبل الاشتراك ضروري وليس اختيارياً: اتصال
  // WebSocket الخاص بـRealtime منفصل تماماً عن apiClient (axios) الذي يرفق
  // Authorization Bearer لطلبات REST فقط — بدون setAuth هنا، القناة تُفتح
  // بلا هوية مصادَق عليها إطلاقاً، فسياسة "to authenticated" لا تنطبق عليها
  // أبداً، ويفشل الاشتراك صامتاً بلا أي خطأ ظاهر (لا حدث INSERT يصل مطلقاً
  // مهما كُتب بالجدول). هذا بالضبط كان يمنع تحديث هذه البطاقة تلقائياً.
  //
  // onAuthStateChange('TOKEN_REFRESHED'/'SIGNED_IN') ضروري أيضاً: توكن
  // supabase.auth.getSession() المستخدَم عند فتح القناة يصلح لساعة واحدة
  // فقط (مدة صلاحية JWT الافتراضية) — بعدها supabase-js يجدّد الجلسة
  // تلقائياً بالخلفية لطلبات apiClient (axios) العادية، لكن القناة المفتوحة
  // مسبقاً بـrealtime.setAuth(token) القديم لا تتجدد تلقائياً معها؛ تبقى
  // مصادَقة بتوكن منتهي الصلاحية، فتُرفض الأحداث الجديدة صامتاً رغم بقاء
  // حالة القناة نفسها SUBSCRIBED ظاهرياً. الاستماع هنا يُعيد setAuth بكل
  // تجديد فعلي للجلسة، بدل الاعتماد على قراءة واحدة عند التحميل.
  useEffect(() => {
    if (!id) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    const openChannel = () => {
      if (channel) return;
      channel = supabase
        .channel(`final-decisions-${id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'final_decisions', filter: `project_id=eq.${id}` },
          () => fetchDashboardData(true)
        )
        .subscribe();
    };

    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;
      await supabase.realtime.setAuth(token);
      if (cancelled) return;
      openChannel();
    })();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!session?.access_token) return;
      await supabase.realtime.setAuth(session.access_token);
    });

    return () => {
      cancelled = true;
      authListener.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
    // fetchDashboardData عمداً خارج القائمة — نفس السبب أعلاه (إعادة إنشاء
    // القناة/الاشتراك بلا داعٍ في كل render لو أُدرجت).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // يُستدعى من ComplianceWidgetCard بالضبط في لحظة انتهاء عدّاد PM10 (تأكيد
  // مخالفة أو تعليق 30 دقيقة) لأي نشاط ظاهر — يطلب إعادة تقييم فورية بدل
  // انتظار دورة polling الاحتياطية التالية (راجع DASHBOARD_POLL_INTERVAL_MS
  // أعلاه، قد تصل عدة دقائق تأخير لو صادف انتهاء العدّاد مباشرة بعد آخر
  // تحديث). قد تنتهي عدة عدّادات في نفس
  // اللحظة تقريباً (عدة أنشطة/بطاقات) — debounce بسيط (500ms عبر useRef، لا
  // إعادة render) يدمجها في طلب واحد بدل عدة طلبات متزامنة لنفس البيانات.
  const debounceTimeoutRef = useRef<number | null>(null);
  const handleCountdownElapsed = () => {
    if (debounceTimeoutRef.current !== null) window.clearTimeout(debounceTimeoutRef.current);
    debounceTimeoutRef.current = window.setTimeout(() => {
      debounceTimeoutRef.current = null;
      // waitForEvaluate=true: ينتظر إعادة الحساب/الكتابة في الخادم قبل
      // القراءة، حتى يعكس القرار الجديد فوراً بدل قراءة القرار القديم
      // بالصدفة والانتظار لدورة polling التالية. راجع تعليق fetchDashboardData.
      fetchDashboardData(true, true);
    }, 500);
  };

  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current !== null) window.clearTimeout(debounceTimeoutRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center font-sans" dir="rtl">
        <div className="text-[#061B40] font-bold animate-pulse text-lg">جاري تحميل بيانات لوحة التحكم...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex flex-col items-center justify-center font-sans text-red-600" dir="rtl">
        <h2 className="text-2xl font-black mb-2">عذراً، حدث خطأ!</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!data || !data.project) return notFound();

  const { project } = data;

  // حالة النشاط من نافذته الزمنية: لم تبدأ / جارية / منتهية.
  // نشاط بلا جدول زمني معروف يُعامل كـ "جارٍ" حتى لا يختفي من كل الفلاتر.
  const activityStatusOf = (a: RecentActivityItem): 'started' | 'scheduled' | 'ended' => {
    const start = a.windowStartIso ? new Date(a.windowStartIso).getTime() : null;
    const end = a.windowEndIso ? new Date(a.windowEndIso).getTime() : null;
    if (start !== null && nowTs < start) return 'scheduled';
    if (end !== null && nowTs > end) return 'ended';
    return 'started';
  };

  // فلترة الأنشطة حسب الحالة النشطة (all / started / scheduled / ended)
  const filteredActivities =
    activeStatus === 'all'
      ? recentActivities
      : recentActivities.filter((a) => activityStatusOf(a) === activeStatus);

  const handleDeleted = (activityGroupId: string) => {
    setRecentActivities((prev) => prev.filter((a) => a.activityGroupId !== activityGroupId));
  };

  // تعديل زمن النشاط يحدث داخل MultiIndicatorActivityBox نفسها (نموذج
  // تاريخ/وقت مضمّن)، فيلزم فقط إعادة جلب بيانات الصفحة كاملة بعد نجاحه
  // — الزمن الجديد يغيّر windowStartIso/windowEndIso/dustResults المشتقة
  // من الخادم، بخلاف الحذف الذي يكفيه إزالة العنصر محلياً.
  const handleEdited = () => {
    fetchDashboardData();
  };

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-8">
        <ProjectHeader project={project} onActivityCreated={handleEdited} />

        {liveDataV2Enabled && (
          <LiveDataIndicator
            connectionStatus={liveConnectionStatus}
            snapshots={liveSnapshots}
            nowTs={liveIndicatorNowTs}
          />
        )}

        <DashboardFilters activeStatus={activeStatus} />

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-black text-[#061B40]">الأنشطة المضافة حديثًا</h2>
            <span className="bg-[#061B40] text-white text-xs font-bold px-3 py-1 rounded-full">
              {filteredActivities.length}
            </span>
          </div>

          {filteredActivities.length > 0 ? (
            <div>
              {filteredActivities.map((activity) => (
                <MultiIndicatorActivityBox
                  key={activity.activityGroupId}
                  activityTitle={activity.activityTitle}
                  summaries={activity.summaries}
                  decisionTargets={activity.decisionTargets}
                  mandatoryStop={activity.mandatoryStop}
                  isFutureActivity={activity.isFutureActivity}
                  windowStartIso={activity.windowStartIso}
                  windowEndIso={activity.windowEndIso}
                  durationMinutes={activity.durationMinutes}
                  workHoursStart={project.work_hours_start as string | null | undefined}
                  workHoursEnd={project.work_hours_end as string | null | undefined}
                  onEdited={handleEdited}
                  onDeleted={() => handleDeleted(activity.activityGroupId)}
                >
                  {/* بطاقات التفاصيل الدقيقة لهذا النشاط — مغذّاة بنتائج محرك
                      الغبار الحي القادمة من الـ API، مربوطة بهذا النشاط عبر
                      activityGroupId. القرار الموحّد يُدار من البطاقة الأم،
                      لذلك نُخفي لوحة القرار وشريط التوقيت داخل كل بطاقة فرعية. */}
                  {(() => {
                    const dust = dustResults.filter(
                      (r) => r.activityGroupId === activity.activityGroupId
                    );

                    if (dust.length === 0) {
                      return (
                        <div className="text-[12px] text-slate-400 font-bold">
                          لا توجد تفاصيل مؤشرات محسوبة لهذا النشاط.
                        </div>
                      );
                    }

                    return (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                        {/* بطاقة مؤشر الرؤية والغبار (DVI) الفيزيائي — مخفاة
                            مؤقتاً بطلب صريح من المستخدم؛ قرار الامتثال
                            التنظيمي في ComplianceWidgetCard أدناه يبقى القرار
                            الملزم المعروض. الكود محفوظ كاملاً (غير محذوف)
                            لتفادي فقدان أي منطق عند إعادة تفعيلها لاحقاً. */}
                        {false && dust.map((r) => (
                          <DustWidgetCard
                            key={`dust-${r.activityId}`}
                            activityType={r.activityType}
                            windowEval={r.windowEval}
                            aei={r.aei}
                            complianceList={r.complianceList}
                            hourlyForecasts={r.hourlyForecasts}
                            projectId={id}
                            activityId={r.activityId}
                            projectName={project.name}
                            hideDecisionPanel
                            hideSchedule
                          />
                        ))}
                        {/* بطاقة الامتثال التنظيمي (الرياض) — المؤشر الرئيسي
                            المعروض حالياً لأنشطة الغبار: قرار الامتثال +
                            قابلية التنفيذ (AEI) + توقعات ساعات الدوام القادمة. */}
                        {dust
                          .filter((r) => (r.complianceList ?? []).length > 0)
                          .map((r) => (
                            <ComplianceWidgetCard
                              key={`dust-compliance-${r.activityId}`}
                              activityType={r.activityType}
                              complianceList={r.complianceList ?? []}
                              complianceHourly={r.complianceHourly}
                              aei={r.aei}
                              nearbySensitiveReceptors={data.nearbySensitiveReceptors}
                              unitReceptors={r.unitReceptors}
                              windowStartIso={r.windowEval?.windowStartIso}
                              windowEndIso={r.windowEval?.windowEndIso}
                              durationHours={r.windowEval?.durationHours}
                              projectId={id}
                              activityId={r.activityId}
                              activityGroupId={r.activityGroupId}
                              projectName={project.name}
                              hideSchedule
                              onCountdownElapsed={handleCountdownElapsed}
                            />
                          ))}
                      </div>
                    );
                  })()}
                </MultiIndicatorActivityBox>
              ))}
            </div>
          ) : (
            <div className="bg-white border-2 border-dashed border-slate-200 rounded-2xl p-10 flex flex-col items-center justify-center text-center shadow-sm">
              <Inbox className="w-14 h-14 text-[#3995FF]/40 mb-4" />
              <h3 className="text-lg font-black text-[#061B40]">لا توجد أنشطة لعرضها</h3>
              <p className="text-sm text-slate-500 mt-2 max-w-sm">
                لم يتم إضافة أي أنشطة لهذا المشروع بعد. استخدم زر &quot;إضافة أنشطة&quot; باللون الأزرق في الأعلى للبدء.
              </p>
            </div>
          )}
        </div>

        <hr className="border-slate-200 my-8" />
      </div>
    </div>
  );
}
