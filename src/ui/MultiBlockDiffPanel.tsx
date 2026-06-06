import type { FunctionComponent } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { computeDiff, type DiffSegment } from "../diff";
import { LocalRemoteBadge } from "./LocalRemoteBadge";

/**
 * Minimal block shape the panel needs. Mirrors `SubtreeNode` from
 * `subtree-walk.ts` but the panel is decoupled so future refactors to
 * the walker don't ripple into UI code.
 */
export interface MultiBlockPanelBlock {
  readonly uuid: string;
  readonly depth: number;
  readonly text: string;
  readonly isParent: boolean;
  readonly hasChildren: boolean;
}

/**
 * Streaming callback the panel calls once per block. Mirrors the
 * `RunAndStream` shape on `DiffPanel.tsx` so callers can wire either
 * the per-block runner (sequential live LLM calls) or the batched
 * runner (pre-computed proposals emitted as a single chunk) through
 * the same interface.
 */
export type RunOneBlock = (
  uuid: string,
  onChunk: (chunk: string) => void,
) => Promise<{ finalText: string }>;

export interface MultiBlockDiffPanelProps {
  readonly actionTitle: string;
  readonly baseUrl: string;
  readonly blocks: readonly MultiBlockPanelBlock[];
  readonly runOneBlock: RunOneBlock;
  /**
   * Optional callback for re-running the LLM for a single block. If
   * omitted, the per-card Retry button is hidden. The per-block runner
   * wires this to the same closure as `runOneBlock`; the batched runner
   * wires it to a closure that re-invokes the LLM for that one block
   * with the original text — abandoning the cached batched proposal for
   * that card only. Other cards keep their batched proposals.
   */
  readonly retryBlock?: RunOneBlock;
  /**
   * Resolves with the blocks the user accepted (status `accepted` or
   * `edited`). Cards in `pending` / `streaming` / `rejected` / `empty`
   * are excluded. Resolve with `null` on Cancel.
   */
  readonly onApply: (accepted: ReadonlyArray<{ uuid: string; text: string }>) => void;
  readonly onCancel: () => void;
}

/** Per-card UI state. Mutated via setState; never mutate in place. */
type CardStatus = "pending" | "streaming" | "empty" | "accepted" | "rejected" | "edited";

interface CardState {
  readonly uuid: string;
  readonly depth: number;
  readonly original: string;
  readonly isParent: boolean;
  readonly hasChildren: boolean;
  proposed: string;
  editedText: string | null;
  status: CardStatus;
  errorMessage: string | null;
}

function initialCards(blocks: readonly MultiBlockPanelBlock[]): CardState[] {
  return blocks.map((b) => ({
    uuid: b.uuid,
    depth: b.depth,
    original: b.text,
    isParent: b.isParent,
    hasChildren: b.hasChildren,
    proposed: "",
    editedText: null,
    status: "pending",
    errorMessage: null,
  }));
}

