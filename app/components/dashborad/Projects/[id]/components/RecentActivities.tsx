import { Layers } from 'lucide-react';

interface RecentActivityItem {
  id: string | number;
  source: 'dust';
  title: string;
  dateLabel: string;
  timeLabel: string;
  statusText: string;
  statusState: 'ended' | 'started' | 'scheduled' | 'postponed' | 'stopped';
  created_at: string | null;
  activityGroupId: string | null;
  indicatorCount?: number; // أضفنا هذا لتمرير عدد المؤشرات
}

interface RecentActivitiesProps {
  activities: RecentActivityItem[];
  activeStatus: string;
}

export default function RecentActivities({ activities, activeStatus }: RecentActivitiesProps) {
  
  // تطبيق الفلترة الجديدة بناءً على حالة النشاط
  const filteredActivities = activities.filter((act) => {
    if (activeStatus === 'all') return true;
    return act.statusState === activeStatus;
  });

  if (filteredActivities.length === 0) {
    return (
      <div className="bg-white border-2 border-dashed border-slate-200 rounded-2xl p-8 flex flex-col items-center justify-center text-center shadow-sm">
        <p className="text-sm text-slate-500">لا توجد أنشطة تتطابق مع حالة الفلتر المحددة.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {filteredActivities.map((activity) => {
        const isMulti = (activity.indicatorCount || 1) > 1;
        const sourceLabel = isMulti ? 'مؤشرات متعددة' : 'رؤية وغبار';

        const sourceBadge = isMulti
          ? 'bg-purple-50 text-purple-700 border-purple-200'
          : 'bg-orange-50 text-orange-700 border-orange-200';

        return (
          <div key={activity.id} className="bg-white rounded-xl border border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md transition-all p-5">
            <div className="flex items-start justify-between gap-4 mb-3">
              <h3 className="font-bold text-[#061B40] text-right text-base line-clamp-2 flex-1">
                {activity.title}
              </h3>
              <span className={`text-[11px] font-black px-2.5 py-1 rounded-md border shrink-0 whitespace-nowrap ${sourceBadge}`}>
                {sourceLabel}
              </span>
            </div>
            
            {/* عرض الحالة التاريخ والوقت مع تمييز الألوان */}
            <div className="flex items-center gap-4 text-xs font-medium text-slate-500">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
                {activity.dateLabel}
              </div>
              <div className={`flex items-center gap-1.5 ${
                activity.statusState === 'started' ? 'text-green-600 font-bold' :
                activity.statusState === 'postponed' ? 'text-indigo-600 font-bold' :
                activity.statusState === 'stopped' ? 'text-red-600 font-bold' :
                activity.statusState === 'ended' ? 'text-slate-400' : 'text-blue-600 font-bold'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  activity.statusState === 'started' ? 'bg-green-500 animate-pulse' :
                  activity.statusState === 'postponed' ? 'bg-indigo-500' :
                  activity.statusState === 'stopped' ? 'bg-red-500' :
                  activity.statusState === 'ended' ? 'bg-slate-300' : 'bg-blue-500'
                }`}></span>
                {activity.statusText}
              </div>
            </div>
            
            {/* شريط يظهر فقط إذا كان النشاط يحتوي على أكثر من مؤشر */}
            {isMulti && (
              <div className="mt-2.5 pt-2.5 border-t border-slate-100 flex items-center gap-1.5 text-[10px] font-bold text-slate-400">
                <Layers className="w-3 h-3" /> {activity.indicatorCount} مؤشرات تقييم لهذا النشاط
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}