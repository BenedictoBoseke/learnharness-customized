import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LOCAL_STATE_DIR } from "../../config.ts";
import { atomicWrite, readJson } from "./atomic-json.ts";
export const SYNC_LOCAL_DIR = path.join(LOCAL_STATE_DIR, "sync");
export interface DeviceIdentity {
  id: string;
  name: string;
}
export function deviceIdentity(): DeviceIdentity {
  const file = path.join(SYNC_LOCAL_DIR, "device.json");
  let value = readJson<DeviceIdentity | null>(file, null);
  if (!value) {
    value = {
      id: "device_" + crypto.randomUUID().replaceAll("-", ""),
      name: process.env.LH_DEVICE_NAME || os.hostname(),
    };
    atomicWrite(file, JSON.stringify(value));
  }
  return value;
}
/** Durable dirty marker is deliberately separate from the public UI event vocabulary. */
export function noteLibraryMutation(): void {
  if (process.env.NODE_ENV === "test" && process.env.LH_SYNC_TEST !== "1")
    return;
  fs.mkdirSync(SYNC_LOCAL_DIR, { recursive: true });
  atomicWrite(
    path.join(SYNC_LOCAL_DIR, "dirty.json"),
    JSON.stringify({ id: crypto.randomUUID(), at: Date.now() }),
  );
  const g = globalThis as typeof globalThis & {
    __lhLibraryChanged?: () => void;
  };
  g.__lhLibraryChanged?.();
}
export function foreignJob(job: { ownerDeviceId?: string }): boolean {
  return Boolean(
    job.ownerDeviceId && job.ownerDeviceId !== deviceIdentity().id,
  );
}
