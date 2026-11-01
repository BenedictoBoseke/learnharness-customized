"use client";
import { useEffect, useRef } from "react";
type Layer = { close: () => void; trigger: Element | null };
const layers: Layer[] = [];
declare global {
  interface Window {
    lhDismissTop?: () => boolean;
  }
}
export function useDismissLayer(
  open: boolean,
  close: () => void,
  modalSelector?: string,
) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const layer: Layer = {
      close: () => latest.current(),
      trigger: document.activeElement,
    };
    layers.push(layer);
    const modal = modalSelector
      ? document.querySelector<HTMLElement>(modalSelector)
      : null;
    const inert: Array<{ node: HTMLElement; previous: boolean }> = [];
    if (modal) {
      let branch: HTMLElement = modal;
      while (branch.parentElement && branch !== document.body) {
        for (const sibling of branch.parentElement.children) {
          if (sibling !== branch && sibling instanceof HTMLElement) {
            inert.push({ node: sibling, previous: sibling.inert });
            sibling.inert = true;
          }
        }
        branch = branch.parentElement;
      }
    }
    const focusable = () =>
      modal
        ? [
            ...modal.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
            ),
          ].filter((n) => n.getClientRects().length > 0)
        : [];
    if (modal) focusable()[0]?.focus({ preventScroll: true });
    window.lhDismissTop = () => {
      const top = layers.at(-1);
      if (!top) return false;
      top.close();
      if (top.trigger instanceof HTMLElement)
        top.trigger.focus({ preventScroll: true });
      return true;
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Tab" && modal && layers.at(-1) === layer) {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
      if (e.key === "Escape" && layers.at(-1) === layer) {
        e.preventDefault();
        e.stopImmediatePropagation();
        window.lhDismissTop?.();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      const i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      document.removeEventListener("keydown", key, true);
      for (const item of inert) item.node.inert = item.previous;
      if (
        modal &&
        layer.trigger instanceof HTMLElement &&
        layer.trigger.isConnected
      )
        layer.trigger.focus({ preventScroll: true });
    };
  }, [open, modalSelector]);
}
