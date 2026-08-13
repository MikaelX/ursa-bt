import "../patterns/patterns.css";
import "./audioGainPage.css";
import { commands, toHex, withDestination } from "../blackmagic/protocol";

/**
 * @file audioGainPage.ts
 *
 * bm-bluetooth — Standalone ATEM utility page for setting Blackmagic Camera Control audio input
 * L/R gain per camera 1-8, outside the mobile camera-control app shell.
 *
 * Private repo.
 */

type AudioPair = { left: number; right: number };

const DEFAULT_CAMERA_SLOTS = 16;
const MAX_CAMERA_SLOTS = 32;
const DEFAULT_GAIN = 0.5;
const SEND_INTERVAL_MS = 80;
const API_BASE = "/api/atem-audio-gain";
const DEFAULT_ATEM_ADDRESS = "10.0.0.13";
const ATEM_DEFAULT_PORT = 9910;
const STORAGE_KEY = "bm-audio-gain-levels-v1";
const ATEM_ADDRESS_STORAGE_KEY = "bm-audio-gain-atem-address-v1";

class AudioGainUtilityPage {
  private connected = false;
  private cameraIds = rangeCameraIds(DEFAULT_CAMERA_SLOTS);
  private readonly levels = new Map<number, AudioPair>();
  private readonly sendTimers = new Map<number, number>();
  private statusPollTimer: number | undefined;

  constructor(private readonly root: HTMLElement) {
    this.loadStoredLevels();
    this.render();
    this.bind();
    window.setTimeout(() => void this.bootstrap(), 0);
  }

  private async bootstrap(): Promise<void> {
    await this.refreshLevelsFromServer().catch(() => {});
    if (this.hasNonDefaultLevels()) await this.publishLevelsToServer().catch(() => {});
    await this.connectAtem();
  }

  private render(): void {
    this.root.className = "audio-gain-page";
    this.root.innerHTML = `
      <main class="utility-shell">
        <header class="utility-header">
          <div>
            <div class="utility-eyebrow">Blackmagic ATEM utility</div>
            <h1 class="utility-title">Audio L/R Gain</h1>
          </div>
          <div class="status-pill" data-status-pill data-state="warn" role="status" aria-label="ATEM disconnected">
            <div class="status-label">ATEM</div>
            <div class="status-line"><span class="status-dot"></span><span data-status-text>Disconnected</span></div>
          </div>
        </header>

        <section class="utility-card" aria-label="ATEM connection">
          <div class="direct-connect-row">
            <label class="field">
              <span class="field-label">ATEM IP</span>
              <input data-atem-address />
            </label>
            <div class="button-row">
              <button class="bm-btn" type="button" data-connect-atem>Connect</button>
              <button class="bm-btn" type="button" data-disconnect>Disconnect</button>
              <button class="bm-btn" type="button" data-reset-gains>Reset</button>
            </div>
          </div>
          <p class="hint">Uses the local Node server to open ATEM CCU control. Gains are stored in this browser.</p>
        </section>

        <section class="camera-grid" aria-label="Audio gain per camera">
          ${this.cameraIds.map((cameraId) => this.renderCameraStrip(cameraId)).join("")}
        </section>

        <section class="utility-card">
          <div class="log" data-log aria-live="polite"></div>
        </section>
      </main>
    `;
    const addressInput = this.root.querySelector<HTMLInputElement>("[data-atem-address]");
    if (addressInput) addressInput.value = this.loadStoredAtemAddress();
    this.setControlsEnabled(false);
  }

  private renderCameraStrip(cameraId: number): string {
    return `
      <div class="camera-strip" data-camera="${cameraId}">
        <div class="camera-id">
          <span class="camera-label">Camera</span>
          <span class="camera-number">${cameraId}</span>
        </div>
        ${this.renderGainCell(cameraId, "left", "L")}
        ${this.renderGainCell(cameraId, "right", "R")}
      </div>
    `;
  }

