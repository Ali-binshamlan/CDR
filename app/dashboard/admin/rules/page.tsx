"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/app/lib/apiClient';
import { DUST_RULES_CATALOG, SEVERITY_LABEL_AR, RULEBOOK_VERSION } from '@/app/utils/dust-compliance-engine/rulesCatalog';
import type { DustComplianceDecisionCategory } from '@/app/utils/dust-compliance-engine/types';
import { Loader2, ShieldAlert, Scale, Search } from 'lucide-react';
import RuleParametersPanel from './RuleParametersPanel';

const SEVERITY_STYLE: Record<DustComplianceDecisionCategory, { bg: string; border: string; text: string; dot: string }> = {
  ALLOW: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  PRECAUTION: { bg: 'bg-yellow-50', border: 'border-yellow-200', text: 'text-yellow-700', dot: 'bg-yellow-500' },
  ALLOW_WITH_CONTROLS: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', dot: 'bg-amber-500' },
  FIELD_VERIFICATION_REQUIRED: { bg: 'bg-blue-50', border: 'border-blue-200', text: 'text-blue-700', dot: 'bg-blue-500' },
  RESTRICT_ACTIVITY: { bg: 'bg-orange-50', border: 'border-orange-200', text: 'text-orange-700', dot: 'bg-orange-500' },
  STOP_AFFECTED_ACTIVITY: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', dot: 'bg-red-600' },
  MANDATORY_STOP: { bg: 'bg-slate-900/5', border: 'border-slate-700', text: 'text-slate-800', dot: 'bg-slate-800' },
};

const SEVERITY_ORDER: DustComplianceDecisionCategory[] = [
  'MANDATORY_STOP',
  'STOP_AFFECTED_ACTIVITY',
  'RESTRICT_ACTIVITY',
  'FIELD_VERIFICATION_REQUIRED',
  'ALLOW_WITH_CONTROLS',
  'PRECAUTION',
  'ALLOW',
];

export default function AdminRulesPage() {
  const router = useRouter();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | undefined>(undefined);
  const [accessDenied, setAccessDenied] = useState(false);
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<DustComplianceDecisionCategory | 'ALL'>('ALL');

  useEffect(() => {
    const check = async () => {
      try {
        const { data: profileResp } = await apiClient.get('/profile');
        const admin = !!profileResp?.data?.is_super_admin;
        setIsSuperAdmin(admin);
        if (!admin) {
          router.replace('/dashboard');
        }
      } catch (error: unknown) {
        if ((error as { response?: { status?: number } })?.response?.status === 403) setAccessDenied(true);
      }
    };
    check();
  }, [router]);

  const totalRulesCount = useMemo(
    () => DUST_RULES_CATALOG.reduce((sum, section) => sum + section.rules.length, 0),
    []
  );

  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return DUST_RULES_CATALOG.map((section) => {
      const rules = section.rules.filter((rule) => {
        if (severityFilter !== 'ALL' && rule.severity !== severityFilter) return false;
        if (!q) return true;
        return (
          rule.code.toLowerCase().includes(q) ||
          rule.messageAr.includes(q) ||
          rule.actionAr.includes(q) ||
          (rule.noteAr ?? '').includes(q)
        );
      });
      return { ...section, rules };
    }).filter((section) => section.rules.length > 0);
  }, [query, severityFilter]);

  if (isSuperAdmin === undefined) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4 text-[#061B40]">
          <Loader2 className="w-10 h-10 animate-spin text-[#0176FB]" />
          <h2 className="font-bold text-lg">جاري التحقق من الصلاحية...</h2>
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="min-h-screen bg-[#F4F7FB] flex flex-col items-center justify-center text-slate-500" dir="rtl">
        <ShieldAlert className="w-16 h-16 mb-4 opacity-30" />
        <p className="font-bold text-lg text-slate-700">غير مصرح لك بالوصول لهذه الصفحة</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Scale className="w-6 h-6 text-[#0176FB]" />
            <h1 className="text-3xl font-black text-[#061B40]">قواعد الامتثال التنظيمي</h1>
          </div>
          <p className="text-[12px] font-bold text-slate-500">
            كل القواعد النصية المفعّلة فعلياً في محرك الامتثال ({totalRulesCount} قاعدة) — إصدار الدليل: {RULEBOOK_VERSION}
          </p>
        </div>

        <RuleParametersPanel />

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex flex-col sm:flex-row gap-3 sticky top-4 z-10">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ابحث برمز القاعدة أو نصها..."
              className="w-full text-[13px] font-bold bg-slate-50 border border-slate-200 rounded-xl py-2.5 pr-9 pl-3 focus:outline-none focus:ring-2 focus:ring-[#0176FB]/30"
            />
          </div>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value as DustComplianceDecisionCategory | 'ALL')}
            className="text-[13px] font-bold bg-slate-50 border border-slate-200 rounded-xl py-2.5 px-3 focus:outline-none focus:ring-2 focus:ring-[#0176FB]/30"
          >
            <option value="ALL">كل درجات الخطورة</option>
            {SEVERITY_ORDER.map((sev) => (
              <option key={sev} value={sev}>{SEVERITY_LABEL_AR[sev]}</option>
            ))}
          </select>
        </div>

        {filteredSections.length === 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center text-slate-400 font-bold text-sm">
            لا توجد قواعد مطابقة لبحثك.
          </div>
        )}

        <div className="space-y-6">
          {filteredSections.map((section) => (
            <div key={section.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="p-5 border-b border-slate-100 bg-slate-50/50">
                <h2 className="font-black text-[#061B40] text-base">{section.titleAr}</h2>
                {section.descriptionAr && (
                  <p className="text-[11px] font-bold text-slate-400 mt-1">{section.descriptionAr}</p>
                )}
              </div>
              <div className="divide-y divide-slate-100">
                {section.rules.map((rule) => {
                  const style = SEVERITY_STYLE[rule.severity];
                  return (
                    <div key={rule.code} className="p-5 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="font-mono text-[11px] font-black text-slate-400">{rule.code}</span>
                        <span className={`text-[10px] font-black px-2.5 py-1 rounded-full border flex items-center gap-1.5 ${style.bg} ${style.border} ${style.text}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                          {SEVERITY_LABEL_AR[rule.severity]}
                        </span>
                      </div>
                      <p className="text-[13px] font-bold text-[#061B40] leading-relaxed">{rule.messageAr}</p>
                      <div className="text-[12px] text-slate-500 leading-relaxed">
                        <span className="font-black text-slate-600">الإجراء المطلوب: </span>
                        {rule.actionAr}
                      </div>
                      {rule.noteAr && (
                        <div className="text-[11px] text-slate-400 bg-slate-50 border border-slate-100 rounded-lg px-3 py-1.5 leading-relaxed">
                          {rule.noteAr}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
