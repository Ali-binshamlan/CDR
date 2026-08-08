"use client";

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'react-hot-toast';
import { apiClient } from '@/app/lib/apiClient';
import { Loader2, SlidersHorizontal, History, RotateCcw, Send } from 'lucide-react';

// خطأ مكتشَف ومُصلَح (مراجعة خبير خارجي — "واجهة إدارة القواعد للعرض فقط؛
// لا يوجد نظام حقيقي يدعم إنشاء نسخة قاعدة، النشر الذري، منع تعديل نسخة
// منشورة، التراجع لنسخة سابقة"): هذه اللوحة تستهلك GET/POST
// /api/admin/rule-parameters — نسخ/نشر/تراجع حقيقي للعتبات الرقمية القابلة
// للضبط في rulebook.ts/engine.ts (راجع ruleParameters.ts للنطاق الكامل
// ولماذا استُبعدت عتبات PM10 صراحة). القواعد النصية (DUST_RULES_CATALOG)
// تبقى في صفحة page.tsx الأصلية أسفل هذه اللوحة — عرض فقط، بلا تغيير.

interface RuleParameterRow {
  code: string;
  labelAr: string;
  descriptionAr: string;
  unit: string;
  valueType: 'NUMBER' | 'INTEGER';
  minValue: number | null;
  maxValue: number | null;
  codeDefaultValue: number;
  currentValue: number;
  isUsingCodeDefault: boolean;
  publishedVersionId: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  changeReasonAr: string | null;
  isRollback: boolean;
}

interface VersionRow {
  id: string;
  value: number;
  status: 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED' | 'ARCHIVED';
  effectiveFrom: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  changeReasonAr: string | null;
  isRollback: boolean;
  supersedesVersionId: string | null;
  createdBy: string | null;
  createdAt: string;
}

const STATUS_LABEL_AR: Record<VersionRow['status'], string> = {
  DRAFT: 'مسودة',
  PUBLISHED: 'منشورة الآن',
  SUPERSEDED: 'استُبدلت',
  ARCHIVED: 'مؤرشفة',
};

const STATUS_STYLE: Record<VersionRow['status'], string> = {
  DRAFT: 'bg-slate-50 text-slate-500 border-slate-200',
  PUBLISHED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  SUPERSEDED: 'bg-slate-50 text-slate-400 border-slate-200',
  ARCHIVED: 'bg-slate-50 text-slate-400 border-slate-200',
};

