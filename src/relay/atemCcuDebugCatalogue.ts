/**
 * Human-readable labels for ATEM Camera Control / relay `__atemCcuTrace` payloads
 * (see `docs/atem-command-catalogue.md`).
 */

/** Matches {@link AtemCameraControlCategory} in `@atem-connection/camera-control`. */
const CC_CATEGORY: Record<number, string> = {
  0: "Lens",
  1: "Video",
  2: "Audio",
  3: "Output",
  4: "Display",
  5: "Tally",
  6: "Reference",
  7: "Configuration",
  8: "ColorCorrection",
  10: "Media",
  11: "PTZControl",
};

/** Documented builder/parser gaps from project catalogue. */
const UNHANDLED_CATALOGUE: Record<string, string> = {
  "0/3": "Lens · ApertureNormalised (builder skips; FStop drives iris)",
  "10/4": "Media · param 4 (not in camera-control enum 0.4)",
  "11/0": "PTZ · PanTiltVelocity",
  "12/8": "Category 12 / param 8 — not in camera-control 0.4",
};

export function describeCcuUnhandledPair(categoryId: number, parameterId: number): string {
  const key = `${categoryId}/${parameterId}`;
  if (UNHANDLED_CATALOGUE[key]) return UNHANDLED_CATALOGUE[key]!;
  const cat = CC_CATEGORY[categoryId] ?? `category ${categoryId}`;
  return `${cat} · param ${parameterId}`;
}

/**
 * Short debug-log lines derived from `__atemCcuTrace` (same shape as `ccuWatchStyleTrace` / atem-ccu-watch JSON).
 */
