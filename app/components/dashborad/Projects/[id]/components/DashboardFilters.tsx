import Link from 'next/link';
import { Layers, PlayCircle, Clock, CheckCircle } from 'lucide-react';

interface DashboardFiltersProps {
  activeStatus: string;
}

export default function DashboardFilters({ activeStatus }: DashboardFiltersProps) {
  return (
    <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <Layers className="w-5 h-5 text-[#061B40]" />
        <span className="font-black text-base text-[#061B40]">تصفية الأنشطة حسب الحالة:</span>
      </div>
      <div className="flex flex-wrap gap-2 w-full sm:w-auto">
        <Link
          href="?status=all"
          className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 ${
            activeStatus === 'all'
              ? 'bg-[#061B40] text-white shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          الكل
        </Link>
        <Link
          href="?status=started"
          className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 ${
            activeStatus === 'started'
              ? 'bg-green-600 text-white shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          <PlayCircle className="w-3.5 h-3.5" /> جارية
        </Link>
        <Link
          href="?status=scheduled"
          className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 ${
            activeStatus === 'scheduled'
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          <Clock className="w-3.5 h-3.5" /> لم تبدأ
        </Link>
        <Link
          href="?status=ended"
          className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-1.5 ${
            activeStatus === 'ended'
              ? 'bg-slate-600 text-white shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          <CheckCircle className="w-3.5 h-3.5" /> منتهية
        </Link>
      </div>
    </div>
  );
}