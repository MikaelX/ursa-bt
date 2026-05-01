/**
 * BM Pattern Library — renders every component recipe defined in
 * .cursor/rules/ui-design.mdc with live, interactive examples.
 *
 * Self-contained: no dependencies on the main app or its state.
 */

// ---------------------------------------------------------------------------
// Section types
// ---------------------------------------------------------------------------

type Section = {
  id: string;
  title: string;
  lead: string;
  render: (host: HTMLElement) => void;
};

const SECTIONS: Section[] = [
  { id: "buttons",   title: "Buttons",                 lead: "Physical hardware keys. Three-layer depth, press-down feedback, optional engaged or call (destructive) variants.", render: renderButtons },
  { id: "stepper",   title: "Stepper buttons",         lead: "Up/down increment keys with engraved arrow glyphs. Hold to auto-repeat with acceleration.", render: renderStepper },
  { id: "leds",      title: "Status LEDs",             lead: "Tiny round indicators above an uppercase label. Three states: off, on, blink. Color is semantic.", render: renderLeds },
  { id: "camid",     title: "Dot-matrix display",      lead: "Retro 5×7 LED grid for the single most important live readout (selected camera ID).", render: renderCamId },
  { id: "seg1",      title: "Single-digit 7-segment",  lead: "One amber digit on a recessed dark panel. Off-segments stay visible as the iconic ghost-8.", render: renderSeg1 },
  { id: "seg2",      title: "Two-digit 7-segment",     lead: "Two digits sharing one recessed window, decimal point as the 8th segment of the integer digit.", render: renderSeg2 },
  { id: "seg4",      title: "Four-digit 7-segment",    lead: "Wider shared window for shutter, ISO, focus distance and similar fixed-format readouts.", render: renderSeg4 },
  { id: "minipot",   title: "Mini-pot",                lead: "Small machined potentiometer with a 4px white indicator dot. Vertical drag adjusts value; ±135° sweep.", render: renderMiniPot },
  { id: "insidepot", title: "Inside-pot",              lead: "Premium rotary with knurled rubber rim, recessed center face, amber indicator line, and an outer tick ring.", render: renderInsidePot },
  { id: "divider",   title: "Dividers",                lead: "Horizontal grooves between control groups, like seams between chassis panels. Three layers of light tell the story.", render: renderDivider },
  { id: "glass",     title: "Glass buttons",           lead: "Color-tinted illuminated lozenges for camera selection, tally, and on-air status. Use sparingly.", render: renderGlass },
  { id: "tbar",      title: "T-bar fader",             lead: "Tall recessed shaft, brushed-chrome handle, optional LED ladder. One per screen — primary transition control.", render: renderTBar },
  { id: "fader",     title: "Audio fader",             lead: "Horizontal dB slider with three-color level meter. Out of MVP scope; reference only.", render: renderFader },
  { id: "vfader",    title: "Audio fader (vertical)",  lead: "Tall channel-strip dB slider. Travel matches a console linear fader; rung-meter rises with level, color-tints into amber and red.", render: renderVFader },
  { id: "pan",       title: "Audio pan pot",           lead: "Bipolar knob with center detent. Orange arc radiates outward from 12 o'clock. Out of MVP scope.", render: renderPan },
  { id: "gain",      title: "Audio gain pot",          lead: "Bipolar dB knob centered at unity (0 dB straight up). Sweep −∞ to +30 dB; arc grows from the top toward the indicator. Out of MVP scope.", render: renderGain },
  { id: "mfaders",   title: "Mini volume faders",      lead: "Strip of monitor-level sliders with icon labels and per-fader mute. Out of MVP scope.", render: renderMiniFaders },
];

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

export function renderPatternLibrary(root: HTMLElement): void {
  root.innerHTML = "";
  const page = el("div", "pl");

  page.appendChild(hero());
  page.appendChild(nav());

  for (const sec of SECTIONS) {
    const section = el("section", "pl__section");
    section.id = sec.id;
    section.appendChild(h2(sec.title));
    section.appendChild(p("pl__lead", sec.lead));
    const demo = el("div", "pl__demo");
    sec.render(demo);
    section.appendChild(demo);
    page.appendChild(section);
  }

  root.appendChild(page);
}

function hero(): HTMLElement {
  const h = el("header", "pl__hero");
  const t = el("h1", "pl__title");
  t.textContent = "BM Pattern Library";
  const s = el("p", "pl__subtitle");
  s.textContent =
    "Live reference for the hardware-panel design language. Components mirror .cursor/rules/ui-design.mdc.";
  h.appendChild(t);
  h.appendChild(s);
  return h;
}

