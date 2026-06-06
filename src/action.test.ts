import { describe, expect, it } from "vitest";
import {
  type Action,
  ActionSchema,
  KeybindingSchema,
  normalizeKeybinding,
  parseAction,
} from "./action";

const minimalAction = {
  id: "spellcheck",
  title: "Spellcheck",
  description: "Fix spelling",
  scope: "block" as const,
  outputMode: "replace" as const,
  systemPrompt: "Fix spelling errors in the text.",
};

describe("ActionSchema", () => {
  it("parses a minimal valid action", () => {
    const result = ActionSchema.parse(minimalAction);
    expect(result.id).toBe("spellcheck");
    expect(result.scope).toBe("block");
    expect(result.outputMode).toBe("replace");
  });

  it("defaults description to empty string when omitted", () => {
    const { description: _desc, ...without } = minimalAction;
    const result = ActionSchema.parse(without);
    expect(result.description).toBe("");
  });

  it("rejects an empty id", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, id: "" })).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, title: "" })).toThrow();
  });

  it("rejects an empty systemPrompt", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, systemPrompt: "" })).toThrow();
  });

  it("rejects an unknown scope", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, scope: "page" })).toThrow();
  });

  it("rejects an unknown outputMode", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, outputMode: "inline" })).toThrow();
  });

  it.each([
    "selection",
    "block",
    "subtree",
    "subtree-per-block",
    "subtree-batched",
  ] as const)("accepts scope=%s", (scope) => {
    expect(() =>
      ActionSchema.parse({ ...minimalAction, scope, outputMode: "diff-panel" }),
    ).not.toThrow();
  });

  // `subtree-per-block` and `subtree-batched` are pinned to `diff-panel`
  // by the schema's superRefine. The runtime has no other apply path for
  // them, so the constraint surfaces at parse time rather than silently
  // misbehaving later.
  it.each([
    "replace",
    "append-children",
    "outline-replace",
    "outline-append",
    "picker-replace",
  ] as const)("rejects subtree-per-block with outputMode=%s (requires diff-panel)", (outputMode) => {
    const result = ActionSchema.safeParse({
      ...minimalAction,
      scope: "subtree-per-block",
      outputMode,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "outputMode");
      expect(issue?.message).toContain("diff-panel");
    }
  });

  it.each([
    "replace",
    "append-children",
    "outline-replace",
    "outline-append",
    "picker-replace",
  ] as const)("rejects subtree-batched with outputMode=%s (requires diff-panel)", (outputMode) => {
    const result = ActionSchema.safeParse({
      ...minimalAction,
      scope: "subtree-batched",
      outputMode,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "outputMode");
      expect(issue?.message).toContain("diff-panel");
    }
  });

  it("accepts subtree-per-block with outputMode=diff-panel", () => {
    expect(() =>
      ActionSchema.parse({
        ...minimalAction,
        scope: "subtree-per-block",
        outputMode: "diff-panel",
      }),
    ).not.toThrow();
  });

  it("accepts subtree-batched with outputMode=diff-panel", () => {
    expect(() =>
      ActionSchema.parse({ ...minimalAction, scope: "subtree-batched", outputMode: "diff-panel" }),
    ).not.toThrow();
  });

  it("leaves the existing subtree + diff-panel combo (used by summarize) untouched", () => {
    expect(() =>
      ActionSchema.parse({ ...minimalAction, scope: "subtree", outputMode: "diff-panel" }),
    ).not.toThrow();
  });

  it.each([
    "replace",
    "diff-panel",
    "append-children",
    "outline-replace",
    "outline-append",
    "picker-replace",
  ] as const)("accepts outputMode=%s", (mode) => {
    expect(() => ActionSchema.parse({ ...minimalAction, outputMode: mode })).not.toThrow();
  });

  it("defaults kind to 'text' when omitted (back-compat for every pre-vision action)", () => {
    const result = ActionSchema.parse(minimalAction);
    expect(result.kind).toBe("text");
  });

  it.each(["text", "vision"] as const)("accepts kind=%s", (kind) => {
    expect(() => ActionSchema.parse({ ...minimalAction, kind })).not.toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, kind: "audio" })).toThrow();
  });
});

describe("parseAction", () => {
  it("returns a typed Action for valid input", () => {
    const action = parseAction(minimalAction);
    // Type-level assertion via usage
    expect(action.id).toBe("spellcheck");
  });

  it("throws a Zod error with the failing field when invalid", () => {
    expect(() => parseAction({ ...minimalAction, scope: "nope" })).toThrow(/scope/);
  });
});

