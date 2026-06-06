/**
 * Per-block input shape. Mirrors the `subtree.ts` `BlockNode` contract
 * (minimal — pure types, no SDK import) but threads the `uuid` through
 * because the per-block runtime needs it to call `updateBlock` on accept.
 * The `SubtreeBlockInput` type is recursive: each block may carry a
 * children array of the same shape.
 */
export interface SubtreeBlockInput {
  readonly uuid: string;
  readonly title?: string;
  readonly content?: string;
  readonly children?: readonly SubtreeBlockInput[];
}

/**
 * One block in the walked subtree. `depth` is 0 for the root, 1 for direct
 * children, 2 for grandchildren, and so on. `isParent` distinguishes the
 * root block from descendants so the panel can render a "Parent" pill
 * without a depth check. `hasChildren` lets the UI decide whether to show
 * a "▾" expander even if the per-block LLM hasn't streamed yet.
 */
export interface SubtreeNode {
  readonly uuid: string;
  readonly depth: number;
  readonly text: string;
  readonly isParent: boolean;
  readonly hasChildren: boolean;
}

export interface SubtreeWalkOptions {
  /**
   * Soft warning threshold. When the total non-empty block count is at
   * or above this number the result sets `warned: true` so the caller
   * can show a "this will take a while" toast. Default 20.
   */
  readonly softWarnAt?: number;
  /**
   * Hard cap. When the total non-empty block count exceeds this number
   * the result switches to `status: "too-large"` and returns no nodes —
   * the caller is expected to abort the action with a "narrow your
   * subtree" toast. Default 50.
   */
  readonly hardCapAt?: number;
}

export type SubtreeWalkResult =
  | {
      readonly status: "ok";
      readonly nodes: readonly SubtreeNode[];
      readonly totalSeen: number;
      readonly warned: boolean;
    }
  | {
      readonly status: "too-large";
      readonly totalSeen: number;
      readonly cap: number;
    };

const DEFAULT_SOFT_WARN_AT = 20;
const DEFAULT_HARD_CAP_AT = 50;

/**
 * Walk a Logseq block subtree in depth-first order (parent first) and
 * return one `SubtreeNode` per non-empty block. Empty blocks (whitespace
 * only) are filtered out — the LLM has nothing to work on and the panel
 * has nothing to diff.
 *
 * The walk uses an explicit stack instead of recursion to avoid blowing
 * the call stack on deeply-nested subtrees. DFS order matters because
 * the per-block runtime streams calls in walk order — that order is also
 * the order the panel renders the cards, which is the order the user
 * reads the diff.
 *
 * The size thresholds exist because per-block scope is a fan-out: K
 * non-empty blocks = K LLM calls. We refuse to do that work past the
 * hard cap and warn the user before doing it past the soft cap. The
 * caller chooses what to do with `warned` and `too-large`.
 */
export function walkSubtree(
  root: SubtreeBlockInput,
  options: SubtreeWalkOptions = {},
): SubtreeWalkResult {
  const softWarnAt = options.softWarnAt ?? DEFAULT_SOFT_WARN_AT;
  const hardCapAt = options.hardCapAt ?? DEFAULT_HARD_CAP_AT;
  if (softWarnAt < 1 || hardCapAt < 1 || hardCapAt < softWarnAt) {
    throw new Error(
      `walkSubtree: softWarnAt (${softWarnAt}) and hardCapAt (${hardCapAt}) must be positive and softWarnAt <= hardCapAt`,
    );
  }

  const out: SubtreeNode[] = [];
  const stack: { node: SubtreeBlockInput; depth: number }[] = [{ node: root, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { node, depth } = frame;
    const raw = node.title ?? node.content ?? "";
    const text = raw.trim();
    if (text.length > 0) {
      out.push({
        uuid: node.uuid,
        depth,
        text,
        isParent: depth === 0,
        hasChildren: (node.children?.length ?? 0) > 0,
      });
      if (out.length > hardCapAt) {
        return { status: "too-large", totalSeen: out.length, cap: hardCapAt };
      }
    }
    // Push children in REVERSE order so the first child is popped first
    // and the walk visits children left-to-right (the on-screen order).
    const kids = node.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) {
      const child = kids[i];
      if (!child) continue;
      stack.push({ node: child, depth: depth + 1 });
    }
  }

  return {
    status: "ok",
    nodes: out,
    totalSeen: out.length,
    warned: out.length >= softWarnAt,
  };
}
