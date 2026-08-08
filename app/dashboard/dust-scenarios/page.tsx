"use client";

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/app/lib/apiClient';
import { DUST_SCENARIOS, scenarioTotalMinutes } from '@/app/lib/dustScenarios';
import type { ScenarioRunState } from '@/app/lib/dustScenarioRunner';
import { Loader2, ShieldAlert, Radio, Play, Square, CheckCircle2, XCircle, Clock } from 'lucide-react';

const STATUS_STYLE: Record<ScenarioRunState['status'], { bg: string; text: string; label: string }> = {
  RUNNING: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', label: 'قيد التشغيل' },
  COMPLETED: { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', label: 'اكتمل' },
  STOPPED: { bg: 'bg-slate-100 border-slate-200', text: 'text-slate-600', label: 'أُوقف يدوياً' },
  FAILED: { bg: 'bg-red-50 border-red-200', text: 'text-red-700', label: 'فشل' },
};

const POLL_INTERVAL_MS = 4000;

export default function DustScenariosPage() {
  const router = useRouter();
  const [isSuperAdmin, setIsSuperAdmin] = useState<boolean | undefined>(undefined);
  const [accessDenied, setAccessDenied] = useState(false);
  const [run, setRun] = useState<ScenarioRunState | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const { data: profileResp } = await apiClient.get('/profile');
        const admin = !!profileResp?.data?.is_super_admin;
        setIsSuperAdmin(admin);
        if (!admin) router.replace('/dashboard');
      } catch (error: unknown) {
        if ((error as { response?: { status?: number } })?.response?.status === 403) setAccessDenied(true);
      }
    };
    check();
  }, [router]);

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await apiClient.get('/dust-scenarios/status');
      setRun(data?.data ?? null);
    } catch {
      // فشل استطلاع دوري صامت — لا يوقف الاستطلاع نفسه
    }
  }, []);

  useEffect(() => {
    if (isSuperAdmin !== true) return;
    const run = async () => {
      await fetchStatus();
    };
    run();
    pollTimer.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [isSuperAdmin, fetchStatus]);

  const handleStart = async (scenarioId: string) => {
    setActionError(null);
    setStartingId(scenarioId);
    try {
      const { data } = await apiClient.post('/dust-scenarios/run', { scenarioId });
      setRun(data?.data ?? null);
    } catch (error: unknown) {
      const message =
        (error as { response?: { data?: { error?: string } } })?.response?.data?.error ||
        'تعذّر بدء السيناريو';
      setActionError(message);
    } finally {
      setStartingId(null);
      fetchStatus();
    }
  };

  const handleStop = async () => {
    if (!run) return;
    setStopping(true);
    setActionError(null);
    try {
      await apiClient.delete(`/dust-scenarios/status?runId=${run.runId}`);
    } catch (error: unknown) {
      const message =
        (error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'تعذّر إيقاف السيناريو';
      setActionError(message);
    } finally {
      setStopping(false);
      fetchStatus();
    }
  };

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

  const isRunning = run?.status === 'RUNNING';
  const currentStageMinutes = isRunning
    ? DUST_SCENARIOS.find((s) => s.id === run.scenarioId)?.stages[run.currentStageIndex]?.minutes
    : undefined;
  const lastTick = run?.ticks[run.ticks.length - 1];

  return (
    <div className="min-h-screen bg-[#F4F7FB] p-6 lg:p-8 font-sans" dir="rtl">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Radio className="w-6 h-6 text-[#0176FB]" />
            <h1 className="text-3xl font-black text-[#061B40]">سيناريوهات اختبار محرك الامتثال</h1>
          </div>
          <p className="text-[12px] font-bold text-slate-500">
            كل زر يرسل قراءات telemetry حقيقية لجهاز ThingsBoard المربوط ببيانات المشروع — يعيد إنتاج بوابة أو قاعدة محددة بدقة عبر مراحل زمنية حقيقية.
          </p>
        </div>

        {actionError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-[12px] font-bold rounded-xl p-3 flex items-center gap-2">
            <XCircle className="w-4 h-4 shrink-0" />
            {actionError}
          </div>
        )}

        {run && (
          <div className={`rounded-2xl border shadow-sm p-5 space-y-3 ${STATUS_STYLE[run.status].bg}`}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                {run.status === 'RUNNING' && <Loader2 className="w-4 h-4 animate-spin" />}
                {run.status === 'COMPLETED' && <CheckCircle2 className="w-4 h-4" />}
                {run.status === 'STOPPED' && <Square className="w-4 h-4" />}
                {run.status === 'FAILED' && <XCircle className="w-4 h-4" />}
                <span className={`text-[13px] font-black ${STATUS_STYLE[run.status].text}`}>
                  {run.scenarioTitleAr} — {STATUS_STYLE[run.status].label}
                </span>
              </div>
              {isRunning && (
                <button
                  onClick={handleStop}
                  disabled={stopping}
                  className="text-[11px] font-black bg-white border border-red-300 text-red-600 rounded-lg px-3 py-1.5 flex items-center gap-1.5 hover:bg-red-50 disabled:opacity-50"
                >
                  {stopping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3.5 h-3.5" />}
                  إيقاف
                </button>
              )}
            </div>

            <div className="flex items-center gap-4 text-[11px] font-bold text-slate-500 flex-wrap">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5" />
                المرحلة {run.currentStageIndex + 1} من {DUST_SCENARIOS.find((s) => s.id === run.scenarioId)?.stages.length ?? '؟'}
                {currentStageMinutes ? ` (${currentStageMinutes} دقيقة)` : ''}
              </span>
              <span>القراءات المُرسَلة: {run.ticks.length}</span>
              {lastTick && (
                <span>
                  آخر قراءة — رياح: {lastTick.windSpeedKmh} كم/س، PM10: {lastTick.pm10}، رؤية: {lastTick.visibilityM}م
                  {lastTick.status !== null ? ` (HTTP ${lastTick.status})` : ' (فشل الإرسال)'}
                </span>
              )}
            </div>

            {run.ticks.length > 0 && (
              <div className="max-h-40 overflow-y-auto bg-white/60 rounded-xl border border-white/80 p-2 text-[10px] font-mono text-slate-500 space-y-0.5">
                {run.ticks
                  .slice()
                  .reverse()
                  .slice(0, 20)
                  .map((tick, idx) => (
                    <div key={idx} className={tick.errorMessage ? 'text-red-500' : ''}>
                      [{new Date(tick.atIso).toLocaleTimeString('ar-SA')}] {tick.stageLabelAr} — pm10={tick.pm10} wind={tick.windSpeedKmh} vis={tick.visibilityM}m
                      {tick.errorMessage ? ` — خطأ: ${tick.errorMessage}` : ` — HTTP ${tick.status}`}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {DUST_SCENARIOS.map((scenario) => {
            const totalMinutes = scenarioTotalMinutes(scenario);
            const disabled = isRunning || startingId === scenario.id;
            return (
              <div key={scenario.id} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col gap-3">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h2 className="font-black text-[#061B40] text-sm">{scenario.titleAr}</h2>
                    <span className="text-[10px] font-black text-slate-400 shrink-0">~{totalMinutes} د</span>
                  </div>
                  <p className="text-[12px] text-slate-500 leading-relaxed">{scenario.descriptionAr}</p>
                  <span className="inline-block mt-2 font-mono text-[10px] font-black text-slate-400 bg-slate-50 border border-slate-100 rounded-full px-2 py-0.5">
                    {scenario.targetRuleAr}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 space-y-0.5">
                  {scenario.stages.map((stage, idx) => (
                    <div key={idx}>
                      {idx + 1}. {stage.labelAr} — {stage.minutes} د
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => handleStart(scenario.id)}
                  disabled={disabled}
                  className="mt-auto text-[12px] font-black bg-[#0176FB] text-white rounded-xl py-2.5 flex items-center justify-center gap-2 hover:bg-[#0176FB]/90 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {startingId === scenario.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  تشغيل السيناريو
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
