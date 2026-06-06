import { describe, expect, it } from "vitest";
import { type Action, ActionSchema } from "../../action";
import { BLANK_DRAFT, type DraftAction, draftFrom, draftToCandidate } from "./types";

const baseAction: Action = {
  id: "spellcheck",
  title: "Spellcheck",
  description: "Fix spelling",
  scope: "block",
  outputMode: "replace",
  kind: "text",
  systemPrompt: "Fix spelling errors in the text.",
};

describe("BLANK_DRAFT", () => {
  it("starts every string field empty and uses the safe defaults for the enum fields", () => {
    expect(BLANK_DRAFT).toEqual({
      id: "",
      title: "",
      description: "",
      scope: "block",
      outputMode: "diff-panel",
      kind: "text",
      systemPrompt: "",
      keybinding: "",
    });
  });
});

describe("draftFrom", () => {
  it("preserves the string form keybinding as-is (no case-folding at the read path)", () => {
    const a: Action = { ...baseAction, keybinding: "mod+shift+a g" };
    expect(draftFrom(a).keybinding).toBe("mod+shift+a g");
  });

  it("preserves an uppercase author form on read (normalisation happens at save time)", () => {
    const a: Action = { ...baseAction, keybinding: "MOD+SHIFT+A G" };
    expect(draftFrom(a).keybinding).toBe("MOD+SHIFT+A G");
  });

  it("flattens an object-form keybinding to its JSON string for display", () => {
    const a: Action = {
      ...baseAction,
      keybinding: { binding: "mod+shift+a g", mode: "non-editing", mac: "cmd+shift+a g" },
    };
    expect(draftFrom(a).keybinding).toBe(
      '{"binding":"mod+shift+a g","mode":"non-editing","mac":"cmd+shift+a g"}',
    );
  });

  it("renders an undefined keybinding as an empty string (treated as 'no binding' by the editor)", () => {
    const a: Action = { ...baseAction };
    expect(draftFrom(a).keybinding).toBe("");
  });
});

describe("draftToCandidate", () => {
  it('omits the `keybinding` field entirely when the input is empty (no `"keybinding": ""` cruft)', () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "" };
    const out = draftToCandidate(d);
    expect("keybinding" in out).toBe(false);
  });

  it("omits the `keybinding` field when the input is whitespace-only", () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "   \t  " };
    const out = draftToCandidate(d);
    expect("keybinding" in out).toBe(false);
  });

  it("lowercases a mixed-case string-form chord so the stored value matches Logseq's keymap UI", () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "Mod+Shift+A G" };
    expect(draftToCandidate(d).keybinding).toBe("mod+shift+a g");
  });

  it("trims surrounding whitespace before normalising", () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "  mod+shift+a g  " };
    expect(draftToCandidate(d).keybinding).toBe("mod+shift+a g");
  });

  it("preserves the canonical lowercase form unchanged", () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "mod+shift+a g" };
    expect(draftToCandidate(d).keybinding).toBe("mod+shift+a g");
  });

  it("strips multi-step chord spaces correctly (Logseq separates sequence steps with spaces)", () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "mod+shift+a g" };
    // The chord "mod+shift+a g" has two steps: "mod+shift+a" then "g".
    // The space inside is part of the syntax; lowercasing doesn't touch it.
    const out = draftToCandidate(d);
    expect(out.keybinding).toBe("mod+shift+a g");
    // Sanity: the value should be parseable as a string-form keybinding.
    expect(() => ActionSchema.parse({ ...baseAction, keybinding: out.keybinding })).not.toThrow();
  });

  it("does not mutate the input draft (returns a new object)", () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "  Mod+Shift+A G  " };
    const before = JSON.stringify(d);
    draftToCandidate(d);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("drops a keybinding that normalises to empty (whitespace-only path)", () => {
    const d: DraftAction = { ...BLANK_DRAFT, keybinding: "   " };
    const out = draftToCandidate(d);
    expect("keybinding" in out).toBe(false);
  });
});
