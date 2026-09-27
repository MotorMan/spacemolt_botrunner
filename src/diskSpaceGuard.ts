import { statSync, writeFileSync, writeFile } from "fs";
import { dirname } from "path";

export interface DiskSpaceState {
  freeBytes: number;
  totalBytes: number;
  isLow: boolean;
  thresholdBytes: number;
  lastCheck: number;
}

export interface PendingWrite {
  key: string;
  data: Buffer | string;
  path: string;
  timestamp: number;
  estimatedSize: number;
}

type AlertCallback = (state: DiskSpaceState) => void;
type EmergencyCallback = (state: DiskSpaceState) => void;

let thresholdBytes = 100 * 1024 * 1024;
let lastState: DiskSpaceState = {
  freeBytes: 0,
  totalBytes: 0,
  isLow: false,
  thresholdBytes,
  lastCheck: 0,
};
const pendingWrites = new Map<string, PendingWrite>();
let onAlert: AlertCallback | null = null;
let onEmergency: EmergencyCallback | null = null;
let emergencyTriggered = false;
let monitoringInterval: ReturnType<typeof setInterval> | null = null;

export function setThreshold(bytes: number): void {
  thresholdBytes = Math.max(0, bytes);
  lastState.thresholdBytes = thresholdBytes;
}

export function getThreshold(): number {
  return thresholdBytes;
}

export function setAlertCallback(cb: AlertCallback | null): void {
  onAlert = cb;
}

export function setEmergencyCallback(cb: EmergencyCallback | null): void {
  onEmergency = cb;
}

export function checkFreeSpace(path: string): { freeBytes: number; totalBytes: number } | null {
  try {
    const resolved = require("path").resolve(path);
    let checkPath = resolved;
    let attempts = 0;
    while (!statSync(checkPath).isDirectory() && attempts < 10) {
      checkPath = dirname(checkPath);
      attempts++;
    }
    const stats = statSync(checkPath);
    const freeBytes = (stats as unknown as { bavail?: number }).bavail ?? (stats as unknown as { avail?: number }).avail ?? 0;
    const totalBytes = (stats as unknown as { blocks?: number }).blocks ?? (stats as unknown as { size?: number }).size ?? 0;
    if (typeof freeBytes !== "number" || !Number.isFinite(freeBytes)) {
      return null;
    }
    const blockSize = (stats as unknown as { bsize?: number }).bsize ?? 4096;
    return {
      freeBytes: freeBytes * blockSize,
      totalBytes: totalBytes * blockSize,
    };
  } catch {
    return null;
  }
}

export function isWriteSafe(path: string, estimatedSize = 0): boolean {
  const space = checkFreeSpace(path);
  if (!space) return true;
  return space.freeBytes >= thresholdBytes + estimatedSize;
}

export function getCurrentState(): DiskSpaceState {
  return { ...lastState };
}

export function refreshDiskSpaceState(path: string): DiskSpaceState {
  const space = checkFreeSpace(path);
  const now = Date.now();
  if (space) {
    lastState.freeBytes = space.freeBytes;
    lastState.totalBytes = space.totalBytes;
  }
  lastState.lastCheck = now;
  lastState.isLow = space ? space.freeBytes < thresholdBytes : false;
  lastState.thresholdBytes = thresholdBytes;
  return { ...lastState };
}

export function bufferWrite(key: string, data: Buffer | string, path: string, estimatedSize: number): void {
  pendingWrites.set(key, { key, data, path, timestamp: Date.now(), estimatedSize });
}

export function discardWrite(key: string): boolean {
  return pendingWrites.delete(key);
}

export function discardAllWrites(): number {
  const count = pendingWrites.size;
  pendingWrites.clear();
  return count;
}

export function getPendingWrites(): PendingWrite[] {
  return [...pendingWrites.values()];
}

