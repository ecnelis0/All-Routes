import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Guards a layout bug that is invisible in code review and silent at
 * runtime.
 *
 * The app is a fixed-viewport map UI: the sidebar scrolls internally and
 * the map fills the rest. Two things make that work, and removing either
 * breaks it without any error:
 *
 *  - `body` must be `h-full`, not `min-h-full`. With min-height the body
 *    is free to grow past the viewport.
 *  - every flex child in the shell chain needs `min-h-0`. Flex items
 *    default to `min-height: auto`, so they refuse to shrink below their
 *    content and `overflow-y-auto` on the sidebar never engages.
 *
 * With either missing, a long route panel stretched the whole row and
 * pushed the 3D tour's transport bar below the fold - the top controls
 * and the progress bar could not be seen at the same time. Measured
 * before the fix: 788px of content in a 772px viewport.
 *
 * This asserts the classes rather than real layout because the suite has
 * no browser. The authoritative check is measuring scrollHeight against
 * innerHeight in Playwright, which is how the bug was found and fixed.
 */
const root = path.join(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("app shell layout", () => {
  it("pins the body to the viewport instead of letting it grow", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/<body className="[^"]*\bh-full\b/);
    expect(layout).not.toMatch(/<body className="[^"]*\bmin-h-full\b/);
  });

  it("lets the sidebar scroll by giving the flex chain min-h-0", () => {
    const page = read("app/page.tsx");
    // The row, the sidebar and the map pane all need it; one missing is
    // enough to reintroduce the overflow.
    expect(page, "flex row").toMatch(/<div className="flex min-h-0 flex-1 overflow-hidden"/);
    expect(page, "sidebar").toMatch(/<aside className="[^"]*\bmin-h-0\b[^"]*\boverflow-y-auto\b/);
    expect(page, "map pane").toMatch(/<main className="[^"]*\bmin-h-0\b/);
  });

  it("keeps the sidebar scrollable rather than clipping it", () => {
    // overflow-hidden here would hide route details instead of scrolling.
    expect(read("app/page.tsx")).toMatch(/<aside className="[^"]*overflow-y-auto/);
  });
});