  private renderGainCell(cameraId: number, channel: keyof AudioPair, label: string): string {
    const value = this.levels.get(cameraId)?.[channel] ?? DEFAULT_GAIN;
    return `
      <div class="gain-cell">
        <span class="gain-label">${label}</span>
        <div
          class="bm-mfader gain-fader"
          data-gain-fader
          data-camera-id="${cameraId}"
          data-channel="${channel}"
          data-control
          role="slider"
          tabindex="0"
          aria-valuemin="0"
          aria-valuemax="1"
          aria-valuenow="${value}"
          aria-label="Camera ${cameraId} audio ${label} gain"
        >
          <div class="bm-mfader__track" aria-hidden="true">
            <span class="bm-mfader__fill" data-gain-fader-fill aria-hidden="true"></span>
            <div class="bm-mfader__thumb" data-gain-fader-handle>
              <span class="bm-mfader__cap"></span>
            </div>
          </div>
        </div>
        <span class="gain-value" data-gain-value="${cameraId}-${channel}">${value.toFixed(2)}</span>
        <span class="gain-rx" data-gain-rx="${cameraId}-${channel}">RX --</span>
      </div>
    `;
  }

  private bind(): void {
    this.root.querySelector("[data-connect-atem]")?.addEventListener("click", () => void this.connectAtem());
    this.root.querySelector("[data-disconnect]")?.addEventListener("click", () => this.disconnect());
    this.root.querySelector("[data-reset-gains]")?.addEventListener("click", () => this.resetGains());
    this.root.querySelector<HTMLInputElement>("[data-atem-address]")?.addEventListener("change", (event) => {
      this.storeAtemAddress((event.currentTarget as HTMLInputElement).value);
    });

    this.root.querySelectorAll<HTMLElement>("[data-gain-fader]").forEach((fader) => {
      this.bindGainFader(fader);
    });
  }

  private async connectAtem(): Promise<void> {
    try {
      this.clearLocalConnectionState();
      const atem = this.readAtemConfig();
      this.setStatus(`Connecting ${atem.address}`, true);
      const status = await postJson(`${API_BASE}/connect`, {
        ...atem,
        levels: this.serverLevelsPayload(),
      });
      this.applyServerStatus(status);
      this.startStatusPolling();
    } catch (error) {
      this.disconnect();
      this.log(`Connect failed: ${errorMessage(error)}`);
    }
  }

  private async refreshLevelsFromServer(): Promise<void> {
    const status = await fetch(`${API_BASE}/status`).then((res) => res.json());
    this.syncFadersFromServerLevels(status);
  }

  private async publishLevelsToServer(): Promise<void> {
    const status = await postJson(`${API_BASE}/levels`, { levels: this.serverLevelsPayload() });
    this.syncFadersFromServerLevels(status);
  }

  private serverLevelsPayload(): Record<string, AudioPair> {
    return Object.fromEntries([...this.levels.entries()].map(([cameraId, pair]) => [String(cameraId), pair]));
  }

  private hasNonDefaultLevels(): boolean {
    for (const pair of this.levels.values()) {
      if (pair.left !== DEFAULT_GAIN || pair.right !== DEFAULT_GAIN) return true;
    }
    return false;
  }

  private bindGainFader(fader: HTMLElement): void {
    let dragging = false;
    let pointerId: number | null = null;
    let startClientY = 0;
    let startValue = this.readFaderValue(fader);

    const setFromPointer = (clientY: number, force: boolean): void => {
      const handle = fader.querySelector<HTMLElement>("[data-gain-fader-handle]");
      const track = fader.querySelector<HTMLElement>(".bm-mfader__track");
      const basis = track && track.clientHeight > 0 ? track : fader;
      const verticalRange = basis.clientHeight - (handle?.offsetHeight ?? 0) || 1;
      const next = clamp(startValue - (clientY - startClientY) / verticalRange, 0, 1);
      this.setFaderValue(fader, Number(next.toFixed(3)), force);
    };

    fader.addEventListener("pointerdown", (event) => {
      if (fader.getAttribute("aria-disabled") === "true") return;
      event.preventDefault();
      dragging = true;
      pointerId = event.pointerId;
      startClientY = event.clientY;
      startValue = this.readFaderValue(fader);
      fader.classList.add("dragging");
      fader.setPointerCapture(event.pointerId);
    });

    fader.addEventListener("pointermove", (event) => {
      if (!dragging || pointerId !== event.pointerId) return;
      event.preventDefault();
      setFromPointer(event.clientY, false);
    });

    const stopDrag = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      dragging = false;
      pointerId = null;
      fader.classList.remove("dragging");
      fader.releasePointerCapture(event.pointerId);
      this.setFaderValue(fader, this.readFaderValue(fader), true);
    };

