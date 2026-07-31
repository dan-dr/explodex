import type { AnchorRect } from "@explodex/sdk";
import { normalizeConversationId } from "./model";

export type EffortDomRuntime = {
  readonly document: Document;
  readonly location: Pick<Location, "pathname">;
  getComputedStyle(element: Element): CSSStyleDeclaration;
  getSelection(): Selection | null;
};

export function conversationIdFromPortals(
  document: Document,
  focusedInput: HTMLElement | null,
): string | null {
  const portals = [
    ...document.querySelectorAll("[data-above-composer-portal]"),
    ...document.querySelectorAll("[data-above-composer-queue-portal]"),
    ...document.querySelectorAll("[data-above-composer-conversation-id]"),
  ];
  if (focusedInput) {
    for (const portal of portals) {
      if (!portal.contains(focusedInput)) continue;
      const id = normalizeConversationId(
        portal.getAttribute("data-above-composer-conversation-id"),
      );
      if (id) return id;
    }
  }
  for (const portal of portals) {
    const id = normalizeConversationId(
      portal.getAttribute("data-above-composer-conversation-id"),
    );
    if (id) return id;
  }
  return null;
}

export function hostIdFromPortal(document: Document): string | null {
  const portal = document.querySelector("[data-above-composer-portal]");
  return (
    portal?.getAttribute("data-above-composer-host-id") ??
    portal?.getAttribute("data-host-id") ??
    null
  );
}

function textControl(element: HTMLElement):
  | (HTMLElement & {
      value: string;
      selectionStart: number | null;
    })
  | null {
  const tag = element.tagName.toLowerCase();
  if ((tag !== "textarea" && tag !== "input") || !("value" in element)) {
    return null;
  }
  return element as HTMLElement & {
    value: string;
    selectionStart: number | null;
  };
}

export function composerCaretRect(
  runtime: EffortDomRuntime,
  input: HTMLElement | null,
): AnchorRect | null {
  if (!input) return null;
  const control = textControl(input);
  if (control) {
    const selection = control.selectionStart ?? control.value.length;
    const style = runtime.getComputedStyle(input);
    const canvas = runtime.document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context) {
      context.font = style.font;
      const width = context.measureText(control.value.slice(0, selection)).width;
      const bounds = input.getBoundingClientRect();
      const left =
        bounds.left +
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.borderLeftWidth) || 0) +
        width;
      return {
        left,
        top: bounds.top,
        right: left,
        bottom: bounds.bottom,
        width: 0,
        height: bounds.height,
      };
    }
  }

  const selection = runtime.getSelection();
  if (!selection?.rangeCount) return input.getBoundingClientRect();
  const range = selection.getRangeAt(0);
  if (!input.contains(range.commonAncestorContainer)) {
    return input.getBoundingClientRect();
  }
  const bounds = range.getBoundingClientRect();
  if (bounds.width || bounds.height) return bounds;
  return range.getClientRects()[0] ?? bounds;
}

export function isComposerSubmitClick(
  input: HTMLElement | null,
  target: EventTarget | null,
): HTMLButtonElement | null {
  if (!input || !(target instanceof Element)) return null;
  const button = target.closest("button");
  if (!(button instanceof HTMLButtonElement)) return null;
  if (button.disabled || button.closest(".ex-popover")) return null;
  let node: HTMLElement | null = input.parentElement;
  for (let depth = 0; depth < 14 && node; depth += 1) {
    if (node.contains(button)) return button;
    node = node.parentElement;
  }
  const inputRect = input.getBoundingClientRect();
  const buttonRect = button.getBoundingClientRect();
  if (!inputRect.width || !buttonRect.width) return null;
  const nearby =
    Math.abs(buttonRect.top - inputRect.bottom) < 140 &&
    buttonRect.left >= inputRect.left - 80 &&
    buttonRect.right <= inputRect.right + 220;
  return nearby && button.querySelector("svg") ? button : null;
}