export function atemCcuTraceCatalogueLines(trace: Record<string, unknown>): string[] {
  const lines: string[] = [];

  const cam = trace.cameraId;
  const w0 = Array.isArray(trace.wireCommands) ? trace.wireCommands[0] : undefined;
  const w0o = w0 && typeof w0 === "object" ? (w0 as Record<string, unknown>) : undefined;
  const flIdx = w0o && typeof w0o.inputIndex === "number" ? w0o.inputIndex : undefined;
  const flSrc = w0o && typeof w0o.source === "string" ? w0o.source : undefined;
  const useFairlightPrefix = trace.note === "atem_wire" && flIdx !== undefined;
  const camPrefix = useFairlightPrefix
    ? `Fairlight strip ${flIdx}${flSrc ? ` (src ${flSrc})` : ""}: `
    : typeof cam === "number"
      ? `cam ${cam}: `
      : "";

  const events = trace.events;
  if (Array.isArray(events) && events.length > 0) {
    lines.push(`${camPrefix}events → ${events.map((e) => String(e)).join(", ")}`);
  }

  const unhandled = trace.unhandled;
  if (Array.isArray(unhandled) && unhandled.length > 0) {
    const parts: string[] = [];
    for (const u of unhandled) {
      if (u && typeof u === "object" && "categoryId" in u && "parameterId" in u) {
        const c = u as { categoryId: number; parameterId: number };
        const id = `${c.categoryId}/${c.parameterId}`;
        parts.push(`${id} — ${describeCcuUnhandledPair(c.categoryId, c.parameterId)}`);
      } else {
        parts.push(JSON.stringify(u));
      }
    }
    lines.push(`${camPrefix}unhandled → ${parts.join(" | ")}`);
  }

  const invalid = trace.invalid;
  if (Array.isArray(invalid) && invalid.length > 0) {
    lines.push(`${camPrefix}invalid → ${JSON.stringify(invalid)}`);
  }

  const changes = trace.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    const max = 14;
    const shown = changes.slice(0, max).map(String);
    const more = changes.length > max ? ` (+${changes.length - max} more)` : "";
    lines.push(`${camPrefix}changes → ${shown.join(", ")}${more}`);
  }

  if (typeof trace.note === "string") {
    lines.push(`${camPrefix}note → ${trace.note}`);
  }

  const wire = trace.wireCommands;
  if (Array.isArray(wire) && wire.length > 0) {
    const max = 8;
    const parts: string[] = [];
    for (let i = 0; i < Math.min(max, wire.length); i++) {
      const w = wire[i];
      if (!w || typeof w !== "object") {
        parts.push(JSON.stringify(w));
        continue;
      }
      const o = w as Record<string, unknown>;
      const strip =
        typeof o.inputIndex === "number"
          ? `strip ${o.inputIndex}${typeof o.source === "string" ? ` src ${o.source}` : ""} · `
          : "";
      const tag =
        [o.ctor, o.rawName].filter((x) => typeof x === "string" && x.length > 0).join(" / ") || "cmd";
      const p = o.properties;
      if (p && typeof p === "object" && !Array.isArray(p)) {
        const pv = p as Record<string, unknown>;
        const hint: string[] = [];
        const addNum = (k: string) => {
          const v = pv[k];
          if (typeof v === "number") hint.push(`${k} ${v}`);
        };
        addNum("gain");
        addNum("faderGain");
        addNum("balance");
        addNum("sourceType");
        addNum("mixOption");
        addNum("framesDelay");
        if (hint.length) parts.push(`${strip}${tag} (${hint.join(", ")})`);
        else parts.push(`${strip}${tag}`);
      } else parts.push(`${strip}${tag}`);
    }
    const more = wire.length > max ? ` (+${wire.length - max} in batch)` : "";
    const ov = trace.wireOverflow;
    const ovPart = typeof ov === "number" && ov > 0 ? ` [+${ov} truncated]` : "";
    lines.push(`${camPrefix}wire → ${parts.join(" | ")}${more}${ovPart}`);
  }

  if (trace.ccuAudioInputLevels && typeof trace.ccuAudioInputLevels === "object") {
    lines.push(`${camPrefix}audio meters → ${JSON.stringify(trace.ccuAudioInputLevels)}`);
  }
  if (typeof trace.ccuMicLevel === "number") {
    lines.push(`${camPrefix}mic level → ${trace.ccuMicLevel}`);
  }

  const audio = trace.audio;
  if (audio && typeof audio === "object" && !Array.isArray(audio)) {
    const o = audio as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof o.micLevel === "number") bits.push(`mic ${o.micLevel}`);
    if (typeof o.headphoneLevel === "number") bits.push(`headphone ${o.headphoneLevel}`);
    if (typeof o.headphoneProgramMix === "number") bits.push(`headphoneProgMix ${o.headphoneProgramMix}`);
    if (typeof o.speakerLevel === "number") bits.push(`speaker ${o.speakerLevel}`);
    if (typeof o.inputType === "number") bits.push(`inputType ${o.inputType}`);
    const il = o.inputLevels;
    if (il && typeof il === "object" && !Array.isArray(il)) {
      const lvPair = il as Record<string, unknown>;
      if (typeof lvPair.left === "number" && typeof lvPair.right === "number") {
        bits.push(`L/R ${lvPair.left}/${lvPair.right}`);
      }
    }
    if (typeof o.phantomPower === "boolean") bits.push(`phantom ${o.phantomPower}`);
    if (bits.length) lines.push(`${camPrefix}audio CC → ${bits.join(", ")}`);
    else if (Object.keys(o).length > 0) lines.push(`${camPrefix}audio CC → ${JSON.stringify(o)}`);
  }

  const tb = trace.tallyBrightness;
  if (tb && typeof tb === "object" && !Array.isArray(tb)) {
    const o = tb as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof o.master === "number") bits.push(`master ${o.master}`);
    if (typeof o.front === "number") bits.push(`front ${o.front}`);
    if (typeof o.rear === "number") bits.push(`rear ${o.rear}`);
    if (bits.length) lines.push(`${camPrefix}tally CC → ${bits.join(", ")}`);
    else if (Object.keys(o).length > 0) lines.push(`${camPrefix}tally CC → ${JSON.stringify(o)}`);
  }

  const tallySnap = trace.tally;
  if (tallySnap && typeof tallySnap === "object" && !Array.isArray(tallySnap)) {
    const o = tallySnap as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof o.programMe === "boolean") bits.push(`programMe ${o.programMe}`);
    if (typeof o.previewMe === "boolean") bits.push(`previewMe ${o.previewMe}`);
    const br = o.brightness;
    if (br && typeof br === "object" && !Array.isArray(br)) {
      const b = br as Record<string, unknown>;
      const sub: string[] = [];
      if (typeof b.master === "number") sub.push(`master ${b.master}`);
      if (typeof b.front === "number") sub.push(`front ${b.front}`);
      if (typeof b.rear === "number") sub.push(`rear ${b.rear}`);
      if (sub.length) bits.push(`brightness ${sub.join(", ")}`);
    }
    if (bits.length) lines.push(`${camPrefix}tally (panel) → ${bits.join(", ")}`);
    else if (Object.keys(o).length > 0) lines.push(`${camPrefix}tally (panel) → ${JSON.stringify(o)}`);
  }

  const lv = trace.lensVideo;
  if (lv && typeof lv === "object") {
    const o = lv as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof o.gainDb === "number") bits.push(`gainDb ${o.gainDb}`);
    if (typeof o.iris === "number") bits.push(`iris ${o.iris}`);
    if (typeof o.focus === "number") bits.push(`focus ${o.focus}`);
    if (bits.length) lines.push(`${camPrefix}lensVideo → ${bits.join(", ")}`);
  }

  if (lines.length === 0) {
    lines.push(`${camPrefix}(no catalogue fields — enable bm-debug-atem-ccu-json for full trace)`);
  }

  return lines;
}

