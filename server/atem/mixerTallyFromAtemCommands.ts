import { Commands } from "atem-connection";

/** Mixer-side tally for one input (maps to {@link CameraSnapshot} `tally.programMe` / `previewMe`). */
export type MixerTallyLeds = { programMe: boolean; previewMe: boolean };

/**
 * Reads {@link Commands.TallyBySourceCommand} from an `atem-connection` `receivedCommands` batch.
 * If several tally commands appear, the last one that defines `cameraId` wins.
 */
export function readTallyBySourceForCamera(commands: unknown[], cameraId: number): MixerTallyLeds | undefined {
  let out: MixerTallyLeds | undefined;
  for (const cmd of commands) {
    if (!(cmd instanceof Commands.TallyBySourceCommand)) continue;
    const row = cmd.properties[cameraId];
    if (!row) continue;
    out = { programMe: row.program, previewMe: row.preview };
  }
  return out;
}
