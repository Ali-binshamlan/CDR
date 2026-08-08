import type { LiveDataListener, LiveDataStore, LiveDeviceSnapshot } from './types';

// تنفيذ Map داخل عملية Node واحدة — راجع قيد "لا مشاركة بين instances" في
// types.ts. singleton على مستوى الموديول (نفس نمط supabaseAdmin.ts).
class InMemoryLiveDataStore implements LiveDataStore {
  private snapshotsByDevice = new Map<string, LiveDeviceSnapshot>();
  // فهرس ثانوي: projectId → مجموعة deviceId (لبناء getProjectSnapshots
  // بكفاءة بدل مسح كل الأجهزة في كل استدعاء).
  private deviceIdsByProject = new Map<string, Set<string>>();
  private listenersByProject = new Map<string, Set<LiveDataListener>>();

  setSnapshot(snapshot: LiveDeviceSnapshot): void {
    this.snapshotsByDevice.set(snapshot.deviceId, snapshot);

    let deviceIds = this.deviceIdsByProject.get(snapshot.projectId);
    if (!deviceIds) {
      deviceIds = new Set();
      this.deviceIdsByProject.set(snapshot.projectId, deviceIds);
    }
    deviceIds.add(snapshot.deviceId);

    const listeners = this.listenersByProject.get(snapshot.projectId);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) {
      // عزل كل مستمع عن أخطاء الآخرين — فشل مستمع واحد (مثال: اتصال SSE
      // مقطوع للتو) لا يجوز أن يمنع بقية المستمعين من استلام التحديث.
      try {
        listener({ type: 'snapshot', snapshot });
      } catch (err) {
        console.error('liveData: فشل مستمع أثناء بث تحديث', err);
      }
    }
  }

  getSnapshot(deviceId: string): LiveDeviceSnapshot | null {
    return this.snapshotsByDevice.get(deviceId) ?? null;
  }

  getProjectSnapshots(projectId: string): LiveDeviceSnapshot[] {
    const deviceIds = this.deviceIdsByProject.get(projectId);
    if (!deviceIds) return [];
    const snapshots: LiveDeviceSnapshot[] = [];
    for (const deviceId of deviceIds) {
      const snapshot = this.snapshotsByDevice.get(deviceId);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  subscribeToProject(projectId: string, listener: LiveDataListener): () => void {
    let listeners = this.listenersByProject.get(projectId);
    if (!listeners) {
      listeners = new Set();
      this.listenersByProject.set(projectId, listeners);
    }
    listeners.add(listener);

    return () => {
      const current = this.listenersByProject.get(projectId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listenersByProject.delete(projectId);
    };
  }
}

// singleton — نفس نمط supabaseAdmin. يُستورد مباشرة من المستهلكين (لا
// factory)؛ الاستبدال بـRedis مستقبلاً يعني تغيير هذا الملف فقط (تصدير
// نفس الاسم liveDataStore بنوع LiveDataStore، تنفيذ مختلف داخلياً).
export const liveDataStore: LiveDataStore = new InMemoryLiveDataStore();
