import { Commands } from "atem-connection";

/** Same shape as deserialized {@link Commands.CameraControlUpdateCommand}; avoids missed batches if `instanceof` fails across bundles. */
export function isCameraControlUpdateLike(c: unknown): c is Commands.CameraControlUpdateCommand {
  if (typeof c !== "object" || c === null) return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.source === "number" &&
    typeof o.category === "number" &&
    typeof o.parameter === "number" &&
    typeof o.properties === "object" &&
    o.properties !== null
  );
}

export function collectCameraControlUpdates(commands: unknown[]): Commands.CameraControlUpdateCommand[] {
  const out: Commands.CameraControlUpdateCommand[] = [];
  for (const c of commands) {
    if (c instanceof Commands.CameraControlUpdateCommand) {
      out.push(c);
      continue;
    }
    if (isCameraControlUpdateLike(c)) {
      out.push(c);
    }
  }
  return out;
}