/** One readable line for the UI debug log (single line, explicit labels). */
export function atemCcuTraceLogLineCompact(trace: Record<string, unknown>): string {
  const pieces: string[] = [];
  if (typeof trace.ts === "string") {
    const t = trace.ts.split("T")[1]?.replace("Z", "").slice(0, 12) ?? "";
    if (t) pieces.push(`time ${t}`);
  }
  if (typeof trace.note === "string") pieces.push(`note ${trace.note}`);

  const wireForStrip = trace.wireCommands;
  let fairlightStrip: string | undefined;
  if (Array.isArray(wireForStrip)) {
    for (const raw of wireForStrip) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.inputIndex === "number") {
        fairlightStrip = `Fairlight strip ${o.inputIndex}${
          typeof o.source === "string" && o.source.length > 0 ? ` (src ${o.source})` : ""
        }`;
        break;
      }
    }
  }
  if (fairlightStrip) pieces.push(fairlightStrip);

  if (typeof trace.cameraId === "number") {
    const n = typeof trace.note === "string" ? trace.note : "";
    if (!(fairlightStrip !== undefined && n === "atem_wire")) {
      pieces.push(`camera ${trace.cameraId}`);
    }
  }

  const lv = trace.lensVideo;
  if (lv && typeof lv === "object" && !Array.isArray(lv)) {
    const o = lv as Record<string, unknown>;
    const seg: string[] = [];
    if (typeof o.iris === "number") seg.push(`iris ${o.iris.toFixed(2)}`);
    if (typeof o.focus === "number") seg.push(`focus ${o.focus.toFixed(2)}`);
    if (typeof o.gainDb === "number") seg.push(`gain ${o.gainDb} dB`);
    if (typeof o.wbKelvin === "number") seg.push(`WB ${o.wbKelvin}K`);
    if (typeof o.tint === "number" && o.tint !== 0) seg.push(`tint ${o.tint}`);
    if (typeof o.shutter === "number") seg.push(`shutter ${o.shutter}`);
    if (typeof o.exposureUs === "number" && o.exposureUs > 0) seg.push(`exposure ${o.exposureUs} µs`);
    if (typeof o.ndStop === "number" && o.ndStop > 0) seg.push(`ND ${o.ndStop}`);
    if (seg.length) pieces.push(`lens: ${seg.join(", ")}`);
  }

  const wire = trace.wireCommands;
  if (Array.isArray(wire) && wire.length > 0) {
    const w0 = wire[0];
    let wtxt = "";
    if (w0 && typeof w0 === "object") {
      const o = w0 as Record<string, unknown>;
      const strip0 =
        typeof o.inputIndex === "number"
          ? `strip ${o.inputIndex}${typeof o.source === "string" ? ` src ${o.source} · ` : ""}`
          : "";
      const ctorName =
        typeof o.ctor === "string" && o.ctor.length > 0
          ? o.ctor
          : typeof o.rawName === "string"
            ? o.rawName
            : "Command";
      const p = o.properties;
      if (p && typeof p === "object" && !Array.isArray(p)) {
        const pv = p as Record<string, unknown>;
        const labeled = readableWireProperties(pv);
        wtxt = labeled.length ? `${strip0}${ctorName} — ${labeled.join(", ")}` : `${strip0}${ctorName}`;
      } else wtxt = `${strip0}${ctorName}`;
    }
    if (wire.length > 1) wtxt += ` (+${wire.length - 1} more in batch)`;
    const ov = trace.wireOverflow;
    if (typeof ov === "number" && ov > 0) wtxt += ` (${ov} more not shown)`;
    pieces.push(wtxt);
  }

  if (typeof trace.iso === "number") pieces.push(`ISO ${trace.iso}`);

  const ev = trace.events;
  if (Array.isArray(ev) && ev.length > 0) pieces.push(`${ev.length} event${ev.length === 1 ? "" : "s"}`);

  const ch = trace.changes;
  if (Array.isArray(ch) && ch.length > 0) {
    const head = ch
      .slice(0, 3)
      .map((x) => String(x).replace(/^colorCorrection\./, ""))
      .join(", ");
    pieces.push(
      `changes: ${head}${ch.length > 3 ? ` (+${ch.length - 3} more)` : ""}`,
    );
  }

  const unh = trace.unhandled;
  if (Array.isArray(unh) && unh.length > 0) {
    pieces.push(`${unh.length} unhandled CC`);
  }

  const ar = trace.atemRaw;
  if (Array.isArray(ar) && ar.length > 0) pieces.push(`atemRaw ×${ar.length}`);

  return pieces.join(" │ ") || "—";
}