export const MultiBlockDiffPanel: FunctionComponent<MultiBlockDiffPanelProps> = (props) => {
  const { blocks, runOneBlock, retryBlock, onApply, onCancel, actionTitle, baseUrl } = props;
  const [cards, setCards] = useState<CardState[]>(() => initialCards(blocks));
  // Index of the card currently being streamed. -1 = initial state
  // (kicks off on mount); blocks.length = all done.
  const [streamingIndex, setStreamingIndex] = useState<number>(-1);
  // True after Cancel or Apply — stops further LLM calls and discards
  // pending stream results. set once, never reset.
  const settledRef = useRef(false);
  // Generation counter — bumped on every state change that should
  // invalidate in-flight chunks (cancel, manual skip, etc.). Each
  // stream captures its own value at start and checks it before any
  // setState, so stale chunks can't bleed into a card's `proposed`.
  const streamGen = useRef(0);
  // Keep the latest `runOneBlock` in a ref so the streaming useEffect
  // doesn't have to list it in its deps (and re-fire every time the
  // parent re-creates the callback). The function captures everything
  // it needs in its closure; the ref is just identity stability.
  const runOneBlockRef = useRef(runOneBlock);
  runOneBlockRef.current = runOneBlock;

  // Sequential streaming: one block at a time, auto-advance as each
  // completes. Cancellation is signalled via `settledRef`; an in-flight
  // stream finishes (or throws) but its result is ignored.
  useEffect(() => {
    if (settledRef.current) return;
    if (streamingIndex < 0) {
      // First entry to the effect: kick off the first block.
      setStreamingIndex(0);
      return;
    }
    if (streamingIndex >= blocks.length) return;

    const block = blocks[streamingIndex];
    if (!block) return;

    const myGen = ++streamGen.current;
    setCards((prev) =>
      prev.map((c, i) => (i === streamingIndex ? { ...c, status: "streaming" } : c)),
    );

    void (async () => {
      try {
        const result = await runOneBlockRef.current(block.uuid, (chunk) => {
          if (settledRef.current || streamGen.current !== myGen) return;
          setCards((prev) =>
            prev.map((c, i) => (i === streamingIndex ? { ...c, proposed: c.proposed + chunk } : c)),
          );
        });
        if (settledRef.current || streamGen.current !== myGen) return;
        setCards((prev) =>
          prev.map((c, i) => {
            if (i !== streamingIndex) return c;
            // Auto-reject empty responses — there's no useful proposal
            // to diff, and accepting would write an empty block. The
            // user can still override via the Edit button (force-edit
            // an empty card to clear it deliberately).
            if (result.finalText.trim().length === 0) {
              return { ...c, status: "empty" as const };
            }
            return { ...c, proposed: result.finalText, status: "pending" as const };
          }),
        );
        setStreamingIndex((i) => i + 1);
      } catch (err) {
        if (settledRef.current || streamGen.current !== myGen) return;
        setCards((prev) =>
          prev.map((c, i) =>
            i === streamingIndex
              ? { ...c, status: "empty" as const, errorMessage: (err as Error).message }
              : c,
          ),
        );
        setStreamingIndex((i) => i + 1);
      }
    })();

    // Cleanup on dep change (i.e., moving to the next index) bumps
    // the gen so any straggler chunks for the old index are dropped.
    return () => {
      streamGen.current += 1;
    };
  }, [streamingIndex, blocks]);

  const handleCancel = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    streamGen.current += 1;
    onCancel();
  }, [onCancel]);

  const handleApply = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    streamGen.current += 1;
    const accepted = cards
      .filter((c) => c.status === "accepted" || c.status === "edited")
      .map((c) => ({ uuid: c.uuid, text: c.editedText ?? c.proposed }));
    onApply(accepted);
  }, [cards, onApply]);

  const handleCardAccept = useCallback((i: number) => {
    setCards((prev) => prev.map((c, idx) => (idx === i ? { ...c, status: "accepted" } : c)));
  }, []);

  const handleCardReject = useCallback((i: number) => {
    setCards((prev) => prev.map((c, idx) => (idx === i ? { ...c, status: "rejected" } : c)));
  }, []);

  const handleCardEdit = useCallback((i: number, text: string) => {
    // Edit implies accept (per the locked UX): the edited text is
    // locked in as the apply value. `editedText` is the source of
    // truth over `proposed` for this card; if the user clears the
    // edit textarea back to the original proposed text, status flips
    // to "accepted" with `editedText` still set (a no-op rewrite).
    setCards((prev) =>
      prev.map((c, idx) => (idx === i ? { ...c, editedText: text, status: "edited" } : c)),
    );
  }, []);

  // Per-card Retry: re-invoke the LLM for a single block. The runner
  // wires this to either the same closure as `runOneBlock` (per-block
  // runner) or a per-block LLM call (batched runner). Reuses the same
  // `streamGen` + `settledRef` guards as the main sequential stream so
  // a Cancel-while-Retry discards stragglers, and a card already
  // mid-stream can't be retried again (button is disabled).
  const handleCardRetry = useCallback(
    (i: number) => {
      if (!retryBlock) return;
      const block = blocks[i];
      if (!block) return;
      const myGen = ++streamGen.current;
      // Snap the card to streaming + clear the prior proposal so the
      // diff view doesn't briefly show old text overlapping the new
      // stream. If the retry errors out, `errorMessage` is set; if it
      // succeeds with empty text, the auto-reject path below flips
      // status to "empty".
      setCards((prev) =>
        prev.map((c, idx) =>
          idx === i
            ? { ...c, status: "streaming", proposed: "", editedText: null, errorMessage: null }
            : c,
        ),
      );
      void (async () => {
        try {
          const result = await retryBlock(block.uuid, (chunk) => {
            if (settledRef.current || streamGen.current !== myGen) return;
            setCards((prev) =>
              prev.map((c, idx) => (idx === i ? { ...c, proposed: c.proposed + chunk } : c)),
            );
          });
          if (settledRef.current || streamGen.current !== myGen) return;
          setCards((prev) =>
            prev.map((c, idx) => {
              if (idx !== i) return c;
              if (result.finalText.trim().length === 0) {
                return { ...c, status: "empty" as const };
              }
              return { ...c, proposed: result.finalText, status: "pending" as const };
            }),
          );
        } catch (err) {
          if (settledRef.current || streamGen.current !== myGen) return;
          setCards((prev) =>
            prev.map((c, idx) =>
              idx === i
                ? { ...c, status: "empty" as const, errorMessage: (err as Error).message }
                : c,
            ),
          );
        }
      })();
    },
    [retryBlock, blocks],
  );

  const handleRejectAllPending = useCallback(() => {
    setCards((prev) =>
      prev.map((c) =>
        c.status === "pending" || c.status === "streaming" ? { ...c, status: "rejected" } : c,
      ),
    );
  }, []);

  // Bulk accept: mark every `pending` card whose proposal actually
  // differs from the original as `accepted`. Unchanged pending cards
  // stay `pending` (they're no-ops at apply time). Cards that are
  // already `accepted`/`rejected`/`edited`/`streaming`/`empty` are
  // left alone — the bulk action is additive to existing decisions.
  // Whitespace-only diffs (`proposed.trim() === original.trim()`) do
  // not count as "changed" — trailing-newline shenanigans from the
  // LLM shouldn't trigger an apply call.
  const handleAcceptAllChanged = useCallback(() => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.status !== "pending") return c;
        if (c.proposed.length === 0) return c;
        if (c.proposed.trim() === c.original.trim()) return c;
        return { ...c, status: "accepted" as const };
      }),
    );
  }, []);

  const counts = useMemo(() => {
    const accepted = cards.filter((c) => c.status === "accepted" || c.status === "edited").length;
    const rejected = cards.filter((c) => c.status === "rejected").length;
    const empty = cards.filter((c) => c.status === "empty").length;
    const streaming = cards.filter((c) => c.status === "streaming").length;
    const pending = cards.filter((c) => c.status === "pending").length;
    return { accepted, rejected, empty, streaming, pending, total: cards.length };
  }, [cards]);

  // Live count of "pending cards with a real diff" — drives the
  // `Accept all changed (N)` button label and its disabled state. A
  // second click after the first is a no-op (count drops to 0 → button
  // disables itself on the next render).
  const changedPendingCount = useMemo(
    () =>
      cards.filter(
        (c) =>
          c.status === "pending" &&
          c.proposed.length > 0 &&
          c.proposed.trim() !== c.original.trim(),
      ).length,
    [cards],
  );

  // Global keyboard: Esc cancels, ⌘↵ applies, ⌘⇧A bulk-accepts every
  // changed pending card. Same conventions as the single-block
  // DiffPanel so users don't have to learn a second set of shortcuts
  // for the per-card actions. The bulk-accept shortcut is gated on
  // `changedPendingCount > 0` indirectly (the handler just calls
  // `handleAcceptAllChanged`, which is a no-op when nothing matches).
  //
  // Cross-platform: the hint shows the Mac `⌘` glyph but the matcher
  // accepts either `metaKey` (Mac) or `ctrlKey` (Linux/Windows) — same
  // convention as the Enter handler four lines below and every other
  // panel in this codebase. The bulk-accept key is matched by physical
  // position (`e.code === "KeyA"`) rather than the produced character,
  // so non-QWERTY layouts (Dvorak, Cyrillic, AZERTY) still trigger on
  // Shift+the-A-key.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if (e.code === "KeyA" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleAcceptAllChanged();
      } else if ((e.key === "Enter" && (e.metaKey || e.ctrlKey)) || e.key === "Return") {
        e.preventDefault();
        handleApply();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleCancel, handleApply, handleAcceptAllChanged]);

  const allDone = streamingIndex >= blocks.length;
  const streamingLabel = allDone
    ? null
    : `Streaming ${Math.min(streamingIndex + 1, blocks.length)} of ${blocks.length}…`;

  return (
    <div class="multi-root" role="dialog" aria-label={`${actionTitle} — review changes`}>
      <div class="diff-modal">
        <header class="diff-header">
          <span class="diff-header-main">
            <strong>{actionTitle}</strong>
            <LocalRemoteBadge baseUrl={baseUrl} />
          </span>
          <span class="diff-hint">
            <kbd>Esc</kbd> cancel · <kbd>⌘⇧A</kbd> accept all · <kbd>⌘ ↵</kbd> apply
          </span>
        </header>

        {streamingLabel ? <div class="multi-streaming-bar">{streamingLabel}</div> : null}

        <section class="multi-body">
          {cards.map((c, i) => (
            <BlockCard
              key={c.uuid}
              card={c}
              segments={allDone && c.proposed ? computeDiff(c.original, c.proposed) : null}
              onAccept={() => handleCardAccept(i)}
              onReject={() => handleCardReject(i)}
              onEdit={(text) => handleCardEdit(i, text)}
              {...(retryBlock ? { onRetry: () => handleCardRetry(i) } : {})}
            />
          ))}
        </section>

        <footer class="diff-footer">
          <span class="multi-counts">
            {counts.accepted} accepted · {counts.rejected} rejected · {counts.empty} empty
            {counts.pending > 0 ? ` · ${counts.pending} pending` : ""}
            {counts.streaming > 0 ? ` · ${counts.streaming} streaming` : ""}
          </span>
          <span class="multi-spacer" />
          <button type="button" class="diff-btn" onClick={handleCancel}>
            Cancel
          </button>
          <button
            type="button"
            class="diff-btn"
            onClick={handleRejectAllPending}
            disabled={counts.pending + counts.streaming === 0}
            title="Mark every still-pending card as rejected"
          >
            Reject remaining
          </button>
          <button
            type="button"
            class="diff-btn"
            onClick={handleAcceptAllChanged}
            disabled={counts.streaming > 0 || changedPendingCount === 0}
            title={
              counts.streaming > 0
                ? "Wait for streaming to finish"
                : "Mark every pending card with a real change as accepted"
            }
          >
            Accept all changed{changedPendingCount > 0 ? ` (${changedPendingCount})` : ""}
          </button>
          <button
            type="button"
            class="diff-btn diff-btn-primary"
            onClick={handleApply}
            disabled={counts.accepted === 0 || !allDone}
            title={!allDone ? "Wait for streaming to finish" : ""}
          >
            Apply {counts.accepted}
          </button>
        </footer>
      </div>
    </div>
  );
};

