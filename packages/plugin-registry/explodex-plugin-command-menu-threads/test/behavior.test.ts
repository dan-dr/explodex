import { describe, expect, test } from "bun:test";
import {
  activateThreadSelection,
  defaultCommandMenuThreadSettings,
  filterThreads,
  normalizeCommandMenuThreadSettings,
  rememberNativeCommandMenuState,
  restoreNativeCommandMenuState,
  type CommandMenuThread,
} from "../src/search.ts";

const threads: CommandMenuThread[] = [
  {
    conversationId: "alpha",
    threadKey: "local:alpha",
    title: "Alpha exact",
    pinned: false,
    activityMs: 100,
    sidebarIndex: 0,
  },
  {
    conversationId: "pinned",
    threadKey: "local:pinned",
    title: "Alpha pinned",
    pinned: true,
    activityMs: 1_000,
    sidebarIndex: 1,
  },
  {
    conversationId: "recent",
    threadKey: "local:recent",
    title: "Recent thread",
    pinned: false,
    activityMs: 10,
    sidebarIndex: 2,
  },
];

class FakeHeading {
  textContent: string;
  style = { display: "" };
  private readonly attributes = new Map<string, string>();

  constructor(text: string) {
    this.textContent = text;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "style") this.style.display = value;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "style") this.style.display = "";
  }
}

class FakeGroup {
  readonly heading: FakeHeading;
  private readonly attributes = new Map<string, string>();

  constructor(
    readonly id: string,
    heading: string,
  ) {
    this.heading = new FakeHeading(heading);
    this.attributes.set("cmdk-group", "");
  }

  querySelector(selector: string): FakeHeading | null {
    return selector === "[cmdk-group-heading]" ? this.heading : null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

class FakeList {
  private readonly attributes = new Map<string, string>();

  constructor(readonly groups: FakeGroup[]) {}

  querySelectorAll(selector: string): FakeGroup[] {
    return selector === ":scope > [cmdk-group]" ? [...this.groups] : [];
  }

  appendChild(group: FakeGroup): FakeGroup {
    const current = this.groups.indexOf(group);
    if (current >= 0) this.groups.splice(current, 1);
    this.groups.push(group);
    return group;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

describe("VAL-PLUG-009 Threads in Command Menu behavior", () => {
  test("normalizes limits and preserves configured priority order", () => {
    expect(
      normalizeCommandMenuThreadSettings({
        maxThreads: 100,
        minChars: -2,
        sortBy: ["match", "match", "pinned"],
        showRecentOnOpen: true,
      }),
    ).toEqual({
      maxThreads: 10,
      minChars: 1,
      sortBy: ["match", "pinned", "recent"],
      showRecentOnOpen: true,
    });
  });

  test("leaves native commands unchanged for short or empty queries unless recent is enabled", () => {
    const settings = defaultCommandMenuThreadSettings();
    expect(filterThreads(threads, "", settings)).toEqual([]);
    expect(filterThreads(threads, "a", settings)).toEqual([]);

    expect(
      filterThreads(threads, "", {
        ...settings,
        maxThreads: 2,
        showRecentOnOpen: true,
      }).map((thread) => thread.conversationId),
    ).toEqual(["pinned", "recent"]);
  });

  test("caps matching threads and orders by pinned, recent, then match without duplicates", () => {
    const result = filterThreads(
      [
        ...threads,
        {
          ...threads[0]!,
          title: "Alpha exact duplicate",
          sidebarIndex: 9,
        },
      ],
      "alpha",
      {
      ...defaultCommandMenuThreadSettings(),
      maxThreads: 2,
      },
    );
    expect(result.map((thread) => thread.conversationId)).toEqual([
      "pinned",
      "alpha",
    ]);
    expect(new Set(result.map((thread) => thread.conversationId)).size).toBe(
      result.length,
    );
  });

  test("selection clicks an existing row or navigates, then closes the menu", () => {
    const actions: string[] = [];
    const rowResult = activateThreadSelection({
      conversationId: "alpha",
      threadKey: "local:alpha",
      findRow(key) {
        return key === "local:alpha"
          ? {
              click() {
                actions.push("click");
              },
            }
          : null;
      },
      navigate(path) {
        actions.push(`navigate:${path}`);
      },
      close() {
        actions.push("close");
      },
      schedule(callback) {
        callback();
      },
    });
    expect(rowResult).toBe("row");
    expect(actions).toEqual(["click", "close"]);

    actions.length = 0;
    const routeResult = activateThreadSelection({
      conversationId: "missing",
      threadKey: null,
      findRow() {
        return null;
      },
      navigate(path) {
        actions.push(`navigate:${path}`);
      },
      close() {
        actions.push("close");
      },
      schedule(callback) {
        callback();
      },
    });
    expect(routeResult).toBe("route");
    expect(actions).toEqual(["navigate:/local/missing", "close"]);
  });

  test("teardown restores native group order and heading presentation", () => {
    const commands = new FakeGroup("commands", "Commands");
    const recent = new FakeGroup("recent", "Recent chats");
    const pinned = new FakeGroup("pinned", "Pinned chats");
    pinned.heading.setAttribute("style", "color:red");
    const list = new FakeList([commands, recent, pinned]);

    rememberNativeCommandMenuState(
      list as unknown as Element,
      "generation-1",
    );
    list.appendChild(recent);
    list.appendChild(pinned);
    list.appendChild(commands);
    recent.heading.textContent = "Threads";
    pinned.heading.textContent = "";
    pinned.heading.style.display = "none";

    expect(
      restoreNativeCommandMenuState(
        list as unknown as Element,
        "generation-1",
      ),
    ).toBe(true);
    expect(list.groups.map((group) => group.id)).toEqual([
      "commands",
      "recent",
      "pinned",
    ]);
    expect(recent.heading.textContent).toBe("Recent chats");
    expect(pinned.heading.textContent).toBe("Pinned chats");
    expect(pinned.heading.getAttribute("style")).toBe("color:red");
    expect(
      restoreNativeCommandMenuState(
        list as unknown as Element,
        "generation-1",
      ),
    ).toBe(false);
  });

  test("only the active replacement generation restores shared native state", () => {
    const commands = new FakeGroup("commands", "Commands");
    const recent = new FakeGroup("recent", "Recent chats");
    const list = new FakeList([commands, recent]);

    rememberNativeCommandMenuState(
      list as unknown as Element,
      "generation-1",
    );
    list.appendChild(recent);
    list.appendChild(commands);
    rememberNativeCommandMenuState(
      list as unknown as Element,
      "generation-2",
    );

    expect(
      restoreNativeCommandMenuState(
        list as unknown as Element,
        "generation-1",
      ),
    ).toBe(false);
    expect(list.groups.map((group) => group.id)).toEqual([
      "recent",
      "commands",
    ]);
    expect(
      restoreNativeCommandMenuState(
        list as unknown as Element,
        "generation-2",
      ),
    ).toBe(true);
    expect(list.groups.map((group) => group.id)).toEqual([
      "commands",
      "recent",
    ]);
  });
});