export async function retryBufferedWrites(): Promise<{ succeeded: string[]; failed: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  const toRetry = [...pendingWrites.values()];
  pendingWrites.clear();
  for (const pw of toRetry) {
    if (isWriteSafe(pw.path, pw.estimatedSize)) {
      try {
        const { writeFileSync } = require("fs");
        writeFileSync(pw.path, typeof pw.data === "string" ? pw.data : Buffer.from(pw.data), "utf-8");
        succeeded.push(pw.key);
      } catch {
        pendingWrites.set(pw.key, pw);
        failed.push(pw.key);
      }
    } else {
      pendingWrites.set(pw.key, pw);
      failed.push(pw.key);
    }
  }
  return { succeeded, failed };
}

export function startMonitoring(dataPath: string, intervalMs = 60_000): void {
  if (monitoringInterval) clearInterval(monitoringInterval);
  refreshDiskSpaceState(dataPath);
  monitoringInterval = setInterval(() => {
    const prev = lastState.isLow;
    const state = refreshDiskSpaceState(dataPath);
    if (!prev && state.isLow) {
      console.warn(`[DiskSpace] Low disk space detected: ${formatBytes(state.freeBytes)} free (threshold: ${formatBytes(state.thresholdBytes)})`);
      if (onAlert) onAlert(state);
    }
    if (state.freeBytes < 10 * 1024 * 1024 && !emergencyTriggered) {
      emergencyTriggered = true;
      console.error(`[DiskSpace] CRITICALLY low disk space: ${formatBytes(state.freeBytes)} free. Triggering emergency return home.`);
      if (onEmergency) onEmergency(state);
    }
    if (state.freeBytes >= state.thresholdBytes * 2) {
      emergencyTriggered = false;
    }
  }, intervalMs);
}

export function stopMonitoring(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function safeWriteFileSync(path: string, data: string | Buffer, estimatedSize = 0): boolean {
  if (!isWriteSafe(path, estimatedSize)) {
    const state = getCurrentState();
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, "utf-8");
    bufferWrite(`${path}:${Date.now()}`, data, path, size);
    console.warn(`[DiskSpace] Write blocked for ${path}: only ${formatBytes(state.freeBytes)} free (need ${formatBytes(size)} + ${formatBytes(state.thresholdBytes)} threshold)`);
    if (onAlert) onAlert(state);
    return false;
  }
  const { writeFileSync: originalWriteFileSync } = require("fs");
  try {
    originalWriteFileSync(path, data, "utf-8");
    return true;
  } catch (err) {
    console.error(`[DiskSpace] Write failed for ${path}:`, err);
    return false;
  }
}

export function safeWriteFile(path: string, data: string | Buffer, callback: (err: Error | null) => void, estimatedSize = 0): boolean {
  if (!isWriteSafe(path, estimatedSize)) {
    const state = getCurrentState();
    const size = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, "utf-8");
    bufferWrite(`${path}:${Date.now()}`, data, path, size);
    console.warn(`[DiskSpace] Async write blocked for ${path}: only ${formatBytes(state.freeBytes)} free`);
    if (onAlert) onAlert(state);
    callback(new Error(`Disk space low: ${formatBytes(state.freeBytes)} free (threshold: ${formatBytes(state.thresholdBytes)})`));
    return false;
  }
  const { writeFile } = require("fs");
  writeFile(path, data, "utf-8", callback);
  return true;
}

export function safeCopyFileSync(src: string, dest: string): boolean {
  let srcSize = 0;
  try {
    const stats = statSync(src);
    srcSize = stats.size;
  } catch {
    return false;
  }
  if (!isWriteSafe(dest, srcSize)) {
    const state = getCurrentState();
    console.warn(`[DiskSpace] Backup copy blocked for ${dest}: only ${formatBytes(state.freeBytes)} free (need ~${formatBytes(srcSize)})`);
    if (onAlert) onAlert(state);
    return false;
  }
  try {
    const { copyFileSync } = require("fs");
    copyFileSync(src, dest);
    return true;
  } catch (err) {
    console.error(`[DiskSpace] Backup copy failed for ${dest}:`, err);
    return false;
  }
}
