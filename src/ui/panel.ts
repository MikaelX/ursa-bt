import { deviceNameLooksLikeAtemSwitcher, type CameraSnapshot } from "../blackmagic/cameraState";
import { BANK_COUNT, SCENE_SLOT_COUNT } from "../banks/bank";
import { formatSegSignedFixed2, populateSegSlots } from "./segmentDisplay";

/**
 * @file panel.ts
 *
 * bm-bluetooth — Static HTML template for the multi-tab control surface, view routing (`VIEW_IDS`), iOS WebBluetooth helpers,
 * fader/iris/paint geometry, and {@link updatePanel} diffing that mirrors {@link CameraSnapshot} into the DOM.
 *
 * Kept colocated with `src/styles.css` / `patterns/*`. **Private** repo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Paint / camera constants & micro-templates
// ─────────────────────────────────────────────────────────────────────────────

export const CAMERA_COUNT = 8;
export const PAINT_CHANNELS = ["red", "green", "blue", "luma"] as const;
export type PaintChannel = (typeof PAINT_CHANNELS)[number];
export const PAINT_GROUPS = ["lift", "gamma", "gain"] as const;
export type PaintGroup = (typeof PAINT_GROUPS)[number];

export const COLOR_GROUP_RANGES: Record<PaintGroup, { min: number; max: number; default: number }> = {
  lift: { min: -2, max: 2, default: 0 },
  gamma: { min: -4, max: 4, default: 0 },
  gain: { min: 0, max: 16, default: 0 },
};

function renderSegReadout(
  readoutKey: string,
  classes: string,
  attrs = "",
  outer: "div" | "span" = "div",
): string {
  return `
    <${outer} class="bm-seg2 app-bm-seg-readout ${classes}" data-readout="${readoutKey}" data-seg-display ${attrs}>
      <${outer} class="bm-seg2__display" data-seg-slots></${outer}>
    </${outer}>
  `.replace(/\s*\n\s*/g, "\n").trim();
}

function formatScale(value: number): string {
  if (Number.isInteger(value)) return value > 0 ? `+${value}` : `${value}`;
  const fixed = value.toFixed(1);
  return value > 0 ? `+${fixed}` : fixed;
}

function renderAudioFader(dataAttr: string, readoutKey: string, label: string): string {
  return `
    <div class="audio-fader-cell">
      <span class="audio-fader-readout" data-readout="${readoutKey}">0.50</span>
      <div
        class="bm-mfader app-bm-mfader"
        data-mini-fader="${dataAttr}"
        data-control
        aria-label="${label}"
      >
        <div class="bm-mfader__track" aria-hidden="true">
          <span class="bm-mfader__fill" data-mini-fader-fill aria-hidden="true"></span>
          <div class="bm-mfader__thumb" data-mini-fader-handle>
            <span class="bm-mfader__cap"></span>
          </div>
        </div>
      </div>
      <span class="audio-fader-label">${label}</span>
    </div>
  `;
}

function renderStepper(stepperId: string, label: string, readoutKey: string, _defaultText: string): string {
  return `
    <div class="stepper-cell" data-stepper="${stepperId}">
      ${renderSegReadout(readoutKey, "stepper-segment bm-seg--green")}
      <div class="stepper-buttons">
        <button class="bm-stepper__btn stepper-btn" type="button" data-stepper-up="${stepperId}" data-control aria-label="${label} up">
          <svg class="bm-stepper__glyph" viewBox="0 0 16 16" aria-hidden="true"><polygon points="8,3 14,12 2,12"/></svg>
        </button>
        <button class="bm-stepper__btn stepper-btn" type="button" data-stepper-down="${stepperId}" data-control aria-label="${label} down">
          <svg class="bm-stepper__glyph" viewBox="0 0 16 16" aria-hidden="true"><polygon points="2,4 14,4 8,13"/></svg>
        </button>
      </div>
      <span class="stepper-label">${label}</span>
    </div>
  `;
}

/** URSA Broadcast ND: dial 1 = CLR, 2 / 3 / 4 on body; same BLE stop ladder 0, 1, 2, 4. */
export const ND_URSA_STEPS = [
  { label: "CLR", stops: 0 },
  { label: "2", stops: 1 },
  { label: "3", stops: 2 },
  { label: "4", stops: 4 },
] as const;

const ND_URSA_TOL = 0.11;

export function stepNdUrsa(current: number | undefined, direction: 1 | -1): number {
  const cur = current ?? 0;
  let idx = ND_URSA_STEPS.findIndex((s) => Math.abs(s.stops - cur) <= ND_URSA_TOL);
  if (idx === -1) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < ND_URSA_STEPS.length; i++) {
      const d = Math.abs(ND_URSA_STEPS[i]!.stops - cur);
      if (d < bestD || (d === bestD && ND_URSA_STEPS[i]!.stops < ND_URSA_STEPS[best]!.stops)) {
        bestD = d;
        best = i;
      }
    }
    idx = best;
  }
  idx = Math.max(0, Math.min(ND_URSA_STEPS.length - 1, idx + direction));
  return ND_URSA_STEPS[idx]!.stops;
}

function renderColorGroup(group: PaintGroup, label: string, min: number, max: number, defaultValue: number): string {
  const channels: { key: PaintChannel; tone: string }[] = [
    { key: "red", tone: "R" },
    { key: "green", tone: "G" },
    { key: "blue", tone: "B" },
    { key: "luma", tone: "Y" },
  ];

  return `
    <div class="color-group color-group-vertical" data-color-group="${group}">
      <div class="color-group-header">${label}</div>
      <div class="color-group-columns">
        ${channels
          .map(
            (channel) => `
              <div class="color-column" data-color-input data-group="${group}" data-channel="${channel.key}">
                <span class="bm-seg2 app-bm-seg-readout paint-value-seg bm-seg--green color-column-seg" data-color-readout data-seg-display>
                  <span class="bm-seg2__display" data-seg-slots></span>
                </span>
                <div
                  class="mini-fader bm-mfader color-vfader app-bm-mini-fader"
                  data-control
                  data-vfader="color-${group}-${channel.key}"
                  data-min="${min}"
                  data-max="${max}"
                  data-default="${defaultValue}"
                  aria-label="${label} ${channel.tone}"
                  role="slider"
                  aria-valuemin="${min}"
                  aria-valuemax="${max}"
                  aria-valuenow="${defaultValue}"
                  tabindex="0"
                >
                  <div class="mini-fader-scale">
                    <span>${formatScale(max)}</span><span></span><span></span><span>${formatScale(defaultValue)}</span><span></span><span></span><span>${formatScale(min)}</span>
                  </div>
                  <div class="bm-mfader__track">
                    <span class="bm-mfader__fill" data-vfader-fill aria-hidden="true"></span>
                    <div class="bm-mfader__thumb" data-vfader-handle>
                      <span class="bm-mfader__cap"></span>
                    </div>
                  </div>
                </div>
                <span class="color-tone color-tone-${channel.key}">${channel.tone}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderColorHFader(
  attr: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
  readoutKey: string,
): string {
  return `
    <div class="color-extras-row">
      <span class="color-extras-label">${label}</span>
      <div class="color-extras-fader-wrap">
        <div class="h-fader color-hfader app-bm-hfader-inline" data-control>
          <div class="h-fader-scale">
            <span>${formatScale(min)}</span><span></span><span></span><span>${formatScale(defaultValue)}</span><span></span><span></span><span>${formatScale(max)}</span>
          </div>
          <div
            class="bm-fader__channel color-hfader__channel"
            data-hfader="${attr}"
            data-min="${min}"
            data-max="${max}"
            data-default="${defaultValue}"
            aria-label="${label}"
            role="slider"
            aria-valuemin="${min}"
            aria-valuemax="${max}"
            aria-valuenow="${defaultValue}"
            tabindex="0"
          >
            <div class="bm-fader__track">
              <span class="bm-fader__meter" aria-hidden="true" style="--meter:0"></span>
              <span class="bm-fader__ticks" aria-hidden="true"></span>
            </div>
            <div class="bm-fader__thumb" data-hfader-handle>
              <span class="bm-fader__cap"></span>
            </div>
          </div>
        </div>
        <span class="bm-seg2 app-bm-seg-readout paint-value-seg bm-seg--green color-extras-seg" data-readout="${readoutKey}" data-seg-display>
          <span class="bm-seg2__display" data-seg-slots></span>
        </span>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// iOS Web Bluetooth affordances (Bluefy + onboarding modals)
// ─────────────────────────────────────────────────────────────────────────────

/** App Store — Bluefy (Web Bluetooth browser for iOS). */
export const BLUEFY_APP_STORE_URL = "https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055";

const BLUEFY_MODAL_DISMISS_KEY = "bm-bluefy-offer-dismissed";

/** True when running on iPhone / iPad / iPod (including iPadOS desktop UA quirks). */
export function isIosLikeWebBluetoothBlocked(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return false;
}

const bluefyModalCloseRef: { current?: () => void } = { current: undefined };

function wireBluefyOfferBackdropOnce(backdrop: HTMLElement): void {
  if (backdrop.dataset.bluefyWired === "1") return;
  backdrop.dataset.bluefyWired = "1";
  const requestClose = (): void => {
    bluefyModalCloseRef.current?.();
  };
  backdrop.querySelector("[data-bluefy-dismiss]")?.addEventListener("click", requestClose);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) requestClose();
  });
}

/** Open the Bluefy install / Web Bluetooth help dialog (iOS-like browsers). */
export function showBluefyOfferModal(root: HTMLElement): void {
  const backdrop = root.querySelector<HTMLElement>("[data-bluefy-modal-root]");
  if (!backdrop) return;
  wireBluefyOfferBackdropOnce(backdrop);
  bluefyModalCloseRef.current?.();

  let onKeyDown: ((e: KeyboardEvent) => void) | undefined;
  const close = (): void => {
    backdrop.hidden = true;
    document.body.classList.remove("bluefy-modal-open");
    if (typeof sessionStorage !== "undefined") {
      try {
        sessionStorage.setItem(BLUEFY_MODAL_DISMISS_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
    bluefyModalCloseRef.current = undefined;
  };

  bluefyModalCloseRef.current = close;
  backdrop.hidden = false;
  document.body.classList.add("bluefy-modal-open");
  onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKeyDown);
}

/** Auto-open Bluefy prompt once per session on first load (iOS + no Web Bluetooth). */
export function initBluefyOfferModal(root: HTMLElement): void {
  const backdrop = root.querySelector<HTMLElement>("[data-bluefy-modal-root]");
  if (!backdrop) return;
  if (typeof sessionStorage !== "undefined") {
    try {
      if (sessionStorage.getItem(BLUEFY_MODAL_DISMISS_KEY) === "1") return;
    } catch {
      /* ignore (e.g. private mode) */
    }
  }
  showBluefyOfferModal(root);
}

const genericBleHelpCloseRef: { current?: () => void } = { current: undefined };

function wireGenericWebBleHelpBackdropOnce(backdrop: HTMLElement): void {
  if (backdrop.dataset.genericBleHelpWired === "1") return;
  backdrop.dataset.genericBleHelpWired = "1";
  const requestClose = (): void => {
    genericBleHelpCloseRef.current?.();
  };
  backdrop.querySelector("[data-web-ble-generic-dismiss]")?.addEventListener("click", requestClose);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) requestClose();
  });
}

/** Open plain-language Web Bluetooth help (non–iOS-like browsers without BLE). */
export function showGenericWebBleHelpModal(root: HTMLElement): void {
  const backdrop = root.querySelector<HTMLElement>("[data-web-ble-generic-modal-root]");
  if (!backdrop) return;
  wireGenericWebBleHelpBackdropOnce(backdrop);
  genericBleHelpCloseRef.current?.();

  const bodyEl = backdrop.querySelector("[data-web-ble-generic-body]");
  if (bodyEl) bodyEl.textContent = webBluetoothUnsupportedDetail();

  let onKeyDown: ((e: KeyboardEvent) => void) | undefined;
  const close = (): void => {
    backdrop.hidden = true;
    if (onKeyDown) document.removeEventListener("keydown", onKeyDown);
    genericBleHelpCloseRef.current = undefined;
  };

  genericBleHelpCloseRef.current = close;
  backdrop.hidden = false;
  onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKeyDown);
}

function renderGenericWebBleHelpModal(): string {
  return `
    <div class="relay-modal-backdrop" data-web-ble-generic-modal-root hidden>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="web-ble-generic-title"
        class="relay-modal"
      >
        <h2 id="web-ble-generic-title" class="relay-modal-title">Web Bluetooth unavailable</h2>
        <p class="relay-modal-body" data-web-ble-generic-body></p>
        <div class="relay-modal-actions">
          <button type="button" class="bm-btn connect-primary" data-web-ble-generic-dismiss data-control>
            OK
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderBluefyOfferModal(): string {
  return `
    <div class="bluefy-modal-backdrop" data-bluefy-modal-root hidden>
      <div
        class="bluefy-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bluefy-modal-title"
      >
        <h2 id="bluefy-modal-title" class="bluefy-modal-title">Use Web Bluetooth on this device</h2>
        <p class="bluefy-modal-body">
          This browser cannot use Bluetooth from websites. <strong>Bluefy</strong> is a free app that adds Web Bluetooth—open this same page there after installing.
        </p>
        <p class="bluefy-modal-hint">Your site must be served over HTTPS (required for Web Bluetooth in Bluefy).</p>
        <div class="bluefy-modal-actions">
          <a
            class="bluefy-modal-store"
            href="${BLUEFY_APP_STORE_URL}"
            target="_blank"
            rel="noopener noreferrer"
          >Get Bluefy on the App Store</a>
          <button type="button" class="bm-btn bluefy-modal-dismiss" data-bluefy-dismiss>Not now</button>
        </div>
      </div>
    </div>
  `;
}

/** Plain-language hint when `navigator.bluetooth` is missing (shown under the main support line). */
export function webBluetoothUnsupportedDetail(): string {
  if (typeof navigator === "undefined") {
    return "Use Chrome or Edge on a computer or Android device with Bluetooth.";
  }
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return "On iPhone and iPad, Safari and Chrome cannot use Web Bluetooth. Use the free Bluefy browser from the App Store, or Android with Chrome / a desktop browser.";
  }
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) {
    return "On iPadOS, websites cannot use Web Bluetooth in Safari or Chrome. Use Bluefy from the App Store, or Android with Chrome / a desktop browser.";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "Web Bluetooth only works on a secure origin. Open this app over HTTPS or http://localhost.";
  }
  return "Use Google Chrome or Microsoft Edge on Windows, macOS, or Android with Bluetooth. Firefox and most non-Chromium browsers do not support Web Bluetooth.";
}

