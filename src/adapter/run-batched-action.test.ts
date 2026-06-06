import { describe, expect, it } from "vitest";
import type { SubtreeNode } from "../subtree-walk";
import { alignBatchedResponse } from "./run-batched-action";

const node = (uuid: string, text: string, depth = 0): SubtreeNode => ({
  uuid,
  depth,
  text,
  isParent: depth === 0,
  hasChildren: false,
});

const tree = (text: string): readonly SubtreeNode[] =>
  text.split("\n").map((line, i) => {
    const match = line.match(/^( *)(- )(.*)$/);
    if (!match) throw new Error(`bad fixture: ${line}`);
    return node(`n${i}`, match[3] ?? "", Math.floor((match[1]?.length ?? 0) / 2));
  });

describe("alignBatchedResponse", () => {
  it("aligns a single-node response with the original subtree", () => {
    const walked = [node("p", "Original parent text")];
    const aligned = alignBatchedResponse(walked, "- Original parent text (edited)");
    expect(aligned.status).toBe("aligned");
    if (aligned.status !== "aligned") throw new Error("expected aligned");
    expect(aligned.proposals.get("p")).toBe("Original parent text (edited)");
    expect(aligned.proposals.size).toBe(1);
  });

  it("aligns a multi-block response index-for-index with the walk", () => {
    const walked = tree(["- Parent", "  - Child A", "  - Child B", "- Sibling"].join("\n"));
    const response = [
      "- Parent (edited)",
      "  - Child A (edited)",
      "  - Child B (edited)",
      "- Sibling (edited)",
    ].join("\n");
    const aligned = alignBatchedResponse(walked, response);
    expect(aligned.status).toBe("aligned");
    if (aligned.status !== "aligned") throw new Error("expected aligned");
    expect(aligned.proposals.get("n0")).toBe("Parent (edited)");
    expect(aligned.proposals.get("n1")).toBe("Child A (edited)");
    expect(aligned.proposals.get("n2")).toBe("Child B (edited)");
    expect(aligned.proposals.get("n3")).toBe("Sibling (edited)");
    expect(aligned.proposals.size).toBe(4);
  });

  it("aligns when the LLM drops a level of indentation but keeps the line count", () => {
    // The model flattens the outline but keeps the same number of lines
    // — alignment still works because the walk is purely positional.
    const walked = tree(["- Parent", "  - Child"].join("\n"));
    const response = ["- Parent (edited)", "- Child (edited)"].join("\n");
    const aligned = alignBatchedResponse(walked, response);
    expect(aligned.status).toBe("aligned");
    if (aligned.status !== "aligned") throw new Error("expected aligned");
    expect(aligned.proposals.get("n0")).toBe("Parent (edited)");
    expect(aligned.proposals.get("n1")).toBe("Child (edited)");
  });

  it("returns misaligned when the response has more lines than the subtree", () => {
    const walked = tree(["- A", "  - B"].join("\n"));
    const response = ["- A", "  - B", "- C", "  - D"].join("\n");
    const aligned = alignBatchedResponse(walked, response);
    expect(aligned.status).toBe("misaligned");
    if (aligned.status !== "misaligned") throw new Error("expected misaligned");
    expect(aligned.observed).toBe(4);
    expect(aligned.expected).toBe(2);
  });

  it("returns misaligned when the response has fewer lines than the subtree", () => {
    const walked = tree(["- A", "  - B", "- C", "  - D"].join("\n"));
    const response = ["- A", "  - B"].join("\n");
    const aligned = alignBatchedResponse(walked, response);
    expect(aligned.status).toBe("misaligned");
    if (aligned.status !== "misaligned") throw new Error("expected misaligned");
    expect(aligned.observed).toBe(2);
    expect(alignment_expected(aligned)).toBe(4);
  });

  it("returns misaligned when the response is empty (parseOutline returns [])", () => {
    const walked = [node("p", "Original")];
    const aligned = alignBatchedResponse(walked, "");
    expect(aligned.status).toBe("misaligned");
    if (aligned.status !== "misaligned") throw new Error("expected misaligned");
    expect(aligned.observed).toBe(0);
    expect(aligned.expected).toBe(1);
  });

  it("returns misaligned when the subtree is empty and the response is not (or vice versa)", () => {
    const empty: readonly SubtreeNode[] = [];
    const alignedEmpty = alignBatchedResponse(empty, "- x");
    expect(alignedEmpty.status).toBe("misaligned");
    if (alignedEmpty.status !== "misaligned") throw new Error("expected misaligned");
    expect(alignedEmpty.observed).toBe(1);
    expect(alignedEmpty.expected).toBe(0);

    const alignedBoth = alignBatchedResponse([node("p", "x")], "");
    expect(alignedBoth.status).toBe("misaligned");
    if (alignedBoth.status !== "misaligned") throw new Error("expected misaligned");
    expect(alignedBoth.observed).toBe(0);
    expect(alignedBoth.expected).toBe(1);
  });

  it("tolerates parseOutline's preamble-skipping and code-fence stripping", () => {
    // The LLM loves to add a "Here is the corrected outline:" preamble
    // and wrap the response in a ``` fence. parseOutline handles both;
    // alignment should succeed when the inner line count matches.
    const walked = tree(["- A", "  - B"].join("\n"));
    const response = [
      "Here is the corrected outline:",
      "```",
      "- A (edited)",
      "  - B (edited)",
      "```",
    ].join("\n");
    const aligned = alignBatchedResponse(walked, response);
    expect(aligned.status).toBe("aligned");
    if (aligned.status !== "aligned") throw new Error("expected aligned");
    expect(aligned.proposals.get("n0")).toBe("A (edited)");
    expect(aligned.proposals.get("n1")).toBe("B (edited)");
  });

  it("returns aligned for a 50-block response at the cap (off-by-one guard)", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- L${i}`);
    const walked = lines.map((l, i) => node(`n${i}`, l.slice(2) ?? "", 0));
    const response = lines.map((l) => `${l} (edited)`).join("\n");
    const aligned = alignBatchedResponse(walked, response);
    expect(aligned.status).toBe("aligned");
    if (aligned.status !== "aligned") throw new Error("expected aligned");
    expect(aligned.proposals.size).toBe(50);
  });

  it("returns misaligned at 51 vs 50 (cap boundary)", () => {
    const walked = Array.from({ length: 50 }, (_, i) => node(`n${i}`, `L${i}`, 0));
    const response = Array.from({ length: 51 }, (_, i) => `- L${i}`).join("\n");
    const aligned = alignBatchedResponse(walked, response);
    expect(aligned.status).toBe("misaligned");
    if (aligned.status !== "misaligned") throw new Error("expected misaligned");
    expect(aligned.observed).toBe(51);
    expect(aligned.expected).toBe(50);
  });
});

function alignment_expected(a: { expected: number }): number {
  return a.expected;
}
