/// <reference types="@logseq/libs" />
import type { Action } from "../action";
import { flattenOutlineTree, parseOutline } from "../parse-outline";
import type { LLMProvider } from "../provider";
import { flattenSubtree } from "../subtree";
import { type SubtreeBlockInput, type SubtreeNode, walkSubtree } from "../subtree-walk";
import type { MultiBlockPanelBlock } from "../ui/MultiBlockDiffPanel";
import { showMultiBlockDiff } from "../ui/show-multi-block-diff";
import { performLLM } from "./llm-runner";
import { runPerBlockAction } from "./run-per-block-action";
import type { ResolvedSettings } from "./settings";

/**
 * Minimal context `runBatchedAction` needs. Same shape as
 * `RunPerBlockContext` — the batched path doesn't read the registry
 * mid-flight, only the provider.
 */
export interface RunBatchedContext {
  readonly provider: LLMProvider;
}

/**
 * Run an action across a node and its descendants with a SINGLE LLM
 * call. The model receives the whole flattened outline and is
 * expected to return the same outline back (preserving depth,
 * structure, and per-block text). We parse the response with
 * `parseOutline`, flatten it, and align it index-for-index with
 * `walkSubtree` output — both walks are parent-first DFS so
 * positions correspond.
 *
 * If alignment fails (count mismatch: the model added, dropped, or
 * merged lines), we fall back transparently to `runPerBlockAction`
 * with the same action — the user sees a brief "batched response
 * didn't align, falling back to per-block" toast and the panel
 * continues exactly as if they'd picked the per-block scope. The
 * first LLM call's cost is sunk; the fallback re-runs the LLM
 * sequentially.
 *
 * Subtree size handling mirrors `runPerBlockAction` — 50-block hard
 * cap, 20-block soft warning.
 */
export async function runBatchedAction(
  action: Action,
  ctx: RunBatchedContext,
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
      `${action.title}: subtree has ${walked.totalSeen} non-empty blocks — running as a single batched call. May take a while.`,
      "info",
    );
  }
  if (walked.nodes.length === 0) {
    logseq.UI.showMsg(`${action.title}: subtree is empty — nothing to do.`, "warning");
    return;
  }

  // Build the LLM input as a flattened outline string. The model's
  // job is to return the same outline shape back with per-block
  // edits applied — `parseOutline` handles the structural tolerance
  // (mixed bullet glyphs, code fences, preamble skipping).
  // We strip the `uuid` field off each node to feed `flattenSubtree`
  // (which is intentionally minimal — it doesn't know about uuids).
  type StrippedNode = { title?: string; content?: string; children?: StrippedNode[] };
  const stripped = (n: SubtreeBlockInput): StrippedNode => {
    const out: StrippedNode = {};
    if (n.title !== undefined) out.title = n.title;
    if (n.content !== undefined) out.content = n.content;
    if (n.children !== undefined) out.children = n.children.map(stripped);
    return out;
  };
  const llmInput = flattenSubtree(stripped(full));

  // One LLM call (non-streaming — the panel's per-card diff UX
  // expects each block to be already-finalised so the user can
  // accept/reject without waiting for a second wave of chunks).
  let output: string;
  try {
    output = await performLLM(ctx.provider, action, llmInput, settings);
  } catch (err) {
    const detail = (err as Error).message;
    logseq.UI.showMsg(`${action.title} failed: ${detail}`, "error");
    return;
  }

  const alignment = alignBatchedResponse(walked.nodes, output);

  if (alignment.status === "misaligned") {
    const observed = alignment.observed;
    const expected = alignment.expected;
    logseq.UI.showMsg(
      `${action.title}: batched response didn't align with the subtree (${observed} line${observed === 1 ? "" : "s"} vs ${expected} block${expected === 1 ? "" : "s"}) — falling back to per-block.`,
      "info",
    );
    return runPerBlockAction(action, ctx, settings, explicitBlockUuid);
  }

  const proposedByUuid = alignment.proposals;

  // Original-text lookup for per-card Retry. The batched path caches
  // the LLM's whole-outline response in `proposedByUuid`; Retry on a
  // single card re-invokes the LLM for just that one block with the
  // original text (see `retryBlock` below), so we need to recover
  // `text` from the walked subtree by uuid.
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
      const text = proposedByUuid.get(uuid) ?? "";
      onChunk(text);
      return { finalText: text };
    },
    // Batched path: Retry abandons the cached batched proposal for
    // that one card and re-invokes the LLM with the original text —
    // a per-block call, not a re-batched call. Other cards keep their
    // batched proposals. This is the cleanest semantic for "the
    // LLM's first response for this card wasn't great" under a
    // single-call scope.
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

async function resolveParentBlock(explicitBlockUuid: string | undefined): Promise<string | null> {
  if (explicitBlockUuid) {
    const block = await logseq.Editor.getBlock(explicitBlockUuid);
    return block?.uuid ?? null;
  }
  const current = await logseq.Editor.getCurrentBlock();
  return current?.uuid ?? null;
}

/**
 * Pure helper: align a single LLM response (assumed to be a full
 * flattened outline) with a `walkSubtree` result, returning a
 * uuid → proposed-text map. Extracted from `runBatchedAction` so the
 * alignment logic is testable without the SDK.
 *
 * The two walks (the subtree walk that produced `walked` and the
 * LLM's response, parsed by `parseOutline` and flattened) are both
 * parent-first DFS, so index N in the response corresponds to the
 * node at walked[N]. If the counts diverge (the model added, dropped,
 * or merged lines), the result is `misaligned` and the runner falls
 * back to per-block.
 */
export type BatchedAlignment =
  | { readonly status: "aligned"; readonly proposals: ReadonlyMap<string, string> }
  | { readonly status: "misaligned"; readonly observed: number; readonly expected: number };

export function alignBatchedResponse(
  walked: readonly SubtreeNode[],
  llmOutput: string,
): BatchedAlignment {
  const parsed = parseOutline(llmOutput);
  const flatParsed = flattenOutlineTree(parsed);

  if (flatParsed.length !== walked.length) {
    return {
      status: "misaligned",
      observed: flatParsed.length,
      expected: walked.length,
    };
  }

  const proposals = new Map<string, string>();
  for (let i = 0; i < walked.length; i++) {
    const node = walked[i];
    const parsedNode = flatParsed[i];
    if (node && parsedNode) proposals.set(node.uuid, parsedNode.text);
  }
  return { status: "aligned", proposals };
}
