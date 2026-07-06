import { describe, expect, it } from "vitest";

import { formatTime } from "./time";

describe("formatTime", () => {
  it("formats zero", () => {
    expect(formatTime(0)).toBe("0:00.0");
  });

  it("formats sub-minute values with tenths", () => {
    expect(formatTime(5.67)).toBe("0:05.6");
    expect(formatTime(59.99)).toBe("0:59.9");
  });

  it("formats minutes", () => {
    expect(formatTime(60)).toBe("1:00.0");
    expect(formatTime(65.32)).toBe("1:05.3");
    expect(formatTime(600.05)).toBe("10:00.0");
  });

  it("is safe on bad input", () => {
    expect(formatTime(-1)).toBe("0:00.0");
    expect(formatTime(Number.NaN)).toBe("0:00.0");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("0:00.0");
  });
});
