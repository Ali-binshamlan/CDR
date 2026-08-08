import { describe, it, expect, vi } from 'vitest';
import type { LiveDataStore, LiveDeviceSnapshot } from './types';

function makeSnapshot(overrides: Partial<LiveDeviceSnapshot> = {}): LiveDeviceSnapshot {
  return {
    deviceId: 'device-1',
    projectId: 'project-1',
    windSpeedKmh: 10,
    windGustKmh: 15,
    windDirectionDeg: 90,
    pm10: 50,
    pm25: 20,
    visibilityM: 5000,
    relativeHumidityPercent: 40,
    temperatureC: 30,
    observedAtIso: '2026-01-01T00:00:00.000Z',
    updatedAtIso: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

describe('InMemoryLiveDataStore', () => {
  it('getSnapshot يرجع null قبل أي كتابة', async () => {
    vi.resetModules();
    const { liveDataStore } = (await import('./inMemoryStore')) as { liveDataStore: LiveDataStore };
    expect(liveDataStore.getSnapshot('unknown-device')).toBeNull();
  });

  it('setSnapshot ثم getSnapshot يرجع نفس القيمة المكتوبة', async () => {
    vi.resetModules();
    const { liveDataStore } = (await import('./inMemoryStore')) as { liveDataStore: LiveDataStore };
    const snapshot = makeSnapshot();
    liveDataStore.setSnapshot(snapshot);
    expect(liveDataStore.getSnapshot('device-1')).toEqual(snapshot);
  });

  it('getProjectSnapshots يجمع كل أجهزة نفس المشروع فقط، لا أجهزة مشاريع أخرى', async () => {
    vi.resetModules();
    const { liveDataStore } = (await import('./inMemoryStore')) as { liveDataStore: LiveDataStore };
    liveDataStore.setSnapshot(makeSnapshot({ deviceId: 'd1', projectId: 'p1' }));
    liveDataStore.setSnapshot(makeSnapshot({ deviceId: 'd2', projectId: 'p1' }));
    liveDataStore.setSnapshot(makeSnapshot({ deviceId: 'd3', projectId: 'p2' }));

    const p1Snapshots = liveDataStore.getProjectSnapshots('p1');
    expect(p1Snapshots).toHaveLength(2);
    expect(p1Snapshots.map((s) => s.deviceId).sort()).toEqual(['d1', 'd2']);
  });

  it('subscribeToProject يستدعي المستمع عند كل setSnapshot لنفس المشروع', async () => {
    vi.resetModules();
    const { liveDataStore } = (await import('./inMemoryStore')) as { liveDataStore: LiveDataStore };
    const listener = vi.fn();
    liveDataStore.subscribeToProject('project-x', listener);

    const snapshot = makeSnapshot({ deviceId: 'dx', projectId: 'project-x' });
    liveDataStore.setSnapshot(snapshot);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: 'snapshot', snapshot });
  });

  it('لا يستدعي مستمعاً مشتركاً بمشروع مختلف', async () => {
    vi.resetModules();
    const { liveDataStore } = (await import('./inMemoryStore')) as { liveDataStore: LiveDataStore };
    const listener = vi.fn();
    liveDataStore.subscribeToProject('project-a', listener);

    liveDataStore.setSnapshot(makeSnapshot({ deviceId: 'db', projectId: 'project-b' }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('دالة إلغاء الاشتراك تمنع استدعاءات لاحقة (لا memory leak)', async () => {
    vi.resetModules();
    const { liveDataStore } = (await import('./inMemoryStore')) as { liveDataStore: LiveDataStore };
    const listener = vi.fn();
    const unsubscribe = liveDataStore.subscribeToProject('project-y', listener);
    unsubscribe();

    liveDataStore.setSnapshot(makeSnapshot({ deviceId: 'dy', projectId: 'project-y' }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('خطأ مستمع واحد لا يمنع بث الحدث لبقية المستمعين', async () => {
    vi.resetModules();
    const { liveDataStore } = (await import('./inMemoryStore')) as { liveDataStore: LiveDataStore };
    const failingListener = vi.fn(() => {
      throw new Error('اتصال SSE مقطوع');
    });
    const workingListener = vi.fn();
    liveDataStore.subscribeToProject('project-z', failingListener);
    liveDataStore.subscribeToProject('project-z', workingListener);

    liveDataStore.setSnapshot(makeSnapshot({ deviceId: 'dz', projectId: 'project-z' }));

    expect(failingListener).toHaveBeenCalledTimes(1);
    expect(workingListener).toHaveBeenCalledTimes(1);
  });
});
