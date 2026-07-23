'use client';

import { Calendar, Clock, MapPin, Sparkles } from 'lucide-react';
import { getInputClass, labelClass, LOCATION_OPTIONS } from './constants';

interface TimeLocationStepProps {
  form: any;
  updateField: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
}

export function TimeLocationStep({ form, updateField, onNext, onBack }: TimeLocationStepProps) {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
      {/* قسم الوقت */}
      <div className="space-y-4">
        <h3 className="font-bold text-[#061B40] border-b border-[#061B40]/10 pb-2">متى سيتم تنفيذ النشاط؟</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>تاريخ النشاط</label>
            <div className="relative">
              <Calendar className="absolute right-3 top-2.5 w-4 h-4 text-[#061B40]/40" />
              <input
                type="date"
                className={`${getInputClass()} pr-9`}
                value={form.plannedDate}
                onChange={e => updateField('plannedDate', e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>وقت البداية</label>
            <div className="relative">
              <Clock className="absolute right-3 top-2.5 w-4 h-4 text-[#061B40]/40" />
              <input
                type="time"
                className={`${getInputClass()} pr-9`}
                value={form.startTime}
                onChange={e => updateField('startTime', e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>وقت النهاية المتوقع</label>
            <div className="relative">
              <Clock className="absolute right-3 top-2.5 w-4 h-4 text-[#061B40]/40" />
              <input
                type="time"
                className={`${getInputClass()} pr-9`}
                value={form.endTime}
                onChange={e => updateField('endTime', e.target.value)}
              />
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 mt-2 cursor-pointer bg-[#3995FF]/5 p-3 rounded-xl border border-[#3995FF]/20">
          <input
            type="checkbox"
            className="w-4 h-4 rounded text-[#3995FF] focus:ring-[#3995FF]"
            checked={form.suggestBetterTime}
            onChange={e => updateField('suggestBetterTime', e.target.checked)}
          />
          <Sparkles className="w-4 h-4 text-[#3995FF]" />
          <span className="text-sm font-semibold text-[#061B40]">أريد من النظام اقتراح وقت أفضل (تلقائياً)</span>
        </label>
      </div>

      {/* قسم المكان */}
      <div className="space-y-4 pt-4">
        <h3 className="font-bold text-[#061B40] border-b border-[#061B40]/10 pb-2">أين سيكون مكان النشاط داخل المشروع؟</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {LOCATION_OPTIONS.map(loc => (
            <button
              key={loc}
              onClick={() => updateField('locationType', loc)}
              className={`p-3 rounded-lg text-xs font-bold transition-all border ${
                form.locationType === loc
                  ? 'bg-[#3995FF] text-white border-[#3995FF]'
                  : 'bg-[#F4F7FB] text-[#061B40] border-[#061B40]/10 hover:border-[#3995FF]/50'
              }`}
            >
              <MapPin className={`w-4 h-4 mx-auto mb-1 ${form.locationType === loc ? 'text-white' : 'text-[#3995FF]'}`} />
              {loc}
            </button>
          ))}
        </div>
      </div>

      <div className="flex justify-between pt-6 mt-6 border-t border-[#061B40]/10">
        <button onClick={onBack} className="px-5 py-2 rounded-lg text-sm font-bold text-[#061B40]/60 hover:bg-[#F4F7FB]">رجوع</button>
        <button onClick={onNext} className="bg-[#3995FF] text-white px-6 py-2 rounded-lg text-sm font-bold hover:bg-[#3995FF]/90 transition-colors">التالي</button>
      </div>
    </div>
  );
}