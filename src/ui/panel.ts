import type { CameraSnapshot } from "../blackmagic/cameraState";

export const CAMERA_COUNT = 8;
export const PAINT_CHANNELS = ["red", "green", "blue", "luma"] as const;
export type PaintChannel = (typeof PAINT_CHANNELS)[number];
export const PAINT_GROUPS = ["lift", "gamma", "gain"] as const;
export type PaintGroup = (typeof PAINT_GROUPS)[number];

export const COLOR_GROUP_RANGES: Record<PaintGroup, { min: number; max: number; default: number }> = {
  lift: { min: -2, max: 2, default: 0 },
  gamma: { min: -4, max: 4, default: 0 },
  gain: { min: 0, max: 16, default: 1 },
};

function formatScale(value: number): string {
  if (Number.isInteger(value)) return value > 0 ? `+${value}` : `${value}`;
  const fixed = value.toFixed(1);
  return value > 0 ? `+${fixed}` : fixed;
}

function renderAudioFader(dataAttr: string, readoutKey: string, label: string): string {
  return `
    <div class="audio-fader-cell">
      <span class="audio-fader-readout" data-readout="${readoutKey}">0.50</span>
      <div class="mini-fader" data-mini-fader="${dataAttr}" data-control aria-label="${label}">
        <div class="mini-fader-scale">
          <span>+</span>
          <span></span>
          <span></span>
          <span></span>
          <span></span>
          <span>-</span>
        </div>
        <div class="mini-fader-track"></div>
        <div class="mini-fader-handle" data-mini-fader-handle>
          <div class="mini-fader-cap"></div>
        </div>
      </div>
      <span class="audio-fader-label">${label}</span>
    </div>
  `;
}

