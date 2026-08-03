'use client';

import { use, useEffect, useRef, useState } from 'react';
import { notFound } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { Inbox } from 'lucide-react';
import { apiClient } from '@/app/lib/apiClient';
import { supabase } from '@/app/lib/supabase';

import ProjectHeader from '@/app/components/dashborad/Projects/[id]/components/ProjectHeader';
import DashboardFilters from '@/app/components/dashborad/Projects/[id]/components/DashboardFilters';
import MultiIndicatorActivityBox, {
  IndicatorSummary,
  UnifiedDecisionTarget,
} from '@/app/components/dashborad/projectdashborad/MultiIndicatorActivityBox';
import DustWidgetCard from '@/app/components/dashborad/projectdashborad/Dustwidgetcard';
import ComplianceWidgetCard from '@/app/components/dashborad/projectdashborad/Compliancewidgetcard';

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

  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // نسخة محلية قابلة للتعديل من الأنشطة، حتى نقدر نحذف عنصر من الواجهة
  // فور نجاح الحذف داخل MultiIndicatorActivityBox دون الحاجة لإعادة جلب الصفحة كاملة
  const [recentActivities, setRecentActivities] = useState<RecentActivityItem[]>([]);
  // نتائج محرك الغبار الحي لكل نشاط، القادمة من الـ API، تُغذّي بطاقات
  // التفاصيل الدقيقة داخل كل نشاط موحّد
  const [dustResults, setDustResults] = useState<any[]>([]);

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
    } catch (err: any) {
      if (silent) return; // فشل التحديث الخلفي الصامت لا يُظهر شاشة خطأ فوق بيانات معروضة بنجاح
      if (err?.response?.status === 404) { notFound(); return; }
      setError(err?.response?.data?.error || 'حدث خطأ أثناء جلب بيانات المشروع');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    fetchDashboardData();

    const intervalId = window.setInterval(() => {
      if (!cancelled) fetchDashboardData(true, false, true);
    }, DASHBOARD_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
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
    const now = Date.now();
    const start = a.windowStartIso ? new Date(a.windowStartIso).getTime() : null;
    const end = a.windowEndIso ? new Date(a.windowEndIso).getTime() : null;
    if (start !== null && now < start) return 'scheduled';
    if (end !== null && now > end) return 'ended';
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
                              complianceList={r.complianceList}
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
                لم يتم إضافة أي أنشطة لهذا المشروع بعد. استخدم زر "إضافة أنشطة" باللون الأزرق في الأعلى للبدء.
              </p>
            </div>
          )}
        </div>

        <hr className="border-slate-200 my-8" />
      </div>
    </div>
  );
}