function nav(): HTMLElement {
  const n = el("nav", "pl__nav");
  for (const s of SECTIONS) {
    const a = document.createElement("a");
    a.href = `#${s.id}`;
    a.textContent = s.title;
    n.appendChild(a);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

function renderButtons(host: HTMLElement): void {
  host.appendChild(button("AUTO IRIS"));
  host.appendChild(button("IRIS/MB ACTIVE", "bm-btn--active"));
  host.appendChild(button("CALL", "bm-btn--call"));
  const disabled = button("DISABLED");
  disabled.disabled = true;
  host.appendChild(disabled);
}

function button(label: string, mod = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `bm-btn ${mod}`.trim();
  b.textContent = label;
  return b;
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------

function renderStepper(host: HTMLElement): void {
  const wrap = el("div", "bm-stepper");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Iris adjustment");

  wrap.appendChild(stepperBtn("up", "Increase"));
  wrap.appendChild(stepperBtn("down", "Decrease"));

  let value = 50;

  const readoutDigits = el("div", "bm-seg2__display");
  readoutDigits.setAttribute("aria-hidden", "true");

  const updateDigits = (v: number): void => {
    readoutDigits.replaceChildren();
    for (const ch of String(v)) {
      const d = makeDigit();
      paintDigit(d, ch, false);
      readoutDigits.appendChild(d);
    }
  };
  updateDigits(value);

  const readout = el("div", "bm-stepper__readout");
  readout.setAttribute("role", "status");
  readout.setAttribute("aria-live", "polite");
  readout.setAttribute("aria-atomic", "true");
  readout.setAttribute("aria-label", `Value ${value}`);
  readout.appendChild(readoutDigits);

  attachStepper(wrap, {
    onStep: (dir) => {
      value = clamp(value + dir, 0, 100);
      updateDigits(value);
      readout.setAttribute("aria-label", `Value ${value}`);
    },
  });

  const row = el("div");
  row.style.display = "inline-flex";
  row.style.alignItems = "center";
  row.style.gap = "12px";
  row.appendChild(wrap);
  row.appendChild(readout);
  host.appendChild(row);
}

function stepperBtn(dir: "up" | "down", aria: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bm-stepper__btn";
  b.dataset.dir = dir;
  b.setAttribute("aria-label", aria);
  b.innerHTML =
    dir === "up"
      ? `<svg class="bm-stepper__glyph" viewBox="0 0 16 16" aria-hidden="true"><polygon points="8,3 14,12 2,12"/></svg>`
      : `<svg class="bm-stepper__glyph" viewBox="0 0 16 16" aria-hidden="true"><polygon points="2,4 14,4 8,13"/></svg>`;
  return b;
}

function attachStepper(
  root: HTMLElement,
  opts: { onStep: (dir: 1 | -1) => void },
): void {
  const initialDelay = 400;
  const startInterval = 120;
  const minInterval = 30;
  const accel = 0.9;

  for (const btn of root.querySelectorAll<HTMLButtonElement>(".bm-stepper__btn")) {
    const dir = btn.dataset.dir === "up" ? 1 : -1;
    let holdTimer: number | undefined;
    let repeatTimer: number | undefined;
    let interval = startInterval;

    const stop = () => {
      window.clearTimeout(holdTimer);
      window.clearTimeout(repeatTimer);
      btn.dataset.repeating = "false";
      interval = startInterval;
    };
    const tick = () => {
      opts.onStep(dir as 1 | -1);
      interval = Math.max(minInterval, interval * accel);
      repeatTimer = window.setTimeout(tick, interval);
    };

    btn.addEventListener("pointerdown", (e) => {
      btn.setPointerCapture(e.pointerId);
      opts.onStep(dir as 1 | -1);
      holdTimer = window.setTimeout(() => {
        btn.dataset.repeating = "true";
        tick();
      }, initialDelay);
    });
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("pointerleave", stop);

    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.onStep(dir as 1 | -1);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Status LEDs
// ---------------------------------------------------------------------------

function renderLeds(host: HTMLElement): void {
  const row = el("div", "bm-status-leds");

  row.appendChild(led("on",    "NETWORK", "green", "Network: connected"));
  row.appendChild(led("blink", "REC",     "red",   "Recording"));
  row.appendChild(led("on",    "TALLY",   "amber", "Tally: standby"));
  row.appendChild(led("off",   "FAULT",   "red",   "No fault"));

  host.appendChild(row);
}

function led(
  state: "off" | "on" | "blink",
  label: string,
  color: "green" | "red" | "amber",
  aria: string,
): HTMLElement {
  const cell = el("div", `bm-led bm-led--${color}`);
  cell.dataset.state = state;
  cell.setAttribute("role", "status");
  cell.setAttribute("aria-label", aria);
  const lamp = el("span", "bm-led__lamp");
  const lab = el("span", "bm-led__label");
  lab.textContent = label;
  cell.appendChild(lamp);
  cell.appendChild(lab);
  // map "green" → default vars
  if (color === "green") {
    // already default, no-op
  }
  return cell;
}

// ---------------------------------------------------------------------------
// Dot-matrix camera ID
// ---------------------------------------------------------------------------

const FONT_5x7: Record<string, string[]> = {
  "0": [".###.","#...#","#..##","#.#.#","##..#","#...#",".###."],
  "1": ["..#..",".##..","..#..","..#..","..#..","..#..",".###."],
  "2": [".###.","#...#","....#","...#.","..#..",".#...","#####"],
  "3": [".###.","#...#","....#","..##.","....#","#...#",".###."],
  "4": ["...#.","..##.",".#.#.","#..#.","#####","...#.","...#."],
  "5": ["#####","#....","####.","....#","....#","#...#",".###."],
  "6": [".###.","#...#","#....","####.","#...#","#...#",".###."],
  "7": ["#####","....#","...#.","..#..",".#...",".#...",".#..."],
  "8": [".###.","#...#","#...#",".###.","#...#","#...#",".###."],
  "9": [".###.","#...#","#...#",".####","....#","#...#",".###."],
};

function renderCamId(host: HTMLElement): void {
  for (let i = 1; i <= 4; i++) {
    host.appendChild(camIdCell(String(i), `Camera ${i}`));
  }
}

function camIdCell(digit: string, label: string): HTMLElement {
  const wrap = el("div", "bm-cam-id");
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", `Selected camera ${digit}`);

  const display = el("div", "bm-cam-id__display");
  display.setAttribute("aria-hidden", "true");
  const rows = FONT_5x7[digit] ?? FONT_5x7["0"];
  for (const row of rows) {
    for (const ch of row) {
      const dot = document.createElement("i");
      if (ch === "#") dot.className = "on";
      display.appendChild(dot);
    }
  }
  const lab = el("div", "bm-cam-id__label");
  lab.textContent = label;
  wrap.appendChild(display);
  wrap.appendChild(lab);
  return wrap;
}

// ---------------------------------------------------------------------------
// 7-segment digits — DSEG7 font with a "ghost-8" layer behind for the iconic
// look of unlit segments staying faintly visible.
// ---------------------------------------------------------------------------

function makeDigit(): HTMLElement {
  const d = el("span", "bm-seg__digit");
  d.setAttribute("aria-hidden", "true");
  d.appendChild(el("span", "bm-seg__ghost"));
  d.appendChild(el("span", "bm-seg__value"));
  return d;
}

function paintDigit(digit: HTMLElement, ch: string, dpOn: boolean): void {
  digit.dataset.value = ch;
  digit.dataset.dp = dpOn ? "true" : "false";
  const ghost = digit.querySelector<HTMLElement>(".bm-seg__ghost");
  const value = digit.querySelector<HTMLElement>(".bm-seg__value");
  if (ghost) ghost.textContent = dpOn ? "8." : "8";
  if (value) value.textContent = dpOn ? `${ch}.` : ch;
}

function renderSeg1(host: HTMLElement): void {
  for (const [color, label, value] of [
    ["bm-seg",         "ND", "3"],
    ["bm-seg bm-seg--red",   "CC", "0"],
    ["bm-seg bm-seg--green", "GAIN", "6"],
  ] as const) {
    const wrap = el("div", color);
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-label", `${label}: ${value}`);
    const window = el("div", "bm-seg__digit-window");
    const digit = makeDigit();
    paintDigit(digit, value, false);
    window.appendChild(digit);
    wrap.appendChild(window);
    const lab = el("div", "bm-seg__label");
    lab.textContent = label;
    wrap.appendChild(lab);
    host.appendChild(wrap);
  }
}

function renderSeg2(host: HTMLElement): void {
  const wrap = el("div", "bm-seg2");
  wrap.setAttribute("role", "status");
  wrap.setAttribute("aria-label", "Master gain: 6.0");

  const display = el("div", "bm-seg2__display");
  display.setAttribute("aria-hidden", "true");
  const d1 = makeDigit(); paintDigit(d1, "6", true);
  const d2 = makeDigit(); paintDigit(d2, "0", false);
  display.appendChild(d1);
  display.appendChild(d2);
  wrap.appendChild(display);
  const lab = el("div", "bm-seg2__label");
  lab.textContent = "Master Gain";
  wrap.appendChild(lab);
  host.appendChild(wrap);
}

function renderSeg4(host: HTMLElement): void {
  for (const [chars, label, ariaValue] of [
    [["0","1","0","0"], "Shutter", "1/100"],
    [["1","6","0","0"], "ISO",     "1600"],
    [["5","6","0","0"], "Color Temp", "5600 K"],
  ] as const) {
    const wrap = el("div", "bm-seg4");
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-label", `${label}: ${ariaValue}`);
    const display = el("div", "bm-seg4__display");
    display.setAttribute("aria-hidden", "true");
    for (const ch of chars) {
      const d = makeDigit();
      paintDigit(d, ch, false);
      display.appendChild(d);
    }
    wrap.appendChild(display);
    const lab = el("div", "bm-seg4__label");
    lab.textContent = label;
    wrap.appendChild(lab);
    host.appendChild(wrap);
  }
}

// ---------------------------------------------------------------------------
// Mini-pot
// ---------------------------------------------------------------------------

function renderMiniPot(host: HTMLElement): void {
  for (const [label, ends] of [
    ["IRIS",  ["CLOSE", "OPEN"]],
    ["FOCUS", ["NEAR",  "FAR"]],
  ] as const) {
    const wrap = el("div", "bm-pot");
    wrap.setAttribute("role", "group");
    const labelId = `pot-${label.toLowerCase()}-label`;
    wrap.setAttribute("aria-labelledby", labelId);

    const knob = el("div", "bm-pot__knob");
    knob.setAttribute("role", "slider");
    knob.tabIndex = 0;
    knob.setAttribute("aria-valuemin", "0");
    knob.setAttribute("aria-valuemax", "100");
    knob.setAttribute("aria-valuenow", "50");
    knob.setAttribute("aria-labelledby", labelId);
    knob.style.setProperty("--angle", "0deg");
    knob.appendChild(el("span", "bm-pot__indicator"));

    const labels = el("div", "bm-pot__labels");
    labels.id = labelId;
    const l1 = el("span", "bm-pot__end"); l1.textContent = ends[0];
    const l2 = el("span", "bm-pot__end"); l2.textContent = ends[1];
    labels.appendChild(l1); labels.appendChild(l2);

    const mode = el("div", "bm-pot__mode");
    mode.textContent = label;

    wrap.appendChild(knob);
    wrap.appendChild(labels);
    wrap.appendChild(mode);

    attachPot(knob, { onChange: () => {} });
    host.appendChild(wrap);
  }
}

// ---------------------------------------------------------------------------
// Inside-pot
// ---------------------------------------------------------------------------

function renderInsidePot(host: HTMLElement): void {
  for (const label of ["FOCUS", "IRIS"]) {
    const wrap = el("div", "bm-pot2");
    wrap.setAttribute("role", "group");
    const labelId = `pot2-${label.toLowerCase()}-label`;
    wrap.setAttribute("aria-labelledby", labelId);

    wrap.appendChild(el("div", "bm-pot2__ticks"));

    const knob = el("div", "bm-pot2__knob");
    knob.setAttribute("role", "slider");
    knob.tabIndex = 0;
    knob.setAttribute("aria-valuemin", "0");
    knob.setAttribute("aria-valuemax", "100");
    knob.setAttribute("aria-valuenow", "50");
    knob.setAttribute("aria-labelledby", labelId);
    knob.style.setProperty("--angle", "0deg");
    knob.appendChild(el("span", "bm-pot2__rim"));
    knob.appendChild(el("span", "bm-pot2__face"));
    knob.appendChild(el("span", "bm-pot2__indicator"));
    wrap.appendChild(knob);

    const lab = el("div", "bm-pot2__label");
    lab.id = labelId;
    lab.textContent = label;
    wrap.appendChild(lab);

    attachPot(knob, { onChange: () => {} });
    host.appendChild(wrap);
  }
}

function attachPot(
  el: HTMLElement,
  opts: { min?: number; max?: number; value?: number; sweep?: number; onChange: (v: number) => void },
): void {
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const sweep = opts.sweep ?? 135;
  let value = opts.value ?? (min + max) / 2;

  const render = () => {
    const norm = (value - min) / (max - min);
    const angle = -sweep + norm * sweep * 2;
    el.style.setProperty("--angle", `${angle}deg`);
    el.setAttribute("aria-valuenow", String(Math.round(value)));
  };
  render();

  let dragStartY = 0;
  let dragStartValue = 0;
  let fine = false;

  const onMove = (e: PointerEvent) => {
    const dy = dragStartY - e.clientY;
    const range = max - min;
    const sensitivity = fine ? range / 600 : range / 150;
    value = clamp(dragStartValue + dy * sensitivity, min, max);
    render();
    opts.onChange(value);
  };
  const onUp = (e: PointerEvent) => {
    el.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  el.addEventListener("pointerdown", (e) => {
    fine = e.shiftKey;
    dragStartY = e.clientY;
    dragStartValue = value;
    el.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  el.addEventListener("keydown", (e) => {
    const step = (max - min) / (e.shiftKey ? 200 : 50);
    if (e.key === "ArrowUp" || e.key === "ArrowRight") value = clamp(value + step, min, max);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") value = clamp(value - step, min, max);
    else return;
    e.preventDefault();
    render();
    opts.onChange(value);
  });
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

function renderDivider(host: HTMLElement): void {
  const col = el("div");
  col.style.width = "100%";
  col.style.maxWidth = "560px";

  const a = el("hr", "bm-divider");
  a.setAttribute("role", "presentation");
  col.appendChild(label("Standard groove"));
  col.appendChild(a);

  col.appendChild(label("Subtle (inside recessed cells)"));
  const b = el("hr", "bm-divider bm-divider--subtle");
  b.setAttribute("role", "presentation");
  col.appendChild(b);

  host.appendChild(col);

  function label(text: string): HTMLElement {
    const l = el("div");
    l.style.font = "600 10px/1.5 ui-monospace, 'SF Mono', Menlo, monospace";
    l.style.color = "var(--bm-text-dim)";
    l.style.letterSpacing = "0.04em";
    l.style.margin = "12px 0 4px";
    l.textContent = text;
    return l;
  }
}

// ---------------------------------------------------------------------------
// Glass buttons
// ---------------------------------------------------------------------------

function renderGlass(host: HTMLElement): void {
  const row = el("div", "bm-glass-row");
  row.setAttribute("role", "radiogroup");
  row.setAttribute("aria-label", "Program camera");

  const buttons = [
    glass("Cam1", "green",  "lit", true),
    glass("Cam2", "red",    "dim", false),
    glass("Cam3", "amber",  "dim", false),
    glass("Cam4", "blue",   "dim", false),
  ];
  for (const b of buttons) row.appendChild(b);

  for (const b of buttons) {
    b.addEventListener("click", () => {
      for (const other of buttons) {
        const lit = other === b;
        other.dataset.state = lit ? "lit" : "dim";
        other.setAttribute("aria-checked", String(lit));
      }
    });
  }

  const onAir = el("button", "bm-glass bm-glass--red bm-glass--onair");
  onAir.type = "button";
  onAir.dataset.state = "lit";
  onAir.setAttribute("aria-label", "On air");
  const onAirLab = el("span", "bm-glass__label");
  onAirLab.textContent = "ON AIR";
  onAir.appendChild(onAirLab);

  host.appendChild(row);
  host.appendChild(onAir);
}

function glass(
  label: string,
  color: "green" | "red" | "amber" | "blue" | "gray",
  state: "off" | "dim" | "lit",
  checked: boolean,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `bm-glass bm-glass--${color}`;
  b.dataset.state = state;
  b.setAttribute("role", "radio");
  b.setAttribute("aria-checked", String(checked));
  const lab = el("span", "bm-glass__label");
  lab.textContent = label;
  b.appendChild(lab);
  return b;
}

// ---------------------------------------------------------------------------
// T-bar
// ---------------------------------------------------------------------------

function renderTBar(host: HTMLElement): void {
  for (const withLadder of [true, false]) {
    const wrap = el("div", "bm-tbar");
    wrap.setAttribute("role", "group");
    const labelId = `tbar-${withLadder ? "main" : "plain"}-label`;
    wrap.setAttribute("aria-labelledby", labelId);

    const shaft = el("div", "bm-tbar__shaft");
    shaft.setAttribute("aria-hidden", "true");
    shaft.appendChild(el("span", "bm-tbar__ticks bm-tbar__ticks--left"));
    shaft.appendChild(el("span", "bm-tbar__ticks bm-tbar__ticks--right"));
    if (withLadder) shaft.appendChild(el("span", "bm-tbar__ladder"));
    shaft.appendChild(el("span", "bm-tbar__slot"));

    const handle = el("div", "bm-tbar__handle");
    handle.setAttribute("role", "slider");
    handle.tabIndex = 0;
    handle.setAttribute("aria-valuemin", "0");
    handle.setAttribute("aria-valuemax", "100");
    handle.setAttribute("aria-valuenow", "0");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-labelledby", labelId);
    handle.style.setProperty("--pos", "0");
    handle.appendChild(el("span", "bm-tbar__cap"));
    handle.appendChild(el("span", "bm-tbar__bar"));

    const lab = el("div", "bm-tbar__label");
    lab.id = labelId;
    lab.textContent = withLadder ? "TRANSITION" : "DISSOLVE";

    wrap.appendChild(shaft);
    wrap.appendChild(handle);
    wrap.appendChild(lab);

    attachTBar(wrap);
    host.appendChild(wrap);
  }
}

function attachTBar(root: HTMLElement): void {
  const handle = root.querySelector<HTMLElement>(".bm-tbar__handle")!;
  const ladder = root.querySelector<HTMLElement>(".bm-tbar__ladder");
  const shaft  = root.querySelector<HTMLElement>(".bm-tbar__shaft")!;
  let value = 0;

  const render = () => {
    handle.style.setProperty("--pos", String(value));
    handle.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    if (ladder) ladder.style.setProperty("--fill", String(value));
  };
  render();

  let dragOffsetY = 0;
  const fromY = (clientY: number) => {
    const rect = shaft.getBoundingClientRect();
    const usable = rect.height - 24;
    const y = clientY - rect.top - 12 - dragOffsetY;
    return clamp(1 - y / usable, 0, 1);
  };

  const onMove = (e: PointerEvent) => {
    value = fromY(e.clientY);
    render();
  };
  const onUp = (e: PointerEvent) => {
    handle.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (value <= 0.02) value = 0;
    else if (value >= 0.98) value = 1;
    render();
  };

  handle.addEventListener("pointerdown", (e) => {
    const rect = handle.getBoundingClientRect();
    dragOffsetY = e.clientY - (rect.top + rect.height / 2);
    handle.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.005 : 0.02;
    if (e.key === "ArrowUp")        value = clamp(value + step, 0, 1);
    else if (e.key === "ArrowDown") value = clamp(value - step, 0, 1);
    else if (e.key === "Home")      value = 0;
    else if (e.key === "End")       value = 1;
    else return;
    e.preventDefault();
    render();
  });
}

// ---------------------------------------------------------------------------
// Audio fader
// ---------------------------------------------------------------------------

function renderFader(host: HTMLElement): void {
  const wrap = el("div", "bm-fader");
  wrap.setAttribute("role", "group");
  const labelId = "fader-master-label";
  wrap.setAttribute("aria-labelledby", labelId);

  const row = el("div", "bm-fader__row");

  const lab = el("div", "bm-fader__label");
  lab.id = labelId;
  lab.textContent = "MASTER";

  const channel = el("div", "bm-fader__channel");

  const track = el("div", "bm-fader__track");
  track.setAttribute("aria-hidden", "true");
  track.appendChild(el("span", "bm-fader__meter"));
  track.appendChild(el("span", "bm-fader__ticks"));

  const thumb = el("div", "bm-fader__thumb");
  thumb.setAttribute("role", "slider");
  thumb.tabIndex = 0;
  thumb.setAttribute("aria-orientation", "horizontal");
  thumb.setAttribute("aria-valuemin", "-60");
  thumb.setAttribute("aria-valuemax", "12");
  thumb.setAttribute("aria-valuenow", "0");
  thumb.setAttribute("aria-labelledby", labelId);
  thumb.appendChild(el("span", "bm-fader__cap"));

  channel.appendChild(track);
  channel.appendChild(thumb);

  const readout = el("div", "bm-fader__readout");
  readout.textContent = "+0.0 dB";

  row.appendChild(lab);
  row.appendChild(channel);
  row.appendChild(readout);
  wrap.appendChild(row);

  const scale = el("div", "bm-fader__scale");
  for (const v of ["−60", "−40", "−20", "−10", "−6", "−3", "0", "+12"]) {
    const s = document.createElement("span");
    s.textContent = v;
    scale.appendChild(s);
  }
  wrap.appendChild(scale);

  host.appendChild(wrap);

  attachFader(wrap, (db) => {
    readout.textContent = `${db >= 0 ? "+" : ""}${db.toFixed(1)} dB`;
  });

  // Drive a fake live meter so the multi-color rung mask is visible.
  let phase = 0;
  setInterval(() => {
    phase += 0.06;
    const level = 0.55 + Math.sin(phase) * 0.35;
    track.querySelector<HTMLElement>(".bm-fader__meter")!
      .style.setProperty("--meter", String(clamp(level, 0, 1)));
    wrap.dataset.clipping = level > 0.95 ? "true" : "false";
  }, 80);
}

function attachFader(root: HTMLElement, onChange: (db: number) => void): void {
  const minDb = -60, maxDb = 12;
  const track = root.querySelector<HTMLElement>(".bm-fader__track")!;
  const thumb = root.querySelector<HTMLElement>(".bm-fader__thumb")!;
  let db = 0;

  const TAPER: [number, number][] = [
    [0,    minDb],
    [0.30, -40],
    [0.50, -20],
    [0.75,   0],
    [1.00, maxDb],
  ];
  const dbToPos = (d: number) => {
    for (let i = 1; i < TAPER.length; i++) {
      const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
      if (d <= d1) return p0 + ((d - d0) / (d1 - d0)) * (p1 - p0);
    }
    return 1;
  };
  const posToDb = (p: number) => {
    for (let i = 1; i < TAPER.length; i++) {
      const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
      if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
    }
    return maxDb;
  };

  const render = () => {
    const pos = clamp(dbToPos(db), 0, 1);
    thumb.style.left = `calc(${pos} * (100% - 22px))`;
    thumb.setAttribute("aria-valuenow", db.toFixed(1));
    onChange(db);
  };
  render();

  const onMove = (e: PointerEvent) => {
    const rect = track.getBoundingClientRect();
    const usable = rect.width - 4;
    const x = clamp(e.clientX - rect.left - 2, 0, usable);
    db = clamp(posToDb(x / usable), minDb, maxDb);
    render();
  };
  const onUp = (e: PointerEvent) => {
    thumb.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  thumb.addEventListener("pointerdown", (e) => {
    thumb.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  let lastTap = 0;
  thumb.addEventListener("pointerup", () => {
    const now = performance.now();
    if (now - lastTap < 300) { db = 0; render(); }
    lastTap = now;
  });

  thumb.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 1;
    if (e.key === "ArrowRight" || e.key === "ArrowUp")    db = clamp(db + step, minDb, maxDb);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") db = clamp(db - step, minDb, maxDb);
    else if (e.key === "Home") db = minDb;
    else if (e.key === "End")  db = maxDb;
    else if (e.key === "0")    db = 0;
    else return;
    e.preventDefault();
    render();
  });

  // place thumb visually inside grid column 2
  thumb.style.position = "absolute";
  thumb.style.top = "50%";
  thumb.style.transform = "translateY(-50%)";
}

// ---------------------------------------------------------------------------
// Audio fader (vertical) — channel-strip style
// ---------------------------------------------------------------------------

const FADER_SCALE_MARKS = ["+12", "+6", "0", "−6", "−12", "−20", "−40", "−60"];

function renderVFader(host: HTMLElement): void {
  const wrap = el("div", "bm-vfader-bay");
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Channel faders");

  for (const channel of ["CH 1", "CH 2", "MASTER"] as const) {
    wrap.appendChild(buildVFader(channel));
  }
  host.appendChild(wrap);
}

function buildVFader(label: string): HTMLElement {
  const cell = el("div", "bm-vfader");
  cell.setAttribute("role", "group");
  const labelId = `vfader-${label.replace(/\s+/g, "-").toLowerCase()}-label`;
  cell.setAttribute("aria-labelledby", labelId);

  const readout = el("div", "bm-vfader__readout");
  readout.textContent = "+0.0";
  cell.appendChild(readout);

  const stage = el("div", "bm-vfader__stage");

  const scale = el("div", "bm-vfader__scale");
  scale.setAttribute("aria-hidden", "true");
  for (const mark of FADER_SCALE_MARKS) {
    const m = document.createElement("span");
    m.textContent = mark;
    scale.appendChild(m);
  }
  stage.appendChild(scale);

  const track = el("div", "bm-vfader__track");
  track.setAttribute("aria-hidden", "true");

  const meter = el("span", "bm-vfader__meter");
  track.appendChild(meter);

  const slot = el("span", "bm-vfader__slot");
  track.appendChild(slot);

  const thumb = el("div", "bm-vfader__thumb");
  thumb.setAttribute("role", "slider");
  thumb.tabIndex = 0;
  thumb.setAttribute("aria-orientation", "vertical");
  thumb.setAttribute("aria-valuemin", "-60");
  thumb.setAttribute("aria-valuemax", "12");
  thumb.setAttribute("aria-valuenow", "0");
  thumb.setAttribute("aria-labelledby", labelId);
  thumb.appendChild(el("span", "bm-vfader__cap"));
  thumb.appendChild(el("span", "bm-vfader__bar"));

  track.appendChild(thumb);
  stage.appendChild(track);
  cell.appendChild(stage);

  const lab = el("div", "bm-vfader__label");
  lab.id = labelId;
  lab.textContent = label;
  cell.appendChild(lab);

  attachVFader(cell, (db) => {
    readout.textContent = `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;
  });

  // Drive a fake live meter so the multi-color rung mask is visible.
  const phaseOffset = label === "MASTER" ? 0.7 : label === "CH 2" ? 1.3 : 0;
  let phase = phaseOffset;
  const tick = (): void => {
    phase += 0.06;
    const level = 0.45 + Math.sin(phase) * 0.35;
    meter.style.setProperty("--meter", String(clamp(level, 0, 1)));
    cell.dataset.clipping = level > 0.95 ? "true" : "false";
  };
  tick();
  setInterval(tick, 80);

  return cell;
}

function attachVFader(root: HTMLElement, onChange: (db: number) => void): void {
  const minDb = -60, maxDb = 12;
  const track = root.querySelector<HTMLElement>(".bm-vfader__track")!;
  const thumb = root.querySelector<HTMLElement>(".bm-vfader__thumb")!;
  let db = 0;

  // Same dB taper as the horizontal fader, just inverted: pos=1 is the TOP.
  const TAPER: [number, number][] = [
    [0,    minDb],
    [0.30, -40],
    [0.50, -20],
    [0.75,   0],
    [1.00, maxDb],
  ];
  const dbToPos = (d: number): number => {
    for (let i = 1; i < TAPER.length; i++) {
      const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
      if (d <= d1) return p0 + ((d - d0) / (d1 - d0)) * (p1 - p0);
    }
    return 1;
  };
  const posToDb = (p: number): number => {
    for (let i = 1; i < TAPER.length; i++) {
      const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
      if (p <= p1) return d0 + ((p - p0) / (p1 - p0)) * (d1 - d0);
    }
    return maxDb;
  };

  const render = (): void => {
    const pos = clamp(dbToPos(db), 0, 1);
    thumb.style.setProperty("--pos", String(pos));
    thumb.setAttribute("aria-valuenow", db.toFixed(1));
    onChange(db);
  };
  render();

  let dragOffsetY = 0;
  const fromY = (clientY: number): number => {
    const rect = track.getBoundingClientRect();
    const usable = rect.height - thumb.offsetHeight;
    const y = clamp(clientY - rect.top - thumb.offsetHeight / 2 - dragOffsetY, 0, usable);
    return 1 - y / usable;
  };

  const onMove = (e: PointerEvent): void => {
    let pos = fromY(e.clientY);
    // Soft snap to unity gain (0 dB → 0.75 in our taper)
    if (Math.abs(pos - 0.75) < 0.015) pos = 0.75;
    db = clamp(posToDb(pos), minDb, maxDb);
    render();
  };
  const onUp = (e: PointerEvent): void => {
    thumb.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  thumb.addEventListener("pointerdown", (e) => {
    const rect = thumb.getBoundingClientRect();
    dragOffsetY = e.clientY - (rect.top + rect.height / 2);
    thumb.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  let lastTap = 0;
  thumb.addEventListener("pointerup", () => {
    const now = performance.now();
    if (now - lastTap < 300) { db = 0; render(); }
    lastTap = now;
  });

  thumb.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 1;
    if (e.key === "ArrowUp"   || e.key === "ArrowRight") db = clamp(db + step, minDb, maxDb);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") db = clamp(db - step, minDb, maxDb);
    else if (e.key === "Home") db = maxDb;
    else if (e.key === "End")  db = minDb;
    else if (e.key === "0")    db = 0;
    else return;
    e.preventDefault();
    render();
  });
}

// ---------------------------------------------------------------------------
// Audio pan pot
// ---------------------------------------------------------------------------

function renderPan(host: HTMLElement): void {
  const wrap = el("div", "bm-pan");
  wrap.setAttribute("role", "group");
  const labelId = "pan-label";
  wrap.setAttribute("aria-labelledby", labelId);

  const lab = el("div", "bm-pan__label");
  lab.id = labelId;
  lab.textContent = "Pan";
  wrap.appendChild(lab);

  const knob = el("div", "bm-pan__knob");
  knob.setAttribute("role", "slider");
  knob.tabIndex = 0;
  knob.setAttribute("aria-valuemin", "-100");
  knob.setAttribute("aria-valuemax", "100");
  knob.setAttribute("aria-valuenow", "0");
  knob.setAttribute("aria-valuetext", "Center");
  knob.setAttribute("aria-labelledby", labelId);
  knob.style.setProperty("--angle", "0deg");
  knob.style.setProperty("--arc", "0");
  knob.appendChild(el("span", "bm-pan__arc"));
  knob.appendChild(el("span", "bm-pan__rim"));
  knob.appendChild(el("span", "bm-pan__face"));
  knob.appendChild(el("span", "bm-pan__indicator"));
  knob.appendChild(el("span", "bm-pan__center-tick"));
  wrap.appendChild(knob);

  const ends = el("div", "bm-pan__ends");
  const l = document.createElement("span"); l.textContent = "L";
  const r = document.createElement("span"); r.textContent = "R";
  ends.appendChild(l); ends.appendChild(r);
  wrap.appendChild(ends);

  const readout = el("div", "bm-pan__readout");
  readout.textContent = "C";
  wrap.appendChild(readout);

  attachPan(knob, readout);
  host.appendChild(wrap);
}

function attachPan(knob: HTMLElement, readout: HTMLElement): void {
  const extent = 100, sweep = 135, detent = 3;
  let value = 0;

  const render = () => {
    const norm = value / extent;
    knob.style.setProperty("--angle", `${norm * sweep}deg`);
    knob.style.setProperty("--arc",   String(norm));
    const r = Math.round(value);
    knob.setAttribute("aria-valuenow", String(r));
    knob.setAttribute("aria-valuetext",
      r === 0 ? "Center" : r < 0 ? `Left ${Math.abs(r)}` : `Right ${r}`);
    readout.textContent = r === 0 ? "C" : r < 0 ? `L${Math.abs(r)}` : `R${r}`;
  };
  render();

  let dragStartY = 0, dragStartValue = 0, fine = false;
  const onMove = (e: PointerEvent) => {
    const dy = dragStartY - e.clientY;
    const sensitivity = fine ? extent / 600 : extent / 150;
    let next = clamp(dragStartValue + dy * sensitivity, -extent, extent);
    if (Math.abs(next) <= detent) next = 0;
    value = next;
    render();
  };
  const onUp = (e: PointerEvent) => {
    knob.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  knob.addEventListener("pointerdown", (e) => {
    fine = e.shiftKey;
    dragStartY = e.clientY;
    dragStartValue = value;
    knob.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  let lastTap = 0;
  knob.addEventListener("pointerup", () => {
    const now = performance.now();
    if (now - lastTap < 300) { value = 0; render(); }
    lastTap = now;
  });

  knob.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.5 : 2;
    if (e.key === "ArrowRight" || e.key === "ArrowUp")    value = clamp(value + step, -extent, extent);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") value = clamp(value - step, -extent, extent);
    else if (e.key === "Home") value = -extent;
    else if (e.key === "End")  value =  extent;
    else if (e.key === "0" || e.key === "c" || e.key === "C") value = 0;
    else return;
    e.preventDefault();
    render();
  });
}

// ---------------------------------------------------------------------------
// Audio gain pot
// ---------------------------------------------------------------------------

function renderGain(host: HTMLElement): void {
  for (const channel of ["L", "R"]) {
    const wrap = el("div", "bm-gain");
    wrap.setAttribute("role", "group");

    const badge = el("div", "bm-gain__badge");
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = channel;
    wrap.appendChild(badge);

    const sr = el("div", "bm-gain__sr-label");
    sr.id = `gain-${channel}-label`;
    sr.textContent = `Channel ${channel} gain`;
    wrap.setAttribute("aria-labelledby", sr.id);
    wrap.appendChild(sr);

    const knob = el("div", "bm-gain__knob");
    knob.setAttribute("role", "slider");
    knob.tabIndex = 0;
    knob.setAttribute("aria-valuemin", "-60");
    knob.setAttribute("aria-valuemax", "30");
    knob.setAttribute("aria-valuenow", "0");
    knob.setAttribute("aria-labelledby", sr.id);
    knob.style.setProperty("--angle", "0deg");
    knob.style.setProperty("--arc-pos-deg", "0deg");
    knob.style.setProperty("--arc-neg-deg", "0deg");
    knob.style.setProperty("--over", "0");
    knob.appendChild(el("span", "bm-gain__arc"));
    knob.appendChild(el("span", "bm-gain__center-mark"));
    knob.appendChild(el("span", "bm-gain__rim"));
    knob.appendChild(el("span", "bm-gain__face"));
    knob.appendChild(el("span", "bm-gain__indicator"));
    wrap.appendChild(knob);

    const ends = el("div", "bm-gain__ends");
    const a = document.createElement("span"); a.textContent = "−∞";
    const c = document.createElement("span"); c.textContent = "0"; c.className = "bm-gain__center-label";
    const b = document.createElement("span"); b.textContent = "+30";
    ends.appendChild(a); ends.appendChild(c); ends.appendChild(b);
    wrap.appendChild(ends);

    const readout = el("div", "bm-gain__readout");
    readout.textContent = "0.00";
    wrap.appendChild(readout);

    attachGain(wrap, knob, readout);
    host.appendChild(wrap);
  }
}

function attachGain(root: HTMLElement, knob: HTMLElement, readout: HTMLElement): void {
  const minDb = -60, maxDb = 30, sweep = 135, detent = 0.3;
  let value = 0;

  /**
   * Bipolar mapping: 0 dB at 12 o'clock (angle 0°).
   * Negative dB sweeps left to −135° (−∞ at the bottom-left).
   * Positive dB sweeps right to +135° (+30 at the bottom-right).
   * Each side is linear in dB; the two sides have different dB-per-degree
   * because the cut range (60 dB) is wider than the boost range (30 dB).
   */
  const dbToAngle = (d: number): number =>
    d >= 0 ? (d / maxDb) * sweep : (d / minDb) * -sweep;

  const render = () => {
    const angle = dbToAngle(value);
    const posFrac = value > 0 ? value / maxDb : 0;
    const negFrac = value < 0 ? value / minDb : 0;
    const overFrac = value > 0 ? Math.min(value / maxDb, 1) : 0;

    knob.style.setProperty("--angle", `${angle}deg`);
    knob.style.setProperty("--arc-pos-deg", `${posFrac * sweep}deg`);
    knob.style.setProperty("--arc-neg-deg", `${negFrac * sweep}deg`);
    knob.style.setProperty("--over", String(overFrac));

    knob.setAttribute("aria-valuenow", value.toFixed(2));
    knob.setAttribute("aria-valuetext",
      value <= minDb + 0.01 ? "Minus infinity"
                            : `${value >= 0 ? "+" : ""}${value.toFixed(2)} dB`);
    readout.textContent =
      value <= minDb + 0.01 ? "−∞" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
    root.dataset.over = value > detent ? "true" : "false";
  };
  render();

  let dragStartY = 0, dragStartValue = 0, fine = false;
  const onMove = (e: PointerEvent) => {
    const dy = dragStartY - e.clientY;
    const dbPerPx = fine ? 0.04 : 0.4;
    let next = dragStartValue + dy * dbPerPx;
    if (Math.abs(next) <= detent && next !== 0) next = 0;
    value = clamp(next, minDb, maxDb);
    render();
  };
  const onUp = (e: PointerEvent) => {
    knob.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };
  knob.addEventListener("pointerdown", (e) => {
    fine = e.shiftKey;
    dragStartY = e.clientY;
    dragStartValue = value;
    knob.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  let lastTap = 0;
  knob.addEventListener("pointerup", () => {
    const now = performance.now();
    if (now - lastTap < 300) { value = 0; render(); }
    lastTap = now;
  });

  knob.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.1 : 1;
    if (e.key === "ArrowUp"   || e.key === "ArrowRight") value = clamp(value + step, minDb, maxDb);
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") value = clamp(value - step, minDb, maxDb);
    else if (e.key === "Home") value = minDb;
    else if (e.key === "End")  value = maxDb;
    else if (e.key === "0")    value = 0;
    else return;
    e.preventDefault();
    render();
  });
}

// ---------------------------------------------------------------------------
// Mini volume faders
// ---------------------------------------------------------------------------

function renderMiniFaders(host: HTMLElement): void {
  const wrap = el("div", "bm-mfaders");
  wrap.setAttribute("role", "group");
  const titleId = "mfaders-title";
  wrap.setAttribute("aria-labelledby", titleId);

  const title = el("div", "bm-mfaders__title");
  title.id = titleId;
  title.textContent = "Headphones";
  wrap.appendChild(title);

  const rails = el("div", "bm-mfaders__rails");
  const min = document.createElement("span"); min.textContent = "MIN";
  const max = document.createElement("span"); max.textContent = "MAX";
  rails.appendChild(min); rails.appendChild(max);
  wrap.appendChild(rails);

  const row = el("div", "bm-mfaders__row");

  const speakerSvg = `
    <svg viewBox="0 0 16 16" width="14" height="14">
      <path d="M3 6h2.5L9 3v10L5.5 10H3z M11 5.5c1 .8 1 4.2 0 5"
            fill="currentColor" stroke="currentColor"
            stroke-width="0.5" stroke-linejoin="round"/>
    </svg>`;
  const headphoneSvg = `
    <svg viewBox="0 0 16 16" width="14" height="14">
      <path d="M2 9V8a6 6 0 0 1 12 0v1 M2 9h2v4H2z M12 9h2v4h-2z"
            fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  const micSvg = `
    <svg viewBox="0 0 16 16" width="14" height="14">
      <rect x="6" y="2" width="4" height="8" rx="2"
            fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M4 8a4 4 0 0 0 8 0 M8 12v2"
            fill="none" stroke="currentColor" stroke-width="1.4"
            stroke-linecap="round"/>
    </svg>`;

  for (const [icon, label, value] of [
    [speakerSvg,   "Speaker level",   0.6],
    [headphoneSvg, "Headphone level", 0.75],
    [micSvg,       "Talkback level",  0.4],
  ] as const) {
    row.appendChild(miniFader(icon, label, value));
  }

  wrap.appendChild(row);
  host.appendChild(wrap);
}

function miniFader(iconHtml: string, ariaLabel: string, value: number): HTMLElement {
  const f = el("div", "bm-mfader");

  const track = el("div", "bm-mfader__track");
  track.setAttribute("aria-hidden", "true");
  const fill = el("span", "bm-mfader__fill");
  track.appendChild(fill);

  const thumb = el("div", "bm-mfader__thumb");
  thumb.setAttribute("role", "slider");
  thumb.tabIndex = 0;
  thumb.setAttribute("aria-orientation", "vertical");
  thumb.setAttribute("aria-valuemin", "0");
  thumb.setAttribute("aria-valuemax", "100");
  thumb.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  thumb.setAttribute("aria-label", ariaLabel);
  thumb.style.setProperty("--pos", String(value));
  thumb.appendChild(el("span", "bm-mfader__cap"));
  track.appendChild(thumb);
  fill.style.setProperty("--pos", String(value));

  const icon = el("div", "bm-mfader__icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconHtml;

  f.appendChild(track);
  f.appendChild(icon);

  attachMiniFader(f, value);
  // tap icon to toggle muted state
  icon.addEventListener("pointerup", () => {
    f.dataset.muted = f.dataset.muted === "true" ? "false" : "true";
  });

  return f;
}

function attachMiniFader(root: HTMLElement, initial: number): void {
  const thumb = root.querySelector<HTMLElement>(".bm-mfader__thumb")!;
  const track = root.querySelector<HTMLElement>(".bm-mfader__track")!;
  const fill  = root.querySelector<HTMLElement>(".bm-mfader__fill")!;
  let value = initial;
  const def = 0.75;
  const snap = 0.02;

  const render = () => {
    thumb.style.setProperty("--pos", String(value));
    fill.style.setProperty("--pos", String(value));
    thumb.setAttribute("aria-valuenow", String(Math.round(value * 100)));
  };
  render();

  let dragOffsetY = 0;
  const fromY = (clientY: number) => {
    const rect = track.getBoundingClientRect();
    const usable = rect.height - thumb.offsetHeight;
    const y = clamp(clientY - rect.top - thumb.offsetHeight / 2 - dragOffsetY, 0, usable);
    return 1 - y / usable;
  };

  const onMove = (e: PointerEvent) => {
    let next = fromY(e.clientY);
    if (Math.abs(next - def) <= snap) next = def;
    value = next;
    render();
  };
  const onUp = (e: PointerEvent) => {
    thumb.releasePointerCapture(e.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  };

  thumb.addEventListener("pointerdown", (e) => {
    const rect = thumb.getBoundingClientRect();
    dragOffsetY = e.clientY - (rect.top + rect.height / 2);
    thumb.setPointerCapture(e.pointerId);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  let lastTap = 0;
  thumb.addEventListener("pointerup", () => {
    const now = performance.now();
    if (now - lastTap < 300) { value = def; render(); }
    lastTap = now;
  });

  thumb.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 0.005 : 0.02;
    if (e.key === "ArrowUp")        value = clamp(value + step, 0, 1);
    else if (e.key === "ArrowDown") value = clamp(value - step, 0, 1);
    else if (e.key === "Home")      value = 0;
    else if (e.key === "End")       value = 1;
    else return;
    e.preventDefault();
    render();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K];
function el(tag: string, className?: string): HTMLElement;
function el(tag: string, className?: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function h2(text: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = text;
  return h;
}

function p(className: string, text: string): HTMLElement {
  const e = document.createElement("p");
  e.className = className;
  e.textContent = text;
  return e;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
