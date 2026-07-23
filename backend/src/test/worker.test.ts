/*
 * Unit coverage for the worker's import-safe account-erasure scheduler seam.
 * The seam must register a tick without starting a real timer and must catch
 * async scheduler failures so importing `worker.ts` stays side-effect free.
 */
import { describe, expect, it, vi } from "vitest";
import { registerAccountErasureScheduler } from "../worker";

describe("registerAccountErasureScheduler", () => {
  it("uses the provided interval and logs rejected account-erasure ticks without leaking them", async () => {
    let registeredCallback: (() => Promise<void> | void) | undefined;
    const schedulerFailure = new Error("scheduler blew up");
    const setIntervalFake = vi.fn(
      (callback: () => Promise<void> | void, delay: number) => {
        registeredCallback = callback;
        return { delay } as unknown as ReturnType<typeof setInterval>;
      },
    );
    const enqueueDueAccountErasures = vi.fn(async () => {
      throw schedulerFailure;
    });
    const logError = vi.fn();

    registerAccountErasureScheduler({} as never, 12_345, {
      setInterval: setIntervalFake,
      enqueueDueAccountErasures,
      logError,
    });

    expect(setIntervalFake).toHaveBeenCalledWith(expect.any(Function), 12_345);
    if (registeredCallback === undefined) {
      throw new Error(
        "expected registerAccountErasureScheduler to register a callback",
      );
    }

    await expect(registeredCallback()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "[scheduler] account erasure tick failed",
    );
  });
});