    fader.addEventListener("pointerup", stopDrag);
    fader.addEventListener("pointercancel", stopDrag);
    fader.addEventListener("keydown", (event) => {
      if (fader.getAttribute("aria-disabled") === "true") return;
      const step = event.shiftKey ? 0.01 : 0.05;
      if (event.key === "ArrowUp" || event.key === "ArrowRight") {
        event.preventDefault();
        this.setFaderValue(fader, this.readFaderValue(fader) + step, true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
        event.preventDefault();
        this.setFaderValue(fader, this.readFaderValue(fader) - step, true);
      }
    });

    this.positionFader(fader, this.readFaderValue(fader));
  }

  private readFaderValue(fader: HTMLElement): number {
    const cameraId = Number(fader.dataset.cameraId);
    const channel = fader.dataset.channel === "right" ? "right" : "left";
    const current = this.levels.get(cameraId) ?? { left: DEFAULT_GAIN, right: DEFAULT_GAIN };
    return current[channel];
  }

  private setFaderValue(fader: HTMLElement, rawValue: number, force: boolean): void {
    const cameraId = Number(fader.dataset.cameraId);
    const channel = fader.dataset.channel === "right" ? "right" : "left";
    const value = clamp(rawValue, 0, 1);
    const current = this.levels.get(cameraId) ?? { left: DEFAULT_GAIN, right: DEFAULT_GAIN };
    current[channel] = value;
    this.levels.set(cameraId, current);
    this.storeLevels();
    this.positionFader(fader, value);
    const readout = this.root.querySelector<HTMLElement>(`[data-gain-value="${cameraId}-${channel}"]`);
    if (readout) readout.textContent = value.toFixed(2);
    this.queueSend(cameraId, force);
  }

  private resetGains(): void {
    for (const cameraId of this.cameraIds) {
      this.levels.set(cameraId, { left: DEFAULT_GAIN, right: DEFAULT_GAIN });
      this.updateFaderView(cameraId, "left", DEFAULT_GAIN);
      this.updateFaderView(cameraId, "right", DEFAULT_GAIN);
      if (this.connected) this.sendCamera(cameraId);
    }
    this.storeLevels();
    this.log(this.connected ? "Reset gains to 0.50 and sent to ATEM." : "Reset gains to 0.50.");
  }

  private updateFaderView(cameraId: number, channel: keyof AudioPair, value: number): void {
    const fader = this.root.querySelector<HTMLElement>(`[data-gain-fader][data-camera-id="${cameraId}"][data-channel="${channel}"]`);
    if (fader) this.positionFader(fader, value);
    const readout = this.root.querySelector<HTMLElement>(`[data-gain-value="${cameraId}-${channel}"]`);
    if (readout) readout.textContent = value.toFixed(2);
  }

  private positionFader(fader: HTMLElement, value: number): void {
    const pos = String(clamp(value, 0, 1));
    fader.querySelector<HTMLElement>("[data-gain-fader-fill]")?.style.setProperty("--pos", pos);
    fader.querySelector<HTMLElement>("[data-gain-fader-handle]")?.style.setProperty("--pos", pos);
    fader.setAttribute("aria-valuenow", Number(pos).toFixed(2));
  }

  private queueSend(cameraId: number, force: boolean): void {
    if (force) {
      const timer = this.sendTimers.get(cameraId);
      if (timer !== undefined) window.clearTimeout(timer);
      this.sendTimers.delete(cameraId);
      this.sendCamera(cameraId);
      return;
    }
    if (this.sendTimers.has(cameraId)) return;
    const timer = window.setTimeout(() => {
      this.sendTimers.delete(cameraId);
      this.sendCamera(cameraId);
    }, SEND_INTERVAL_MS);
    this.sendTimers.set(cameraId, timer);
  }

