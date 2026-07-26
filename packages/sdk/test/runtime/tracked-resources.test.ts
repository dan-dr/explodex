import { describe, expect, test } from "bun:test";
import {
  createLifecycleHarness,
  createTrackedResourceRegistry,
} from "../../src/testing/index.ts";
import type { PluginApi } from "../../src/types/plugin.ts";

describe("VAL-SDK-020 lifecycle tracked-resource cleanup", () => {
  test("successful setup runs once and unload disposes tracked resources", async () => {
    const harness = createLifecycleHarness();
    let setupCount = 0;
    let teardownCount = 0;
    let unsubscribed = false;
    let observerDisconnected = false;
    let timeoutFired = false;

    const applied = await harness.apply("sample", {
      setup(api: PluginApi) {
        setupCount += 1;
        api.track.subscription(() => {
          unsubscribed = true;
        });
        api.track.observe({
          disconnect() {
            observerDisconnected = true;
          },
        });
        api.track.timeout(() => {
          timeoutFired = true;
        }, 60_000);
        const mount = {
          removed: false,
          remove() {
            this.removed = true;
          },
        };
        api.track.mount(mount);
        return () => {
          teardownCount += 1;
        };
      },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error(applied.message);
    expect(applied.record.setupCount).toBe(1);
    expect(applied.record.resources.total).toBeGreaterThanOrEqual(4);

    const unload = await harness.unload("sample");
    expect(unload).not.toBeNull();
    expect(setupCount).toBe(1);
    expect(teardownCount).toBe(1);
    expect(unsubscribed).toBe(true);
    expect(observerDisconnected).toBe(true);
    expect(timeoutFired).toBe(false);

    const after = harness.snapshot("sample");
    expect(after?.total).toBe(0);

    const leaks = harness.detectTrackedLeaks("sample");
    expect(leaks.leaked).toBe(false);
  });

  test("repeated unload is idempotent", async () => {
    const harness = createLifecycleHarness();
    let teardownCount = 0;
    await harness.apply("sample", {
      setup() {
        return () => {
          teardownCount += 1;
        };
      },
    });
    await harness.unload("sample");
    await harness.unload("sample");
    expect(teardownCount).toBe(1);
  });

  test("harness detects controlled tracked-resource presence before unload", async () => {
    const harness = createLifecycleHarness();
    await harness.apply("sample", {
      setup(api) {
        api.track.subscription(() => {});
      },
    });
    const before = harness.snapshot("sample");
    expect(before?.subscriptions).toBe(1);
    // Not unloaded yet — total > 0 is the controlled tracked state.
    expect(before?.total).toBeGreaterThan(0);
  });

  test("registry rejects new resources after disposeAll", () => {
    const registry = createTrackedResourceRegistry({
      generation: 1,
      token: "t1",
    });
    registry.track.subscription(() => {});
    const disposed = registry.disposeAll();
    expect(disposed.subscriptions).toBe(1);
    expect(registry.snapshot().total).toBe(0);
    expect(() => registry.track.subscription(() => {})).toThrow(/rejected|no longer accepting/i);
  });

  test("does not claim universal leak prevention for untracked effects", async () => {
    const harness = createLifecycleHarness();
    const untracked: { alive: boolean } = { alive: true };
    await harness.apply("sample", {
      setup() {
        // Deliberately untracked side effect — harness must not claim to detect it.
        untracked.alive = true;
      },
    });
    await harness.unload("sample");
    // Untracked object remains; lifecycle only guarantees runtime-tracked resources.
    expect(untracked.alive).toBe(true);
    const leaks = harness.detectTrackedLeaks("sample");
    expect(leaks.leaked).toBe(false);
  });
});