/**
 * One card in the stacked list. Renders the original/proposed diff (or
 * a streaming/empty state), per-card Accept/Reject/Edit buttons, and a
 * status pill. Pure-render — all state lives in the parent.
 */
interface BlockCardProps {
  readonly card: CardState;
  readonly segments: readonly DiffSegment[] | null;
  readonly onAccept: () => void;
  readonly onReject: () => void;
  readonly onEdit: (text: string) => void;
  /**
   * Optional Retry callback. When provided, a per-card ↻ button is
   * rendered next to the Edit glyph. Disabled while the card is
   * streaming (Retry is a "the previous response wasn't great"
   * affordance — retrying during a stream doesn't make sense).
   */
  readonly onRetry?: () => void;
}

const BlockCard: FunctionComponent<BlockCardProps> = ({
  card,
  segments,
  onAccept,
  onReject,
  onEdit,
  onRetry,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(card.editedText ?? card.proposed);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Keep the edit textarea's draft in sync if the proposed text
  // changes mid-edit (e.g., a slow stream finishes while the user is
  // typing) — but only if the user hasn't diverged from the
  // streamed-yet text, so we don't clobber their edits.
  useEffect(() => {
    if (isEditing) editRef.current?.focus();
  }, [isEditing]);

  const startEdit = () => {
    setEditDraft(card.editedText ?? card.proposed);
    setIsEditing(true);
  };

  const commitEdit = () => {
    onEdit(editDraft);
    setIsEditing(false);
  };

  const cancelEdit = () => {
    setEditDraft(card.editedText ?? card.proposed);
    setIsEditing(false);
  };

  const statusPill = (() => {
    switch (card.status) {
      case "streaming":
        return <span class="multi-status multi-status-streaming">streaming…</span>;
      case "empty":
        return (
          <span class="multi-status multi-status-empty" title={card.errorMessage ?? ""}>
            empty
          </span>
        );
      case "accepted":
        return <span class="multi-status multi-status-accepted">accepted</span>;
      case "rejected":
        return <span class="multi-status multi-status-rejected">rejected</span>;
      case "edited":
        return <span class="multi-status multi-status-edited">edited</span>;
      default:
        return <span class="multi-status multi-status-pending">pending</span>;
    }
  })();

  return (
    <article
      class={`multi-card multi-card-depth-${Math.min(card.depth, 4)}${
        card.status === "accepted" || card.status === "edited"
          ? " multi-card-accepted"
          : card.status === "rejected"
            ? " multi-card-rejected"
            : ""
      }`}
      data-uuid={card.uuid}
    >
      <header class="multi-card-header">
        <span class="multi-card-label">
          {card.isParent ? <strong>Parent</strong> : `Child${card.hasChildren ? " ▾" : ""}`}
        </span>
        {statusPill}
        <div class="multi-card-actions">
          {!isEditing ? (
            <>
              <button
                type="button"
                class="multi-icon-btn multi-icon-accept"
                disabled={card.status === "streaming" || card.status === "empty"}
                onClick={onAccept}
                title={
                  card.status === "empty"
                    ? "Empty proposal — Edit to provide your own text or Reject"
                    : "Accept this block's proposal"
                }
                aria-label="Accept"
              >
                ✓
              </button>
              <button
                type="button"
                class="multi-icon-btn multi-icon-reject"
                onClick={onReject}
                title="Reject this block — keep its original text"
                aria-label="Reject"
              >
                ✗
              </button>
              <button
                type="button"
                class="multi-icon-btn multi-icon-edit"
                onClick={startEdit}
                title="Edit the proposed text before accepting"
                aria-label="Edit"
              >
                ✎
              </button>
              {onRetry ? (
                <button
                  type="button"
                  class="multi-icon-btn multi-icon-retry"
                  onClick={onRetry}
                  disabled={card.status === "streaming"}
                  title="Re-run the LLM for this block"
                  aria-label="Retry"
                >
                  ↻
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button
                type="button"
                class="diff-btn"
                onClick={commitEdit}
                title="Save edit (Accept)"
              >
                Save
              </button>
              <button type="button" class="diff-btn" onClick={cancelEdit}>
                Cancel
              </button>
            </>
          )}
        </div>
      </header>
      <div class="multi-card-body">
        <div class="multi-card-original">
          <h4>Original</h4>
          <pre class="diff-pre">{card.original}</pre>
        </div>
        <div class="multi-card-proposed">
          <h4>{isEditing ? "Edit" : "Proposed"}</h4>
          {isEditing ? (
            <textarea
              ref={editRef}
              class="diff-edit"
              value={editDraft}
              onInput={(e) => setEditDraft((e.target as HTMLTextAreaElement).value)}
              rows={Math.max(3, editDraft.split("\n").length + 1)}
            />
          ) : (
            <pre class="diff-pre">
              {card.status === "empty" ? (
                <span class="multi-empty-note">
                  Model returned an empty response
                  {card.errorMessage ? ` — ${card.errorMessage}` : ""}. Use Edit to type your own
                  text, or Reject to keep the original.
                </span>
              ) : card.proposed ? (
                segments ? (
                  renderUnified(segments)
                ) : (
                  card.proposed
                )
              ) : card.status === "streaming" ? (
                <span class="multi-streaming-note">…</span>
              ) : (
                ""
              )}
            </pre>
          )}
        </div>
      </div>
    </article>
  );
};

/**
 * Single-column diff view: `same` segments render as plain text,
 * `removed` segments render with a strikethrough + tinted background,
 * `added` segments render with a highlight + tinted background. Used
 * inside each BlockCard so the user sees the change at a glance
 * without a side-by-side split (cards are too narrow for that).
 */
function renderUnified(segments: readonly DiffSegment[]) {
  return segments.map((seg, i) => {
    if (seg.kind === "same") return <span key={i}>{seg.value}</span>;
    if (seg.kind === "removed") {
      return (
        <span key={i} class="diff-removed">
          {seg.value}
        </span>
      );
    }
    return (
      <span key={i} class="diff-added">
        {seg.value}
      </span>
    );
  });
}
