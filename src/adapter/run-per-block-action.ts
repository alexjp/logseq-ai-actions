/// <reference types="@logseq/libs" />
import type { Action } from "../action";
import type { LLMProvider } from "../provider";
import { type SubtreeBlockInput, walkSubtree } from "../subtree-walk";
import type { MultiBlockPanelBlock } from "../ui/MultiBlockDiffPanel";
import { showMultiBlockDiff } from "../ui/show-multi-block-diff";
import { performLLM } from "./llm-runner";
import type { ResolvedSettings } from "./settings";

/**
 * The minimal context `runPerBlockAction` needs from `RunActionContext`.
 * Mirrors the `provider` + `getActiveActions` fields of the parent
 * context but only the bits this path actually uses — per-block
 * actions don't re-look-up actions in the registry mid-stream.
 */
export interface RunPerBlockContext {
  readonly provider: LLMProvider;
}

/**
 * Run an action across a node and its descendants, one LLM call per
 * non-empty block, with a multi-block diff panel for review and
 * per-block apply. Children are NOT replaced — only the text of
 * accepted blocks changes.
 *
 *   1. Resolve the parent block (cursor or explicit uuid).
 *   2. Load the full subtree (includeChildren: true).
 *   3. Walk the subtree DFS, filtering empty blocks, enforcing the
 *      50-block hard cap and 20-block soft warning.
 *   4. Open the multi-block diff panel. The panel drives the
 *      streaming — it calls `runOneBlock(uuid, onChunk)` for each
 *      block in walk order, sequentially.
 *   5. On Apply, call `logseq.Editor.updateBlock` for each accepted
 *      block. Empty/rejected cards are skipped.
 *
 * The `runOneBlock` callback closes over the action + settings, so
 * the panel doesn't need any action or settings context of its own.
 */
export async function runPerBlockAction(
  action: Action,
  ctx: RunPerBlockContext,
  settings: ResolvedSettings,
  explicitBlockUuid?: string,
): Promise<void> {
  const current = await resolveParentBlock(explicitBlockUuid);
  if (!current) {
    logseq.UI.showMsg(
      explicitBlockUuid
        ? `${action.title}: couldn't read that block — was it deleted?`
        : `${action.title}: place your cursor inside a block first.`,
      "warning",
    );
    return;
  }

  const full = (await logseq.Editor.getBlock(current, {
    includeChildren: true,
  })) as unknown as SubtreeBlockInput | null;
  if (!full) {
    logseq.UI.showMsg(`${action.title}: could not load the block and its children`, "warning");
    return;
  }

  const walked = walkSubtree({ ...full, uuid: current });
  if (walked.status === "too-large") {
    logseq.UI.showMsg(
      `${action.title}: subtree has ${walked.totalSeen} non-empty blocks — exceeds the ${walked.cap}-block cap. Narrow your selection.`,
      "warning",
    );
    return;
  }
  if (walked.warned) {
    logseq.UI.showMsg(
      `${action.title}: subtree has ${walked.totalSeen} non-empty blocks — running the action once per block in sequence. May take a while.`,
      "info",
    );
  }
  if (walked.nodes.length === 0) {
    logseq.UI.showMsg(`${action.title}: subtree is empty — nothing to do.`, "warning");
    return;
  }

  // Pre-compute the per-block text lookups once. The panel calls
  // `runOneBlock(uuid, onChunk)` with only the uuid, so the runner
  // closes over a uuid→text map to recover the input without a
  // second `getBlock` round-trip.
  const textByUuid = new Map<string, string>();
  for (const n of walked.nodes) textByUuid.set(n.uuid, n.text);

  const panelBlocks: MultiBlockPanelBlock[] = walked.nodes.map((n) => ({
    uuid: n.uuid,
    depth: n.depth,
    text: n.text,
    isParent: n.isParent,
    hasChildren: n.hasChildren,
  }));

  const accepted = await showMultiBlockDiff({
    actionTitle: action.title,
    baseUrl: settings.baseUrl,
    blocks: panelBlocks,
    runOneBlock: async (uuid, onChunk) => {
      const text = textByUuid.get(uuid) ?? "";
      const finalText = await performLLM(ctx.provider, action, text, settings, onChunk);
      return { finalText };
    },
    // Per-block path: Retry re-invokes the LLM for the touched block
    // with the same input — same body as `runOneBlock`. (Duplicating
    // the 3-line closure is clearer than aliasing; the panel calls
    // them at different points in the user flow.)
    retryBlock: async (uuid, onChunk) => {
      const text = textByUuid.get(uuid) ?? "";
      const finalText = await performLLM(ctx.provider, action, text, settings, onChunk);
      return { finalText };
    },
  });

  if (accepted === null) {
    logseq.UI.showMsg(`${action.title} cancelled`, "info");
    return;
  }
  if (accepted.length === 0) {
    logseq.UI.showMsg(`${action.title}: nothing accepted`, "info");
    return;
  }

  for (const { uuid, text } of accepted) {
    await logseq.Editor.updateBlock(uuid, text);
  }
  const plural = accepted.length === 1 ? "" : "s";
  logseq.UI.showMsg(`${action.title}: applied ${accepted.length} block${plural}`, "success");
}

/**
 * Resolve which block to operate on. Context-menu invocations pass
 * `explicitBlockUuid`; everything else falls back to the editor's
 * current block. Returns the uuid string or `null` if no block is
 * available (caller surfaces the toast).
 */
async function resolveParentBlock(explicitBlockUuid: string | undefined): Promise<string | null> {
  if (explicitBlockUuid) {
    const block = await logseq.Editor.getBlock(explicitBlockUuid);
    return block?.uuid ?? null;
  }
  const current = await logseq.Editor.getCurrentBlock();
  return current?.uuid ?? null;
}
