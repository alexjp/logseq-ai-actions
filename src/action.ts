import { z } from "zod";
import type { ActionKind, ActionScope, OutputMode } from "./types";

const SCOPES: readonly ActionScope[] = [
  "selection",
  "block",
  "subtree",
  "subtree-per-block",
  "subtree-batched",
];
const OUTPUT_MODES: readonly OutputMode[] = [
  "replace",
  "diff-panel",
  "append-children",
  "outline-replace",
  "outline-append",
  "picker-replace",
];
const KINDS: readonly ActionKind[] = ["text", "vision"];

/**
 * Optional keyboard shortcut for an action. Two authored shapes —
 * mirroring Logseq's `SimpleCommandKeybinding` — converge on the same
 * normalised `SimpleCommandKeybinding` form at registration time.
 *
 * - String form (e.g. `"mod+shift+a g"`) — sugar that expands to
 *   `{ binding: <string>, mode: "global" }`.
 * - Object form — `{ binding: string | string[], mode?, mac? }`.
 *   `mode` defaults to `"global"` when omitted; `mac` is preserved.
 *
 * Empty strings and empty `binding` arrays are rejected so a half-saved
 * draft can't register a no-op binding. The schema preserves whichever
 * shape was authored — string round-trips as a string, object as an
 * object — so the JSON textarea is identity for the object form.
 */
export const KeybindingSchema = z.union([
  z.string().min(1, "keybinding string is empty"),
  z.object({
    binding: z.union([
      z.string().min(1, "keybinding.binding string is empty"),
      z
        .array(z.string().min(1, "keybinding.binding contains an empty string"))
        .min(1, "keybinding.binding array is empty"),
    ]),
    mode: z.enum(["global", "non-editing", "editing"]).optional(),
    mac: z.string().optional(),
  }),
]);

export type Keybinding = z.infer<typeof KeybindingSchema>;

/** Logseq's `SimpleCommandKeybinding` shape — the only form the SDK accepts. */
export interface SimpleCommandKeybinding {
  mode?: "global" | "non-editing" | "editing";
  binding: string | string[];
  mac?: string;
}

/**
 * Convert the schema's union form into the SDK's `SimpleCommandKeybinding`
 * shape. String → `{ binding, mode: "global" }`; object fills missing
 * `mode` with `"global"`; `undefined` → `undefined`. Pure — no SDK import.
 */
export function normalizeKeybinding(
  kb: Keybinding | undefined,
): SimpleCommandKeybinding | undefined {
  if (kb === undefined) return undefined;
  if (typeof kb === "string") {
    return { binding: kb, mode: "global" };
  }
  return {
    ...(kb.mode ? { mode: kb.mode } : { mode: "global" }),
    binding: kb.binding,
    ...(kb.mac ? { mac: kb.mac } : {}),
  };
}

/**
 * Canonical Action shape. Single source of truth for both built-in seed
 * actions (TS literals validated at build time) and user-defined actions
 * loaded from JSON at runtime — both paths converge on this schema.
 *
 * See REQUIREMENTS §4–§6 for scope/outputMode semantics, §17 for keybinding.
 */
export const ActionSchema = z
  .object({
    id: z.string().min(1, "id is required"),
    title: z.string().min(1, "title is required"),
    description: z.string().default(""),
    scope: z.enum(SCOPES as [ActionScope, ...ActionScope[]]),
    outputMode: z.enum(OUTPUT_MODES as [OutputMode, ...OutputMode[]]),
    systemPrompt: z.string().min(1, "systemPrompt is required"),
    // `kind` is optional with a default of "text" — every existing action
    // and every existing user-defined action JSON literal stays valid.
    kind: z.enum(KINDS as [ActionKind, ...ActionKind[]]).default("text"),
    keybinding: KeybindingSchema.optional(),
  })
  .superRefine((action, ctx) => {
    // `subtree-per-block` and `subtree-batched` both fan out the action
    // across a node's subtree with one diff entry per block. The
    // multi-block diff panel IS the only sensible apply path — other
    // output modes (replace / append-children / outline-* / picker-*)
    // either don't make sense per-block, or would still need a manual
    // review UI we haven't built. Pin to `diff-panel` at parse time so
    // user-defined JSON surfaces the constraint immediately rather than
    // silently misbehaving at runtime.
    if (
      (action.scope === "subtree-per-block" || action.scope === "subtree-batched") &&
      action.outputMode !== "diff-panel"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputMode"],
        message: `scope '${action.scope}' requires outputMode 'diff-panel' (got '${action.outputMode}')`,
      });
    }
  });

export type Action = z.infer<typeof ActionSchema>;

/** Parse + validate in one call. Throws a ZodError on failure. */
export function parseAction(raw: unknown): Action {
  return ActionSchema.parse(raw);
}
