import { Capacitor } from "@capacitor/core";

export type CapacitorPlatform = "ios" | "android" | "web";

export function getCapacitorPlatform(): CapacitorPlatform {
  const p = Capacitor.getPlatform();
  if (p === "ios" || p === "android") return p;
  return "web";
}

export function isNativeShell(): boolean {
  return Capacitor.isNativePlatform();
}
