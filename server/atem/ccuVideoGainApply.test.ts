import { describe, expect, it } from "vitest";
import { Commands } from "atem-connection";
import { extractCcuGainDbUpdate } from "./ccuVideoGainApply.js";

function ccUpdate(
  source: number,
  parameter: number,
  type: Commands.CameraControlDataType,
  numberData: number[],
): Commands.CameraControlUpdateCommand {
  return new Commands.CameraControlUpdateCommand(source, 1, parameter, {
    type,
    boolData: [],
    numberData,
    bigintData: [],
    stringData: "",
    periodicFlushEnabled: false,
  });
}

describe("extractCcuGainDbUpdate", () => {
  it("reads param 13 as SINT16 (builder rejects this type)", () => {
    const v = extractCcuGainDbUpdate([ccUpdate(7, 13, Commands.CameraControlDataType.SINT16, [12])], 7);
    expect(v).toBe(12);
  });

  it("reads param 13 as SINT8", () => {
    expect(extractCcuGainDbUpdate([ccUpdate(3, 13, Commands.CameraControlDataType.SINT8, [-3])], 3)).toBe(-3);
  });

  it("prefers param 13 over legacy param 1 in the same batch", () => {
    const v = extractCcuGainDbUpdate(
      [ccUpdate(2, 1, Commands.CameraControlDataType.SINT8, [99]), ccUpdate(2, 13, Commands.CameraControlDataType.SINT8, [6])],
      2,
    );
    expect(v).toBe(6);
  });

  it("falls back to legacy param 1 when param 13 absent", () => {
    expect(extractCcuGainDbUpdate([ccUpdate(5, 1, Commands.CameraControlDataType.SINT8, [4])], 5)).toBe(4);
  });

  it("ignores other cameras", () => {
    expect(extractCcuGainDbUpdate([ccUpdate(8, 13, Commands.CameraControlDataType.SINT8, [10])], 7)).toBeUndefined();
  });
});
