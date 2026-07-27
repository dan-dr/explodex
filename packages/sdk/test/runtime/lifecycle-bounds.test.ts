import { describe, expect, test } from "bun:test";
import { createLifecycleHarness } from "../../src/testing/index.ts";
import type { PluginApi, PluginTeardown } from "../../src/types/plugin.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("VAL-SDK-019 bounded generation-safe setup/teardown", () => {
  test("awaits async setup within bound and records generation token", async () => {
    const harness = createLifecycleHarness();
    const tokens: string[] = [];
    const result = await harness.apply(
      "sample",
      {
        async setup(api: PluginApi) {
          tokens.push(api.token);
          await Promise.resolve();
          return () => {
            /* teardown */
          };
        },
      },
      { setupTimeoutMs: 1_000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.record.status).toBe("applied");
    expect(result.record.generation).toBe(1);
    expect(result.record.token).toBe(tokens[0]!);
    expect(result.record.setupCount).toBe(1);
  });

  test("setup timeout is reported truthfully and does not mark applied", async () => {
    const harness = createLifecycleHarness();
    const result = await harness.apply(
      "sample",
      {
        setup() {
          return new Promise(() => {
            /* never resolves */
          });
        },
      },
      { setupTimeoutMs: 30 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected timeout");
    expect(result.code).toBe("plugin.lifecycle.setup-timeout");
    expect(result.record.status).toBe("failed");
  });

  test("unload racing in-flight setup prevents late apply", async () => {
    const harness = createLifecycleHarness();
    const gate = deferred<PluginTeardown | void>();
    let setupEntered = false;

    const applyPromise = harness.apply(
      "sample",
      {
        setup() {
          setupEntered = true;
          return gate.promise;
        },
      },
      { setupTimeoutMs: 2_000 },
    );

    // Wait until setup is in flight.
    for (let i = 0; i < 50 && !setupEntered; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(setupEntered).toBe(true);

    const unload = await harness.unload("sample");
    expect(unload).not.toBeNull();

    // Late resolve with a teardown function: cleanup-only, not applied.
    let teardownCalls = 0;
    gate.resolve(async () => {
      teardownCalls += 1;
    });

    const apply = await applyPromise;
    expect(apply.ok).toBe(false);
    if (apply.ok) throw new Error("expected superseded");
    expect(apply.code).toBe("plugin.lifecycle.superseded");
    expect(apply.record.status).not.toBe("applied");
    // Late teardown is invoked exactly once in cleanup-only mode.
    await new Promise((r) => setTimeout(r, 20));
    expect(teardownCalls).toBe(1);
  });

  test("supersession rejects new tracked resources from late generation", async () => {
    const harness = createLifecycleHarness();
    const gate = deferred<void>();
    let lateApi: PluginApi | null = null;

    const first = harness.apply(
      "sample",
      {
        async setup(api) {
          lateApi = api;
          await gate.promise;
        },
      },
      { setupTimeoutMs: 2_000 },
    );

    // Start second generation while first is in flight.
    await new Promise((r) => setTimeout(r, 10));
    const second = await harness.apply(
      "sample",
      {
        setup() {
          /* immediate */
        },
      },
      { setupTimeoutMs: 1_000 },
    );
    expect(second.ok).toBe(true);

    gate.resolve();
    const late = await first;
    expect(late.ok).toBe(false);

    expect(lateApi).not.toBeNull();
    expect(() =>
      lateApi!.track.subscription(() => {
        /* should reject */
      }),
    ).toThrow(/no longer accepting|rejected/i);
  });

  test("teardown is invoked at most once", async () => {
    const harness = createLifecycleHarness();
    let teardownCalls = 0;
    const applied = await harness.apply("sample", {
      setup() {
        return () => {
          teardownCalls += 1;
        };
      },
    });
    expect(applied.ok).toBe(true);
    await harness.unload("sample");
    await harness.unload("sample");
    await harness.unload("sample");
    expect(teardownCalls).toBe(1);
  });

  test("failed replacement never restores the superseded generation", async () => {
    const harness = createLifecycleHarness();
    let oldTeardownCalls = 0;

    const first = await harness.apply("sample", {
      setup() {
        return () => {
          oldTeardownCalls += 1;
        };
      },
    });
    expect(first.ok).toBe(true);

    const replacement = await harness.apply("sample", {
      setup() {
        throw new Error("replacement failed");
      },
    });
    expect(replacement.ok).toBe(false);
    if (replacement.ok) throw new Error("expected replacement failure");
    expect(replacement.record.status).toBe("failed");
    expect(harness.host.get("sample")?.generation).toBe(replacement.record.generation);
    expect(harness.host.get("sample")?.status).toBe("failed");
    expect(harness.host.get("sample")?.generation).not.toBe(first.record.generation);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(oldTeardownCalls).toBe(1);
  });

  test("in-flight generation superseded by a failed replacement finishes cleanup-only", async () => {
    const harness = createLifecycleHarness();
    const gate = deferred<PluginTeardown>();
    let oldTeardownCalls = 0;

    const firstPromise = harness.apply(
      "sample",
      {
        setup() {
          return gate.promise;
        },
      },
      { setupTimeoutMs: 2_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const replacement = await harness.apply("sample", {
      setup() {
        throw new Error("replacement failed");
      },
    });
    expect(replacement.ok).toBe(false);
    if (replacement.ok) throw new Error("expected replacement failure");
    expect(harness.host.get("sample")?.generation).toBe(replacement.record.generation);

    gate.resolve(() => {
      oldTeardownCalls += 1;
    });
    const first = await firstPromise;
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("expected superseded result");
    expect(first.code).toBe("plugin.lifecycle.superseded");
    expect(first.record.status).toBe("superseded");
    expect(oldTeardownCalls).toBe(1);
    expect(harness.host.get("sample")?.generation).toBe(replacement.record.generation);
    expect(harness.host.get("sample")?.status).toBe("failed");
  });

  test("timed-out setup may only finish through one cleanup-only teardown", async () => {
    const harness = createLifecycleHarness();
    const gate = deferred<PluginTeardown>();
    let teardownCalls = 0;

    const result = await harness.apply(
      "sample",
      {
        setup() {
          return gate.promise;
        },
      },
      { setupTimeoutMs: 20, teardownTimeoutMs: 1_000 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected timeout");
    expect(result.code).toBe("plugin.lifecycle.setup-timeout");

    gate.resolve(() => {
      teardownCalls += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(teardownCalls).toBe(1);
    expect(harness.host.get("sample")?.status).toBe("failed");
  });

  test("late setup rejection cannot overwrite unloaded leak truth", async () => {
    const harness = createLifecycleHarness();
    const gate = deferred<void>();
    const applyPromise = harness.apply(
      "sample",
      {
        async setup(api) {
          api.track.subscription(() => {
            throw new Error("still retained");
          });
          await gate.promise;
        },
      },
      { setupTimeoutMs: 2_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const unload = await harness.unload("sample");
    expect(unload?.record.status).toBe("unloaded");
    expect(unload?.record.resources.subscriptions).toBe(1);
    expect(harness.detectTrackedLeaks("sample").leaked).toBe(true);

    gate.reject(new Error("late setup rejection"));
    const apply = await applyPromise;
    expect(apply.ok).toBe(false);
    expect(harness.host.get("sample")?.status).toBe("unloaded");
    expect(harness.detectTrackedLeaks("sample").leaked).toBe(true);
  });
});
