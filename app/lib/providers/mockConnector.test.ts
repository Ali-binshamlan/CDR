import { describe, it, expect } from 'vitest';
import { mockConnector } from './mockConnector';

describe('mockConnector', () => {
  it('ينجح testConnection بأي مفتاح غير invalid', async () => {
    const result = await mockConnector.testConnection('', { api_key: 'anything' });
    expect(result.success).toBe(true);
  });

  it("يفشل testConnection عمداً مع api_key='invalid'", async () => {
    const result = await mockConnector.testConnection('', { api_key: 'invalid' });
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBeTruthy();
  });

  it('يرجع listStations قائمة ثابتة بمحطتين', async () => {
    const stations = await mockConnector.listStations('', {});
    expect(stations).toHaveLength(2);
    expect(stations.map((s) => s.vendorStationId)).toEqual(['DEMO-01', 'DEMO-02']);
  });

  it('يرجع fetchLatestReading قيماً ضمن النطاقات المنطقية لمحطة صالحة', async () => {
    const reading = await mockConnector.fetchLatestReading('', {}, 'DEMO-01');
    expect(reading).not.toBeNull();
    expect(reading!.pm10).toBeGreaterThanOrEqual(20);
    expect(reading!.pm10).toBeLessThanOrEqual(100);
    expect(reading!.temperatureC).toBeGreaterThanOrEqual(20);
    expect(reading!.temperatureC).toBeLessThanOrEqual(40);
    expect(reading!.windDirectionDeg).toBeGreaterThanOrEqual(0);
    expect(reading!.windDirectionDeg).toBeLessThanOrEqual(360);
    expect(reading!.relativeHumidityPercent).toBeGreaterThanOrEqual(20);
    expect(reading!.relativeHumidityPercent).toBeLessThanOrEqual(60);
    expect(reading!.observedAtIso).toBeTruthy();
    expect(new Date(reading!.observedAtIso!).getTime()).toBeCloseTo(Date.now(), -2);
  });

  it('يرجع null لمعرّف محطة غير موجود', async () => {
    const reading = await mockConnector.fetchLatestReading('', {}, 'UNKNOWN-STATION');
    expect(reading).toBeNull();
  });
});
