import type { Bank, BanksFile, GlobalScenesFile } from "./bank";
import { emptyBanksFile, emptyGlobalScenesFile } from "./bank";

export type SaveGlobalSceneResponse = { camera: BanksFile; globalBanks: Array<Bank | null> };

export interface BanksApi {
  load(deviceId: string): Promise<BanksFile>;
  loadGlobalScenes(): Promise<GlobalScenesFile>;
  saveBank(deviceId: string, slot: number, bank: Bank): Promise<BanksFile>;
  saveGlobalScene(deviceId: string, slot: number, bank: Bank): Promise<SaveGlobalSceneResponse>;
  setLoadedScene(
    deviceId: string,
    update: { slot?: number | null; globalLoadedSlot?: number | null },
  ): Promise<BanksFile>;
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

  async loadGlobalScenes(): Promise<GlobalScenesFile> {
    const res = await fetch(`${this.baseUrl}/global/scenes`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Global scenes load failed: HTTP ${res.status}`);
    return (await res.json()) as GlobalScenesFile;
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

  async saveGlobalScene(deviceId: string, slot: number, bank: Bank): Promise<SaveGlobalSceneResponse> {
    const res = await fetch(
      `${this.baseUrl}/cameras/${encodeURIComponent(deviceId)}/global-scenes/${slot}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bank),
      },
    );
    if (!res.ok) throw new Error(`Global scene save failed: HTTP ${res.status}`);
    return (await res.json()) as SaveGlobalSceneResponse;
  }

  async setLoadedScene(
    deviceId: string,
    update: { slot?: number | null; globalLoadedSlot?: number | null },
  ): Promise<BanksFile> {
    const res = await fetch(
      `${this.baseUrl}/cameras/${encodeURIComponent(deviceId)}/loaded`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      },
    );
    if (!res.ok) throw new Error(`Loaded-scene save failed: HTTP ${res.status}`);
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
  async loadGlobalScenes(): Promise<GlobalScenesFile> {
    return emptyGlobalScenesFile();
  }
  async saveBank(_d: string, _s: number, _b: Bank): Promise<BanksFile> {
    return emptyBanksFile();
  }
  async saveGlobalScene(): Promise<SaveGlobalSceneResponse> {
    return { camera: emptyBanksFile(), globalBanks: emptyGlobalScenesFile().banks };
  }
  async setLoadedScene(): Promise<BanksFile> {
    return emptyBanksFile();
  }
  async saveLastState(): Promise<void> {
    return undefined;
  }
}
