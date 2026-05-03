/**
 * @file atemPanelSyncMirrorBle.ts
 *
 * Turn ATEM relay `panel_sync` snapshot slices (same shape as {@link CameraSnapshot} JSON) into
 * Blackmagic **Change Configuration** packets so a locally connected camera can track the switcher.
 */

import { commands } from "../blackmagic/protocol";

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function record(x: unknown): Record<string, unknown> | undefined {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
}

type RgbLuma = { red: number; green: number; blue: number; luma: number };

function lgg(x: unknown): RgbLuma | undefined {
  const o = record(x);
  if (!o) return undefined;
  const r = num(o.red);
  const g = num(o.green);
  const b = num(o.blue);
  const l = num(o.luma);
  if (r === undefined || g === undefined || b === undefined || l === undefined) return undefined;
  return { red: r, green: g, blue: b, luma: l };
}

/** Map ATEM-derived `panel_sync` merge keys → BLE configuration packets (destination applied by caller). */
export function blePacketsFromAtemPanelSyncClean(clean: Record<string, unknown>): Uint8Array[] {
  const out: Uint8Array[] = [];

  const lens = record(clean.lens);
  if (lens) {
    const focus = num(lens.focus);
    if (focus !== undefined) out.push(commands.focus(focus));

    const norm = num(lens.apertureNormalised);
    const fstopField = num(lens.apertureFstop);
    if (norm !== undefined && norm >= 0 && norm <= 1) {
      out.push(commands.iris(norm));
    } else if (fstopField !== undefined) {
      if (fstopField >= 0 && fstopField <= 1) out.push(commands.iris(fstopField));
      else out.push(commands.aperture(fstopField));
    }

    const zoom = num(lens.zoom);
    if (zoom !== undefined) out.push(commands.zoomNormalised(zoom));
  }

  const wb = record(clean.whiteBalance);
  if (wb) {
    const t = num(wb.temperature);
    const tint = num(wb.tint) ?? 0;
    if (t !== undefined) out.push(commands.whiteBalance(t, tint));
  }

  const gainDb = num(clean.gainDb);
  if (gainDb !== undefined) out.push(commands.gain(gainDb));

  const iso = num(clean.iso);
  if (iso !== undefined) out.push(commands.iso(iso));

  const exposureUs = num(clean.exposureUs);
  if (exposureUs !== undefined) out.push(commands.exposureUs(exposureUs));

  const shutterSpeed = num(clean.shutterSpeed);
  if (shutterSpeed !== undefined) out.push(commands.shutterSpeed(shutterSpeed));

  const shutterAngle = num(clean.shutterAngle);
  if (shutterAngle !== undefined) out.push(commands.shutterAngle(shutterAngle));

  const sharpening = num(clean.sharpeningLevel);
  if (sharpening !== undefined) out.push(commands.sharpening(sharpening));

  const nd = num(clean.ndFilterStops);
  if (nd !== undefined) {
    const mode = num(clean.ndFilterDisplayMode) ?? 0;
    out.push(commands.ndFilterStops(nd, mode));
  } else {
    const ndModeOnly = num(clean.ndFilterDisplayMode);
    if (ndModeOnly !== undefined) out.push(commands.ndFilterDisplayMode(ndModeOnly));
  }

  const dyn = num(clean.dynamicRange);
  if (dyn !== undefined) out.push(commands.dynamicRange(dyn));

  const ae = num(clean.autoExposureMode);
  if (ae !== undefined) out.push(commands.autoExposureMode(ae));

  const lut = record(clean.displayLut);
  if (lut) {
    const sel = num(lut.selected);
    const en = lut.enabled === true;
    if (sel !== undefined) out.push(commands.displayLut(sel, en));
  }

  const color = record(clean.color);
  if (color) {
    const lift = lgg(color.lift);
    if (lift) out.push(commands.lift(lift.red, lift.green, lift.blue, lift.luma));
    const gamma = lgg(color.gamma);
    if (gamma) out.push(commands.gamma(gamma.red, gamma.green, gamma.blue, gamma.luma));
    const cg = lgg(color.gain);
    if (cg) out.push(commands.videoGain(cg.red, cg.green, cg.blue, cg.luma));
    const off = lgg(color.offset);
    if (off) out.push(commands.offset(off.red, off.green, off.blue, off.luma));
    const con = record(color.contrast);
    if (con) {
      const pivot = num(con.pivot);
      const adj = num(con.adjust);
      if (pivot !== undefined && adj !== undefined) out.push(commands.contrast(pivot, adj));
    }
    const lm = num(color.lumaMix);
    if (lm !== undefined) out.push(commands.lumaMix(lm));
    const hue = num(color.hue);
    const sat = num(color.saturation);
    if (hue !== undefined && sat !== undefined) out.push(commands.colorAdjust(hue, sat));
  }

  const uo = record(clean.unitOutputs);
  if (uo) {
    if (typeof uo.colorBars === "boolean") out.push(commands.colorBars(uo.colorBars ? 30 : 0));
    if (typeof uo.programReturnFeed === "boolean")
      out.push(commands.programReturnFeed(uo.programReturnFeed ? 30 : 0));
  }

  const audio = record(clean.audio);
  if (audio) {
    const mic = num(audio.micLevel);
    if (mic !== undefined) out.push(commands.micLevel(mic));
    const hp = num(audio.headphoneLevel);
    if (hp !== undefined) out.push(commands.headphoneLevel(hp));
    const hpm = num(audio.headphoneProgramMix);
    if (hpm !== undefined) out.push(commands.headphoneProgramMix(hpm));
    const sp = num(audio.speakerLevel);
    if (sp !== undefined) out.push(commands.speakerLevel(sp));
    const it = num(audio.inputType);
    if (it !== undefined) out.push(commands.audioInputType(it));
    if (typeof audio.phantomPower === "boolean") out.push(commands.phantomPower(audio.phantomPower));
    // Skip audio.inputLevels — CCU meters would spam the camera.
  }

  const tally = record(clean.tally);
  const br = tally ? record(tally.brightness) : undefined;
  if (br) {
    const m = num(br.master);
    if (m !== undefined) out.push(commands.tallyBrightness(m));
    const f = num(br.front);
    if (f !== undefined) out.push(commands.frontTallyBrightness(f));
    const r = num(br.rear);
    if (r !== undefined) out.push(commands.rearTallyBrightness(r));
  }

  return out;
}
