import type { Viewport, XYPosition } from "@xyflow/react";

import type { CanvasMode, SavedPositions } from "./canvasGraph.logic";

const POSITIONS_KEY = "kud.canvas.positions.v1";

function isPosition(value: unknown): value is XYPosition {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as XYPosition).x) &&
    Number.isFinite((value as XYPosition).y)
  );
}

/** Positions this viewer dragged nodes to. Storage can be missing or blocked; then none. */
export function readSavedPositions(): SavedPositions {
  try {
    const raw = window.localStorage.getItem(POSITIONS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isPosition(value)));
  } catch {
    return {};
  }
}

export function writeSavedPositions(positions: SavedPositions): void {
  try {
    if (Object.keys(positions).length === 0) window.localStorage.removeItem(POSITIONS_KEY);
    else window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // Positions are a convenience; the layout works without them.
  }
}

// Kept for the session so coming back from a thread lands where the viewer left the canvas.
const viewports = new Map<CanvasMode, Viewport>();
let lastOpenedThreadKey: string | null = null;

export const readCanvasViewport = (mode: CanvasMode) => viewports.get(mode) ?? null;
export const rememberCanvasViewport = (mode: CanvasMode, viewport: Viewport) => {
  viewports.set(mode, viewport);
};
export const readLastOpenedThreadKey = () => lastOpenedThreadKey;
export const rememberOpenedThreadKey = (key: string) => {
  lastOpenedThreadKey = key;
};