  private sendCamera(cameraId: number): void {
    const pair = this.levels.get(cameraId) ?? { left: DEFAULT_GAIN, right: DEFAULT_GAIN };
    const packet = withDestination(commands.audioInputLevels(pair.left, pair.right), cameraId);
    const hex = toHex(packet).replace(/\s+/g, "");
    try {
      if (!this.connected) {
        this.log("Connect ATEM before sending.");
        return;
      }
      void postJson(`${API_BASE}/forward`, { hex })
        .then((status) => this.applyServerStatus(status))
        .then(() => this.log(`cam ${cameraId}: L ${pair.left.toFixed(2)} R ${pair.right.toFixed(2)}`))
        .catch((error: unknown) => {
          this.applyServerStatus({ connected: false });
          this.log(`Send failed: ${errorMessage(error)}`);
        });
    } catch (error) {
      this.log(`Send failed: ${errorMessage(error)}`);
    }
  }

  private readAtemConfig(): { address: string; port: number } {
    const address = this.root.querySelector<HTMLInputElement>("[data-atem-address]")?.value.trim() ?? "";
    if (!address) throw new Error("ATEM IP required");
    this.storeAtemAddress(address);
    return { address, port: ATEM_DEFAULT_PORT };
  }

  private disconnect(): void {
    this.clearLocalConnectionState();
    void postJson(`${API_BASE}/disconnect`, {}).catch(() => {});
  }

  private clearLocalConnectionState(): void {
    if (this.statusPollTimer !== undefined) {
      window.clearInterval(this.statusPollTimer);
      this.statusPollTimer = undefined;
    }
    for (const timer of this.sendTimers.values()) window.clearTimeout(timer);
    this.sendTimers.clear();
    this.connected = false;
    this.setControlsEnabled(false);
    this.setStatus("Disconnected", false);
  }

  private startStatusPolling(): void {
    if (this.statusPollTimer !== undefined) window.clearInterval(this.statusPollTimer);
    this.statusPollTimer = window.setInterval(() => {
      void fetch(`${API_BASE}/status`)
        .then((res) => res.json())
        .then((status: unknown) => this.applyServerStatus(status))
        .catch(() => {});
    }, 750);
  }

  private setControlsEnabled(enabled: boolean): void {
    this.root.querySelectorAll<HTMLElement>("[data-gain-fader]").forEach((fader) => {
      fader.setAttribute("aria-disabled", enabled ? "false" : "true");
      fader.tabIndex = enabled ? 0 : -1;
    });
  }

  private setStatus(text: string, ready: boolean): void {
    const pill = this.root.querySelector<HTMLElement>("[data-status-pill]");
    const label = this.root.querySelector<HTMLElement>("[data-status-text]");
    if (pill) {
      pill.dataset.state = ready ? "ready" : "warn";
      pill.setAttribute("aria-label", text);
    }
    if (label) label.textContent = text;
  }

  private applyServerStatus(status: unknown): void {
    const connected =
      status !== null &&
      typeof status === "object" &&
      !Array.isArray(status) &&
      Boolean((status as { connected?: unknown }).connected);
    const target =
      status !== null && typeof status === "object" && !Array.isArray(status)
        ? (status as { target?: unknown }).target
        : undefined;
    const address =
      target !== null && typeof target === "object" && !Array.isArray(target)
        ? String((target as { address?: unknown }).address ?? "")
        : "";
    this.applyCameraSlots(status);
    this.connected = connected;
    this.setControlsEnabled(connected);
    this.setStatus(connected ? `ATEM linked ${address}` : "ATEM disconnected", connected);
    this.syncFadersFromServerLevels(status);
    this.updateReceivedReadouts(status);
  }

  private readServerLevelRows(status: unknown, key: "levels" | "received"): Record<string, unknown> | undefined {
    if (status === null || typeof status !== "object" || Array.isArray(status)) return undefined;
    const rows = (status as Record<string, unknown>)[key];
    if (rows === null || typeof rows !== "object" || Array.isArray(rows)) return undefined;
    return rows as Record<string, unknown>;
  }

  private syncFadersFromServerLevels(status: unknown): void {
    const configured = this.readServerLevelRows(status, "levels");
    const received = this.readServerLevelRows(status, "received");
    if (!configured && !received) return;
    let synced = 0;
    for (const cameraId of this.cameraIds) {
      const key = String(cameraId);
      const row = configured?.[key] ?? received?.[key];
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const left = Number((row as { left?: unknown }).left);
      const right = Number((row as { right?: unknown }).right);
      if (!Number.isFinite(left) || !Number.isFinite(right)) continue;
      const pair = { left: clamp(left, 0, 1), right: clamp(right, 0, 1) };
      this.levels.set(cameraId, pair);
      this.updateFaderView(cameraId, "left", pair.left);
      this.updateFaderView(cameraId, "right", pair.right);
      synced += 1;
    }
    if (synced > 0) this.log(`Synced ${synced} camera gain row(s) from server.`);
  }

