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
    expect(disposed.attempted.subscriptions).toBe(1);
    expect(disposed.disposed.subscriptions).toBe(1);
    expect(disposed.failed.total).toBe(0);
    expect(registry.snapshot().total).toBe(0);
    expect(() => registry.track.subscription(() => {})).toThrow(/rejected|no longer accepting/i);
  });

  test("failed tracked disposals remain visible while every resource is attempted", async () => {
    const harness = createLifecycleHarness();
    const attempts: string[] = [];

    await harness.apply("sample", {
      setup(api) {
        api.track.subscription(() => {
          attempts.push("later");
        });
        api.track.subscription(() => {
          attempts.push("failed");
          throw new Error("cannot unsubscribe");
        });
        api.track.subscription(() => {
          attempts.push("first");
        });
      },
    });

    const unload = await harness.unload("sample");
    expect(unload).not.toBeNull();
    if (unload === null) throw new Error("expected unload result");
    expect(attempts).toEqual(["first", "failed", "later"]);
    expect(unload.disposed.attempted.subscriptions).toBe(3);
    expect(unload.disposed.disposed.subscriptions).toBe(2);
    expect(unload.disposed.failed.subscriptions).toBe(1);
    expect(unload.disposed.residual.subscriptions).toBe(1);
    expect(unload.disposed.failures).toHaveLength(1);
    expect(unload.record.resources.subscriptions).toBe(1);
    expect(unload.record.error?.code).toBe("plugin.lifecycle.cleanup-failed");

    const leaks = harness.detectTrackedLeaks("sample");
    expect(leaks.leaked).toBe(true);
    expect(leaks.snapshot?.subscriptions).toBe(1);
  });

  test("failed disposal from a superseded generation remains queryable", async () => {
    const harness = createLifecycleHarness();
    await harness.apply("sample", {
      setup(api) {
        api.track.subscription(() => {
          throw new Error("old generation retained");
        });
      },
    });

    const replacement = await harness.apply("sample", {
      setup() {},
    });
    expect(replacement.ok).toBe(false);
    if (replacement.ok) throw new Error("expected previous cleanup failure");
    expect(replacement.code).toBe("plugin.lifecycle.previous-cleanup-failed");
    expect(replacement.record.supersededCleanupFailures).toHaveLength(1);
    expect(
      replacement.record.supersededCleanupFailures[0]?.cleanup.residual.subscriptions,
    ).toBe(1);
    expect(harness.detectTrackedLeaks("sample").leaked).toBe(true);

    const third = await harness.apply("sample", { setup() {} });
    expect(third.record.supersededCleanupFailures).toHaveLength(1);
    expect(harness.detectTrackedLeaks("sample").leaked).toBe(true);
  });

  test("rejected late registrations do not create untracked listener or timer effects", () => {
    let listeners = 0;
    let timers = 0;
    const registry = createTrackedResourceRegistry({
      generation: 1,
      token: "late",
      timers: {
        setTimeout() {
          timers += 1;
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout() {},
        setInterval() {
          timers += 1;
          return 2 as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval() {},
      },
    });
    registry.rejectNew("superseded");

    expect(() =>
      registry.track.listen(
        {
          addEventListener() {
            listeners += 1;
          },
          removeEventListener() {
            listeners -= 1;
          },
        },
        "click",
        null,
      ),
    ).toThrow(/rejected|no longer accepting/i);
    expect(() => registry.track.timeout(() => {}, 1)).toThrow(/rejected|no longer accepting/i);
    expect(() => registry.track.interval(() => {}, 1)).toThrow(/rejected|no longer accepting/i);
    expect(listeners).toBe(0);
    expect(timers).toBe(0);
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