function renderStepper(stepperId: string, label: string, readoutKey: string, defaultText: string): string {
  return `
    <div class="stepper-cell" data-stepper="${stepperId}">
      <div class="segmented stepper-segment" data-readout="${readoutKey}">${defaultText}</div>
      <div class="stepper-buttons">
        <button class="stepper-btn" data-stepper-up="${stepperId}" data-control aria-label="${label} up">▲</button>
        <button class="stepper-btn" data-stepper-down="${stepperId}" data-control aria-label="${label} down">▼</button>
      </div>
      <span class="stepper-label">${label}</span>
    </div>
  `;
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
                <span class="readout-mini" data-color-readout>${defaultValue.toFixed(2)}</span>
                <div
                  class="mini-fader color-vfader"
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
                    <span>${formatScale(max)}</span><span></span><span>${formatScale(defaultValue)}</span><span></span><span></span><span>${formatScale(min)}</span>
                  </div>
                  <div class="mini-fader-track"></div>
                  <div class="mini-fader-handle" data-vfader-handle>
                    <div class="mini-fader-cap"></div>
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
      <div class="color-extras-meta">
        <span class="color-extras-label">${label}</span>
        <span class="readout-mini" data-readout="${readoutKey}">${defaultValue.toFixed(2)}</span>
      </div>
      <div
        class="h-fader color-hfader"
        data-control
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
        <div class="h-fader-scale">
          <span>${formatScale(min)}</span><span></span><span>${formatScale(defaultValue)}</span><span></span><span></span><span>${formatScale(max)}</span>
        </div>
        <div class="h-fader-track"></div>
        <div class="h-fader-handle" data-hfader-handle>
          <div class="h-fader-cap"></div>
        </div>
      </div>
    </div>
  `;
}

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

/** Show Bluefy install prompt once modal is in the DOM (iOS + no Web Bluetooth only). */
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
    document.removeEventListener("keydown", onKeyDown);
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  backdrop.hidden = false;
  document.body.classList.add("bluefy-modal-open");

  backdrop.querySelector("[data-bluefy-dismiss]")?.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKeyDown);
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
          <button type="button" class="bluefy-modal-dismiss" data-bluefy-dismiss>Not now</button>
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

export function renderPanelTemplate(isSupported: boolean): string {
  const channelLabel = (channel: PaintChannel): string =>
    channel === "luma" ? "Y" : channel.charAt(0).toUpperCase();
  const channelClass = (channel: PaintChannel): string => (channel === "luma" ? "luma" : channel);

  const paintKnobs = PAINT_GROUPS.flatMap((group) =>
    PAINT_CHANNELS.map(
      (channel) => `
        <div class="knob-cell" data-paint-cell data-group="${group}" data-channel="${channel}" data-control>
          <div class="knob knob-${channelClass(channel)}" data-knob>
            <div class="knob-indicator" data-knob-indicator></div>
          </div>
          <div class="knob-meta">
            <span class="knob-label">${group} ${channelLabel(channel)}</span>
            <span class="knob-value" data-paint-value>0.00</span>
          </div>
        </div>
      `,
    ),
  ).join("");

  return `
    <main class="panel-app">
      <header class="panel-hero">
        <div>
          <p class="eyebrow">Blackmagic Camera Control</p>
          <h1>Camera Control Panel</h1>
          <p data-support class="${isSupported ? "ok" : "warn"}">
            Web Bluetooth ${isSupported ? "is available" : "is not available"} in this browser.
          </p>
          ${
            isSupported
              ? ""
              : `<p data-support-detail class="warn support-detail">${webBluetoothUnsupportedDetail()}</p>`
          }
        </div>
        <div class="connection-controls">
          <p data-connection class="pill">Disconnected</p>
          <div class="button-row">
            <button data-connect ${isSupported ? "" : "disabled"}>Connect</button>
            <button data-disconnect data-control>Disconnect</button>
            <button data-power data-control class="power-btn" aria-pressed="false">
              <span class="power-led"></span>
              <span data-power-label>Power On</span>
            </button>
          </div>
          <label class="auto-reconnect-toggle">
            <input data-auto-reconnect type="checkbox" checked />
            Auto-reconnect on drop
          </label>
        </div>
      </header>

      <section class="chassis">
        <div class="chassis-row stepper-row">
          ${renderStepper("wb", "White Bal", "wb", "5600")}
          ${renderStepper("tint", "Tint", "tint", "0")}
          ${renderStepper("gain", "Master Gain", "gain", "0.0")}
          ${renderStepper("iso", "ISO", "iso", "----")}
          ${renderStepper("shutter", "Shutter", "shutter", "0180")}
          ${renderStepper("nd", "ND Stops", "nd", "--")}
          <div class="stepper-cell auto-exp-cell">
            <button class="auto-exp-btn" data-auto-exp data-control aria-pressed="false">
              <span class="auto-exp-led"></span>
              <span class="auto-exp-text" data-readout="autoexp">MANUAL</span>
            </button>
            <span class="stepper-label">Auto Exp</span>
          </div>
          <div class="stepper-cell unit-btn-cell">
            <span class="unit-btn-indicator">ABS</span>
            <span class="unit-btn-led" data-wb-led></span>
            <button class="unit-btn" data-video-set-auto-wb data-control aria-label="Set auto white balance">W/B</button>
            <span class="stepper-label">White Bal</span>
          </div>
          <div class="stepper-cell unit-btn-cell">
            <span class="unit-btn-indicator">BARS</span>
            <span class="unit-btn-led" data-bars-led></span>
            <button
              class="unit-btn"
              type="button"
              data-color-bars
              data-control
              aria-label="Color bars — hold 1s to enable, tap to disable"
            >BARS</button>
            <span class="stepper-label">Color Bars</span>
          </div>
        </div>

        <div class="chassis-row camera-row">
          <div class="paint-area">
            <div class="paint-knobs">${paintKnobs}</div>
            <div class="paint-actions">
              <span class="paint-actions-hint">Drag knobs to adjust. Y = luma (master).</span>
              <div class="paint-actions-buttons">
                <button data-color-adv data-control class="adv-btn" aria-pressed="false" aria-controls="color-card">
                  ADV
                </button>
                <button data-color-reset data-control>Color Reset</button>
              </div>
            </div>
          </div>
        </div>

        <div class="chassis-row scene-file-row">
          <span class="scene-file-label">SCENE FILE</span>
          <div class="scene-file-banks" data-scene-banks>
            ${Array.from({ length: 5 }, (_, index) => {
              const slot = index;
              return `
                <button
                  class="scene-bank"
                  data-scene-bank
                  data-bank-slot="${slot}"
                  data-control
                  aria-label="Scene file ${slot + 1}"
                  aria-pressed="false"
                >
                  <span class="scene-bank-label">${slot + 1}</span>
                  <span class="scene-bank-led"></span>
                </button>
              `;
            }).join("")}
          </div>
          <button class="scene-store" data-scene-store data-control aria-pressed="false">
            STORE
          </button>
        </div>

        <div class="chassis-row iris-row">
          <div class="iris-left">
            <div class="camera-pillar" data-camera-pillar role="listbox" aria-label="Select camera">
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

            <div class="iris-readouts">
              <div class="readout-block">
                <div class="segmented big" data-readout="iris">F--</div>
                <span class="readout-label">IRIS</span>
              </div>
              <div class="readout-block">
                <div class="segmented big" data-readout="masterBlackReadout">0.0</div>
                <span class="readout-label">MASTER BLACK</span>
              </div>
              <div class="readout-block">
                <div class="segmented" data-readout="focus">--</div>
                <span class="readout-label">FOCUS</span>
              </div>
              <div class="readout-block">
                <div class="segmented" data-readout="format">---</div>
                <span class="readout-label">FORMAT</span>
              </div>
              <div class="readout-block">
                <div class="segmented" data-readout="codec">---</div>
                <span class="readout-label">CODEC</span>
              </div>
              <div class="readout-block">
                <div class="segmented" data-readout="tintReadout">0</div>
                <span class="readout-label">TINT</span>
              </div>
              <div class="readout-block">
                <div class="segmented" data-readout="ndReadout">--</div>
                <span class="readout-label">ND</span>
              </div>
              <div class="readout-block tally-block">
                <div class="tally-dots">
                  <span class="tally-dot tally-pgm" data-tally="program">PGM</span>
                  <span class="tally-dot tally-pvw" data-tally="preview">PVW</span>
                </div>
                <span class="readout-label">TALLY</span>
              </div>
            </div>
          </div>

          <div class="iris-center">
            <div class="iris-wheel">
              <div class="iris-wheel-ring"></div>
              <div class="iris-wheel-knob" data-iris-wheel>
                <div class="iris-wheel-marker" data-iris-wheel-marker></div>
              </div>
              <span class="iris-wheel-label">MASTER BLACK</span>
            </div>
            <div class="iris-coarse">
              <span class="iris-coarse-label close">-2.0</span>
              <span class="iris-coarse-divider"></span>
              <span class="iris-coarse-label open">+2.0</span>
            </div>
            <div class="focus-fader-wrapper">
              <span class="focus-fader-label">FOCUS</span>
              <div class="h-fader" data-h-fader="focus" data-control aria-label="Focus (horizontal drag)">
                <div class="h-fader-scale">
                  <span>NEAR</span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span></span>
                  <span>FAR</span>
                </div>
                <div class="h-fader-track"></div>
                <div class="h-fader-handle" data-h-fader-handle>
                  <div class="h-fader-cap"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="iris-fader-column">
            <div class="iris-joystick" data-iris-joystick data-control aria-label="Iris (vertical drag)">
              <div class="iris-joystick-scale">
                <span>L</span>
                <span>8.0</span>
                <span>11</span>
                <span>16</span>
                <span>22</span>
                <span>CLS</span>
              </div>
              <div class="iris-joystick-track"></div>
              <div class="iris-joystick-handle" data-iris-joystick-handle>
                <div class="iris-joystick-stick"></div>
                <div class="iris-joystick-cap"></div>
              </div>
            </div>
            <span class="iris-label">IRIS</span>
          </div>

          <div class="iris-side-buttons">
            <button class="side-btn" data-iris-mb-active data-control>IRIS/MB<br />ACTIVE</button>
            <button class="side-btn" data-auto-aperture data-control>AUTO<br />IRIS</button>
            <button class="side-btn" data-autofocus data-control>AUTO<br />FOCUS</button>
            <button class="side-btn record-btn" data-record-start data-control>REC</button>
            <button class="side-btn stop-btn" data-record-stop data-control>STOP</button>
            <button class="side-btn" data-still-capture data-control>STILL</button>
            <button
              class="side-btn bars-btn"
              type="button"
              data-program-return-feed
              data-control
              aria-label="Program return feed — hold 3s to show program on monitor, tap when lit to turn off"
            >
              <span class="side-btn-led" data-program-return-led></span>
              PGM<br />RET
            </button>
          </div>
        </div>

        <div class="chassis-row panel-footer-row">
          <div class="footer-buttons">
            <button class="footer-btn" data-panel-active data-control>
              <span class="footer-btn-label">PANEL<br />ACTIVE</span>
            </button>
            <div class="footer-leds">
              <span class="footer-led" data-led="connected">NETWORK</span>
              <span class="footer-led" data-led="recording">ALARM</span>
              <span class="footer-led" data-led="paired">CABLE</span>
            </div>
          </div>
          <div class="footer-buttons-right">
            <button class="footer-btn" data-video-toggle data-control aria-pressed="false" aria-controls="video-card">VIDEO</button>
            <button class="footer-btn" data-audio-toggle data-control aria-pressed="false" aria-controls="audio-card">AUDIO</button>
            <button class="footer-btn" data-preview data-control>PREVIEW</button>
            <button class="footer-btn" data-call data-control>CALL</button>
          </div>
        </div>
      </section>

      <section class="card color-card" data-color-card id="color-card" hidden>
        <div class="card-header">
          <h2>Color Correction</h2>
          <button data-color-reset-card data-control>Reset</button>
        </div>
        <div class="card-body color-body">
          ${renderColorGroup("lift", "Lift", -2, 2, 0)}
          ${renderColorGroup("gamma", "Gamma", -4, 4, 0)}
          ${renderColorGroup("gain", "Gain", 0, 16, 1)}
          <div class="color-extras">
            ${renderColorHFader("contrast-pivot", "Contrast pivot", 0, 1, 0.5, "contrastPivot")}
            ${renderColorHFader("contrast-adjust", "Contrast adjust", 0, 2, 1, "contrastAdjust")}
            ${renderColorHFader("luma-mix", "Luma mix", 0, 1, 1, "lumaMix")}
            ${renderColorHFader("hue", "Hue", -1, 1, 0, "hue")}
            ${renderColorHFader("saturation", "Saturation", 0, 2, 1, "saturation")}
          </div>
        </div>
      </section>

      <section class="card audio-card" data-audio-card id="audio-card" hidden>
        <div class="card-header">
          <h2>Audio</h2>
          <button data-audio-reset data-control>Reset</button>
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

      <section class="card video-card" data-video-card id="video-card" hidden>
        <div class="card-header">
          <h2>Video</h2>
        </div>
        <div class="card-body video-body">
          <div class="video-row">
            <span class="video-row-label">Auto white balance</span>
            <div class="video-row-actions">
              <button data-video-set-auto-wb data-control>SET AUTO WB</button>
              <button data-video-restore-auto-wb data-control>RESTORE AUTO WB</button>
            </div>
          </div>

          <div class="video-row">
            <span class="video-row-label">Dynamic range</span>
            <div class="segmented-group" role="radiogroup" data-video-dynamic-range>
              <button class="segmented-option" data-control data-value="0" role="radio" aria-checked="false">Film</button>
              <button class="segmented-option" data-control data-value="1" role="radio" aria-checked="false">Video</button>
              <button class="segmented-option" data-control data-value="2" role="radio" aria-checked="false">Extended Video</button>
            </div>
          </div>

          <div class="video-row">
            <span class="video-row-label">Sharpening</span>
            <div class="segmented-group" role="radiogroup" data-video-sharpening>
              <button class="segmented-option" data-control data-value="0" role="radio" aria-checked="false">Off</button>
              <button class="segmented-option" data-control data-value="1" role="radio" aria-checked="false">Low</button>
              <button class="segmented-option" data-control data-value="2" role="radio" aria-checked="false">Medium</button>
              <button class="segmented-option" data-control data-value="3" role="radio" aria-checked="false">High</button>
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

          <div class="video-row video-row-grid">
            <span class="video-row-label">Exposure</span>
            <div class="stepper-cell" data-stepper="exposure">
              <div class="segmented stepper-segment" data-readout="exposureUs">----</div>
              <div class="stepper-buttons">
                <button class="stepper-btn" data-stepper-up="exposure" data-control aria-label="Exposure up">▲</button>
                <button class="stepper-btn" data-stepper-down="exposure" data-control aria-label="Exposure down">▼</button>
              </div>
              <span class="stepper-label">µs</span>
            </div>
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

      <section class="card status-card">
        <h2>Camera Status</h2>
        <ul class="status-flags" data-status>
          <li>No camera status yet</li>
        </ul>
      </section>

      <section class="card">
        <div class="log-header">
          <h2>Debug Log</h2>
          <button data-clear-log>Clear</button>
        </div>
        <ul class="debug-log" data-log></ul>
      </section>
      ${!isSupported && isIosLikeWebBluetoothBlocked() ? renderBluefyOfferModal() : ""}
    </main>
  `;
}

export function updatePanel(root: HTMLElement, snapshot: CameraSnapshot): void {
  setReadout(root, "gain", formatGain(snapshot.gainDb));
  setReadout(root, "shutter", formatShutter(snapshot));
  setReadout(root, "autoexp", formatAutoExp(snapshot.autoExposureMode));
  updateAutoExpButton(root, snapshot.autoExposureMode);
  updatePowerButton(root, snapshot.status?.powerOn ?? false);
  setReadout(root, "iris", formatIris(snapshot));
  setReadout(root, "focus", formatFocus(snapshot.lens.focus));
  setReadout(root, "masterBlackReadout", formatMasterBlack(snapshot.color.lift.luma));
  setReadout(root, "wb", formatWhiteBalance(snapshot.whiteBalance));
  setReadout(root, "tint", formatTint(snapshot.whiteBalance?.tint));
  setReadout(root, "tintReadout", formatTint(snapshot.whiteBalance?.tint));
  setReadout(root, "iso", formatIso(snapshot.iso));
  setReadout(root, "nd", formatNd(snapshot.ndFilterStops));
  setReadout(root, "ndReadout", formatNd(snapshot.ndFilterStops));
  setReadout(root, "format", formatRecordingFormat(snapshot));
  setReadout(root, "codec", formatCodec(snapshot.codec));

  updateAudioCard(root, snapshot);
  updateVideoCard(root, snapshot);
  updatePaintKnobs(root, snapshot);
  updateColorCard(root, snapshot);
  updateCameraPillar(root, snapshot.cameraNumber);
  updateIrisWheel(root, snapshot);
  updateIrisJoystick(root, snapshot);
  updateFocusFader(root, snapshot);
  updateLeds(root, snapshot);
  updateRecording(root, snapshot.recording);
}

export interface SceneBanksUiState {
  filledSlots: boolean[];
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
    button.classList.toggle("filled", filled);
    button.classList.toggle("loaded", loaded);
    button.classList.toggle("dirty", loaded && Boolean(ui.dirty));
    button.setAttribute("aria-pressed", loaded ? "true" : "false");
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

export const MASTER_GAIN_RANGE = { min: -12, max: 30 };
export const MASTER_BLACK_RANGE = { min: -2, max: 2 };

function updateIrisWheel(root: HTMLElement, snapshot: CameraSnapshot): void {
  const marker = root.querySelector<HTMLElement>("[data-iris-wheel-marker]");
  if (!marker) return;

  const norm = masterBlackToNormalised(snapshot.color.lift.luma ?? 0);
  const angle = norm * 270 - 135;
  marker.style.transform = `rotate(${angle}deg)`;
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
  const value = snapshot.lens.focus;
  if (value === undefined) return;
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

export function positionIrisHandle(joystick: HTMLElement, handle: HTMLElement, irisNormalised: number): void {
  const rect = joystick.getBoundingClientRect();
  if (rect.height === 0 || rect.width === 0) return;

  const verticalRange = rect.height - handle.offsetHeight;
  const iris = Math.max(0, Math.min(1, irisNormalised));
  const y = (1 - iris) * verticalRange;
  handle.style.transform = `translate(-50%, ${y}px)`;
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
      readout.textContent = value.toFixed(2);
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
  setReadout(root, readoutKey, value.toFixed(2));
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
  if (n >= 0.5) return def + ((n - 0.5) / 0.5) * (max - def);
  return def - ((0.5 - n) / 0.5) * (def - min);
}

export function positionVerticalFader(fader: HTMLElement, handle: HTMLElement, value: number): void {
  const height = fader.clientHeight;
  if (height === 0) return;
  const norm = valueToCenteredNorm(value, readFaderRange(fader));
  const verticalRange = Math.max(0, height - handle.offsetHeight - FADER_PADDING_PX * 2);
  const y = FADER_PADDING_PX + (1 - norm) * verticalRange;
  handle.style.transform = `translate(-50%, ${y}px)`;
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
  gain: { min: 0, max: 16, default: 1 },
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
    const indicator = cell.querySelector<HTMLElement>("[data-knob-indicator]");
    const readout = cell.querySelector<HTMLElement>("[data-paint-value]");

    if (indicator) {
      indicator.style.transform = `rotate(${paintValueToAngle(group, value)}deg)`;
    }

    if (readout) {
      readout.textContent = value.toFixed(2);
    }
  });
}

function updateLeds(root: HTMLElement, snapshot: CameraSnapshot): void {
  const status = snapshot.status;
  toggleLed(root, "power", status?.powerOn ?? false);
  toggleLed(root, "connected", status?.connected ?? false);
  toggleLed(root, "paired", status?.paired ?? false);
  toggleLed(root, "ready", status?.cameraReady ?? false);
  toggleLed(root, "recording", snapshot.recording);

  const pgm = root.querySelector<HTMLElement>('[data-tally="program"]');
  const pvw = root.querySelector<HTMLElement>('[data-tally="preview"]');
  if (pgm) pgm.classList.toggle("on", snapshot.tally?.programMe === true);
  if (pvw) pvw.classList.toggle("on", snapshot.tally?.previewMe === true);
}

function updateRecording(root: HTMLElement, recording: boolean): void {
  root.querySelector<HTMLElement>("[data-record-start]")?.classList.toggle("active", recording);
}

function toggleLed(root: HTMLElement, name: string, on: boolean): void {
  const led = root.querySelector<HTMLElement>(`[data-led="${name}"]`);
  if (led) {
    led.classList.toggle("on", on);
  }
}

function setReadout(root: HTMLElement, name: string, value: string): void {
  const element = root.querySelector<HTMLElement>(`[data-readout="${name}"]`);
  if (element) {
    element.textContent = value;
  }
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
  if (stops === undefined || Number.isNaN(stops)) return "--";
  if (stops <= 0.05) return "CLR";
  return `${stops.toFixed(1)}`;
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
  const rect = fader.getBoundingClientRect();
  if (rect.height === 0) return;
  const verticalRange = rect.height - handle.offsetHeight;
  const v = Math.max(0, Math.min(1, value));
  const y = (1 - v) * verticalRange;
  handle.style.top = `${y}px`;
}

export function positionHFaderHandle(fader: HTMLElement, handle: HTMLElement, value: number): void {
  const rect = fader.getBoundingClientRect();
  if (rect.width === 0) return;
  const horizontalRange = rect.width - handle.offsetWidth;
  const v = Math.max(0, Math.min(1, value));
  const x = v * horizontalRange;
  handle.style.left = `${x}px`;
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

  setReadout(root, "exposureUs", snapshot.exposureUs !== undefined ? String(snapshot.exposureUs) : "----");

  setMiniFaderMirror(root, "tally-master", "tallyMaster", snapshot.tally?.brightness?.master);
  setMiniFaderMirror(root, "tally-front", "tallyFront", snapshot.tally?.brightness?.front);
  setMiniFaderMirror(root, "tally-rear", "tallyRear", snapshot.tally?.brightness?.rear);
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
