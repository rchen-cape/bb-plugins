import { describe, expect, it } from "vitest";
import { addWheelZoom, wheelDeltaPx, wheelZoom, wheelZoomFactor } from "./viewport";

describe("wheel zoom", () => {
  it("scales smoothly by exp(-deltaY / 100) for small deltas", () => {
    expect(wheelZoomFactor(-4)).toBeCloseTo(Math.exp(0.04));
    expect(wheelZoomFactor(4)).toBeCloseTo(Math.exp(-0.04));
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it("caps one wheel event at about 10%", () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.1));
    expect(wheelZoomFactor(-1000)).toBeCloseTo(Math.exp(0.1));
    expect(wheelZoomFactor(250)).toBeCloseTo(Math.exp(-0.1));
    expect(wheelZoomFactor(Number.NaN)).toBe(1);
    expect(Math.round(wheelZoom(1, -100) * 100)).toBe(111);
  });

  it("caps several events in one frame", () => {
    let factor = 1;
    for (let i = 0; i < 10; i += 1) factor = addWheelZoom(factor, -100);
    expect(factor).toBeCloseTo(1.25);
    factor = 1;
    for (let i = 0; i < 10; i += 1) factor = addWheelZoom(factor, 100);
    expect(factor).toBeCloseTo(0.8);
    expect(addWheelZoom(1, -5)).toBeCloseTo(Math.exp(0.05));
  });

  it("keeps zoom inside its limits", () => {
    expect(wheelZoom(30, -1000)).toBe(30);
    expect(wheelZoom(0.1, 1000)).toBe(0.1);
  });

  it("turns line and page deltas into pixels", () => {
    expect(wheelDeltaPx(3, 0, 800)).toBe(3);
    expect(wheelDeltaPx(3, 1, 800)).toBe(48);
    expect(wheelDeltaPx(1, 2, 800)).toBe(800);
    expect(wheelDeltaPx(1, 2, 0)).toBe(1);
  });
});
