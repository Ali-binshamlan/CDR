'use client';

import { Users, Truck, Wrench } from 'lucide-react';
import { getInputClass, labelClass } from './constants';

interface ResourcesStepProps {
  form: any;
  updateField: (field: string, value: any) => void;
  onNext: () => void;
  onBack: () => void;
}

export function ResourcesStep({ form, updateField, onNext, onBack }: ResourcesStepProps) {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
      <div className="space-y-4">
        <h3 className="font-bold text-[#061B40] border-b border-[#061B40]/10 pb-2">الموارد المخصصة للنشاط</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-[#F4F7FB] p-4 rounded-xl border border-[#061B40]/10">
            <label className="flex items-center gap-2 mb-3 text-sm font-bold text-[#061B40]">
              <Users className="w-5 h-5 text-[#3995FF]" />
              عدد العمال المتوقع
            </label>
            <input
              type="number"
              min="1"
              className={getInputClass()}
              value={form.workersCount}
              onChange={e => updateField('workersCount', Number(e.target.value))}
            />
          </div>

          <div className="bg-[#F4F7FB] p-4 rounded-xl border border-[#061B40]/10">
            <label className="flex items-center gap-2 mb-3 text-sm font-bold text-[#061B40]">
              <Wrench className="w-5 h-5 text-[#3995FF]" />
              المعدات والآليات
            </label>
            <div className="space-y-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="rounded text-[#3995FF] focus:ring-[#3995FF]"
                  checked={form.hasEquipment}
                  onChange={e => updateField('hasEquipment', e.target.checked)}
                />
                <span className="text-sm font-semibold">هل توجد معدات مستخدمة؟</span>
              </label>

              {form.hasEquipment && (
                <input
                  type="text"
                  placeholder="نوع المعدات (اختياري)"
                  className={getInputClass()}
                  value={form.equipmentType}
                  onChange={e => updateField('equipmentType', e.target.value)}
                />
              )}

              <label className="flex items-center gap-2 cursor-pointer mt-2 pt-2 border-t border-[#061B40]/10">
                <input
                  type="checkbox"
                  className="rounded text-[#3995FF] focus:ring-[#3995FF]"
                  checked={form.hasCrane}
                  onChange={e => updateField('hasCrane', e.target.checked)}
                />
                <span className="text-sm font-semibold flex items-center gap-1">
                  <Truck className="w-4 h-4" />
                  هل توجد رافعة (Crane)؟
                </span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="flex justify-between pt-6 mt-6 border-t border-[#061B40]/10">
        <button onClick={onBack} className="px-5 py-2 rounded-lg text-sm font-bold text-[#061B40]/60 hover:bg-[#F4F7FB]">رجوع</button>
        <button onClick={onNext} className="bg-[#3995FF] text-white px-6 py-2 rounded-lg text-sm font-bold hover:bg-[#3995FF]/90 transition-colors">التالي</button>
      </div>
    </div>
  );
}