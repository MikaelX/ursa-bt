import type { Bank, BanksFile } from "./bank";
import { emptyBanksFile } from "./bank";

export interface BanksApi {
  load(deviceId: string): Promise<BanksFile>;
  saveBank(deviceId: string, slot: number, bank: Bank): Promise<BanksFile>;
  setLoadedSlot(deviceId: string, slot: number | null): Promise<BanksFile>;
  saveLastState(deviceId: string, state: Bank): Promise<void>;
}

export class HttpBanksApi implements BanksApi {
  constructor(private readonly baseUrl = "/api") {}

  async load(deviceId: string): Promise<BanksFile> {
    const res = await fetch(`${this.baseUrl}/cameras/${encodeURIComponent(deviceId)}/banks`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Banks load failed: HTTP ${res.status}`);
    return (await res.json()) as BanksFile;
  }

  async saveBank(deviceId: string, slot: number, bank: Bank): Promise<BanksFile> {
    const res = await fetch(
      `${this.baseUrl}/cameras/${encodeURIComponent(deviceId)}/banks/${slot}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bank),
      },
    );
    if (!res.ok) throw new Error(`Bank save failed: HTTP ${res.status}`);
    return (await res.json()) as BanksFile;
  }

  async setLoadedSlot(deviceId: string, slot: number | null): Promise<BanksFile> {
    const res = await fetch(
      `${this.baseUrl}/cameras/${encodeURIComponent(deviceId)}/loaded`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot }),
      },
    );
    if (!res.ok) throw new Error(`Loaded-slot save failed: HTTP ${res.status}`);
    return (await res.json()) as BanksFile;
  }

  async saveLastState(deviceId: string, state: Bank): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/cameras/${encodeURIComponent(deviceId)}/state`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
      },
    );
    if (!res.ok) throw new Error(`Last-state save failed: HTTP ${res.status}`);
  }
}

export class NullBanksApi implements BanksApi {
  async load(): Promise<BanksFile> {
    return emptyBanksFile();
  }
  async saveBank(_d: string, _s: number, _b: Bank): Promise<BanksFile> {
    return emptyBanksFile();
  }
  async setLoadedSlot(): Promise<BanksFile> {
    return emptyBanksFile();
  }
  async saveLastState(): Promise<void> {
    return undefined;
  }
}
