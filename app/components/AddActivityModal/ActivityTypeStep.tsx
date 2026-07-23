'use client';

import { useState } from 'react';
import { Plus, Trash2, ListChecks, ArrowLeft } from 'lucide-react';
import { REGULATORY_ACTIVITY_OPTIONS, type RegulatoryActivityKey, labelClass, getInputClass } from './constants';

interface ActivityTypeStepProps {
  // تُستدعى بعد اختيار قائمة الأنشطة التنظيمية والضغط على "متابعة" —
  // العنصر الأول هو النشاط "الحالي" (المسودة) وبقية العناصر تدخل قائمة
  // الانتظار (regulatoryQueue). الترتيب محفوظ كما أضافه المستخدم.
  onContinue: (activityKeys: RegulatoryActivityKey[]) => void;
}

export function ActivityTypeStep({ onContinue }: ActivityTypeStepProps) {
  // القائمة التراكمية للأنشطة التنظيمية المختارة (بالترتيب) + النشاط
  // المُحدَّد حالياً في القائمة المنسدلة قبل الضغط على "إضافة".
  const [selected, setSelected] = useState<RegulatoryActivityKey[]>([]);
  const [current, setCurrent] = useState<RegulatoryActivityKey>(REGULATORY_ACTIVITY_OPTIONS[0].key);

  const labelOf = (key: RegulatoryActivityKey) =>
    REGULATORY_ACTIVITY_OPTIONS.find((o) => o.key === key)?.label ?? key;

  const addActivity = () => {
    // نسمح بتكرار نفس النوع (مثلاً كسارتان في موقعين مختلفين) — كل عنصر
    // في القائمة يصبح نشاطاً تنظيمياً مستقلاً بتفاصيله الخاصة لاحقاً.
    setSelected((prev) => [...prev, current]);
  };

  const removeActivity = (index: number) => {
    setSelected((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-bold text-[#061B40] mb-1">أنشطة الامتثال التنظيمي</h3>
        <p className="text-xs text-[#061B40]/60">
          اختر نشاط الامتثال التنظيمي (Riyadh Dust Compliance) وأضفه للقائمة. يمكنك إضافة أكثر من نشاط، وسيُقيَّم كل
          نشاط للغبار والإجهاد الحراري معاً.
        </p>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label className={labelClass}>نوع النشاط التنظيمي</label>
          <select
            value={current}
            onChange={(e) => setCurrent(e.target.value as RegulatoryActivityKey)}
            className={getInputClass(false)}
          >
            {REGULATORY_ACTIVITY_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={addActivity}
          className="flex items-center gap-1.5 bg-[#3995FF] hover:bg-[#3995FF]/90 text-white font-bold px-4 py-2.5 rounded-lg text-sm shrink-0 transition-colors"
        >
          <Plus className="w-4 h-4" /> إضافة
        </button>
      </div>

      {/* القائمة التراكمية للأنشطة المختارة */}
      <div className="space-y-2">
        <h4 className="text-sm font-bold text-[#061B40] flex items-center gap-1.5">
          <ListChecks className="w-4 h-4 text-[#3995FF]" /> الأنشطة المختارة ({selected.length})
        </h4>
        {selected.length === 0 ? (
          <p className="text-[11px] font-bold text-[#061B40]/40 bg-[#F4F7FB] border border-dashed border-[#061B40]/15 rounded-lg p-3">
            لم تُضف أي نشاط بعد. اختر نوع النشاط من القائمة أعلاه واضغط "إضافة".
          </p>
        ) : (
          <div className="space-y-1.5">
            {selected.map((key, i) => (
              <div
                key={`${key}-${i}`}
                className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2"
              >
                <span className="text-sm font-bold text-emerald-800">{i + 1}. {labelOf(key)}</span>
                <button
                  type="button"
                  onClick={() => removeActivity(i)}
                  className="text-red-500 hover:text-red-600"
                  title="حذف"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        disabled={selected.length === 0}
        onClick={() => onContinue(selected)}
        className="w-full flex items-center justify-center gap-2 bg-[#061B40] hover:bg-[#061B40]/90 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl text-sm transition-colors"
      >
        متابعة لإدخال التفاصيل <ArrowLeft className="w-4 h-4" />
      </button>
    </div>
  );
}
