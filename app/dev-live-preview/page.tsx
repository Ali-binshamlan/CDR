'use client';

// صفحة اختبار محلية فقط — لا تتصل بأي قاعدة بيانات ولا شبكة إطلاقاً.
// تولّد قراءة عشوائية كل دقيقة وتشغّل evaluateDustCompliance (محرك
// القرار الحقيقي نفسه المستخدَم في الإنتاج) محلياً في المتصفح، لمعاينة
// كيف تتحدّث الواجهة "حيّة" دون خطر تعليق provider-pull/Supabase.
// غير موصولة بأي layout للوحة التحكم — لا تحتاج تسجيل دخول.
// تُعطَّل تلقائياً خارج بيئة التطوير (راجع الفحص أسفل المكوّن).

import { useEffect, useState } from 'react';
import { evaluateDustCompliance } from '@/app/utils/dust-compliance-engine/engine';
import type {
  DustComplianceContext,
  DustComplianceResult,
  DustActivityComplianceProfile,
  DustProjectComplianceProfile,
} from '@/app/utils/dust-compliance-engine/types';

const REFRESH_INTERVAL_MS = 60_000;

function randomInRange(min: number, max: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round((min + Math.random() * (max - min)) * factor) / factor;
}

function buildProjectProfile(): DustProjectComplianceProfile {
  return {
    siteAreaM2: 1500,
    dailyTruckMovements: 10,
    hasOnsiteCrusher: false,
    hasOnsiteBatchingPlant: false,
    dmpApprovalStatus: 'APPROVED',
    dmpSubmittedAt: null,
    dmpApprovedAt: null,
    baselineMonitoringDays: 14,
    monitoringStationCount: 1,
    monitoringLoggingIntervalMinutes: 1,
    anemometerHeightM: 2.5,
    entryExitCamerasInstalled: true,
    cameraRetentionDays: 90,
    sensitivityMapPrepared: true,
  };
}

function buildActivityProfile(isEnclosed: boolean): DustActivityComplianceProfile {
  return {
    activityGroupId: 'dev-preview-activity',
    regulatoryActivity: 'EARTHWORKS',
    isDustGenerating: true,
    isEnclosedOperation: isEnclosed,
    isActiveOrPlanned: true,
    controls: {
      dustSuppressionSystemOperational: true,
      continuousMisting: true,
      sprayCannonAvailable: true,
      dustScreensAvailable: true,
      wetCuttingActive: true,
      hepaExtractionActive: true,
      wheelWashOperational: true,
      hourlyInspectionRecorded: true,
      speedControlApplied: true,
      loadCovered: true,
      conveyorsEnclosed: true,
      foggingAvailable: true,
      idleSurfaceStabilized: true,
      silosSealed: true,
      pm10FilterEfficiencyPercent: 99.5,
      leakDetected: false,
      dryCleaningMethodUsed: false,
      idleSurfaceCoverIntact: true,
      surfaceWatered: true,
      truckRoutesDesignated: true,
      pathCoverMaterial: 'GRAVEL',
      waterSprayMethod: 'SPRAY',
      soilCompactedAfterExcavation: true,
      stabilizerUsedDuringPause: true,
      pauseDurationOver5Days: false,
      sprayUsedDuringSoilUnloading: true,
      workAreaPhased: true,
      unpavedRoadsWateredDaily: true,
      dustControlMethod: 'WATER_SPRAY',
      speedLimitSignsPosted: true,
      containersCoveredBeforeMoving: true,
      containersInspectedBeforeDeparture: true,
      loadHeightExceedsContainerLimit: false,
      adjacentRoadsSweptMechanically: true,
      sweepFrequencyBand: 'HOURLY',
      wheelWashAtExit: true,
      wheelWashMaintainedRegularly: true,
      washWaterRecycled: true,
      allLoadsCovered: true,
      trucksInspectedBeforeDeparture: true,
      loadSideCoverageAdequate: true,
      publicRoadsVacuumSweptDaily: true,
      waterUsedRoutinelyForCleaning: false,
      accessRoadPaved: true,
      tireCleaningMethod: 'WHEEL_WASH',
      sandTrapPresent: true,
      oilSeparatorPresent: true,
      washCycleDurationAdequate: true,
    } as DustActivityComplianceProfile['controls'],
    measurements: {},
  } as DustActivityComplianceProfile;
}

