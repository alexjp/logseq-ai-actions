import { h } from "preact";
import {
  MultiBlockDiffPanel,
  type MultiBlockPanelBlock,
  type RunOneBlock,
} from "./MultiBlockDiffPanel";
import { mountPanel } from "./mount-panel";

export interface ShowMultiBlockDiffOptions {
  readonly actionTitle: string;
  readonly baseUrl: string;
  readonly blocks: readonly MultiBlockPanelBlock[];
  /**
   * Streaming callback the panel calls once per block. The per-block
   * runner wires a live LLM call here; the batched runner wires a
   * pre-computed proposal emitted as a single chunk. Either way the
   * panel's contract is the same: one call per block, return the
   * trimmed final text.
   */
  readonly runOneBlock: RunOneBlock;
}

/**
 * Mount the multi-block diff panel, resolve with the list of accepted
 * blocks on Apply or `null` on Cancel. Mirrors `showDiffPanel` so
 * call-site ergonomics match the single-block path.
 */
export function showMultiBlockDiff(
  options: ShowMultiBlockDiffOptions,
): Promise<ReadonlyArray<{ uuid: string; text: string }> | null> {
  return mountPanel<ReadonlyArray<{ uuid: string; text: string }> | null>(null, (teardown) =>
    h(MultiBlockDiffPanel, {
      actionTitle: options.actionTitle,
      baseUrl: options.baseUrl,
      blocks: options.blocks,
      runOneBlock: options.runOneBlock,
      onApply: (accepted) => teardown(accepted),
      onCancel: () => teardown(null),
    }),
  );
}