/** Human-readable Fairlight / wire numeric fields (subset of common keys). */
function readableWireProperties(pv: Record<string, unknown>): string[] {
  const out: string[] = [];
  const n = (key: string, label: string) => {
    const v = pv[key];
    if (typeof v === "number" && !Number.isNaN(v)) out.push(`${label} ${v}`);
  };
  n("gain", "gain");
  n("faderGain", "fader");
  n("balance", "balance");
  n("mixOption", "mix");
  n("sourceType", "source type");
  n("framesDelay", "delay frames");
  n("maxFramesDelay", "max delay frames");
  n("equalizerGain", "EQ gain");
  n("makeUpGain", "make-up gain");
  n("stereoSimulation", "stereo sim");
  n("bandCount", "bands");
  const eqEn = pv.equalizerEnabled;
  if (typeof eqEn === "boolean") out.push(`EQ ${eqEn ? "on" : "off"}`);
  const stereo = pv.hasStereoSimulation;
  if (typeof stereo === "boolean") out.push(`stereo sim ${stereo ? "yes" : "no"}`);
  const sup = pv.supportedMixOptions;
  if (Array.isArray(sup) && sup.length > 0 && sup.length <= 6) {
    out.push(`mix opts [${sup.join(", ")}]`);
  }
  return out;
}
