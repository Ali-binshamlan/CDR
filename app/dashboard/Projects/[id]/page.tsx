'use client';

import { use, useEffect, useState } from 'react';
import { notFound } from 'next/navigation';
import { useSearchParams } from 'next/navigation';
import { Inbox } from 'lucide-react';

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

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/projects/${id}`);

        if (!response.ok) {
          if (response.status === 404) notFound();
          throw new Error('حدث خطأ أثناء جلب بيانات المشروع');
        }

        const result = await response.json();
        setData(result);
        setRecentActivities(result.recentActivities || []);
        setDustResults(result.dustResults || []);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchDashboardData();
    }
  }, [id]);

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

  const handleEdit = (activity: RecentActivityItem) => {
    // TODO: فتح نموذج/مودال التعديل الفعلي لهذا النشاط.
    // MultiIndicatorActivityBox لا يملك منطق التعديل، فقط يستدعي onEdit
    // ليقرر الأب (هذه الصفحة) كيف يفتح النموذج المناسب حسب نوع النشاط.
    console.log('تعديل النشاط:', activity.activityGroupId);
  };

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-8">
        <ProjectHeader project={project} />

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
                  onEdit={() => handleEdit(activity)}
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
                              projectName={project.name}
                              hideDecisionPanel
                              hideSchedule
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
