import { describe, expect, it } from "vitest";
import { type SubtreeBlockInput, walkSubtree } from "./subtree-walk";

const block = (
  uuid: string,
  text: string,
  children: readonly SubtreeBlockInput[] = [],
): SubtreeBlockInput => ({ uuid, title: text, children });

describe("walkSubtree", () => {
  it("emits the parent first (DFS pre-order) for a single-block subtree", () => {
    const result = walkSubtree(block("p1", "Root"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.nodes).toEqual([
      { uuid: "p1", depth: 0, text: "Root", isParent: true, hasChildren: false },
    ]);
    expect(result.warned).toBe(false);
    expect(result.totalSeen).toBe(1);
  });

  it("walks a flat list of children left-to-right at depth 1", () => {
    const result = walkSubtree(block("p", "Root", [block("c1", "A"), block("c2", "B")]));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.nodes.map((n) => ({ uuid: n.uuid, depth: n.depth }))).toEqual([
      { uuid: "p", depth: 0 },
      { uuid: "c1", depth: 1 },
      { uuid: "c2", depth: 1 },
    ]);
    expect(result.nodes[0]?.isParent).toBe(true);
    expect(result.nodes[1]?.isParent).toBe(false);
  });

  it("tracks depth recursively and reports hasChildren for non-leaves", () => {
    const result = walkSubtree(
      block("p", "Root", [
        block("c1", "Child", [block("g1", "Grand"), block("g2", "Grand 2")]),
        block("c2", "Sibling", [block("g3", "Another")]),
      ]),
    );
    if (result.status !== "ok") throw new Error("expected ok");
    const summary = result.nodes.map((n) => ({
      uuid: n.uuid,
      depth: n.depth,
      hasChildren: n.hasChildren,
    }));
    expect(summary).toEqual([
      { uuid: "p", depth: 0, hasChildren: true },
      { uuid: "c1", depth: 1, hasChildren: true },
      { uuid: "g1", depth: 2, hasChildren: false },
      { uuid: "g2", depth: 2, hasChildren: false },
      { uuid: "c2", depth: 1, hasChildren: true },
      { uuid: "g3", depth: 2, hasChildren: false },
    ]);
  });

  it("filters out empty (whitespace-only) blocks", () => {
    const result = walkSubtree(
      block("p", "Root", [
        block("c1", ""),
        block("c2", "   "),
        block("c3", "Real text"),
        block("c4", "\n\t  \n"),
      ]),
    );
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.nodes.map((n) => n.uuid)).toEqual(["p", "c3"]);
    expect(result.totalSeen).toBe(2);
  });

  it("prefers title over content and trims surrounding whitespace", () => {
    const result = walkSubtree({ uuid: "p", title: "  Title  ", content: "Content" });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.nodes[0]?.text).toBe("Title");
  });

  it("falls back to content when title is missing", () => {
    const result = walkSubtree({ uuid: "p", content: "Just content" });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.nodes[0]?.text).toBe("Just content");
  });

  it("treats an empty children array the same as no children", () => {
    const result = walkSubtree({ uuid: "p", title: "Root", children: [] });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.nodes[0]?.hasChildren).toBe(false);
  });

  it("does not warn on small subtrees (under the soft threshold)", () => {
    const children = Array.from({ length: 5 }, (_, i) => block(`c${i}`, `text ${i}`));
    const result = walkSubtree(block("p", "Root", children));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.totalSeen).toBe(6);
    expect(result.warned).toBe(false);
  });

  it("warns when block count reaches the soft threshold (default 20)", () => {
    const children = Array.from({ length: 19 }, (_, i) => block(`c${i}`, `text ${i}`));
    const result = walkSubtree(block("p", "Root", children));
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.totalSeen).toBe(20);
    expect(result.warned).toBe(true);
  });

  it("honours a custom softWarnAt option", () => {
    const children = Array.from({ length: 4 }, (_, i) => block(`c${i}`, `text ${i}`));
    const result = walkSubtree(block("p", "Root", children), { softWarnAt: 3, hardCapAt: 10 });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.warned).toBe(true);
  });

  it("returns too-large when the count exceeds the hard cap (default 50)", () => {
    const children = Array.from({ length: 50 }, (_, i) => block(`c${i}`, `text ${i}`));
    const result = walkSubtree(block("p", "Root", children));
    expect(result.status).toBe("too-large");
    if (result.status !== "too-large") throw new Error("expected too-large");
    expect(result.totalSeen).toBeGreaterThan(50);
    expect(result.cap).toBe(50);
  });

  it("returns too-large exactly at the hard cap (off-by-one guard)", () => {
    // 1 (parent) + 49 = 50. The cap is `out.length > hardCapAt` so 50 is the last
    // allowed value. Use a custom cap of 1 to force the off-by-one on a tiny tree.
    const small = walkSubtree(block("p", "Root"), { softWarnAt: 1, hardCapAt: 1 });
    expect(small.status).toBe("ok"); // 1 == cap, allowed
    if (small.status !== "ok") throw new Error("expected ok");
    const tooBig = walkSubtree(block("p", "Root", [block("c1", "x")]), {
      softWarnAt: 1,
      hardCapAt: 1,
    });
    expect(tooBig.status).toBe("too-large");
  });

  it("counts pre-cap (the cap is on the visible list, not the underlying subtree size)", () => {
    // A subtree with 100 children but 60 of them are empty: the cap is enforced
    // AFTER the empty filter. The non-empty count (40) stays under the cap.
    const children: SubtreeBlockInput[] = [];
    for (let i = 0; i < 100; i++) {
      children.push(block(`c${i}`, i < 60 ? "" : `text ${i}`));
    }
    const result = walkSubtree(block("p", "Root", children), { hardCapAt: 50 });
    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.totalSeen).toBe(41);
  });

  it("throws on invalid threshold options (developer error, not user input)", () => {
    expect(() => walkSubtree(block("p", "R"), { softWarnAt: 0 })).toThrow();
    expect(() => walkSubtree(block("p", "R"), { softWarnAt: 5, hardCapAt: 3 })).toThrow();
  });
});
