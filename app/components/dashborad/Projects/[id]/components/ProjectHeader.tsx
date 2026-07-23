import Link from 'next/link';
import { MapPin, Settings, ArrowRight } from 'lucide-react';
// تأكدي من صحة مسار مكون AddActivityModal حسب هيكلة مشروعك
import AddActivityModal from '@/app/components/AddActivityModal';

interface ProjectHeaderProps {
  project: any;
}

export default function ProjectHeader({ project }: ProjectHeaderProps) {
  // إعداد الإحداثيات الافتراضية في حال لم تكن متوفرة
  const lat = typeof project.latitude === 'number' ? project.latitude : 24.7136;
  const lon = typeof project.longitude === 'number' ? project.longitude : 46.6753;

  return (
    <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
      <div>
        <h1 className="text-3xl font-black text-[#061B40] mb-2">{project.name}</h1>
        <div className="flex items-center gap-2 text-sm font-bold text-slate-500">
          <MapPin className="w-4 h-4 text-slate-400" /> {project.city}
        </div>
      </div>
      <div className="flex items-center gap-3 w-full lg:w-auto mt-4 lg:mt-0">
        
        {/* زر إعدادات المشروع */}
        <Link
          href={`/dashboard/Projects/${project.id}/settings`}
          className="bg-white border border-slate-200 hover:bg-[#F4F7FB] text-[#061B40] px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all"
        >
          <Settings className="w-4 h-4 text-[#3995FF]" /> إعدادات المشروع
        </Link>

        {/* نافذة إضافة نشاط */}
        <AddActivityModal
          project={{
            id: project.id,
            latitude: lat,
            longitude: lon,
            terrain_type: project.terrain_type || 'suburban',
            dust_causing_activities: project.dust_causing_activities,
            exposed_dust_area_size: project.exposed_dust_area_size,
            unpaved_roads_length: project.unpaved_roads_length,
            heavy_machinery_count: project.heavy_machinery_count,
            trucks_per_day: project.trucks_per_day,
            is_near_public_road: project.is_near_public_road,
            is_near_sensitive_areas: project.is_near_sensitive_areas,
            dust_mitigation_measures: project.dust_mitigation_measures,
            has_concrete_curing_plan: project.has_concrete_curing_plan,
            can_advance_pouring_time: project.can_advance_pouring_time,
            work_hours_start: project.work_hours_start,
            work_hours_end: project.work_hours_end,
            shifts: project.shifts,
            work_days_list: project.work_days_list,
            // منطقة المشروع الكاملة (zone) — تُستخدم لقصّ موقع الرافعة داخلها
            zone_type: project.zone_type,
            zone_polygon: project.zone_polygon,
            zone_radius_m: project.zone_radius_m,
          }}
        />
        
        {/* زر العودة للمشاريع */}
        <Link
          href="/dashboard/Projects"
          className="bg-white border border-slate-200 hover:bg-[#F4F7FB] text-[#061B40] px-5 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 shadow-sm transition-all"
        >
          <ArrowRight className="w-4 h-4 text-[#3995FF]" /> العودة للمشاريع
        </Link>
      </div>
    </div>
  );
}