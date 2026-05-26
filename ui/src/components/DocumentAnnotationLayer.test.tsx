// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentAnnotationLayer } from "./DocumentAnnotationLayer";

const mockRangesForNormalizedSpan = vi.hoisted(() => vi.fn());

vi.mock("@/lib/document-annotation-selection", () => ({
  buildAnchorFromContainerSelection: vi.fn(),
  getContainerTextOffset: vi.fn(),
  rangesForNormalizedSpan: mockRangesForNormalizedSpan,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("DocumentAnnotationLayer", () => {
  let container: HTMLDivElement;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockRangesForNormalizedSpan.mockReturnValue([
      {
        getClientRects: () => [makeRect(8, 12, 80, 18)],
      },
    ]);
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(makeRect(0, 0, 400, 300));
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    rectSpy.mockRestore();
    container.remove();
    vi.clearAllMocks();
  });

  it("uses solid yellow backgrounds for annotation highlights in light and dark themes", async () => {
    const body = document.createElement("div");
    body.textContent = "Annotated body text.";
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DocumentAnnotationLayer
          containerRef={{ current: body }}
          markdown="Annotated body text."
          threads={[
            { id: "active", selectedText: "Annotated", status: "open", anchorState: "active" },
            { id: "focused", selectedText: "body", status: "open", anchorState: "active" },
            { id: "stale", selectedText: "text", status: "open", anchorState: "stale" },
            { id: "resolved", selectedText: "body text", status: "resolved", anchorState: "active" },
          ]}
          focusedThreadId="focused"
          onThreadFocus={vi.fn()}
          pendingAnchor={null}
          onPendingAnchorChange={vi.fn()}
          onRequestComment={vi.fn()}
          hideResolved={false}
        />,
      );
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });

    const highlights = Array.from(container.querySelectorAll(".paperclip-doc-annotation-highlight"));
    expect(highlights).toHaveLength(4);

    for (const highlight of highlights) {
      const backgroundClasses = Array.from(highlight.classList).filter((className) =>
        /^(dark:|hover:|dark:hover:)?bg-yellow-\d+$/.test(className)
        || /^(dark:|hover:|dark:hover:)?bg-yellow-\d+\//.test(className),
      );
      expect(backgroundClasses.some((className) => className.includes("/"))).toBe(false);
      expect(backgroundClasses.some((className) => className.startsWith("bg-yellow-"))).toBe(true);
      expect(backgroundClasses.some((className) => className.startsWith("dark:bg-yellow-"))).toBe(true);
    }
  });
});
