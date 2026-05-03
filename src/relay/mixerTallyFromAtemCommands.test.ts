import { Commands } from "atem-connection";
import { describe, expect, it } from "vitest";
import { readTallyBySourceForCamera } from "../../server/atem/mixerTallyFromAtemCommands.js";

describe("readTallyBySourceForCamera", () => {
  it("returns undefined when no tally command", () => {
    expect(readTallyBySourceForCamera([], 3)).toBeUndefined();
    expect(readTallyBySourceForCamera([{}], 3)).toBeUndefined();
  });

  it("maps program/preview to programMe/previewMe for the requested source", () => {
    const cmd = new Commands.TallyBySourceCommand({
      1: { program: false, preview: true },
      3: { program: true, preview: false },
    });
    expect(readTallyBySourceForCamera([cmd], 3)).toEqual({ programMe: true, previewMe: false });
    expect(readTallyBySourceForCamera([cmd], 1)).toEqual({ programMe: false, previewMe: true });
    expect(readTallyBySourceForCamera([cmd], 99)).toBeUndefined();
  });

  it("uses the last TallyBySourceCommand when several appear in one batch", () => {
    const a = new Commands.TallyBySourceCommand({ 2: { program: true, preview: false } });
    const b = new Commands.TallyBySourceCommand({ 2: { program: false, preview: true } });
    expect(readTallyBySourceForCamera([a, b], 2)).toEqual({ programMe: false, previewMe: true });
  });
});