// ---------------------------------------------------------------------------
// View navigation — split the panel into self-contained mobile-first views.
// ---------------------------------------------------------------------------

export const VIEW_IDS = ["connect", "settings", "audio", "iris", "video", "color", "debug"] as const;
export type ViewId = (typeof VIEW_IDS)[number];

/** Views where the persistent scene file bar is visible above the bottom nav. */
export const SCENE_BAR_VIEWS: ReadonlySet<ViewId> = new Set<ViewId>(["settings"]);

const VIEW_LABELS: Record<ViewId, string> = {
  connect: "Connect",
  settings: "Exposure",
  iris: "Iris",
  audio: "Audio",
  video: "Video",
  color: "Color",
  debug: "Debug",
};

/**
 * Compact mono SVG glyphs that read as machined panel labels rather than
 * decorative emoji. Each inherits text color and stays crisp at any DPR.
 */
const VIEW_ICONS: Record<ViewId, string> = {
  connect: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.5v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.6 4.4a4.6 4.6 0 1 0 6.8 0" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  settings: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 4h6M11 4h3M2 8h3M8 8h6M2 12h8M13 12h1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="9.5" cy="4" r="1.6" fill="currentColor"/><circle cx="6.5" cy="8" r="1.6" fill="currentColor"/><circle cx="11.5" cy="12" r="1.6" fill="currentColor"/></svg>`,
  iris: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/><path d="M8 2.2 11 8 8 13.8 5 8z" fill="none" stroke="currentColor" stroke-width="1"/></svg>`,
  audio: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 6h2.5L9 3v10L5.5 10H3z" fill="currentColor"/><path d="M11 5.4c1 .8 1 4.4 0 5.2M12.6 4c1.6 1.4 1.6 6.6 0 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  video: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="4" width="9" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m11 7 3-1.6v5.2L11 9z" fill="currentColor"/></svg>`,
  color: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="5" r="2" fill="#ff6b66"/><circle cx="5.5" cy="9.5" r="2" fill="#76e26a"/><circle cx="10.5" cy="9.5" r="2" fill="#5ea4ff" fill-opacity="0.85"/></svg>`,
  debug: `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.5 6h0M4.5 8.5h0M7 8.5h5M7 11h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="4.5" cy="6" r="0.7" fill="currentColor"/></svg>`,
};

/**
 * Legacy data attributes wired onto the corresponding nav tab so older
 * code paths and tests that reach for `[data-video-toggle]` /
 * `[data-audio-toggle]` continue to find a clickable element.
 */
const VIEW_LEGACY_ALIAS: Partial<Record<ViewId, string>> = {
  video: "data-video-toggle",
  audio: "data-audio-toggle",
};

function renderViewNav(): string {
  return `
    <div class="view-nav-shell">
      <div class="view-nav-accent" aria-hidden="true">
        <svg class="view-nav-accent__svg" viewBox="0 0 400 28" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="navAccentHalo" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="400" y2="0">
              <stop offset="0%" stop-color="#283038" stop-opacity="0"/>
              <stop offset="38%" stop-color="#ffd070" stop-opacity="0.35"/>
              <stop offset="50%" stop-color="#fff2cf" stop-opacity="0.62"/>
              <stop offset="62%" stop-color="#ffd070" stop-opacity="0.35"/>
              <stop offset="100%" stop-color="#283038" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="navAccentStroke" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="400" y2="0">
              <stop offset="0%" stop-color="#2f3540"/>
              <stop offset="40%" stop-color="#c4974e"/>
              <stop offset="50%" stop-color="#ffe9bc"/>
              <stop offset="60%" stop-color="#c4974e"/>
              <stop offset="100%" stop-color="#2f3540"/>
            </linearGradient>
          </defs>
          <path d="M0 21 Q 96 17 200 10 Q 304 17 400 21" fill="none" stroke="url(#navAccentHalo)" stroke-width="11" stroke-linecap="round"/>
          <path d="M0 20.5 Q 100 15 200 9 Q 300 15 400 20.5" fill="none" stroke="url(#navAccentStroke)" stroke-width="2.15" stroke-linecap="round"/>
        </svg>
      </div>
      <nav class="view-nav" role="tablist" aria-label="Camera control sections" data-view-nav>
      ${VIEW_IDS.map((id, idx) => {
        const alias = VIEW_LEGACY_ALIAS[id] ? ` ${VIEW_LEGACY_ALIAS[id]}` : "";
        return `
          <button
            class="view-nav-tab${idx === 0 ? " is-active" : ""}"
            type="button"
            role="tab"
            id="tab-${id}"
            data-view-switch="${id}"${alias}
            aria-controls="view-${id}"
            aria-selected="${idx === 0 ? "true" : "false"}"
            tabindex="${idx === 0 ? "0" : "-1"}"
          >
            <span class="view-nav-icon">${VIEW_ICONS[id]}</span>
            <span class="view-nav-label">${VIEW_LABELS[id]}</span>
          </button>
        `;
      }).join("")}
      </nav>
    </div>
  `;
}

function renderAppHeader(bleAvailable: boolean): string {
  return `
    <header class="app-header" data-app-header>
      <div class="app-header-brand">
        <span class="app-header-eyebrow">BM Camera</span>
        <div class="app-header-live">
          <span class="app-header-camera-product app-header-camera-badge" data-camera-product hidden aria-label="Camera model"></span>
          <p data-connection class="app-header-pill app-header-connection-meta">Disconnected</p>
        </div>
      </div>
      <div class="app-header-meta">
        <span class="app-header-cam" data-cam-badge aria-label="Selected camera" role="status">
          <span class="app-header-cam-label">CAM</span>
          <span class="app-header-cam-digit" data-cam-badge-digit>—</span>
        </span>
        <div class="app-header-leds" aria-label="Connection status">
          <span class="footer-led" data-led="connected">NET</span>
          <span class="footer-led" data-led="paired">PAIR</span>
          <span class="footer-led" data-led="recording">REC</span>
        </div>
        <button class="bm-btn app-header-panel-active footer-btn" type="button" data-panel-active data-control aria-pressed="true" title="Panel Active — when off, controls are muted">
          <span class="footer-btn-label">PANEL</span>
        </button>
      </div>
      ${
        bleAvailable
          ? ""
          : `<p data-support-detail class="warn support-detail app-header-support">${webBluetoothUnsupportedDetail()}</p>`
      }
    </header>
  `;
}

function renderConnectView(bleAvailable: boolean, bleUi?: PanelBleUiOptions): string {
  const atemLan =
    bleUi?.showAtemLanConnect === true
      ? `
      <div class="card connect-atem-card" data-atem-ccu-lan-card>
        <div class="connect-atem-head">
          <p class="eyebrow connect-atem-eyebrow">ATEM mixer</p>
          <h2 class="connect-atem-title">LAN camera control</h2>
        </div>
        <p class="muted connect-atem-hint">
          Hub must reach the switcher on your LAN (e.g. <code class="connect-atem-code">npm run dev:server</code>). A relay session is opened automatically; CCU debug lines (<code class="connect-atem-code">[ccu h]</code>) appear in the log below once data flows.
        </p>
        <div class="connect-atem-row">
          <label class="connect-atem-inline-field connect-atem-inline-field--address">
            <span class="connect-atem-inline-label">Address</span>
            <input
              type="text"
              data-atem-ccu-ip
              autocomplete="off"
              placeholder="192.168.1.199"
              enterkeyhint="go"
            />
          </label>
          <label class="connect-atem-inline-field connect-atem-inline-field--camera">
            <span class="connect-atem-inline-label">Camera</span>
            <input
              type="number"
              data-atem-ccu-camera
              min="1"
              max="24"
              step="1"
            />
          </label>
          <button type="button" class="bm-btn connect-primary connect-atem-connect-btn" data-atem-ccu-lan-connect data-control>
            Connect
          </button>
        </div>
        <p class="muted connect-atem-status" data-atem-ccu-lan-status hidden></p>
      </div>
    `
      : "";

  return `
    <section class="view view--connect" data-view="connect" id="view-connect" role="tabpanel" aria-labelledby="tab-connect">
      <div class="card connect-card">
        <div class="connect-status">
          <p class="eyebrow">Camera link</p>
          <h2 class="connect-status-title">${bleAvailable ? "Pair a Blackmagic camera" : "Bluetooth unavailable"}</h2>
        </div>
        <div class="connection-controls connect-controls">
          <div class="connect-button-row">
            <button class="bm-btn connect-primary" type="button" data-connect-toggle>
              Connect
            </button>
            <button class="bm-btn" type="button" data-relay-join-toggle>Join</button>
            <button class="bm-btn" type="button" data-relay-share-toggle data-control>Share</button>
            <button class="bm-btn power-btn" type="button" data-power data-control aria-pressed="false">
              <span class="power-led"></span>
              <span data-power-label>Power On</span>
            </button>
          </div>
          <div class="last-ble-row" data-last-ble-row hidden>
            <button type="button" class="bm-btn last-ble-reconnect-btn" data-last-ble-reconnect data-control>
              Last camera
            </button>
          </div>
          <label class="auto-reconnect-toggle">
            <input data-auto-reconnect type="checkbox" checked />
            Auto-reconnect (BLE: every 20s to last device after a drop; relay join drop/reload; off after manual Disconnect)
          </label>
          <p class="connect-relay-hint">
            Connect pairs over Bluetooth; Join opens remote sessions when you are not the BLE host. The same hub buttons switch to Disconnect, Leave, or Stop sharing when active.
          </p>
          <div class="relay-sessions-inline" data-relay-sessions-inline hidden>
            <h3 class="relay-sessions-inline-title">Hosted sessions</h3>
            <ul class="relay-session-list relay-session-list--inline" data-relay-session-list-inline aria-live="polite"></ul>
            <p class="relay-session-empty muted" data-relay-inline-empty hidden></p>
            <div class="native-ble-found-inline" data-native-ble-found hidden>
              <h3 class="relay-sessions-inline-title native-ble-found-title">Found devices</h3>
              <p class="native-ble-found-hint muted">
                Only Blackmagic cameras (by advertised name or camera-control service) appear here; tap to connect. Entries marked “on this phone” are already linked via Bluetooth.
                Use Connect for the system picker if yours does not advertise in a way we can detect.
              </p>
              <button class="bm-btn native-ble-rescan-btn" type="button" data-native-ble-rescan>Rescan</button>
              <ul class="relay-session-list relay-session-list--inline" data-native-ble-found-list aria-live="polite"></ul>
              <p class="relay-session-empty muted" data-native-ble-found-empty hidden>Scanning for Blackmagic cameras…</p>
            </div>
          </div>
        </div>
      </div>
      ${atemLan}

      <div class="card connect-camera-picker" data-connect-camera-id-card hidden>
        <div class="card-header">
          <h2>Camera ID</h2>
          <span class="readout-label">Slate &amp; destination</span>
        </div>
        <div class="camera-pillar camera-pillar--picker" data-camera-pillar role="listbox" aria-label="Select camera">
          ${Array.from({ length: CAMERA_COUNT }, (_, index) => {
            const id = index + 1;
            return `
              <button
                class="cam-led"
                data-camera-led
                data-camera-id="${id}"
                data-control
                role="option"
                aria-label="Camera ${id}"
              >
                <span class="cam-led-digit">${id}</span>
              </button>
            `;
          }).join("")}
          <span class="iris-label">CAMERA</span>
        </div>
        <p class="connect-camera-hint">Tap a number to set the broadcast ID and command destination. Stored automatically.</p>
      </div>
    </section>
  `;
}

function renderSettingsView(): string {
  return `
    <section class="view view--settings" data-view="settings" id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
      <div class="chassis chassis--single settings-chassis">
        <div class="settings-stage">
          <div class="chassis-row stepper-row settings-steppers" aria-label="Exposure and colour steppers">
            ${renderStepper("wb", "White Bal", "wb", "5600")}
            ${renderStepper("tint", "Tint", "tint", "0")}
            ${renderStepper("gain", "Master Gain", "gain", "0.0")}
            ${renderStepper("iso", "ISO", "iso", "----")}
            ${renderStepper("shutter", "Shutter", "shutter", "0180")}
            ${renderStepper("nd", "ND", "nd", "CLR")}
          </div>
          <div class="settings-buttons" role="group" aria-label="Auto exposure and program keys">
            <div class="stepper-cell auto-exp-cell">
              <button class="bm-btn auto-exp-btn" type="button" data-auto-exp data-control aria-pressed="false" title="Cycle: Manual → Iris → Shutter → Iris+Shutter → Shutter+Iris">
                <span class="auto-exp-led"></span>
                ${renderSegReadout("autoexp", "auto-exp-seg bm-seg--green", 'role="status"', "span")}
              </button>
              <span class="stepper-label">Auto Exp</span>
            </div>
            <div class="stepper-cell unit-btn-cell">
              <div class="unit-btn-head">
                <span class="unit-btn-led" data-wb-led aria-hidden="true"></span>
                <span class="unit-btn-indicator">ABS</span>
              </div>
              <button class="bm-btn unit-btn" type="button" data-video-set-auto-wb data-control aria-label="Set auto white balance">W/B</button>
              <span class="stepper-label">White Bal</span>
            </div>
            <div class="stepper-cell unit-btn-cell">
              <div class="unit-btn-head">
                <span class="unit-btn-led" data-bars-led aria-hidden="true"></span>
                <span class="unit-btn-indicator">BARS</span>
              </div>
              <button
                class="bm-btn unit-btn"
                type="button"
                data-color-bars
                data-control
                aria-label="Color bars — hold 1s to enable, tap to disable"
              >BARS</button>
              <span class="stepper-label">Color Bars</span>
            </div>
            <div class="stepper-cell unit-btn-cell">
              <div class="unit-btn-head">
                <span class="unit-btn-led" data-program-return-led aria-hidden="true"></span>
                <span class="unit-btn-indicator">RTN</span>
              </div>
              <button
                class="bm-btn unit-btn"
                type="button"
                data-program-return-feed
                data-control
                aria-label="Program return feed — hold 3s to show program on monitor, tap when lit to turn off"
              >RTN</button>
              <span class="stepper-label">Pgm Return</span>
            </div>
          </div>
        </div>
        <p class="settings-version muted" data-settings-version role="note"></p>
      </div>
    </section>
  `;
}

function renderIrisView(): string {
  return `
    <section class="view view--iris" data-view="iris" id="view-iris" role="tabpanel" aria-labelledby="tab-iris" hidden>
      <div class="iris-stage">
        <div class="iris-status">
          <div class="iris-status-main">
            ${renderSegReadout("iris", "iris-status-fstop bm-seg--green", 'role="status"')}
            <span class="readout-label">IRIS</span>
          </div>
          <div class="iris-status-tally">
            <span class="tally-dot tally-pgm" data-tally="program">PGM</span>
            <span class="tally-dot tally-pvw" data-tally="preview">PVW</span>
            <span class="readout-label iris-status-tally-label">TALLY</span>
          </div>
        </div>

        <div class="iris-stage-accent" aria-hidden="true">
          <svg class="iris-stage-accent__svg" viewBox="0 0 400 26" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="irisAccentLine" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="400" y2="0">
                <stop offset="0%" stop-color="#323841"/>
                <stop offset="38%" stop-color="#d4a556"/>
                <stop offset="50%" stop-color="#ffe8b8"/>
                <stop offset="62%" stop-color="#d4a556"/>
                <stop offset="100%" stop-color="#323841"/>
              </linearGradient>
              <linearGradient id="irisAccentHalo" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="400" y2="0">
                <stop offset="0%" stop-color="#283038" stop-opacity="0"/>
                <stop offset="40%" stop-color="#ffd070" stop-opacity="0.45"/>
                <stop offset="50%" stop-color="#fff6dc" stop-opacity="0.75"/>
                <stop offset="60%" stop-color="#ffd070" stop-opacity="0.45"/>
                <stop offset="100%" stop-color="#283038" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path
              d="M0 19 Q 96 13 200 9 Q 304 13 400 19"
              fill="none"
              stroke="url(#irisAccentHalo)"
              stroke-width="10"
              stroke-linecap="round"
            />
            <path
              d="M0 18.5 Q 100 11.5 200 8 Q 300 11.5 400 18.5"
              fill="none"
              stroke="url(#irisAccentLine)"
              stroke-width="2.25"
              stroke-linecap="round"
            />
          </svg>
        </div>

        <div class="iris-stage-grid">
          <div class="iris-side-column iris-side-column--left">
            <div class="iris-side-buttons iris-side-buttons--left">
              <button class="bm-btn side-btn" type="button" data-iris-mb-active data-control>IRIS/MB<br />ACTIVE</button>
              <button class="bm-btn side-btn" type="button" data-auto-aperture data-control>AUTO<br />IRIS</button>
              <button class="bm-btn side-btn" type="button" data-autofocus data-control>AUTO<br />FOCUS</button>
              <button
                class="bm-btn bm-btn--call side-btn"
                type="button"
                data-record-start
                data-control
                aria-pressed="false"
                aria-label="Start recording"
              >
                REC
              </button>
            </div>

            <div class="iris-focus-cell iris-side-lens-cell" data-iris-focus-cell data-active="false">
              <div class="iris-focus-head">
                <span class="iris-focus-title">FOCUS</span>
                <button
                  class="bm-btn iris-focus-toggle"
                  type="button"
                  data-iris-focus-toggle
                  aria-pressed="false"
                  aria-label="Toggle focus control active"
                >
                  <span class="iris-focus-toggle-led"></span>
                  <span>ACTIVE</span>
                </button>
                ${renderSegReadout("focus", "iris-focus-readout bm-seg--green", 'role="status"')}
              </div>
              <div class="h-fader iris-focus-fader app-bm-hfader-inline" data-control aria-label="Focus (horizontal drag)" style="--thumb-w:22px;--thumb-h:12px;--track-h:5px;">
                <div class="h-fader-scale">
                  <span>NEAR</span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span>FAR</span>
                </div>
                <div class="bm-fader__channel iris-focus-fader__channel" data-h-fader="focus">
                  <div class="bm-fader__track">
                    <span class="bm-fader__meter" aria-hidden="true" style="--meter:0"></span>
                    <span class="bm-fader__ticks" aria-hidden="true"></span>
                  </div>
                  <div class="bm-fader__thumb" data-h-fader-handle>
                    <span class="bm-fader__cap"></span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="iris-primary">
            <div class="bm-tbar app-bm-iris-tbar iris-joystick iris-joystick--xl" data-iris-joystick data-control aria-label="Iris (vertical drag)">
              <div class="bm-tbar__shaft" aria-hidden="true">
                <span class="bm-tbar__ticks bm-tbar__ticks--left"></span>
                <span class="bm-tbar__ticks bm-tbar__ticks--right"></span>
                <span class="bm-tbar__ladder"></span>
                <span class="bm-tbar__slot"></span>
                <div class="iris-joystick-scale app-bm-iris-tbar-scale">
                  <span>OPEN</span>
                  <span>8.0</span>
                  <span>11</span>
                  <span>16</span>
                  <span>22</span>
                  <span>CLS</span>
                </div>
              </div>
              <div
                class="bm-tbar__handle"
                data-iris-joystick-handle
                role="slider"
                tabindex="0"
                aria-valuemin="0"
                aria-valuemax="1"
                aria-orientation="vertical"
                aria-label="Iris"
                aria-valuenow="50"
              >
                <span class="bm-tbar__cap"></span>
                <span class="bm-tbar__bar"></span>
              </div>
            </div>
            <span class="iris-label">IRIS</span>
          </div>

          <div class="iris-side-column iris-side-column--right">
            <div class="iris-side-buttons iris-side-buttons--right">
              <button class="bm-btn side-btn" type="button" data-record-stop data-control>STOP</button>
              <button class="bm-btn side-btn" type="button" data-still-capture data-control>STILL</button>
              <button class="bm-btn side-btn" type="button" data-preview data-control>PREVIEW</button>
              <button class="bm-btn side-btn" type="button" data-call data-control>CALL</button>
            </div>

            <div class="iris-zoom-cell iris-side-lens-cell" data-control>
              <div class="iris-zoom-head">
                <span class="iris-zoom-title">ZOOM</span>
                ${renderSegReadout("zoom", "iris-zoom-readout bm-seg--green", 'role="status"')}
              </div>
              <div class="h-fader iris-zoom-fader app-bm-hfader-inline" aria-label="Zoom (horizontal drag)" style="--thumb-w:22px;--thumb-h:12px;--track-h:5px;">
                <div class="h-fader-scale">
                  <span>WIDE</span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span>TIGHT</span>
                </div>
                <div class="bm-fader__channel iris-zoom-fader__channel" data-h-fader="zoom">
                  <div class="bm-fader__track">
                    <span class="bm-fader__meter" aria-hidden="true" style="--meter:0"></span>
                    <span class="bm-fader__ticks" aria-hidden="true"></span>
                  </div>
                  <div class="bm-fader__thumb" data-h-fader-handle>
                    <span class="bm-fader__cap"></span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="iris-secondary">
          <div class="knob-cell iris-mb-cell" data-iris-mb-cell">
            <div class="iris-mb-bm-pot bm-pot">
              <div
                class="bm-pot__knob iris-mb-knob"
                data-iris-wheel
                data-control
                role="slider"
                aria-label="Master black"
                aria-valuemin="-2"
                aria-valuemax="2"
                aria-valuenow="0"
                tabindex="0"
                style="--angle: 0deg;"
              >
                <span class="bm-pot__indicator" aria-hidden="true"></span>
              </div>
            </div>
            <div class="knob-meta">
              <span class="knob-label">Master Black</span>
              <span class="knob-value" data-readout="masterBlackReadout">+0.00</span>
            </div>
          </div>
        </div>

        <div class="iris-info-strip" aria-label="Camera info">
          <span><em>FORMAT</em><b data-readout="format">---</b></span>
          <span><em>CODEC</em><b data-readout="codec">---</b></span>
          <span data-nd-readout-wrap><em>ND</em><b data-readout="ndReadout">--</b></span>
          <span><em>TINT</em><b data-readout="tintReadout">0</b></span>
        </div>
      </div>
    </section>
  `;
}

function renderAudioView(): string {
  return `
    <section class="view view--audio" data-view="audio" id="view-audio" role="tabpanel" aria-labelledby="tab-audio" hidden>
      <section class="card audio-card" data-audio-card id="audio-card">
        <div class="card-header">
          <h2>Audio</h2>
          <button class="bm-btn" type="button" data-audio-reset data-control>Reset</button>
        </div>
        <div class="card-body audio-body">
          <p class="audio-note">Live signal metering isn't exposed over Bluetooth - sliders show configured gain only.</p>

          <div class="audio-faders">
            <span class="audio-group-label audio-group-label--gain">GAIN</span>
            <span class="audio-group-label audio-group-label--monitor">MONITOR</span>
            ${renderAudioFader("audio-left", "audioLeftSlider", "L")}
            ${renderAudioFader("audio-right", "audioRightSlider", "R")}
            <div class="audio-group-divider" aria-hidden="true"></div>
            ${renderAudioFader("audio-mic", "audioMic", "MIC")}
            ${renderAudioFader("audio-headphone", "audioHeadphone", "HP")}
            ${renderAudioFader("audio-program-mix", "audioProgramMix", "MIX")}
            ${renderAudioFader("audio-speaker", "audioSpeaker", "SPK")}
          </div>

          <div class="audio-row audio-row-grid">
            <label>
              <span class="audio-row-label">Input type</span>
              <select data-audio-input-type data-control>
                <option value="0">Internal mic</option>
                <option value="1">Line</option>
                <option value="2">Low mic (XLR)</option>
                <option value="3">High mic (XLR)</option>
              </select>
            </label>
            <div class="audio-toggle audio-phantom-readonly" title="Phantom power is controlled by the physical switch on the camera">
              <span class="audio-phantom-led" data-audio-phantom-led></span>
              <span>+48V phantom <small>(hw switch)</small></span>
            </div>
          </div>
        </div>
      </section>
    </section>
  `;
}

function renderVideoView(): string {
  return `
    <section class="view view--video" data-view="video" id="view-video" role="tabpanel" aria-labelledby="tab-video" hidden>
      <section class="card video-card" data-video-card id="video-card">
        <div class="card-header">
          <h2>Video</h2>
        </div>
        <div class="card-body video-body">
          <div class="video-row">
            <span class="video-row-label">Auto white balance</span>
            <div class="video-row-actions">
              <button class="bm-btn" type="button" data-video-set-auto-wb data-control>SET AUTO WB</button>
              <button class="bm-btn" type="button" data-video-restore-auto-wb data-control>RESTORE AUTO WB</button>
            </div>
          </div>

          <div class="video-row">
            <span class="video-row-label">Dynamic range</span>
            <div class="segmented-group" role="radiogroup" data-video-dynamic-range>
              <button class="segmented-option" type="button" data-control data-value="0" role="radio" aria-checked="false">Film</button>
              <button class="segmented-option" type="button" data-control data-value="1" role="radio" aria-checked="false">Video</button>
              <button class="segmented-option" type="button" data-control data-value="2" role="radio" aria-checked="false">Extended Video</button>
            </div>
          </div>

          <div class="video-row">
            <span class="video-row-label">Sharpening</span>
            <div class="segmented-group" role="radiogroup" data-video-sharpening>
              <button class="segmented-option" type="button" data-control data-value="0" role="radio" aria-checked="false">Off</button>
              <button class="segmented-option" type="button" data-control data-value="1" role="radio" aria-checked="false">Low</button>
              <button class="segmented-option" type="button" data-control data-value="2" role="radio" aria-checked="false">Medium</button>
              <button class="segmented-option" type="button" data-control data-value="3" role="radio" aria-checked="false">High</button>
            </div>
          </div>

          <div class="video-row video-row-grid">
            <label>
              <span class="video-row-label">Project FPS</span>
              <select data-video-frame-rate data-control title="Requires live resolution from camera (see FORMAT on Iris tab)">
                <option value="">Apply when ready…</option>
                <option value="23">23</option>
                <option value="24">24</option>
                <option value="25">25</option>
                <option value="29">29</option>
                <option value="30">30</option>
                <option value="47">47</option>
                <option value="48">48</option>
                <option value="50">50</option>
                <option value="59">59</option>
                <option value="60">60</option>
                <option value="100">100</option>
                <option value="120">120</option>
              </select>
            </label>
            <div class="video-offspeed-field">
              <label>
                <span class="video-row-label">Off-speed FPS</span>
                <input type="number" min="0" step="1" data-video-off-speed-rate data-control placeholder="—" />
              </label>
              <button class="bm-btn" type="button" data-video-off-speed-apply data-control>Apply</button>
            </div>
          </div>

          <div class="video-row video-row-grid">
            <label>
              <span class="video-row-label">Display LUT</span>
              <select data-video-display-lut data-control>
                <option value="0">None</option>
                <option value="1">Custom</option>
                <option value="2">Film to Video</option>
                <option value="3">Film to Extended Video</option>
              </select>
            </label>
            <label class="video-toggle">
              <input type="checkbox" data-video-display-lut-enabled data-control />
              <span>LUT enabled</span>
            </label>
          </div>

          <div class="video-row video-tally-row">
            <span class="video-row-label">Tally brightness</span>
            <div class="audio-faders">
              ${renderAudioFader("tally-master", "tallyMaster", "MASTER")}
              ${renderAudioFader("tally-front", "tallyFront", "FRONT")}
              ${renderAudioFader("tally-rear", "tallyRear", "REAR")}
            </div>
          </div>
        </div>
      </section>
    </section>
  `;
}

function renderColorView(): string {
  const channelLabel = (channel: PaintChannel): string =>
    channel === "luma" ? "Y" : channel.charAt(0).toUpperCase();
  const channelClass = (channel: PaintChannel): string => (channel === "luma" ? "luma" : channel);

  const paintKnobs = PAINT_GROUPS.flatMap((group) =>
    PAINT_CHANNELS.map(
      (channel) => {
        const r = COLOR_GROUP_RANGES[group];
        return `
        <div class="knob-cell paint-knob-cell" data-paint-cell data-group="${group}" data-channel="${channel}" data-control>
          <div
            class="bm-pot2__knob paint-bm-knob knob-channel--${channelClass(channel)}"
            role="slider"
            tabindex="0"
            aria-label="${group} ${channelLabel(channel)}"
            aria-valuemin="${r.min}"
            aria-valuemax="${r.max}"
            aria-valuenow="${r.default}"
            data-knob
            data-control
            style="--angle: 0deg;"
          >
            <span class="bm-pot2__rim" aria-hidden="true"></span>
            <span class="bm-pot2__face" aria-hidden="true"></span>
            <span class="bm-pot2__indicator" aria-hidden="true"></span>
          </div>
          <div class="knob-meta">
            <span class="knob-label">${group} ${channelLabel(channel)}</span>
            <span class="bm-seg2 app-bm-seg-readout paint-value-seg bm-seg--green" data-paint-value data-seg-display>
              <span class="bm-seg2__display" data-seg-slots></span>
            </span>
          </div>
        </div>
      `;
      },
    ),
  ).join("");

  return `
    <section class="view view--color" data-view="color" id="view-color" role="tabpanel" aria-labelledby="tab-color" hidden>
      <div class="chassis chassis--single">
        <div class="chassis-row camera-row">
          <div class="paint-area">
            <div class="paint-knobs">${paintKnobs}</div>
            <div class="paint-actions">
              <span class="paint-actions-hint">Drag knobs to adjust. Y = luma (master).</span>
              <div class="paint-actions-buttons">
                <button class="bm-btn adv-btn" type="button" data-color-adv data-control aria-pressed="false" aria-controls="color-card">
                  ADV
                </button>
                <button class="bm-btn" type="button" data-color-reset data-control>Color Reset</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <section class="card color-card" data-color-card id="color-card" hidden>
        <div class="card-header">
          <h2>Color Correction — Advanced</h2>
          <button class="bm-btn" type="button" data-color-reset-card data-control>Reset</button>
        </div>
        <div class="card-body color-body">
          ${renderColorGroup("lift", "Lift", -2, 2, 0)}
          ${renderColorGroup("gamma", "Gamma", -4, 4, 0)}
          ${renderColorGroup("gain", "Gain", 0, 16, 0)}
          <div class="color-extras">
            ${renderColorHFader("contrast-pivot", "Contrast pivot", 0, 1, 0.5, "contrastPivot")}
            ${renderColorHFader("contrast-adjust", "Contrast adjust", 0, 2, 1, "contrastAdjust")}
            ${renderColorHFader("luma-mix", "Luma mix", 0, 1, 1, "lumaMix")}
            ${renderColorHFader("hue", "Hue", -1, 1, 0, "hue")}
            ${renderColorHFader("saturation", "Saturation", 0, 2, 1, "saturation")}
          </div>
        </div>
      </section>
    </section>
  `;
}

function renderDebugView(): string {
  return `
    <section class="view view--debug" data-view="debug" id="view-debug" role="tabpanel" aria-labelledby="tab-debug" hidden>
      <section class="card status-card">
        <h2>Camera Status</h2>
        <ul class="status-flags" data-status>
          <li>No camera status yet</li>
        </ul>
      </section>

      <section class="card debug-settings-card">
        <div class="card-header">
          <h2>Settings</h2>
          <span class="readout-label">local</span>
        </div>
        <ul class="debug-settings-list" aria-label="Debug and developer settings">
          <li class="debug-settings-row">
            <label class="debug-settings-label">
              <input type="checkbox" data-debug-atem-sync checked />
              <span class="debug-settings-text">
                <span class="debug-settings-name">ATEM CCU compact trace</span>
                <span class="debug-settings-desc muted">Short lines + catalogue in the log for each panel_sync (on by default; turn off here).</span>
              </span>
            </label>
          </li>
          <li class="debug-settings-row">
            <label class="debug-settings-label">
              <input type="checkbox" data-debug-atem-ccu-json />
              <span class="debug-settings-text">
                <span class="debug-settings-name">ATEM CCU full JSON</span>
                <span class="debug-settings-desc muted">Log full trace JSON when compact trace is on.</span>
              </span>
            </label>
          </li>
          <li class="debug-settings-row">
            <span class="debug-settings-text">
              <span class="debug-settings-name">ATEM raw in log</span>
              <span class="debug-settings-desc muted">Hub sends <code class="connect-atem-code">[atem-raw]</code> lines (incl. <code class="connect-atem-code">TimeCommand</code>) by default; set <code class="connect-atem-code">ATEM_CCU_RELAY_RAW_TO_TRACE=0</code> on the server to stop. Optional <code class="connect-atem-code">ATEM_CCU_RELAY_RAW_MAX=256</code>.</span>
            </span>
          </li>
          <li class="debug-settings-row">
            <label class="debug-settings-label">
              <input type="checkbox" data-debug-relay-localhost />
              <span class="debug-settings-text">
                <span class="debug-settings-name">Relay hub → localhost</span>
                <span class="debug-settings-desc muted">Use <code>127.0.0.1:5173</code> for relay WS + session list (Vite proxies <code>/api</code>).</span>
                <span class="debug-settings-note muted">
                  From <code>https://</code>, <code>ws://127.0.0.1</code> is often blocked — open the app over <code>http://localhost:5173</code> when this is on.
                </span>
              </span>
            </label>
          </li>
        </ul>
      </section>

      <section class="card debug-log-card">
        <div class="log-header">
          <h2>Debug Log</h2>
          <button class="bm-btn" type="button" data-clear-log>Clear</button>
        </div>
        <ul class="debug-log" data-log></ul>
      </section>
    </section>
  `;
}

function renderSceneBar(): string {
  return `
    <div class="scene-bar" data-scene-bar hidden>
      <div class="chassis-row scene-file-row">
        <span class="scene-file-label">SCENE FILE</span>
        <div class="scene-file-banks" data-scene-banks>
          ${Array.from({ length: SCENE_SLOT_COUNT }, (_, index) => {
            const slot = index;
            const isGlobal = slot >= BANK_COUNT;
            const label = isGlobal ? `G${slot - BANK_COUNT + 1}` : String(slot + 1);
            const ariaDefault = isGlobal ? `Global scene ${label}` : `Scene file ${slot + 1}`;
            return `
              <button
                class="scene-bank${isGlobal ? " scene-bank--global" : ""}"
                data-scene-bank
                data-bank-slot="${slot}"
                data-control
                aria-label="${ariaDefault}"
                aria-pressed="false"
              >
                <span class="scene-bank-led" aria-hidden="true"></span>
                <span class="scene-bank-label">${label}</span>
              </button>
            `;
          }).join("")}
        </div>
        <button class="bm-btn scene-store" type="button" data-scene-store data-control aria-pressed="false">
          STORE
        </button>
      </div>
    </div>
  `;
}

function renderRelayModals(): string {
  return `
    <div class="relay-modal-backdrop" data-relay-host-modal hidden>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="relay-host-title"
        class="relay-modal"
      >
        <h2 id="relay-host-title" class="relay-modal-title">Relay session name</h2>
        <p class="relay-modal-body">Shown to guests in Join. A default name is saved on this phone.</p>
        <label class="relay-modal-field">
          <span class="relay-modal-label">Session name</span>
          <input type="text" data-relay-host-name maxlength="120" autocomplete="off" />
        </label>
        <label class="relay-modal-check">
          <input type="checkbox" data-relay-host-share checked />
          <span class="relay-modal-check-text">Share session (start relay now)</span>
        </label>
        <label class="relay-modal-check">
          <input type="checkbox" data-relay-host-atem-ccu />
          <span class="relay-modal-check-text">ATEM CCU shared session (switcher on the banks server LAN)</span>
        </label>
        <div class="relay-modal-field-group" data-relay-host-atem-fields hidden>
          <label class="relay-modal-field">
            <span class="relay-modal-label">ATEM IP or hostname</span>
            <input type="text" data-relay-host-atem-address autocomplete="off" placeholder="192.168.1.199" />
          </label>
          <label class="relay-modal-field">
            <span class="relay-modal-label">Camera index (1–8)</span>
            <input type="number" data-relay-host-atem-camera min="1" max="24" step="1" />
          </label>
        </div>
        <div class="relay-modal-actions">
          <button type="button" class="bm-btn connect-primary" data-relay-host-confirm data-control>
            Confirm
          </button>
          <button type="button" class="bm-btn" data-relay-host-cancel data-control>
            Cancel
          </button>
        </div>
      </div>
    </div>
    <div class="relay-modal-backdrop" data-relay-list-modal hidden>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="relay-list-title"
        class="relay-modal relay-modal--wide"
      >
        <h2 id="relay-list-title" class="relay-modal-title">Join session</h2>
        <p class="relay-modal-body muted">Open sessions on this server (same-origin list).</p>
        <button type="button" class="bm-btn" data-relay-refresh-list data-control>Refresh list</button>
        <div class="relay-session-list-wrap">
          <ul class="relay-session-list" data-relay-session-list aria-live="polite"></ul>
          <p class="relay-session-empty muted" data-relay-empty hidden>Loading hosted sessions…</p>
        </div>
        <div class="relay-modal-actions">
          <button type="button" class="bm-btn" data-relay-list-close data-control>Close</button>
        </div>
      </div>
    </div>
    <div class="relay-modal-backdrop" data-relay-share-needs-connection hidden>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="relay-share-needs-ble-title"
        class="relay-modal"
      >
        <h2 id="relay-share-needs-ble-title" class="relay-modal-title">Connection needed</h2>
        <p class="relay-modal-body">
          To share a session for remote operators, connect this device to the camera over Bluetooth first, then tap Share again.
          Or share <strong>ATEM CCU</strong> over your LAN when the banks API server can reach the switcher.
        </p>
        <div class="relay-modal-actions relay-modal-actions--stack">
          <button type="button" class="bm-btn connect-primary" data-relay-share-atem-setup data-control>
            Share ATEM CCU…
          </button>
          <button type="button" class="bm-btn" data-relay-share-needs-ble-ok data-control>
            OK
          </button>
        </div>
      </div>
    </div>
    <div class="relay-modal-backdrop" data-record-stop-confirm-modal hidden>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-stop-confirm-title"
        class="relay-modal"
      >
        <h2 id="record-stop-confirm-title" class="relay-modal-title">Stop recording?</h2>
        <p class="relay-modal-body">Stop recording on the camera?</p>
        <div class="relay-modal-actions">
          <button type="button" class="bm-btn" data-record-stop-cancel data-control>
            Cancel
          </button>
          <button type="button" class="bm-btn connect-primary" data-record-stop-confirm data-control>
            Stop recording
          </button>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Root panel template + view chrome
// ─────────────────────────────────────────────────────────────────────────────

export interface PanelBleUiOptions {
  /** Capacitor WebView: hide install-Bluefy / desktop-Chrome hints — BLE uses the native stack. */
  hideBrowserBleInstallHints?: boolean;
  /** Desktop/browser only: show ATEM mixer LAN quick-connect on Connect tab. */
  showAtemLanConnect?: boolean;
}

/** @param bleUi - Optional Connect-tab extras (e.g. browser-only ATEM LAN block). */
export function renderPanelTemplate(bleTransportAvailable: boolean, bleUi?: PanelBleUiOptions): string {
  const hideHints = bleUi?.hideBrowserBleInstallHints ?? false;
  return `
    <main class="panel-app panel-app--views" data-view-active="connect">
      ${renderAppHeader(bleTransportAvailable)}
      <div class="views" data-views>
        ${renderConnectView(bleTransportAvailable, bleUi)}
        ${renderSettingsView()}
        ${renderIrisView()}
        ${renderAudioView()}
        ${renderVideoView()}
        ${renderColorView()}
        ${renderDebugView()}
      </div>
      ${renderSceneBar()}
      ${renderViewNav()}
      ${!bleTransportAvailable && !hideHints && isIosLikeWebBluetoothBlocked() ? renderBluefyOfferModal() : ""}
      ${!bleTransportAvailable && !hideHints && !isIosLikeWebBluetoothBlocked() ? renderGenericWebBleHelpModal() : ""}
      ${renderRelayModals()}
    </main>
  `;
}

/** Switch the active view. Updates DOM visibility, ARIA, nav state, and scene bar. */
export function setActiveView(root: HTMLElement, viewId: ViewId): void {
  const main = root.querySelector<HTMLElement>(".panel-app");
  if (!main) return;
  main.dataset.viewActive = viewId;

  root.querySelectorAll<HTMLElement>("[data-view]").forEach((section) => {
    const matches = section.dataset.view === viewId;
    section.hidden = !matches;
  });

  root.querySelectorAll<HTMLButtonElement>("[data-view-switch]").forEach((tab) => {
    const matches = tab.dataset.viewSwitch === viewId;
    tab.classList.toggle("is-active", matches);
    tab.setAttribute("aria-selected", matches ? "true" : "false");
    tab.tabIndex = matches ? 0 : -1;
  });

  const sceneBar = root.querySelector<HTMLElement>("[data-scene-bar]");
  if (sceneBar) {
    sceneBar.hidden = !SCENE_BAR_VIEWS.has(viewId);
  }
}

export function isViewId(value: string | null | undefined): value is ViewId {
  return value !== null && value !== undefined && (VIEW_IDS as readonly string[]).includes(value);
}

/** Product label from BLE / GATT name (URSA Broadcast spelled out; other lines stay short). */
/** True when the paired BLE name is a URSA family body (ND is mechanical / not reliable over Bluetooth). */
export function isUrsaCameraName(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  return raw.toUpperCase().includes("URSA");
}

/** Original URSA Broadcast (not G2): sensor master gain steps in 2 dB from −6 dB to +18 dB. */
export function isUrsaBroadcastG1CameraName(raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const u = raw.toUpperCase();
  if (!u.includes("URSA") || !u.includes("BROADCAST")) return false;
  if (u.includes("G2")) return false;
  return true;
}

export type MasterGainStepDirection = 1 | -1;

const URSA_BROADCAST_G1_GAIN_DB: readonly number[] = (() => {
  const min = -6;
  const max = 18;
  const step = 2;
  const n = (max - min) / step + 1;
  return Array.from({ length: n }, (_, i) => min + i * step);
})();

/**
 * Next master gain (dB) for stepper buttons: G1 Broadcast uses a −6…+18 dB ladder in 2 dB steps; other bodies use ±1 dB within {@link MASTER_GAIN_RANGE}.
 */
export function stepMasterGainDb(
  current: number,
  direction: MasterGainStepDirection,
  rawDeviceName: string | undefined,
): number {
  if (isUrsaBroadcastG1CameraName(rawDeviceName)) {
    const ladder = URSA_BROADCAST_G1_GAIN_DB;
    let bestI = 0;
    let bestDist = Infinity;
    for (let i = 0; i < ladder.length; i++) {
      const v = ladder[i]!;
      const d = Math.abs(v - current);
      if (d < bestDist) {
        bestDist = d;
        bestI = i;
      }
    }
    const nextI = Math.min(Math.max(bestI + direction, 0), ladder.length - 1);
    return ladder[nextI]!;
  }
  const next = Math.round(current + direction);
  return Math.min(Math.max(next, MASTER_GAIN_RANGE.min), MASTER_GAIN_RANGE.max);
}

export function formatCameraProductLabel(raw: string | undefined): string {
  if (!raw?.trim()) return "";
  const u = raw.toUpperCase();
  if (u.includes("URSA")) {
    if (u.includes("MINI")) return "URSA MINI";
    if (u.includes("BROADCAST")) return "URSA Broadcast";
    return "URSA";
  }
  if (u.includes("POCKET")) return "POCKET";
  if (u.includes("PYXIS")) return "PYXIS";
  if (u.includes("STUDIO")) return "STUDIO";
  const skip = new Set(["BLACKMAGIC", "BMD", "DESIGN", "CAMERA"]);
  const tokens = raw.split(/[\s/-]+/).filter((t) => t.length > 0 && !skip.has(t.toUpperCase()));
  const first = tokens[0];
  if (!first) return "CAMERA";
  return first.toUpperCase().slice(0, 14);
}

export function updateAppHeaderCameraProduct(root: HTMLElement, rawName: string | undefined): void {
  const el = root.querySelector<HTMLElement>("[data-camera-product]");
  if (!el) return;
  const trimmed = rawName?.trim();
  if (!trimmed || deviceNameLooksLikeAtemSwitcher(trimmed)) {
    el.hidden = true;
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  el.textContent = formatCameraProductLabel(trimmed) || "CAMERA";
  el.title = trimmed;
  el.hidden = false;
}

function ndManualReferenceDisplay(mode: number | undefined): boolean {
  return mode === 1 || mode === 2;
}

export function updatePanel(
  root: HTMLElement,
  snapshot: CameraSnapshot,
  transport?: { localBleGattConnected?: boolean },
): void {
  setReadout(root, "gain", formatGain(snapshot.gainDb));
  setReadout(root, "shutter", formatShutter(snapshot));
  setReadout(root, "autoexp", formatAutoExp(snapshot.autoExposureMode));
  updateAutoExpButton(root, snapshot.autoExposureMode);
  updatePowerButton(root, snapshot.status?.powerOn ?? false);
  setReadout(root, "iris", formatIris(snapshot));
  setReadout(root, "focus", formatFocus(snapshot.lens.focus));
  setReadout(root, "zoom", formatZoom(snapshot.lens.zoom, snapshot.lens.zoomMm));
  setReadout(root, "masterBlackReadout", formatMasterBlack(snapshot.color.lift.luma));
  setReadout(root, "wb", formatWhiteBalance(snapshot.whiteBalance));
  setReadout(root, "tint", formatTint(snapshot.whiteBalance?.tint));
  setReadout(root, "tintReadout", formatTint(snapshot.whiteBalance?.tint));
  setReadout(root, "iso", formatIso(snapshot.iso));
  setReadout(root, "nd", formatNd(snapshot.ndFilterStops));
  setReadout(root, "ndReadout", formatNd(snapshot.ndFilterStops));
  const ndManualRef = ndManualReferenceDisplay(snapshot.ndFilterDisplayMode);
  const ursaNd = isUrsaCameraName(snapshot.deviceName);
  const ndSeg = root.querySelector<HTMLElement>('[data-readout="nd"]');
  if (ndSeg) {
    if (ursaNd) {
      ndSeg.classList.remove("bm-seg--green", "bm-seg--yellow");
      ndSeg.classList.add("bm-seg--orange");
    } else {
      ndSeg.classList.remove("bm-seg--orange");
      ndSeg.classList.toggle("bm-seg--green", !ndManualRef);
      ndSeg.classList.toggle("bm-seg--yellow", ndManualRef);
    }
  }
  const ndWrap = root.querySelector<HTMLElement>("[data-nd-readout-wrap]");
  if (ndWrap) {
    if (ursaNd) {
      ndWrap.classList.remove("iris-info-strip__nd--manual-ref");
      ndWrap.classList.add("iris-info-strip__nd--ursa-manual");
    } else {
      ndWrap.classList.remove("iris-info-strip__nd--ursa-manual");
      ndWrap.classList.toggle("iris-info-strip__nd--manual-ref", ndManualRef);
    }
  }

  setReadout(root, "format", formatRecordingFormat(snapshot));
  setReadout(root, "codec", formatCodec(snapshot.codec));

  updateAudioCard(root, snapshot);
  updateVideoCard(root, snapshot);
  updatePaintKnobs(root, snapshot);
  updateColorCard(root, snapshot);
  updateCameraPillar(root, snapshot.cameraNumber);
  updateCameraBadge(root, snapshot.cameraNumber);
  updateIrisWheel(root, snapshot);
  updateIrisJoystick(root, snapshot);
  updateFocusFader(root, snapshot);
  updateZoomFader(root, snapshot);
  updateUnitOutputs(root, snapshot);
  updateLeds(root, snapshot, transport);
  updateRecording(root, snapshot.recording);
  updateAppHeaderCameraProduct(root, snapshot.deviceName);
}

export interface SceneBanksUiState {
  /** Per-button fill state: indices 0–4 local scenes, 5–8 global G1–G4. */
  filledSlots: boolean[];
  /** Unified loaded index: 0–4 local, 5–8 global, or null. */
  loadedSlot: number | null;
  storeArmed: boolean;
  /** True when the live panel state has diverged from the loaded bank. */
  dirty?: boolean;
}

export function updateSceneBanks(root: HTMLElement, ui: SceneBanksUiState): void {
  root.querySelectorAll<HTMLButtonElement>("[data-scene-bank]").forEach((button) => {
    const slot = Number(button.dataset.bankSlot);
    const filled = Boolean(ui.filledSlots[slot]);
    const loaded = ui.loadedSlot === slot;
    const dirty = loaded && Boolean(ui.dirty);
    button.classList.toggle("filled", filled);
    button.classList.toggle("loaded", loaded);
    button.classList.toggle("dirty", dirty);
    button.setAttribute("aria-pressed", loaded ? "true" : "false");
    const isGlobal = slot >= BANK_COUNT;
    const labelText = isGlobal ? `G${slot - BANK_COUNT + 1}` : String(slot + 1);
    const kind = isGlobal ? "Global" : "Scene";
    const title = loaded
      ? dirty
        ? `${kind} ${labelText} (loaded, unsaved changes)`
        : `${kind} ${labelText} (loaded)`
      : filled
        ? `${kind} ${labelText} (saved)`
        : `${kind} ${labelText} (empty)`;
    button.title = title;
    const ariaCore = isGlobal ? `Global scene ${labelText}` : `Scene file ${slot + 1}`;
    button.setAttribute(
      "aria-label",
      loaded ? `${ariaCore}, loaded${dirty ? ", modified since load" : ""}` : `${ariaCore}, ${filled ? "saved" : "empty"}`,
    );
  });

  const storeBtn = root.querySelector<HTMLButtonElement>("[data-scene-store]");
  if (storeBtn) {
    storeBtn.classList.toggle("armed", ui.storeArmed);
    storeBtn.setAttribute("aria-pressed", ui.storeArmed ? "true" : "false");
  }

  const wrapper = root.querySelector<HTMLElement>("[data-scene-banks]");
  if (wrapper) wrapper.classList.toggle("store-armed", ui.storeArmed);
}

function updatePowerButton(root: HTMLElement, on: boolean): void {
  const button = root.querySelector<HTMLButtonElement>("[data-power]");
  if (!button) return;
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  const label = button.querySelector<HTMLElement>("[data-power-label]");
  if (label) {
    label.textContent = on ? "Power Off" : "Power On";
  }
}

function updateAutoExpButton(root: HTMLElement, mode: number | undefined): void {
  const button = root.querySelector<HTMLButtonElement>("[data-auto-exp]");
  if (!button) return;
  const enabled = isAutoExpEnabled(mode);
  button.classList.toggle("active", enabled);
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
}

function updateCameraPillar(root: HTMLElement, cameraNumber: number | undefined): void {
  const id = cameraNumber ?? 1;
  root.querySelectorAll<HTMLButtonElement>("[data-camera-led]").forEach((led) => {
    const ledId = Number(led.dataset.cameraId);
    led.classList.toggle("on", ledId === id);
  });
}

function updateCameraBadge(root: HTMLElement, cameraNumber: number | undefined): void {
  const digit = root.querySelector<HTMLElement>("[data-cam-badge-digit]");
  if (!digit) return;
  digit.textContent = cameraNumber !== undefined ? String(cameraNumber) : "—";
}

// ─────────────────────────────────────────────────────────────────────────────
// Fader / iris / paint numeric mapping helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Continuous master-gain span for most bodies (e.g. URSA Broadcast G2). Original URSA Broadcast uses {@link stepMasterGainDb} (−6…+18 dB, 2 dB steps). */
export const MASTER_GAIN_RANGE = { min: -12, max: 30 };
export const MASTER_BLACK_RANGE = { min: -2, max: 2 };

function updateIrisWheel(root: HTMLElement, snapshot: CameraSnapshot): void {
  const knob = root.querySelector<HTMLElement>("[data-iris-wheel]");
  if (!knob) return;

  const luma = snapshot.color.lift.luma ?? 0;
  const norm = masterBlackToNormalised(luma);
  const angle = norm * 270 - 135;
  knob.style.setProperty("--angle", `${angle}deg`);
  knob.setAttribute("aria-valuenow", String(luma));
}

export function gainDbToNormalised(db: number): number {
  const span = MASTER_GAIN_RANGE.max - MASTER_GAIN_RANGE.min;
  return Math.max(0, Math.min(1, (db - MASTER_GAIN_RANGE.min) / span));
}

export function normalisedToGainDb(norm: number): number {
  const span = MASTER_GAIN_RANGE.max - MASTER_GAIN_RANGE.min;
  return MASTER_GAIN_RANGE.min + Math.max(0, Math.min(1, norm)) * span;
}

export function masterBlackToNormalised(value: number): number {
  const span = MASTER_BLACK_RANGE.max - MASTER_BLACK_RANGE.min;
  return Math.max(0, Math.min(1, (value - MASTER_BLACK_RANGE.min) / span));
}

export function normalisedToMasterBlack(norm: number): number {
  const span = MASTER_BLACK_RANGE.max - MASTER_BLACK_RANGE.min;
  return MASTER_BLACK_RANGE.min + Math.max(0, Math.min(1, norm)) * span;
}

function updateFocusFader(root: HTMLElement, snapshot: CameraSnapshot): void {
  const fader = root.querySelector<HTMLElement>('[data-h-fader="focus"]');
  const handle = fader?.querySelector<HTMLElement>("[data-h-fader-handle]");
  if (!fader || !handle) return;
  if (fader.classList.contains("dragging")) return;
  const value = snapshot.lens.focus ?? 0.5;
  positionHFaderHandle(fader, handle, value);
}

function updateZoomFader(root: HTMLElement, snapshot: CameraSnapshot): void {
  const fader = root.querySelector<HTMLElement>('[data-h-fader="zoom"]');
  const handle = fader?.querySelector<HTMLElement>("[data-h-fader-handle]");
  if (!fader || !handle) return;
  if (fader.classList.contains("dragging")) return;
  const value = snapshot.lens.zoom ?? 0.5;
  positionHFaderHandle(fader, handle, value);
}

function updateIrisJoystick(root: HTMLElement, snapshot: CameraSnapshot): void {
  const joystick = root.querySelector<HTMLElement>("[data-iris-joystick]");
  const handle = root.querySelector<HTMLElement>("[data-iris-joystick-handle]");
  if (!joystick || !handle) return;
  if (joystick.dataset.dragging === "true") return;

  const iris = snapshot.lens.apertureNormalised ?? 0.5;
  positionIrisHandle(joystick, handle, iris);
}

const IRIS_TBAR_SHAFT_PADDING_PX = 24;

/** Usable iris travel inside the bm-tbar shaft (matches patterns attachTBar: shaft height − 12px top/bottom inset). */
export function irisTbarDragRangePx(joystick: HTMLElement, handle: HTMLElement): number {
  const shaft = joystick.querySelector<HTMLElement>(".bm-tbar__shaft");
  if (shaft && shaft.clientHeight > 0) {
    return Math.max(1, shaft.clientHeight - IRIS_TBAR_SHAFT_PADDING_PX);
  }
  return Math.max(1, joystick.clientHeight - 1.2 * 16 - handle.offsetHeight);
}

/** Position T-bar iris handle; syncs `--travel` so bm-tbar thumb math stays aligned with drag range. */
export function positionIrisHandle(joystick: HTMLElement, handle: HTMLElement, irisNormalised: number): void {
  if (joystick.clientHeight === 0) return;
  const iris = Math.max(0, Math.min(1, irisNormalised));
  /** bm-tbar `--pos` is 1 at shaft top; apertureNormalised is 0 wide open → 1 closed (matches F readout mapping). */
  const pos = 1 - iris;

  joystick.style.setProperty("--travel", `${irisTbarDragRangePx(joystick, handle)}px`);

  handle.style.setProperty("--pos", String(pos));
  joystick.querySelector<HTMLElement>(".bm-tbar__ladder")?.style.setProperty("--fill", String(pos));
  handle.setAttribute("aria-valuenow", String(Math.round(iris * 100)));
}

function updateColorCard(root: HTMLElement, snapshot: CameraSnapshot): void {
  PAINT_GROUPS.forEach((group) => {
    PAINT_CHANNELS.forEach((channel) => {
      const cell = root.querySelector<HTMLElement>(
        `[data-color-input][data-group="${group}"][data-channel="${channel}"]`,
      );

      if (!cell) return;

      const fader = cell.querySelector<HTMLElement>("[data-vfader]");
      const handle = cell.querySelector<HTMLElement>("[data-vfader-handle]");
      const readout = cell.querySelector<HTMLElement>("[data-color-readout]");

      if (!fader || !handle || !readout) return;
      if (fader.dataset.dragging === "true") return;

      const value = snapshot.color[group][channel];
      positionVerticalFader(fader, handle, value);
      fader.setAttribute("aria-valuenow", value.toFixed(2));
      writePaintSegReadout(readout, value);
    });
  });

  syncHorizontalFader(root, "contrast-pivot", snapshot.color.contrast?.pivot ?? 0.5, "contrastPivot");
  syncHorizontalFader(root, "contrast-adjust", snapshot.color.contrast?.adjust ?? 1, "contrastAdjust");
  syncHorizontalFader(root, "luma-mix", snapshot.color.lumaMix ?? 1, "lumaMix");
  syncHorizontalFader(root, "hue", snapshot.color.hue ?? 0, "hue");
  syncHorizontalFader(root, "saturation", snapshot.color.saturation ?? 1, "saturation");
}

function syncHorizontalFader(
  root: HTMLElement,
  attr: string,
  value: number,
  readoutKey: string,
): void {
  const fader = root.querySelector<HTMLElement>(`[data-hfader="${attr}"]`);
  const handle = fader?.querySelector<HTMLElement>("[data-hfader-handle]");
  setReadout(root, readoutKey, formatSegSignedFixed2(value));
  if (!fader || !handle) return;
  if (fader.dataset.dragging === "true") return;
  positionHorizontalFader(fader, handle, value);
  fader.setAttribute("aria-valuenow", value.toFixed(2));
}

const FADER_PADDING_PX = 8;

export interface FaderRange {
  min: number;
  max: number;
  default: number;
}

export function readFaderRange(el: HTMLElement): FaderRange {
  const min = Number(el.dataset.min ?? "0");
  const max = Number(el.dataset.max ?? "1");
  const def = Number(el.dataset.default ?? String((min + max) / 2));
  return { min, max, default: def };
}

/** Map value -> [0,1] where the fader's default sits at exactly 0.5. */
export function valueToCenteredNorm(value: number, range: FaderRange): number {
  const { min, max, default: def } = range;
  const span = max - min;
  if (span <= 0) return 0.5;
  // Default at an endpoint (e.g. gain min=default=0): map [min,max] linearly to fader travel
  // so the neutral value sits at the physical min/max, not at the bipolar "0.5" detent.
  if (def <= min) {
    return Math.max(0, Math.min(1, (value - min) / span));
  }
  if (def >= max) {
    return Math.max(0, Math.min(1, (value - min) / span));
  }
  if (value >= def) {
    const aboveSpan = max - def || 1;
    return 0.5 + 0.5 * Math.max(0, Math.min(1, (value - def) / aboveSpan));
  }
  const belowSpan = def - min || 1;
  return 0.5 - 0.5 * Math.max(0, Math.min(1, (def - value) / belowSpan));
}

/** Inverse of valueToCenteredNorm. */
export function centeredNormToValue(norm: number, range: FaderRange): number {
  const n = Math.max(0, Math.min(1, norm));
  const { min, max, default: def } = range;
  const span = max - min;
  if (span <= 0) return def;
  if (def <= min || def >= max) {
    return min + n * span;
  }
  if (n >= 0.5) return def + ((n - 0.5) / 0.5) * (max - def);
  return def - ((0.5 - n) / 0.5) * (def - min);
}

export function positionVerticalFader(fader: HTMLElement, handle: HTMLElement, value: number): void {
  const norm = valueToCenteredNorm(value, readFaderRange(fader));
  handle.style.setProperty("--pos", String(norm));
  fader.querySelector<HTMLElement>("[data-vfader-fill]")?.style.setProperty("--pos", String(norm));
}

export function positionHorizontalFader(fader: HTMLElement, handle: HTMLElement, value: number): void {
  const width = fader.clientWidth;
  if (width === 0) return;
  const norm = valueToCenteredNorm(value, readFaderRange(fader));
  const horizontalRange = Math.max(0, width - handle.offsetWidth - FADER_PADDING_PX * 2);
  const x = FADER_PADDING_PX + norm * horizontalRange;
  handle.style.left = `${x}px`;
}

export const PAINT_RANGE: Record<PaintGroup, { min: number; max: number; default: number }> = {
  lift: { min: -2, max: 2, default: 0 },
  gamma: { min: -4, max: 4, default: 0 },
  gain: { min: 0, max: 16, default: 0 },
};

const KNOB_MAX_ANGLE_DEG = 135;

export function paintValueToAngle(group: PaintGroup, value: number): number {
  const { min, max, default: def } = PAINT_RANGE[group];
  const half = Math.max(max - def, def - min) || 1;
  const normalized = Math.max(-1, Math.min(1, (value - def) / half));
  return normalized * KNOB_MAX_ANGLE_DEG;
}

function updatePaintKnobs(root: HTMLElement, snapshot: CameraSnapshot): void {
  root.querySelectorAll<HTMLElement>("[data-paint-cell]").forEach((cell) => {
    if (cell.dataset.dragging === "true") return;

    const group = cell.dataset.group as PaintGroup | undefined;
    const channel = cell.dataset.channel as PaintChannel | undefined;

    if (!group || !channel) {
      return;
    }

    const value = snapshot.color[group][channel];
    const knob = cell.querySelector<HTMLElement>("[data-knob]");
    const readout = cell.querySelector<HTMLElement>("[data-paint-value]");

    if (knob) {
      knob.style.setProperty("--angle", `${paintValueToAngle(group, value)}deg`);
      knob.setAttribute("aria-valuenow", value.toFixed(2));
    }

    if (readout) {
      writePaintSegReadout(readout, value);
    }
  });
}

export function writePaintSegReadout(readout: HTMLElement, value: number): void {
  const slots = readout.querySelector<HTMLElement>("[data-seg-slots]");
  const text = formatSegSignedFixed2(value);
  if (slots) {
    populateSegSlots(slots, text);
    readout.setAttribute("aria-label", text.trim());
    return;
  }
  readout.textContent = text.trim();
}

function updateLeds(
  root: HTMLElement,
  snapshot: CameraSnapshot,
  transport?: { localBleGattConnected?: boolean },
): void {
  const status = snapshot.status;
  const pairOn = (status?.paired ?? false) || transport?.localBleGattConnected === true;
  toggleLed(root, "power", status?.powerOn ?? false);
  toggleLed(root, "connected", status?.connected ?? false);
  toggleLed(root, "paired", pairOn);
  toggleLed(root, "ready", status?.cameraReady ?? false);
  toggleLed(root, "recording", snapshot.recording);

  const pgm = root.querySelector<HTMLElement>('[data-tally="program"]');
  const pvw = root.querySelector<HTMLElement>('[data-tally="preview"]');
  if (pgm) pgm.classList.toggle("on", snapshot.tally?.programMe === true);
  if (pvw) pvw.classList.toggle("on", snapshot.tally?.previewMe === true);

  syncViewportTallyBorder(root, snapshot.tally?.programMe === true, snapshot.tally?.previewMe === true);
}

/** Program (red) wins over preview (green); see `.panel-app` tally `::before` in styles.css. */
function syncViewportTallyBorder(root: HTMLElement, programOn: boolean, previewOn: boolean): void {
  const panel = root.querySelector<HTMLElement>(".panel-app");
  if (!panel) return;
  panel.classList.toggle("viewport-tally--program", programOn);
  panel.classList.toggle("viewport-tally--preview", previewOn && !programOn);
}

function updateRecording(root: HTMLElement, recording: boolean): void {
  const btn = root.querySelector<HTMLButtonElement>("[data-record-start]");
  if (!btn) return;
  btn.classList.toggle("active", recording);
  btn.setAttribute("aria-pressed", recording ? "true" : "false");
  btn.setAttribute(
    "aria-label",
    recording ? "Recording — tap to stop after confirming" : "Start recording",
  );
}

function toggleLed(root: HTMLElement, name: string, on: boolean): void {
  root.querySelectorAll<HTMLElement>(`[data-led="${name}"]`).forEach((led) => {
    led.classList.toggle("on", on);
  });
}

function setReadout(root: HTMLElement, name: string, value: string): void {
  root.querySelectorAll<HTMLElement>(`[data-readout="${name}"]`).forEach((element) => {
    const slots = element.querySelector<HTMLElement>("[data-seg-slots]");
    if (slots) {
      populateSegSlots(slots, value);
      element.setAttribute("aria-label", value);
      return;
    }
    element.textContent = value;
  });
}

function formatGain(gainDb: number | undefined): string {
  if (gainDb === undefined) return "--";
  const sign = gainDb < 0 ? "-" : "";
  return `${sign}${Math.abs(gainDb).toFixed(1)}`;
}

function formatShutter(snapshot: CameraSnapshot): string {
  const degrees = shutterAngleDegrees(snapshot);

  if (degrees === undefined) {
    return "----";
  }

  return Math.round(degrees).toString().padStart(4, "0");
}

function shutterAngleDegrees(snapshot: CameraSnapshot): number | undefined {
  if (snapshot.shutterAngle !== undefined) {
    return snapshot.shutterAngle / 100;
  }

  if (snapshot.shutterSpeed && snapshot.shutterSpeed > 0) {
    const fps = snapshot.recordingFormat?.frameRate ?? 25;
    const angle = (fps * 360) / snapshot.shutterSpeed;
    return Math.min(360, Math.max(1, angle));
  }

  return undefined;
}

export function formatAutoExp(mode: number | undefined): string {
  switch (mode) {
    case undefined:
    case 0:
      return "MANUAL";
    case 1:
      return "IRIS";
    case 2:
      return "SHUTTER";
    case 3:
      return "IRIS+SH";
    case 4:
      return "SH+IRIS";
    default:
      return `MODE ${mode}`;
  }
}

export function isAutoExpEnabled(mode: number | undefined): boolean {
  return mode !== undefined && mode !== 0;
}

function formatIris(snapshot: CameraSnapshot): string {
  const fstop = estimateFstop(snapshot);

  if (fstop === undefined) {
    return "F--";
  }

  return `F${fstop.toFixed(1)}`;
}

function estimateFstop(snapshot: CameraSnapshot): number | undefined {
  if (snapshot.lens.apertureFstop !== undefined) {
    return 2 ** (snapshot.lens.apertureFstop / 2);
  }

  if (snapshot.lens.apertureNormalised !== undefined) {
    const minStop = 1.8;
    const maxStop = 22;
    const normalised = Math.min(1, Math.max(0, snapshot.lens.apertureNormalised));
    return minStop + (maxStop - minStop) * normalised;
  }

  return undefined;
}

function formatFocus(focus: number | undefined): string {
  if (focus === undefined) return "--";
  return `${(focus * 100).toFixed(0)}%`;
}

function formatZoom(zoomNormalised: number | undefined, zoomMm: number | undefined): string {
  if (zoomNormalised !== undefined) {
    return `${(zoomNormalised * 100).toFixed(0)}%`;
  }
  if (zoomMm !== undefined && Number.isFinite(zoomMm)) {
    return `${Math.round(zoomMm)}mm`;
  }
  return "--";
}

function formatMasterBlack(luma: number): string {
  return `${luma >= 0 ? "+" : ""}${luma.toFixed(2)}`;
}

function formatWhiteBalance(wb: CameraSnapshot["whiteBalance"]): string {
  if (!wb) return "----";
  return Math.round(wb.temperature).toString().padStart(4, "0");
}

function formatTint(tint: number | undefined): string {
  if (tint === undefined) return "0";
  return Math.round(tint).toString();
}

function formatIso(iso: number | undefined): string {
  if (iso === undefined) return "----";
  return iso.toString().padStart(4, " ");
}

export function formatNd(stops: number | undefined): string {
  if (stops === undefined || Number.isNaN(stops)) return "CLR";
  for (const p of ND_URSA_STEPS) {
    if (Math.abs(stops - p.stops) <= ND_URSA_TOL) return p.label;
  }
  return (Math.round(stops * 10) / 10).toFixed(1);
}

function setMiniFaderMirror(root: HTMLElement, faderAttr: string, readout: string, value: number | undefined): void {
  if (value === undefined) return;
  const fader = root.querySelector<HTMLElement>(`[data-mini-fader="${faderAttr}"]`);
  if (fader && !fader.classList.contains("dragging")) {
    const handle = fader.querySelector<HTMLElement>("[data-mini-fader-handle]");
    if (handle) positionMiniFaderHandle(fader, handle, value);
  }
  setReadout(root, readout, value.toFixed(2));
}

export function positionMiniFaderHandle(fader: HTMLElement, handle: HTMLElement, value: number): void {
  const v = Math.max(0, Math.min(1, value));
  handle.style.setProperty("--pos", String(v));
  fader.querySelector<HTMLElement>("[data-mini-fader-fill]")?.style.setProperty("--pos", String(v));
}

export function positionHFaderHandle(fader: HTMLElement, handle: HTMLElement, value: number): void {
  const rect = fader.getBoundingClientRect();
  if (rect.width === 0) return;
  const horizontalRange = Math.max(1, rect.width - handle.offsetWidth);
  const v = Math.max(0, Math.min(1, value));
  const x = v * horizontalRange;
  handle.style.left = `${x}px`;
}

/** Thumb centre at `clientX` → normalised 0–1 (aligns drag start with pointer / visual thumb). */
export function hfaderValueFromClientX(fader: HTMLElement, handle: HTMLElement, clientX: number): number {
  const rect = fader.getBoundingClientRect();
  if (rect.width === 0) return 0;
  const horizontalRange = Math.max(1, rect.width - handle.offsetWidth);
  const x = clientX - rect.left;
  const v = (x - handle.offsetWidth / 2) / horizontalRange;
  return Math.max(0, Math.min(1, v));
}

function updateAudioCard(root: HTMLElement, snapshot: CameraSnapshot): void {
  const a = snapshot.audio;
  setMiniFaderMirror(root, "audio-left", "audioLeftSlider", a.inputLevels?.left);
  setMiniFaderMirror(root, "audio-right", "audioRightSlider", a.inputLevels?.right);
  setMiniFaderMirror(root, "audio-mic", "audioMic", a.micLevel);
  setMiniFaderMirror(root, "audio-headphone", "audioHeadphone", a.headphoneLevel);
  setMiniFaderMirror(root, "audio-program-mix", "audioProgramMix", a.headphoneProgramMix);
  setMiniFaderMirror(root, "audio-speaker", "audioSpeaker", a.speakerLevel);

  const inputType = root.querySelector<HTMLSelectElement>("[data-audio-input-type]");
  if (inputType && a.inputType !== undefined && document.activeElement !== inputType) {
    inputType.value = String(a.inputType);
  }
  const phantomLed = root.querySelector<HTMLElement>("[data-audio-phantom-led]");
  if (phantomLed) {
    phantomLed.classList.toggle("on", a.phantomPower === true);
  }
}


function updateUnitOutputs(root: HTMLElement, snapshot: CameraSnapshot): void {
  const barsOn = snapshot.unitOutputs?.colorBars === true;
  root.querySelectorAll<HTMLButtonElement>("[data-color-bars]").forEach((bars) => {
    bars.classList.toggle("active", barsOn);
    bars.setAttribute("aria-pressed", barsOn ? "true" : "false");
  });
  const pgmOn = snapshot.unitOutputs?.programReturnFeed === true;
  root.querySelectorAll<HTMLButtonElement>("[data-program-return-feed]").forEach((pgmRet) => {
    pgmRet.classList.toggle("active", pgmOn);
    pgmRet.setAttribute("aria-pressed", pgmOn ? "true" : "false");
  });
  root.querySelectorAll<HTMLElement>("[data-bars-led]").forEach((el) => {
    el.classList.toggle("on", barsOn);
  });
  root.querySelectorAll<HTMLElement>("[data-program-return-led]").forEach((el) => {
    el.classList.toggle("on", pgmOn);
  });
}

function updateVideoCard(root: HTMLElement, snapshot: CameraSnapshot): void {
  setSegmentedValue(root, "[data-video-dynamic-range]", snapshot.dynamicRange);
  setSegmentedValue(root, "[data-video-sharpening]", snapshot.sharpeningLevel);

  const lutSelect = root.querySelector<HTMLSelectElement>("[data-video-display-lut]");
  if (lutSelect && snapshot.displayLut?.selected !== undefined && document.activeElement !== lutSelect) {
    lutSelect.value = String(snapshot.displayLut.selected);
  }
  const lutEnabled = root.querySelector<HTMLInputElement>("[data-video-display-lut-enabled]");
  if (lutEnabled && snapshot.displayLut?.enabled !== undefined && document.activeElement !== lutEnabled) {
    lutEnabled.checked = snapshot.displayLut.enabled;
  }

  const autoWbOn = snapshot.autoWhiteBalanceActive === true;
  root.querySelectorAll<HTMLButtonElement>("[data-video-set-auto-wb]").forEach((button) => {
    button.classList.toggle("active", autoWbOn);
    button.setAttribute("aria-pressed", autoWbOn ? "true" : "false");
  });

  setMiniFaderMirror(root, "tally-master", "tallyMaster", snapshot.tally?.brightness?.master);
  setMiniFaderMirror(root, "tally-front", "tallyFront", snapshot.tally?.brightness?.front);
  setMiniFaderMirror(root, "tally-rear", "tallyRear", snapshot.tally?.brightness?.rear);

  const frameRateSelect = root.querySelector<HTMLSelectElement>("[data-video-frame-rate]");
  if (frameRateSelect && snapshot.recordingFormat?.frameRate !== undefined && document.activeElement !== frameRateSelect) {
    const v = String(Math.round(snapshot.recordingFormat.frameRate));
    if ([...frameRateSelect.options].some((o) => o.value === v)) {
      frameRateSelect.value = v;
    }
  }
  const offSpeedInput = root.querySelector<HTMLInputElement>("[data-video-off-speed-rate]");
  if (offSpeedInput && snapshot.offSpeedFrameRate !== undefined && document.activeElement !== offSpeedInput) {
    offSpeedInput.value = String(snapshot.offSpeedFrameRate);
  }
}

function setSegmentedValue(root: HTMLElement, selector: string, value: number | undefined): void {
  if (value === undefined) return;
  const group = root.querySelector<HTMLElement>(selector);
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>(".segmented-option").forEach((opt) => {
    const active = Number(opt.dataset.value ?? "-1") === value;
    opt.classList.toggle("active", active);
    opt.setAttribute("aria-checked", active ? "true" : "false");
  });
}

function formatRecordingFormat(snapshot: CameraSnapshot): string {
  const format = snapshot.recordingFormat;

  if (!format) {
    return "---";
  }

  const { frameWidth, frameHeight, frameRate } = format;
  const size = frameWidth && frameHeight ? `${frameWidth}x${frameHeight}` : "";
  const rate = frameRate ? ` @${frameRate}` : "";
  return `${size}${rate}`.trim() || "---";
}

function formatCodec(codec: CameraSnapshot["codec"]): string {
  if (!codec) return "---";
  const basics: Record<number, string> = {
    0: "CinemaDNG",
    1: "DNxHD",
    2: "ProRes",
    3: "BRAW",
  };
  const base = basics[codec.basic] ?? `C${codec.basic}`;
  return `${base}.${codec.variant}`;
}