describe("KeybindingSchema", () => {
  // The schema is a union (string | object). Both shapes land in JSON, so
  // a half-saved or partial import should keep both sides parseable. The
  // rejection cases pin the "no empty bindings" contract: a registered
  // chord that matches no real key would be a silent failure mode.
  it("accepts a non-empty string form", () => {
    const result = KeybindingSchema.parse("mod+shift+a g");
    expect(result).toBe("mod+shift+a g");
  });

  it("accepts the object form with a string binding + mode + mac", () => {
    const result = KeybindingSchema.parse({
      binding: "mod+shift+a g",
      mode: "non-editing",
      mac: "cmd+shift+a g",
    });
    expect(result).toEqual({
      binding: "mod+shift+a g",
      mode: "non-editing",
      mac: "cmd+shift+a g",
    });
  });

  it("accepts the object form with a string[] binding", () => {
    const result = KeybindingSchema.parse({
      binding: ["mod+shift+a g", "mod+shift+a h"],
    });
    expect(result).toEqual({ binding: ["mod+shift+a g", "mod+shift+a h"] });
  });

  it("preserves the original shape (string stays a string, object stays an object)", () => {
    // The JSON round-trip depends on this — see REQUIREMENTS §17. If the
    // schema collapsed both forms to the object shape, an object form
    // would survive a textarea round-trip but a string form would
    // re-serialise as `{"binding":"...","mode":"global"}`, surprising
    // users who hand-edit the JSON.
    const s = KeybindingSchema.parse("mod+shift+a g");
    expect(typeof s).toBe("string");
    const o = KeybindingSchema.parse({ binding: "mod+shift+a g" });
    expect(typeof o).toBe("object");
  });

  it("rejects an empty string", () => {
    const result = KeybindingSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects an empty `binding: []` array", () => {
    const result = KeybindingSchema.safeParse({ binding: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty `binding: ""` string', () => {
    const result = KeybindingSchema.safeParse({ binding: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty member inside a `binding: string[]`", () => {
    const result = KeybindingSchema.safeParse({ binding: ["mod+a", ""] });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown `mode`", () => {
    const result = KeybindingSchema.safeParse({
      binding: "mod+shift+a g",
      mode: "always-on",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-string member inside a `binding: string[]`", () => {
    const result = KeybindingSchema.safeParse({ binding: ["mod+a", 42] });
    expect(result.success).toBe(false);
  });
});

describe("normalizeKeybinding", () => {
  // The boundary normalizer that lets `index.ts` hand a single
  // SimpleCommandKeybinding shape to `registerCommandPalette` regardless
  // of how the user authored the field. Each case pins a separate
  // contract so an accidental regression (e.g., re-deriving `mac` from
  // `binding`) gets caught.
  it("returns `undefined` for `undefined`", () => {
    expect(normalizeKeybinding(undefined)).toBeUndefined();
  });

  it("expands a string form to `{ binding, mode: 'global' }`", () => {
    expect(normalizeKeybinding("mod+shift+a g")).toEqual({
      binding: "mod+shift+a g",
      mode: "global",
    });
  });

  it("fills missing `mode` with 'global' on the object form", () => {
    expect(normalizeKeybinding({ binding: "mod+shift+a g" })).toEqual({
      binding: "mod+shift+a g",
      mode: "global",
    });
  });

  it("preserves `mode` and `mac` when provided on the object form", () => {
    expect(
      normalizeKeybinding({
        binding: ["mod+shift+a g", "mod+shift+a h"],
        mode: "editing",
        mac: "cmd+shift+a g",
      }),
    ).toEqual({
      binding: ["mod+shift+a g", "mod+shift+a h"],
      mode: "editing",
      mac: "cmd+shift+a g",
    });
  });
});

describe("ActionSchema with keybinding", () => {
  // Backwards-compat: every existing user-defined action JSON predates
  // the `keybinding` field. Omitting it must keep the action valid and
  // produce `keybinding: undefined`.
  it("accepts an action without a `keybinding` field (back-compat)", () => {
    const result = ActionSchema.parse(minimalAction);
    expect(result.keybinding).toBeUndefined();
  });

  it("accepts a string `keybinding`", () => {
    const result = ActionSchema.parse({ ...minimalAction, keybinding: "mod+shift+a g" });
    expect(result.keybinding).toBe("mod+shift+a g");
  });

  it("accepts an object `keybinding`", () => {
    const result = ActionSchema.parse({
      ...minimalAction,
      keybinding: { binding: "mod+shift+a g", mode: "non-editing" },
    });
    expect((result as Action).keybinding).toEqual({
      binding: "mod+shift+a g",
      mode: "non-editing",
    });
  });

  it("rejects an action with an empty-string `keybinding`", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, keybinding: "" })).toThrow();
  });

  it("rejects an action with an empty `binding: []` `keybinding`", () => {
    expect(() => ActionSchema.parse({ ...minimalAction, keybinding: { binding: [] } })).toThrow();
  });
});