function getApiErrorMessage(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object'
  ) {
    const response = (error as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  if (error instanceof Error) return error.message;
  return undefined;
}

function ParameterRow({ row, onChanged }: { row: RuleParameterRow; onChanged: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  // خطأ eslint مُصلَح (react-hooks/set-state-in-effect): بدل useEffect
  // لمزامنة draftValue مع row.currentValue بعد كل نشر ناجح، الأب (RuleParametersPanel)
  // يُمرِّر key={`${row.code}-${row.currentValue}`} فيُعيد React تركيب هذا
  // المكوّن بالكامل (state جديد كلياً) تلقائياً عند تغيّر القيمة المنشورة —
  // لا حاجة لمزامنة يدوية بعد الآن.
  const [draftValue, setDraftValue] = useState(String(row.currentValue));
  const [changeReason, setChangeReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const { data } = await apiClient.get(`/admin/rule-parameters/${row.code}`);
      setVersions(data?.versions || []);
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل جلب سجل النسخ');
    } finally {
      setLoadingHistory(false);
    }
  }, [row.code]);

  const toggleExpanded = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && versions === null) loadHistory();
  };

  const handlePublish = async () => {
    const numeric = Number(draftValue);
    if (!Number.isFinite(numeric)) {
      toast.error('القيمة يجب أن تكون رقماً صالحاً');
      return;
    }
    if (!changeReason.trim()) {
      toast.error('سبب النشر إلزامي — سجل تدقيق: لماذا تغيّرت هذه القيمة؟');
      return;
    }
    setSaving(true);
    try {
      await apiClient.post(`/admin/rule-parameters/${row.code}/publish`, {
        value: numeric,
        changeReasonAr: changeReason.trim(),
      });
      toast.success('تم نشر القيمة الجديدة');
      setChangeReason('');
      // onChanged يُعيد جلب القائمة الكاملة من الأب — بعد اكتمالها، الأب
      // يُمرِّر key جديداً (`${code}-${currentValue}`) فيُعيد React تركيب
      // هذا المكوّن بالكامل بالقيمة المنشورة الجديدة (راجع تعليق draftValue
      // أعلاه) — لا حاجة لـloadHistory هنا، سجل النسخ يُعاد جلبه عند فتح
      // اللوحة من جديد بعد إعادة التركيب.
      await onChanged();
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل نشر القيمة');
    } finally {
      setSaving(false);
    }
  };

  const handleRollback = async (versionId: string) => {
    const reason = window.prompt('سبب التراجع (إلزامي):');
    if (!reason || !reason.trim()) return;
    setSaving(true);
    try {
      await apiClient.post(`/admin/rule-parameters/${row.code}/rollback`, {
        versionId,
        changeReasonAr: reason.trim(),
      });
      toast.success('تم التراجع بنجاح');
      // راجع تعليق onChanged في handlePublish أعلاه — نفس آلية إعادة
      // التركيب عبر key جديد، لا حاجة لـloadHistory هنا.
      await onChanged();
    } catch (error) {
      toast.error(getApiErrorMessage(error) || 'فشل التراجع');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-black text-[13px] text-[#061B40]">{row.labelAr}</span>
            <span className="font-mono text-[10px] font-bold text-slate-400">{row.code}</span>
            {row.isUsingCodeDefault ? (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-50 text-amber-700 border-amber-200">
                القيمة الافتراضية (لم تُنشَر بعد)
              </span>
            ) : (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                منشورة
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{row.descriptionAr}</p>
          {row.changeReasonAr && (
            <p className="text-[10px] text-slate-400 mt-1">آخر سبب نشر: {row.changeReasonAr}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="text-left">
            <div className="text-lg font-black text-[#061B40] tabular-nums" dir="ltr">
              {row.currentValue} <span className="text-[11px] font-bold text-slate-400">{row.unit}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={toggleExpanded}
            className="text-slate-400 hover:text-[#0176FB] p-2 rounded-lg hover:bg-slate-50"
            title="سجل النسخ"
          >
            <History className="w-4 h-4" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 bg-slate-50/40">
          <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end pt-3">
            <div className="flex-1">
              <label className="block text-[10px] font-bold text-slate-500 mb-1">قيمة جديدة</label>
              <input
                type="number"
                step={row.valueType === 'INTEGER' ? 1 : 0.1}
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                dir="ltr"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm tabular-nums"
              />
              {(row.minValue !== null || row.maxValue !== null) && (
                <p className="text-[10px] text-slate-400 mt-1">
                  المدى الآمن: {row.minValue ?? '—'} إلى {row.maxValue ?? '—'} {row.unit}
                </p>
              )}
            </div>
            <div className="flex-[2]">
              <label className="block text-[10px] font-bold text-slate-500 mb-1">سبب النشر *</label>
              <input
                type="text"
                value={changeReason}
                onChange={(e) => setChangeReason(e.target.value)}
                placeholder="مثال: تعديل بناءً على تعميم جديد من الجهة المختصة"
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm"
              />
            </div>
            <button
              type="button"
              onClick={handlePublish}
              disabled={saving}
              className="bg-[#0176FB] hover:bg-[#0176FB]/90 disabled:bg-slate-300 text-white text-xs font-bold py-2.5 px-4 rounded-lg transition-all flex items-center justify-center gap-2 whitespace-nowrap"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              نشر
            </button>
          </div>

          <div>
            <p className="text-[11px] font-black text-slate-500 mb-2">سجل النسخ</p>
            {loadingHistory ? (
              <div className="flex items-center gap-2 text-slate-400 text-xs">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> جاري التحميل...
              </div>
            ) : !versions || versions.length === 0 ? (
              <p className="text-[11px] text-slate-400">لا يوجد أي نشر بعد — القيمة الحالية هي الافتراضية من الكود.</p>
            ) : (
              <div className="space-y-1.5">
                {versions.map((v) => (
                  <div key={v.id} className="flex items-center justify-between gap-2 bg-white border border-slate-100 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[9px] font-black px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLE[v.status]}`}>
                        {STATUS_LABEL_AR[v.status]}
                      </span>
                      <span className="font-black text-[12px] text-[#061B40] tabular-nums shrink-0" dir="ltr">{v.value}</span>
                      <span className="text-[10px] text-slate-400 truncate">{v.changeReasonAr || '—'}</span>
                      {v.isRollback && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-600 border border-purple-200 shrink-0">تراجع</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] text-slate-400" dir="ltr">
                        {v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('ar-SA', { calendar: 'gregory' }) : new Date(v.createdAt).toLocaleDateString('ar-SA', { calendar: 'gregory' })}
                      </span>
                      {v.status !== 'PUBLISHED' && (
                        <button
                          type="button"
                          onClick={() => handleRollback(v.id)}
                          disabled={saving}
                          className="text-[10px] font-bold text-[#0176FB] hover:underline flex items-center gap-1 disabled:opacity-40"
                        >
                          <RotateCcw className="w-3 h-3" /> تراجع لهذه القيمة
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function RuleParametersPanel() {
  const [rows, setRows] = useState<RuleParameterRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/admin/rule-parameters');
      setRows(data?.data || []);
      setError(null);
    } catch (err) {
      setError(getApiErrorMessage(err) || 'فشل جلب معاملات القواعد');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const run = async () => {
      await load();
    };
    run();
  }, [load]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="p-5 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-[#0176FB]" />
          <h2 className="font-black text-[#061B40] text-base">العتبات القابلة للضبط</h2>
        </div>
        <p className="text-[11px] font-bold text-slate-400 mt-1">
          مسافات المستقبِلات الحساسة، سرعات بوابات الرياح، حدود السرعة، الأزمنة، النسب — نسخ/نشر/تراجع حقيقي بسجل تدقيق كامل.
          عتبات PM10 التنظيمية مُستبعَدة عمداً (تبقى ثابتة في حزمة القواعد النشطة).
        </p>
      </div>

      {loading ? (
        <div className="p-8 flex items-center justify-center gap-2 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" /> جاري التحميل...
        </div>
      ) : error ? (
        <div className="p-8 text-center text-red-500 text-sm font-bold">{error}</div>
      ) : !rows || rows.length === 0 ? (
        <div className="p-8 text-center text-slate-400 text-sm font-bold">لا توجد معاملات مسجَّلة</div>
      ) : (
        <div>
          {rows.map((row) => (
            <ParameterRow key={`${row.code}-${row.currentValue}`} row={row} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
