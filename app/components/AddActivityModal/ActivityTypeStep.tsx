'use client';

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { REGULATORY_ACTIVITY_OPTIONS, type RegulatoryActivityKey, labelClass, getInputClass } from './constants';

interface ActivityTypeStepProps {
  // Called after selecting the regulatory activity type and clicking "Continue" —
  // a single item only (the system does not support adding more than one regulatory activity in the same session).
  onContinue: (activityKey: RegulatoryActivityKey) => void;
}

export function ActivityTypeStep({ onContinue }: ActivityTypeStepProps) {
  const [selected, setSelected] = useState<RegulatoryActivityKey>(REGULATORY_ACTIVITY_OPTIONS[0].key);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-bold text-[#061B40] mb-1">أنشطة الامتثال التنظيمي</h3>
        <p className="text-xs text-[#061B40]/60">
          اختر نشاط الامتثال التنظيمي (Riyadh Dust Compliance) الذي تريد تقييمه.
        </p>
      </div>

      <div>
        <label className={labelClass}>نوع النشاط التنظيمي</label>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value as RegulatoryActivityKey)}
          className={getInputClass(false)}
        >
          {REGULATORY_ACTIVITY_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>{o.label}</option>
          ))}
        </select>
      </div>

      <button
        type="button"
        onClick={() => onContinue(selected)}
        className="w-full flex items-center justify-center gap-2 bg-[#061B40] hover:bg-[#061B40]/90 text-white font-bold py-3 rounded-xl text-sm transition-colors"
      >
        متابعة لإدخال التفاصيل <ArrowLeft className="w-4 h-4" />
      </button>
    </div>
  );
}