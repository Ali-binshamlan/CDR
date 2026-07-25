"use client";

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { apiClient } from '@/app/lib/apiClient';
import { translateActivityType } from '@/app/lib/activityLabels';
import { CalendarDays, ChevronRight, ChevronLeft, MapPin, Clock, Loader2 } from 'lucide-react';

// أيام الأسبوع بترتيب السعودية (الأحد أولاً) — نفس الترتيب المستخدم فعلياً
// في AddActivityModal/index.tsx وDustStep.tsx (work_days_list: sun..sat).
const WEEKDAYS = [
  { key: 'sun', label: 'الأحد' },
  { key: 'mon', label: 'الاثنين' },
  { key: 'tue', label: 'الثلاثاء' },
  { key: 'wed', label: 'الأربعاء' },
  { key: 'thu', label: 'الخميس' },
  { key: 'fri', label: 'الجمعة' },
  { key: 'sat', label: 'السبت' },
];

function toDateStr(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

// بداية الأسبوع (الأحد) الذي يقع فيه التاريخ المُعطى
function startOfWeek(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - result.getDay());
  return result;
}

function addDays(d: Date, days: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDayLabel(d: Date): string {
  // calendar: 'gregory' صراحةً — ar-SA قد يعرض هجرياً افتراضياً في بعض
  // المتصفحات فيظهر يوم مختلف عن التاريخ الميلادي المخزَّن.
  return d.toLocaleDateString('ar-SA', { day: 'numeric', month: 'short', calendar: 'gregory' });
}

function formatRangeLabel(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric', calendar: 'gregory' };
  return `${start.toLocaleDateString('ar-SA', opts)} — ${end.toLocaleDateString('ar-SA', opts)}`;
}

// صفحة "جدول الأسبوع" — تقويم أسبوعي (7 أعمدة) لأنشطة الغبار المجدولة عبر
// كل مشاريع المستخدم، نظرة تخطيطية بحتة على المواعيد (بلا حساب DVI حي لكل
// نشاط بكل الأسبوع، تجنباً لعشرات نداءات الطقس المتزامنة).
export default function SchedulePage() {
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [isLoading, setIsLoading] = useState(true);
  const [projects, setProjects] = useState<any[]>([]);
  const [activities, setActivities] = useState<any[]>([]);

  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  useEffect(() => {
    const fetchSchedule = async () => {
      setIsLoading(true);
      try {
        const { data } = await apiClient.get('/dashboard/schedule', {
          params: { from: toDateStr(weekStart), to: toDateStr(weekEnd) },
        });
        setProjects(data?.projects || []);
        setActivities(data?.activities || []);
      } catch (error) {
        console.error('Error fetching schedule:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchSchedule();
  }, [weekStart, weekEnd]);

  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects]
  );

  const activitiesByDate = useMemo(() => {
    const map = new Map<string, any[]>();
    activities.forEach((a) => {
      const list = map.get(a.planned_date) || [];
      list.push(a);
      map.set(a.planned_date, list);
    });
    return map;
  }, [activities]);

  const days = useMemo(
    () => WEEKDAYS.map((wd, i) => ({ ...wd, date: addDays(weekStart, i) })),
    [weekStart]
  );

  const todayStr = toDateStr(new Date());

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-[1440px] mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-50 text-[#0176FB] rounded-xl flex items-center justify-center border border-blue-100 shadow-inner">
              <CalendarDays className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-[#061B40] mb-1">جدول الأسبوع</h1>
              <p className="text-sm font-bold text-slate-500">{formatRangeLabel(weekStart, weekEnd)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setWeekStart((prev) => addDays(prev, -7))}
              className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-colors"
            >
              <ChevronRight className="w-4 h-4" /> الأسبوع السابق
            </button>
            <button
              onClick={() => setWeekStart(startOfWeek(new Date()))}
              className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold shadow-sm transition-colors"
            >
              اليوم
            </button>
            <button
              onClick={() => setWeekStart((prev) => addDays(prev, 7))}
              className="bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-colors"
            >
              الأسبوع التالي <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-24 text-[#061B40]">
            <Loader2 className="w-10 h-10 animate-spin text-[#0176FB] mb-4" />
            <h2 className="font-bold text-lg">جاري تحميل الجدول...</h2>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
            {days.map((day) => {
              const dateStr = toDateStr(day.date);
              const dayActivities = (activitiesByDate.get(dateStr) || []);
              const isToday = dateStr === todayStr;

              return (
                <div
                  key={day.key}
                  className={`bg-white rounded-2xl border shadow-sm overflow-hidden flex flex-col min-h-[220px] ${
                    isToday ? 'border-blue-300 ring-2 ring-blue-500/10' : 'border-slate-200'
                  }`}
                >
                  <div className={`px-4 py-3 border-b border-slate-100 ${isToday ? 'bg-blue-50/60' : 'bg-slate-50/60'}`}>
                    <div className="text-sm font-black text-[#061B40]">{day.label}</div>
                    <div className="text-[11px] font-bold text-slate-400">{formatDayLabel(day.date)}</div>
                  </div>

                  <div className="flex-1 p-2 space-y-2">
                    {dayActivities.length === 0 ? (
                      <div className="text-center text-[11px] font-bold text-slate-300 py-8">لا توجد أنشطة مجدولة</div>
                    ) : (
                      dayActivities.map((a) => (
                        <Link
                          key={a.id}
                          href={`/dashboard/Projects/${a.project_id}`}
                          className="block bg-slate-50 hover:bg-blue-50 border border-slate-100 hover:border-blue-200 rounded-xl p-2.5 transition-colors"
                        >
                          <div className="font-bold text-[12px] text-[#061B40] truncate">{translateActivityType(a.activity_type)}</div>
                          <div className="flex items-center gap-1 text-[10px] text-slate-400 font-semibold mt-1 truncate">
                            <MapPin className="w-3 h-3 shrink-0" />
                            <span className="truncate">{projectNameById.get(a.project_id) || '—'}</span>
                          </div>
                          <div className="flex items-center gap-1 text-[10px] text-slate-400 font-semibold mt-0.5">
                            <Clock className="w-3 h-3 shrink-0" />
                            {String(a.planned_time || '').slice(0, 5) || '—'}
                            {a.duration_hours ? ` · ${a.duration_hours} س` : ''}
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