function buildRandomContext(isEnclosed: boolean): DustComplianceContext {
  const windSpeedKmh = randomInRange(5, 40);
  const pm10 = randomInRange(20, 200);
  return {
    project: buildProjectProfile(),
    activity: buildActivityProfile(isEnclosed),
    isForecastStale: false,
    dviScore: 10,
    dviDecision: 'ALLOW',
    dviMandatoryStop: false,
    dviConfidenceScore: 95,
    windSpeedKmh,
    windGustKmh: windSpeedKmh + randomInRange(2, 8),
    windDirectionDeg: randomInRange(0, 360, 0),
    pm10UgM3: pm10,
    pm25UgM3: randomInRange(10, 80),
    relativeHumidityPercent: randomInRange(20, 50, 0),
    temperatureC: randomInRange(25, 40),
    visibilityM: 10000,
    dataSource: 'onsite',
    sensitiveReceptors: [],
  };
}

export default function DevLivePreviewPage() {
  const [isEnclosed, setIsEnclosed] = useState(false);
  const [result, setResult] = useState<DustComplianceResult | null>(null);
  const [context, setContext] = useState<DustComplianceContext | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string>('');

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    function tick(enclosed: boolean) {
      const ctx = buildRandomContext(enclosed);
      const r = evaluateDustCompliance(ctx);
      setContext(ctx);
      setResult(r);
      setLastUpdatedAt(new Date().toLocaleTimeString('ar-SA'));
    }

    tick(isEnclosed);
    const timer = setInterval(() => tick(isEnclosed), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isEnclosed]);

  if (process.env.NODE_ENV !== 'development') {
    return <div style={{ padding: 24 }}>هذه الصفحة متاحة فقط في بيئة التطوير المحلية.</div>;
  }

  const decisionColor =
    result?.decisionCategory === 'ALLOW'
      ? '#16a34a'
      : result?.decisionCategory === 'MANDATORY_STOP' || result?.decisionCategory === 'STOP_AFFECTED_ACTIVITY'
        ? '#dc2626'
        : '#d97706';

  return (
    <div dir="rtl" style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>معاينة حية محلية — بلا قاعدة بيانات</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        قيم عشوائية تتولّد محلياً كل دقيقة وتُمرَّر مباشرة لمحرك القرار الحقيقي (evaluateDustCompliance) —
        لا اتصال بأي شبكة أو Supabase.
      </p>

      <label style={{ display: 'block', margin: '12px 0' }}>
        <input
          type="checkbox"
          checked={isEnclosed}
          onChange={(e) => setIsEnclosed(e.target.checked)}
        />{' '}
        النشاط مغلق (isEnclosedOperation)
      </label>

      {result && context && (
        <div style={{ marginTop: 16, border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 12, color: '#888' }}>آخر تحديث: {lastUpdatedAt}</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: decisionColor, marginTop: 8 }}>
            {result.decisionLabelAr}
          </div>
          <div style={{ marginTop: 8, fontSize: 14 }}>{result.shortReasonAr}</div>
          <div style={{ marginTop: 12, fontSize: 13, color: '#444' }}>
            <div>سرعة الرياح: {context.windSpeedKmh} كم/س</div>
            <div>هبة الرياح: {context.windGustKmh} كم/س</div>
            <div>PM10: {context.pm10UgM3} ميكروجرام/م³</div>
            <div>نطاق الرياح: {result.windBand}</div>
            <div>مغلق: {result.isEnclosedOperation ? 'نعم' : 'لا'}</div>
          </div>
          {result.triggeredRules.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>القواعد المُفعَّلة:</div>
              <ul style={{ fontSize: 12, color: '#555' }}>
                {result.triggeredRules.map((rule) => (
                  <li key={rule.code}>
                    {rule.code} — {rule.messageAr}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
