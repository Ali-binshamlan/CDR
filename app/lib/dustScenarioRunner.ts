// منفّذ سيناريوهات ThingsBoard الخلفي — يرسل قراءات telemetry حقيقية على
// فواصل زمنية حقيقية (نفس آلية scripts/local-thingsboard-*-scenario.mjs،
// لكن مُشغَّلة من زر بدل تشغيل يدوي في الطرفية). حالة التشغيل تُخزَّن في
// الذاكرة (Map على مستوى الوحدة) — يعمل بشكل موثوق طالما عملية Node واحدة
// طويلة الأمد (تطوير محلي / سيرفر تقليدي)؛ على بيئة serverless متعددة
// الـinstances (Vercel) لا تضمن نفس الـinstance يخدم كل الطلبات اللاحقة —
// هذا مقبول هنا لأداة تشغيلية داخلية للاختبار اليدوي، لا مسار إنتاجي حرج.
import { randomUUID } from 'crypto';
import { DUST_SCENARIOS, findDustScenario, scenarioTotalMinutes, type DustScenarioStage } from './dustScenarios';

export type ScenarioRunStatus = 'RUNNING' | 'COMPLETED' | 'STOPPED' | 'FAILED';

export interface ScenarioRunTick {
  atIso: string;
  stageIndex: number;
  stageLabelAr: string;
  status: number | null;
  windSpeedKmh: number;
  windGustKmh: number;
  pm10: number;
  visibilityM: number;
  errorMessage?: string;
}

export interface ScenarioRunState {
  runId: string;
  scenarioId: string;
  scenarioTitleAr: string;
  startedAt: string;
  finishedAt: string | null;
  status: ScenarioRunStatus;
  totalMinutes: number;
  currentStageIndex: number;
  ticks: ScenarioRunTick[];
  stopRequested: boolean;
}

const runs = new Map<string, ScenarioRunState>();
// سيناريو واحد فعّال كحد أقصى في كل لحظة — إرسال سيناريوهين متزامنين لنفس
// الجهاز يُنتج قراءات متداخلة لا تعكس أي سيناريو بدقة.
let activeRunId: string | null = null;

function randomInRange([min, max]: [number, number], decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function buildReadingForStage(stage: DustScenarioStage) {
  return {
    windSpeed: randomInRange(stage.windSpeedKmh),
    windGust: randomInRange(stage.windGustKmh),
    windDirection: randomInRange([0, 360], 0),
    pm10: randomInRange(stage.pm10),
    pm25: randomInRange([Math.min(10, stage.pm10[0] * 0.4), Math.min(150, stage.pm10[1] * 0.6)]),
    visibility: randomInRange(stage.visibilityM, 0) / 1000, // م → كم (نفس وحدة السكربتات المحلية)
    humidity: randomInRange([20, 50], 0),
    temperature: randomInRange([25, 40], 1),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getActiveRun(): ScenarioRunState | null {
  return activeRunId ? runs.get(activeRunId) ?? null : null;
}

export function getRun(runId: string): ScenarioRunState | null {
  return runs.get(runId) ?? null;
}

export function requestStop(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || run.status !== 'RUNNING') return false;
  run.stopRequested = true;
  return true;
}

export interface StartRunOptions {
  scenarioId: string;
  baseUrl: string;
  deviceToken: string;
  // فاصل الإرسال الفعلي — افتراضياً دقيقة واحدة (يطابق دورة السحب
  // التصميمية)؛ قابل للتقصير هنا فقط للاختبار اليدوي السريع من الواجهة.
  sendIntervalMs?: number;
}

export function startScenarioRun(options: StartRunOptions): ScenarioRunState | { error: string } {
  const scenario = findDustScenario(options.scenarioId);
  if (!scenario) return { error: 'سيناريو غير معروف' };

  const existing = getActiveRun();
  if (existing && existing.status === 'RUNNING') {
    return { error: `يوجد سيناريو قيد التشغيل بالفعل (${existing.scenarioTitleAr}) — أوقفه أولاً قبل بدء سيناريو جديد` };
  }

  const runId = randomUUID();
  const state: ScenarioRunState = {
    runId,
    scenarioId: scenario.id,
    scenarioTitleAr: scenario.titleAr,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'RUNNING',
    totalMinutes: scenarioTotalMinutes(scenario),
    currentStageIndex: 0,
    ticks: [],
    stopRequested: false,
  };
  runs.set(runId, state);
  activeRunId = runId;

  const sendIntervalMs = options.sendIntervalMs ?? 60_000;

  void runLoop(state, scenario.stages, options.baseUrl, options.deviceToken, sendIntervalMs);

  return state;
}

async function runLoop(
  state: ScenarioRunState,
  stages: DustScenarioStage[],
  baseUrl: string,
  deviceToken: string,
  sendIntervalMs: number
): Promise<void> {
  try {
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      if (state.stopRequested) break;
      const stage = stages[stageIndex];
      state.currentStageIndex = stageIndex;
      const ticksInStage = Math.max(1, Math.round((stage.minutes * 60 * 1000) / sendIntervalMs));

      for (let i = 0; i < ticksInStage; i++) {
        if (state.stopRequested) break;
        const reading = buildReadingForStage(stage);
        const atIso = new Date().toISOString();
        try {
          const res = await fetch(`${baseUrl}/api/v1/${deviceToken}/telemetry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reading),
          });
          state.ticks.push({
            atIso,
            stageIndex,
            stageLabelAr: stage.labelAr,
            status: res.status,
            windSpeedKmh: reading.windSpeed,
            windGustKmh: reading.windGust,
            pm10: reading.pm10,
            visibilityM: Math.round(reading.visibility * 1000),
          });
        } catch (err) {
          state.ticks.push({
            atIso,
            stageIndex,
            stageLabelAr: stage.labelAr,
            status: null,
            windSpeedKmh: reading.windSpeed,
            windGustKmh: reading.windGust,
            pm10: reading.pm10,
            visibilityM: Math.round(reading.visibility * 1000),
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
        if (i < ticksInStage - 1 && !state.stopRequested) await sleep(sendIntervalMs);
      }
    }
    state.status = state.stopRequested ? 'STOPPED' : 'COMPLETED';
  } catch (err) {
    state.status = 'FAILED';
    state.ticks.push({
      atIso: new Date().toISOString(),
      stageIndex: state.currentStageIndex,
      stageLabelAr: 'خطأ عام',
      status: null,
      windSpeedKmh: 0,
      windGustKmh: 0,
      pm10: 0,
      visibilityM: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  } finally {
    state.finishedAt = new Date().toISOString();
    if (activeRunId === state.runId) activeRunId = null;
  }
}

export { DUST_SCENARIOS };