  private updateReceivedReadouts(status: unknown): void {
    const received = this.readServerLevelRows(status, "received");
    const configured = this.readServerLevelRows(status, "levels");
    for (const cameraId of this.cameraIds) {
      const key = String(cameraId);
      const row = received?.[key] ?? configured?.[key];
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const left = Number((row as { left?: unknown }).left);
      const right = Number((row as { right?: unknown }).right);
      if (Number.isFinite(left)) this.setRxReadout(cameraId, "left", left);
      if (Number.isFinite(right)) this.setRxReadout(cameraId, "right", right);
    }
  }

  private setRxReadout(cameraId: number, channel: keyof AudioPair, value: number): void {
    const el = this.root.querySelector<HTMLElement>(`[data-gain-rx="${cameraId}-${channel}"]`);
    if (el) el.textContent = `RX ${value.toFixed(2)}`;
  }

  private loadStoredLevels(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    } catch {
      parsed = {};
    }

    for (const cameraId of this.cameraIds) {
      const row =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)[String(cameraId)]
          : undefined;
      const left = row !== null && typeof row === "object" && !Array.isArray(row) ? Number((row as AudioPair).left) : NaN;
      const right = row !== null && typeof row === "object" && !Array.isArray(row) ? Number((row as AudioPair).right) : NaN;
      this.levels.set(cameraId, {
        left: Number.isFinite(left) ? clamp(left, 0, 1) : DEFAULT_GAIN,
        right: Number.isFinite(right) ? clamp(right, 0, 1) : DEFAULT_GAIN,
      });
    }
  }

  private storeLevels(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.levels)));
    } catch {
      // Best effort only; private browsing/storage quotas should not block live control.
    }
  }

  private loadStoredAtemAddress(): string {
    return window.localStorage.getItem(ATEM_ADDRESS_STORAGE_KEY)?.trim() || DEFAULT_ATEM_ADDRESS;
  }

  private storeAtemAddress(address: string): void {
    try {
      window.localStorage.setItem(ATEM_ADDRESS_STORAGE_KEY, address.trim());
    } catch {
      // Best effort only; the default address still keeps reload connect useful.
    }
  }

  private applyCameraSlots(status: unknown): void {
    if (status === null || typeof status !== "object" || Array.isArray(status)) return;
    const count = clampCameraSlots(Number((status as { cameraSlots?: unknown }).cameraSlots));
    if (count === this.cameraIds.length) return;
    this.cameraIds = rangeCameraIds(count);
    for (const cameraId of this.cameraIds) {
      if (!this.levels.has(cameraId)) this.levels.set(cameraId, { left: DEFAULT_GAIN, right: DEFAULT_GAIN });
    }
    const grid = this.root.querySelector<HTMLElement>(".camera-grid");
    if (!grid) return;
    grid.innerHTML = this.cameraIds.map((cameraId) => this.renderCameraStrip(cameraId)).join("");
    grid.querySelectorAll<HTMLElement>("[data-gain-fader]").forEach((fader) => {
      this.bindGainFader(fader);
      fader.setAttribute("aria-disabled", this.connected ? "false" : "true");
      fader.tabIndex = this.connected ? 0 : -1;
    });
    this.log(`Detected ${count} CCU slots.`);
  }

  private log(message: string): void {
    const box = this.root.querySelector<HTMLElement>("[data-log]");
    if (!box) return;
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    box.prepend(line);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function clampCameraSlots(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CAMERA_SLOTS;
  return Math.round(clamp(value, 1, MAX_CAMERA_SLOTS));
}

function rangeCameraIds(count: number): number[] {
  return Array.from({ length: clampCameraSlots(count) }, (_, index) => index + 1);
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const message =
      data !== null && typeof data === "object" && !Array.isArray(data) && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

const app = document.querySelector<HTMLElement>("#audio-gain-app");
if (!app) throw new Error("Audio gain app root not found");
new AudioGainUtilityPage(app);
