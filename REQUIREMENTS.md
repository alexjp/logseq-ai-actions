# `logseq-ai-actions` — Requirements (v1)

Status: **Signed off 2026-04-23. Seed set and output-mode taxonomy extended 2026-04-25** (4 tone-rewrite variants, 2 outline modes + actions, vision support with `kind` field + `picker-replace` mode + 2 vision actions). **Per-block diff across subtree added 2026-06-06** — two new scopes (`subtree-per-block`, `subtree-batched`), new multi-block diff panel, new §18. **Retry button added 2026-06-06** — per-card ↻ glyph (multi-block) and footer button between Edit and Accept (single-block) re-invoke the LLM with the same input; batched-path retry falls through to per-block for the retried card. **Bulk accept button added 2026-06-06** — `Accept all changed (N)` footer button + `⌘⇧A` shortcut on the multi-block panel; marks every `pending` card with a real diff as `accepted`, leaving unchanged `pending` cards and terminal-status cards alone. Changes to this document must land via a PR and be reflected in `CHANGELOG.md`.

## 1. Purpose

A Logseq plugin that runs AI-driven actions on blocks. v1 ships a curated seed set covering text transformation (spellcheck, grammar, rewrite + tone variants, summarize, key-points, nested outlines) and image-asset analysis (title generation, OCR), plus an extension mechanism so new actions can be added without touching plugin source. Privacy-first: targets small, locally-hosted LLMs by default; vision actions work with multimodal models like `qwen3.5:2b`.

**Graph target (v1):** Logseq **DB graphs only.** File-based graph support is out of scope for v1 (revisit in v2 based on user demand). Manifest declares `supportsDbGraph: true` and either omits or explicitly sets `supportsFileGraph: false`.

## 2. Model hosting

- Plugin talks to a **user-run OpenAI-compatible HTTP endpoint**.
- Presets: **LM Studio (primary default)**, **Ollama (secondary)**, **Goose (candidate — verify OpenAI-compat at scaffold time)**, **Custom**.
- No embedded model, no cloud API in v1.
- Behind a single `LLMProvider` interface so future backends (WebLLM, cloud, …) drop in cleanly.

## 3. Entry points

All five Logseq surfaces, driven by one action registry:

- Block context menu (`"AI: <title>"` per action) — **shipped**
- Slash commands (`/AI <action>`) — **shipped**
- Command palette (`logseq.App.registerCommandPalette`, `"AI: <title>"`) — **shipped**
- Keyboard shortcuts — ships *for free* with palette entries (Logseq's keymap UI lets users bind any palette command); no default bindings
- Toolbar button (✨ → `ActionPickerPanel`) — **shipped**

One `Action` declaration auto-wires every surface. Adding an action is a **single-file change**.

### Entry-point block capture

Entry points that open a picker before running the action (currently only the toolbar button) must **resolve the focused block UUID at click time** and thread it into `runAction(action, ctx, explicitBlockUuid)`. The toolbar click itself blurs the editor (Logseq dismisses edit state on any click outside the editor area), so a synchronous probe inside the click handler usually returns null even when the user clearly had a block focused a moment ago — the bug behind the picker's "Click to run on the current block" promise.

Resolution strategy (defined in `src/adapter/editing-block-cache.ts`):

1. Synchronous three-tier probe at click time: `checkEditing()` → `getCurrentBlock()` → `getSelectedBlocks()[0]`. The first non-null wins.
2. Fallback to a polling cache populated every 500 ms via the same probe. UUID expires after 10 s of inactivity and is cleared on `onRouteChanged` so cross-page leaks are impossible.

Picker behaviour when both the live probe and the cache come back empty:

- All action cards render disabled (greyed, click swallowed) — kept visible for discoverability rather than hidden.
- The header subtitle changes from "Click to run on the current block" to **"Place your cursor in a block first."**
- Footer entries (Close, Diagnostics, Manage actions) stay enabled — they don't need a block.

Slash commands, context-menu items, and assignable shortcuts already carry their own block context (cursor-in-block invariant for slash; explicit UUID for context menu) and are unaffected. Same constraint applies to any future entry that funnels through a picker.

### Toolbar picker layout

Actions in the toolbar picker are grouped into five fixed categories so all built-in seed actions plus typical user actions fit one viewport without scrolling:

- **Fix** — `spellcheck`, `grammar`, or any id starting with `spellcheck-` / `grammar-`.
- **Rewrite** — `rewrite` or any id starting with `rewrite-` (matches the diff-panel action bar's Rewrite dropdown grouping).
- **Transform** — `summarize`, `key-points`, or any id starting with `summarize-` / `key-points-` / `outline-`.
- **Vision** — any action with `kind: "vision"` (id-pattern checks above are skipped — vision dispatch is a runtime concern, not a label).
- **Custom** — anything else (typically user-defined actions that don't follow a built-in naming convention).

User-defined actions auto-route into a built-in category when their id matches a prefix above, so a user-authored `rewrite-snarky` lives next to the seed Rewrite tones rather than in a separate Custom bucket. To keep authorship legible inside built-in categories, **user-defined cards carry an additional `custom` pill** alongside the scope/mode pills; built-in cards are unmarked. Cards in the Custom category also carry the pill (consistent rule: any user action shows it regardless of section).

Visual contract:

- Each non-empty category renders as a section: small uppercase header with a count, followed by a 2-column grid of compact cards.
- Card content: title + 1–2 monospace pills (scope + output mode; vision pill highlighted) + optional `custom` pill.
- Full description is rendered as a hover tooltip (HTML `title` attribute), not inline — keeps cards single-row.
- Empty categories are not rendered.
- Empty-state behaviour from the previous subsection still applies: cards disabled, subtitle changes to "Place your cursor in a block first."

Manage Actions remains the surface where users browse full descriptions and edit user actions.

## 4. Action scopes (v1)

- `selection` (highlighted text in a block)
- `block` (current block)
- `subtree` (block + descendants, flattened with indent markers)
- `subtree-per-block` (block + descendants, ONE LLM call per non-empty block, per-block diff)
- `subtree-batched` (block + descendants, ONE LLM call returning the whole outline back, per-block diff; auto-falls-back to `subtree-per-block` on alignment failure)
- **Not in v1:** whole-page, multi-select.
- **Fixed per-action defaults.** No per-invocation override in v1.
- **`subtree-per-block` and `subtree-batched` are restricted to `outputMode: "diff-panel"`** — both fan the action out into a multi-block diff panel; other output modes don't have a per-block apply path. Pinned by a Zod `.superRefine` so user-defined JSON surfaces the constraint at parse time rather than silently misbehaving at runtime.
- See §18 for the full per-block diff panel contract (UX, size caps, fallback rule, edit semantics).

## 5. Seed actions

| Action | Scope | Kind | Output mode | Notes |
|---|---|---|---|---|
| `spellcheck` | block | text | diff-panel | Surgical: preserves proper nouns, code, URLs, wikilinks, tags. |
| `grammar` | selection → block | text | diff-panel | Logseq-aware: respects bullet fragments, contractions, lowercase starts. |
| `rewrite` | selection → block | text | diff-panel | Streaming. |
| `rewrite-formal` | block | text | diff-panel | Formal / business register. |
| `rewrite-professional` | block | text | diff-panel | "Writing the Amazon Way" — declarative, active voice, no weasel words. |
| `rewrite-casual` | block | text | diff-panel | Conversational. |
| `rewrite-friendly` | block | text | diff-panel | Warm without forced enthusiasm. |
| `summarize` | subtree | text | diff-panel | TL;DR; written into parent, children preserved. Streaming. |
| `key-points` | subtree | text | append-children | 3–7 points as new children. |
| `outline-replace` | subtree | text | outline-replace | Destructive: deletes existing children before inserting the generated outline tree. |
| `outline-append` | subtree | text | outline-append | Non-destructive: appends the generated outline alongside existing children. |
| `image-title` | block | vision | picker-replace | Image asset blocks only. Three candidate titles; chosen value writes to `:block/title`. |
| `extract-image-text` | block | vision | outline-append | Image asset blocks only. OCR; preserves well-formed markdown tables as standalone blocks. |

## 6. Output handling

Six output modes; each action declares its default:

- **`replace`** — overwrite the block's text with the LLM output.
- **`diff-panel`** — show a side panel with original vs proposed; user accepts / rejects / edits before applying. Modal is height-capped to the viewport with header, action bar, and Reject / Edit / Accept footer all pinned; only the diff body scrolls. Action bar collapses related text-transform tones (currently the four `rewrite-*` variants alongside the bare `rewrite`) into a single dropdown chip so the row stays scannable as more actions are added.
- **`append-children`** — append the LLM output as *new child blocks* under the current block (one line per child). Non-destructive.
- **`outline-replace`** — parse the LLM output as a nested markdown outline (with table-block support); delete the block's existing direct children; insert the parsed tree as the block's new subtree. Block's own text is preserved. Destructive — confirm panel warns.
- **`outline-append`** — same parser as `outline-replace`, but appends without deleting. Non-destructive. Used for OCR output and for the non-destructive outline action.
- **`picker-replace`** — show the LLM-returned candidates in a `ChoicePanel` (1/2/3 hotkeys, Esc cancels). On accept, replace the block's text with the chosen candidate. Generic — first user is `image-title`, but reusable for text-action flows that want "show N options, user picks one".

Additional behaviours:

- One-click undo (in-session revert of pre-action content).
- Streaming updates live into block (replace mode) or into "proposed" side (diff panel).
- Vision-kind actions take an entirely separate runtime path (`runVisionAction`) that reads asset bytes from `assets/<uuid>.<ext>`, base64-encodes them, and POSTs an OpenAI-multimodal `messages` body to the same `/v1/chat/completions` endpoint. They dispatch on `outputMode` for the write step (picker-replace vs. outline-append at present).
- The asset-byte loader (`src/adapter/image-loader.ts`) routes through Logseq's postMessage caller via `logseq._execCallableAPIAsync("doAction", ["readFileRaw", path, "js-obj"])`. `Assets.makeUrl` returns `file:///abs/path` on Electron (`logseq/src/main/frontend/handler/assets.cljs:154`), and the plugin iframe runs at the `lsp://logseq.io/...` origin cross-origin with the Logseq main window, so `fetch(file://)` and `<img src="file://">` both hit Chromium's "Not allowed to load local resource". `logseq.Request._request` is unavailable in this configuration: it uses `Experiments.invokeExperMethod` → `ensureHostScope()` which synchronously reads `parent.window.logseq`, and that property access throws `SecurityError` cross-origin. `:httpRequest` (the IPC handler `Request._request` would have hit) is wrong for `file://` because Logseq pins `node-fetch@3.3.2` which rejects `file://` URLs. `:readFileRaw` (`logseq/src/electron/electron/handler.cljs:79`) uses `fs.readFileSync` directly and returns a Node Buffer — bypasses node-fetch entirely. The Postmate-based caller (`logseq/libs/src/LSPlugin.caller.ts`) uses `window.postMessage` which is cross-origin-safe; the call resolves `"doAction"` to `window.apis.doAction` via the snake-case lookup chain in `logseq/libs/src/common.ts:invokeHostExportedApi`, which `ipcRenderer.invoke("main", [...])` to the main-process dispatcher, which keywordises the first arg and routes to `:readFileRaw`. The trailing `"js-obj"` flag is critical: without it, `set-ipc-handler!` (`logseq/src/electron/electron/handler.cljs:531`) wraps the result with `sqlite-util/write-transit-str`, so the Buffer comes back as a transit-encoded string of the form `["~#'", "~b<base64>"]` and the loader can't decode it. With the flag, the dispatcher returns `(bean/->js result)` — Buffer is a `Uint8Array` subclass and survives Postmate structured-clone intact. We Blob/FileReader it to base64 in the plugin. Renderer-side `fetch` and `<img>+canvas` are kept as fallbacks for Logseq Web.
- Returns a discriminated `{ ok: true, … } | { ok: false, reason, hint? }` (reasons: `no-path`, `no-type`, `unsupported-mime`, `makeurl-failed`, `fetch-failed`, `decode-failed`) so `runVisionAction`'s toast names the actual failure instead of the generic "path or asset type unrecognised". Pure `describeOriginMismatch(origin, url)` adds a last-resort hint when every read path fails and the plugin is on an HTTP origin reading a `file://` URL. **Lesson from v1.1.2:** matching the IPC keyword (`:readFileRaw`) and reaching the right handler isn't enough — Logseq's IPC dispatcher transit-encodes returns by default. v1.0.5 → v1.1.1 fought the keyword/colon mechanics and never noticed the bytes were arriving as a string (`toUint8Array` correctly returned null; the diagnostic warn was filtered out by the user's console levels). Always probe the IPC return shape directly when an "it should work" path fails.

## 7. Extensibility

- **Hybrid.** Built-in seed actions in TS source; user-defined actions stored as a JSON array in the plugin's `userActionsJson` setting. The file-in-graph path (`logseq/plugins/logseq-action/actions.json`) is deferred behind a Desktop-Electron adapter — the settings-stored approach works identically on Logseq Web and Desktop today.
- Both share the same **Zod schema** (`ActionSchema`).
- Two authoring surfaces, round-tripping through the same setting:
  1. **`ManageActionsPanel`** (primary) — opened via `/AI Manage Actions`, the palette entry, or the toolbar picker's footer. **Gallery design (Mockup C, redesigned 2026-04-25):** card grid of all actions with built-ins shown read-only at top and user actions below; toolbar with search (filters by title / id / description / prompt), `+ New action`, `Import JSON`, and `Copy all`; clicking a built-in opens a read-only inspect view with a `⧉ Duplicate as user action` button that auto-increments the new id; clicking a user card opens the inline editor (shared form for Create / Update / View) with pill-style scope and kind selectors, output-mode dropdown, validation summary at the top after a save attempt and per-field red borders live; delete is an in-modal confirmation overlay.
  2. **Native settings textarea** (power-user) — the `userActionsJson` field in the plugin's gear settings. Useful for scripting, migration, or hand-editing.
- Plugin rebuilds the registry on `onSettingsChanged` when `userActionsJson` changes. Editing an existing action's title / prompt / scope hot-reloads — the slash handler looks up its action by id at invocation time. Adding or removing an entry still requires a plugin toggle (Logseq has no slash-command deregister API).
- A user action whose `id` matches a built-in **shadows** the built-in (swap in-place at same slash-menu slot; Manage UI shows a "shadowed by user" badge).

## 8. Privacy, consent, endpoint trust

- **One-time first-run consent modal.** Plain language; one "Got it" button.
- **LOCAL/REMOTE endpoint labeling** everywhere the endpoint is visible.
  - Pure `classifyEndpoint(baseUrl)` — loopback (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) → LOCAL, anything else → REMOTE (strict for v1; LAN ranges are REMOTE).
  - Colored badge (green LOCAL, amber REMOTE), same component everywhere.
  - One-time warning modal on LOCAL → REMOTE endpoint change.
- **Debug log.** Off by default. When enabled: in-memory ring buffer of last 50 requests, viewable in settings, "copy to clipboard" for bug reports. **Never written to disk.**
- **Redaction / content filtering.** Not in v1. README warns users not to invoke on content they don't want sent to their configured endpoint.

## 9. Testing (TDD)

| Tier | Purpose | Stack | Gate |
|---|---|---|---|
| 1 — Unit | Pure logic (registry, scope, classifier, diff, parsing) | **Vitest** + stubbed `fetch` | **80 % coverage, CI-blocking** |
| 2 — Integration | Live LLM endpoint; hot-reload; graph file watcher | Vitest, gated by `TEST_LIVE_LLM=1` | Nightly CI, no coverage gate |
| 3 — E2E | Slash → diff → accept golden paths in real Logseq | **Playwright** + MSW mock LLM | PRs to `main`, golden paths only |

**Discipline rule.** The Logseq-touching adapter stays **thin**; everything else is pure so Tier 1 covers it. A PR that adds Logseq-API-touching code without respecting this boundary should be rejected on review.

## 10. Tooling

- **Build:** Vite 8, vanilla config. `vite-plugin-logseq` is not needed — Logseq loads the plugin directly from the dev-server URL.
- **Package manager:** pnpm.
- **Lint + format:** Biome (single binary, replaces ESLint + Prettier).
- **UI framework:** Preact (React-compatible API, tiny runtime).
- **Validation:** Zod (runtime + inferred types).
- **Release:** changesets → automated `CHANGELOG.md` + versioning.
- **CI:** GitHub Actions.
- **Pre-commit:** `biome check --write` + `tsc --noEmit` via `simple-git-hooks` (or husky). Hooks never skipped.

## 11. Project hygiene

- `tasks.md` at repo root — primary task tracker.
- `CHANGELOG.md` — Keep a Changelog format, driven by changesets.
- `README.md` — setup, preset table, CORS guide, privacy note, user-actions primer pointing at the Manage UI.
- ~~`actions.example.json`~~ — superseded by the Manage Actions UI + README example snippet. Dropped.
- MIT license.
- Semantic versioning. **v1.0.0 release gate** — every runtime feature (seed actions, diff panel, preset picker, LOCAL/REMOTE label, first-run modal, Manage UI, streaming, all five entry points) is **shipped**. Remaining blockers: Tier 3 e2e tests (Phase 9) and release-prep checklist (Phase 10 — author + repo confirmation, first changeset, tag, marketplace submission).

## 12. Identity

- npm / marketplace name: `logseq-ai-actions`
- plugin id: `logseq-ai-actions`
- display title: **AI Actions**
- local dir: `logseq-action/` (intentional mismatch; documented in README)
- author: `Danzu <hdansou@gmail.com>` *(email exposure to be confirmed before release)*
- repo: `https://github.com/hdansou/logseq-ai-actions`
- license: MIT

## 13. Explicitly out of scope for v1

- Whole-page and multi-select scopes
- Per-invocation scope or output-mode override
- ~~Form-based settings UI for user actions~~ — shipped (`ManageActionsPanel`, redesigned to gallery + inline editor 2026-04-25).
- Replacing the native gear-icon plugin settings with a custom Preact settings panel (would enable inline LOCAL/REMOTE preview and prettier validation across all settings, not just user actions)
- Cloud LLM provider
- Embedded WebLLM provider
- Redaction / content filtering
- Action history panel (may piggyback on the debug ring buffer later)
- Per-action vision-model override (today there's one global `visionModel` setting; per-action overrides would let, say, `extract-image-text` use a larger model than `image-title`)
- Variable substitution in user prompts (`{{block_text}}`, `{{selection}}`, etc. — the Manage UI hints at it but the runtime doesn't substitute)
- **True `selection` scope with block-range splicing** — see §14 for the full memo.

## 14. Deferred — true `selection` scope with block-range splicing

Grammar and Rewrite are specced (§5) to operate on the user's highlighted text when present, falling back to block content when not. In v1 the fallback is the only path — `selection`-scoped actions always resolve to block scope in practice. This section captures why, and what a future implementation would need.

### The pain

Every invocation path we've shipped destroys or can't read the DOM text selection before our handler sees it:

| Entry point | Fate of the selection |
|---|---|
| **Slash command** (`/AI Grammar`) | Typing `/` into Logseq's block editor *replaces the active selection* with the `/` character. By the time the slash handler fires, selection is gone. Unrecoverable. |
| **Command palette** (`logseq.App.registerCommandPalette`, shipped in v1) | Cmd-K opens a modal overlay — no typing into the block, so the DOM selection is preserved in the underlying contenteditable. **But reading it is the hard part** (see below). |
| **Block context menu** (not yet registered) | Right-click preserves selection through the menu. Same "reading it" problem. |
| **Keyboard shortcut** (bindable via Logseq keymap) | Same as palette — preserves selection, but reading it is still the blocker. |

The blocker for all the non-slash surfaces is **reading the selection from the plugin iframe**:

- **Logseq Desktop (Electron):** the plugin iframe is same-origin with the host. `window.parent.getSelection()?.toString()` *should* work. **Unverified empirically — confirm before building.**
- **Logseq Web (shadow-cljs watch, the current user's environment):** the plugin iframe is served from `localhost:8282` while Logseq is at `localhost:3001` — cross-origin. `parent.getSelection()` throws `SecurityError` and is unrecoverable without new SDK support.

### What the SDK exposes today (as of `@logseq/libs@0.3.2`)

- `logseq.Editor.getEditingCursorPosition()` → `{ top, left, pos, rect, dir } | null` — **integer cursor position only, no anchor/focus range**.
- `logseq.Editor.getCurrentBlock()` / `getEditingBlockContent()` → block text; no selection metadata.
- No method returns a selection range.

Until Logseq adds one, Web-build users have no path to selection-scope support.

### What a workable v2 implementation looks like

1. **Verify empirically** on Logseq Desktop that a command-palette handler (or a block-context-menu item) can read `window.parent.getSelection()` and extract the selected substring + its offsets within the block. Sanity check that the block's `:title` contains the substring at those offsets (handles block vs. page-title edge cases).
2. Add `src/selection.ts` pure module:
   - `spliceText(content: string, range: { start: number; end: number }, replacement: string): string` — TDD'd; maps (fullBlockContent, range, llmOutput) → updated block content. Straightforward.
3. Adapter changes:
   - Add a `detectSelection()` helper that tries `parent.getSelection()` inside try/catch. Returns `{ text, range: {start, end}, blockUuid } | null`.
   - Extend `ResolvedInput` with optional `selectionRange` + `fullBlockContent`.
   - `resolveInput(action, options?)` — when `action.scope === "selection"` and `options.invocationPath !== "slash"`, call `detectSelection()`. If it returns a range *and* the selected text is a substring of the current block's content at the expected offsets, use it; otherwise fall back to block scope silently.
   - `runAction`'s apply path (both `replace` and `diff-panel` accept) switches on `input.selectionRange`: when set, `spliceText` before `updateBlock`; when absent, `updateBlock` with the full output as today.
4. DiffPanel's `Original` column shows just the selected substring when `selectionRange` is set. User iterates on the highlighted phrase, not the whole block. The accept splice handles the surrounding content.
5. Slash-command invocations keep falling back silently — the slash path never gets a selection, and that's documented user behaviour.

### What the SDK would need to unblock Logseq Web

Either of these unlocks Web:

- `logseq.Editor.getEditingSelection(): { start: number; end: number; blockUuid: string } | null` — block-relative offsets of the current selection, same RPC treatment as `getEditingCursorPosition`.
- A context parameter on command-palette / context-menu handlers that includes a selection snapshot captured at invocation time.

**Action item when we return**: raise this as an upstream issue in `logseq/logseq` before investing in the desktop-only version — the SDK design might shift the implementation shape meaningfully.

### Acceptance criteria (when revisited)

- [ ] Palette-triggered Grammar / Rewrite on highlighted text (Logseq Desktop) shows a diff panel whose Original column is the *selection*, not the full block.
- [ ] Accepting replaces only the selection range; rest of the block untouched.
- [ ] No active selection → falls back to block scope silently, no error toast.
- [ ] Slash-command invocations still fall back to block (no regression).
- [ ] Logseq Web behaviour: either (a) SDK gained a selection API and Web works too, or (b) one-time notice on first selection-scoped invocation explaining "selection scope is Desktop-only for now," mirroring the LOCAL→REMOTE warning pattern.
- [ ] `spliceText` pure helper TDD'd to 100 % line coverage, including empty ranges and edge offsets (start === 0, end === content.length).

## 15. Theme integration

The plugin runs inside a cross-origin iframe; Logseq does not propagate its `--ls-*` CSS variables into plugin documents. The plugin defines its own token set (`--bg`, `--fg`, `--accent`, …) with light- and dark-mode defaults that reference `var(--ls-*, fallback)` — the references stay in case Logseq adds propagation later, but the **fallbacks are what render today**.

Light/dark follows the host:

- On boot, probe `logseq.App.getStateFromStore('ui/theme')`. If it returns nothing or throws, fall back to `window.matchMedia('(prefers-color-scheme: dark)').matches`. Final fallback: light.
- The resolved mode toggles `html.dark` on the iframe's `document.documentElement`; the existing `html.dark` CSS overrides do the rest.
- `logseq.App.onThemeModeChanged` keeps the toggle in sync as the user changes mode inside Logseq.

Custom community-theme palettes (themes/plugins that override `--ls-*` on the main app) are **not** mirrored in v1 — the cross-origin iframe blocks propagation and the SDK doesn't expose a per-token API. Users on custom themes see the plugin's stock light/dark palette. Revisit if Logseq adds a propagation channel.

## 16. Per-action visibility — Hide actions

Status: Spec drafted 2026-05-05. UX picked from `prototypes/hide-actions/` (Variant C — archive bin). Implementation tracked in `tasks.md` under "Per-action visibility — hide actions (2026-05-05)".

Users can hide individual actions — built-in or user-defined — from every entry surface. Hidden actions remain visible (and restorable) inside `Manage Actions`. Visibility is purely a UI / discovery filter; the underlying action definitions are untouched.

### Decisions locked at spec time

The following defaults were chosen on 2026-05-05 without explicit user sign-off on each. Change these here before TDD if any are wrong:

- **Hidden-section ordering.** Preserve original section order: built-ins first (in seed order), then user actions (in JSON order). Stable, predictable, mirrors the rest of the panel.
- **Bulk affordances.** No "Hide all built-ins" / "Show all" buttons in v1 of this feature. The collapsible Hidden bin is itself the bulk-restore surface; bulk-hide is rare and destructive.
- **Undo toast.** Keep — a small toast appears at the bottom of the Manage modal after every hide/restore, with an Undo link, auto-dismissing after ~2.5 s.
- **Source pill on every row.** A small `built-in` / `user` pill renders on every action row (visible and hidden sections alike), so the mixed Hidden bin reads cleanly without the eye having to remember which section a row came from.

### Storage

- Plugin setting `hiddenActionIds: string[]` — a real array, not a JSON-serialised string.
- Persisted via `logseq.updateSettings({ hiddenActionIds: [...] })`; per-graph, same as every other plugin setting.
- Default `[]`.
- Declared in the existing `useSettingsSchema(...)` array in `src/index.ts`.

### Effective-action filter

- Pure helper `filterHiddenActions(actions, hiddenIds): readonly Action[]` in a new `src/visibility.ts` module — drops any action whose id appears in `hiddenIds`. Order-preserving.
- Applied **after** registry merge: `activeActions = filterHiddenActions(buildRegistry(SEED_ACTIONS, userActionsJson), hiddenActionIds)`. The filtered list is what every entry-point surface (slash, palette, context menu, toolbar picker) renders from.
- The Manage Actions panel uses the **unfiltered** merged registry plus the raw `hiddenActionIds` so it can still display and restore hidden entries.

### Shadow + hide interaction

Shadowing happens first; hide applies to whatever's effective:

1. `userActionsJson` shadowing: a user action with the same id as a built-in swaps the built-in in place. Result: one effective action per id.
2. `hiddenActionIds` hides by id, after shadowing: the hidden id refers to *whichever effective action carries that id* — the built-in if no shadow, the user version if shadowed.

### Manage Actions UX (Variant C — archive bin)

- New collapsible **Hidden** section at the bottom of the modal, below `Your actions`.
  - Header: chevron + "Hidden" + count badge + helper line: "Out of sight in the picker, slash menu, and toolbar."
  - Collapsed by default; expands on click, persists open within the same panel session (no separate setting).
- Per-row **Hide** button (visible on hover) on every action in Built-in and Your actions sections.
- Per-row **Restore** button (always visible) on every action inside the Hidden section.
- **Source pill** (`built-in` / `user`) on every row, rendered inline with the existing scope / output-mode tags. Same monospace style.
- **Hide** action: append id to `hiddenActionIds`; the row moves to the Hidden section on next render.
- **Restore** action: remove id from `hiddenActionIds`; the row returns to its original section.
- **Search filter** matches against title / id / description / prompt across both visible and hidden rows. When the query matches a hidden row, the Hidden section auto-expands so the match is reachable.
- **Undo toast** appears after every hide/restore: small overlay at the bottom of the modal with the action's title and an `Undo` link. Auto-dismisses after 2.5 s. Click Undo → reverse the last hide/restore.

### Persistence behaviour

- Hide / Restore are **autosave** — they write via `logseq.updateSettings(...)` immediately. No Save / Cancel ceremony.
- The Manage panel's existing dirty-tracking (for user-action edits) is unaffected; hide/restore mutations don't mark the panel dirty.

### Slash-command caveat

- Logseq has no slash-command deregister API. Once a slash command is registered for an action, it stays alive for the rest of the session.
- Hiding an action takes effect immediately for the toolbar picker, command palette (re-registration on plugin reload), block context menu, and Manage panel filter views. Slash-command entries for hidden actions remain responsive in the current session and only stop registering on the next plugin reload.
- This is the same caveat that applies to add/remove of user actions today; document in README and AGENTS.md alongside it.

### Out of scope for this iteration

- Bulk "Hide all built-ins" / "Show all" buttons.
- Drag-and-drop between sections (button-only).
- Sort / filter options inside the Hidden section.
- Per-graph vs. global hidden state — v1 follows the rest of the plugin (per-graph).

## 17. Keybindings

### Approach

Every action — built-in or user-defined — already registers as a `logseq.App.registerCommandPalette` entry with a stable key (`<id>` — see the "Don't prefix the `key`" gotcha below). Those entries appear automatically in Logseq's **Settings → Keyboard shortcuts** UI, where users can assign or rebind any chord with no extra plugin work. That's the primary surface for end-user customisation; the plugin layers an optional schema field on top for portable defaults inside user-action JSON.

### No shipped defaults on seed actions

The plugin does NOT ship a default keybinding for any built-in action. Reasoning: any single-key or chord-prefix default risks colliding with Logseq core or another plugin in someone's setup. Asking users to assign their own chord via the keymap UI is one click per action and produces a binding that survives plugin reloads, plugin updates, and Logseq's "reset shortcuts" flow.

### Schema field on `Action`

Optional `keybinding` field accepts:

- **String form** — a Logseq chord string (e.g. `"mod+shift+a g"`). Sugar that expands at registration time to `{ binding: <string>, mode: "global" }`. Lowercased by `draftToCandidate` (the editor's save path) so authors can type mixed-case ("Mod+Shift+A") and have the stored value match Logseq's keymap UI; Logseq's chord parser is case-insensitive, so this is display-only.
- **Object form** — `{ binding: string | string[], mode?: 'global' | 'non-editing' | 'editing', mac?: string }`, mirroring Logseq's `SimpleCommandKeybinding`. Empty `binding` arrays and empty strings are rejected by the schema. The object form is NOT authored through the Manage panel editor (which is string-only); use the JSON settings textarea (`userActionsJson`) for that.

The schema PRESERVES whichever shape was authored — JSON round-trip through the Manage panel is identity for the object form when the user keeps the JSON textarea as their authoring surface. The Manage panel's inline `Keybinding` input collapses object forms to their primary chord string when displayed, so editing in the panel reduces an object form to a string.

### Registration boundary

`normalizeKeybinding(action.keybinding)` (pure, in `src/action.ts`) converts both forms into the SDK's `SimpleCommandKeybinding` shape and is passed as the `keybinding` option on `registerCommandPalette`. Logseq's keymap UI overrides whatever the plugin registers, so the field is a default, not a lock.

### Reload caveat

`registeredInvocationIds` in `src/index.ts` is a one-shot guard that prevents the same action id from registering twice in the same session. Consequence: changing the `keybinding` on an existing action — just like changing its title or prompt — only takes effect on the NEXT plugin reload. Adding a new action with a `keybinding` always picks the binding up immediately. This is the same caveat that already applies to slash command and palette label edits.

### Don't prefix the `key` (Logseq host gotcha — integration-tested 2026-06-06)

`registerCommandPalette({ key, … })` takes the `key` field verbatim and hands it to the host's `simple-cmd-keybinding->shortcut-args`, which builds the keymap id as `(str "plugin." pid "/" key)`. ClojureScript keywords only allow **one** `/` (namespace/name separator). If the plugin passes `key = "<prefix>/<id>"` (its own slash-prefix baked in), the resulting id has two slashes and is an **invalid cljs keyword**.

Symptoms:

- The chord appears in Logseq's **Settings → Keyboard** editor with the user-set binding shown, but pressing it does NOT fire the action.
- The host's `shortcut-binding` (line 82 of `frontend/modules/shortcut/data_helper.cljs`) emits `{:shortcut/binding-not-found {:id :/plugin.logseq-ai-actions}, :line 82}` on **every** keypress, not just on plugin load.
- Clearing the binding in the editor throws a cljs reader error: `Invalid keyword: plugin.<pid>/<prefix>/<id>.`

Fix: pass the `key` BARE — the action id alone, with no plugin prefix. The host's `plugin.<pid>/` segment is the only valid prefix, and it is added by the host, not by us. The code has a comment block on the registration call to keep future readers from "helpfully" adding the prefix back.

### Out of scope for this iteration

- Default keybindings on seed actions (decision locked above; revisit only if user feedback shows the empty default is a real friction point).
- Per-graph keybinding overrides — Logseq's keymap UI is global; plugin-side `keybinding` defaults are global by virtue of riding on `registerCommandPalette`. A graph-scoped override layer is not on the v1 roadmap.
- A keybinding-capture widget in the Manage panel (e.g. "press your chord to set"). The plain text input is shippable; a capture widget can come later if users hit syntax-friction.

## 18. Per-block diff across subtree

### Motivation

Knowledge-graph blocks are usually small and live inside a tree. The existing `subtree` scope flattens the whole tree into a single LLM call (great for summarise / outline-replace / outline-append) but applies the result to a SINGLE block — the parent. Running grammar / spellcheck / rewrite on every block in a subtree currently means clicking into each child and re-running the action N times. The two new scopes fix that.

### Two scopes, one panel, two execution paths

| Scope | LLM call pattern | Best for |
|---|---|---|
| `subtree-per-block` | ONE LLM call per non-empty block (sequential, streams into the panel) | Small local models; reliable across block sizes. **Recommended default.** |
| `subtree-batched` | ONE LLM call returning the whole transformed outline | Fast local models with reliable structured output. Auto-falls-back to `subtree-per-block` on count mismatch. |

Both feed the same multi-block diff panel (next subsection) and apply per-block via `logseq.Editor.updateBlock` — children are never replaced or restructured.

### Multi-block diff panel

- Header: action title + `LocalRemoteBadge` + `Esc cancel · ⌘↵ apply` hint.
- Streaming bar: `Streaming 3 of 8…` while in progress; absent once all blocks have streamed.
- Body: scrollable list of `BlockCard`s, one per non-empty block in the subtree, in DFS order. Each card has:
  - Depth indent (CSS class `multi-card-depth-0` … `multi-card-depth-4`, capped at 4 visually).
  - A `Parent` / `Child ▾` label.
  - A status pill: `pending` / `streaming` / `accepted` / `rejected` / `edited` / `empty`.
  - Two columns: `Original` (plain) and `Proposed` (or `Edit` textarea when in edit mode).
  - Per-card buttons: `✓ Accept` / `✗ Reject` / `✎ Edit` / `↻ Retry` (the Accept button is disabled while the card is `streaming` or `empty`; the Retry button is disabled while the card is `streaming`; the Retry button is hidden entirely when the runner didn't wire a `retryBlock` callback).
  - When the streaming pass is finished, the `Proposed` column renders a unified diff (red strikethrough for removed, green highlight for added) via the existing `computeDiff` helper.
  - Footer: count summary (`N accepted · N rejected · N empty · N pending · N streaming`) + `Cancel` + `Reject remaining` (marks all still-pending/streaming cards as `rejected`) + `Accept all changed (N)` (bulk-accepts every `pending` card whose proposal actually differs from the original; see Bulk-accept subsection below) + `Apply N` (writes only the accepted/edited cards, sequentially).
  - Sequential streaming: the panel drives `runOneBlock(uuid, onChunk)` one block at a time, auto-advancing as each LLM call completes. A stale-chunk guard via a `useRef`-held generation counter drops chunks from prior in-flight calls if the user clicks `Cancel` or `Reject remaining` mid-stream.
  - Keyboard: `Esc` cancels (discards pending), `⌘⇧A` bulk-accepts every changed pending card, `⌘↵` / `Ctrl↵` applies the accepted set (disabled while streaming).

### Edit-implies-accept

Editing a card's proposed text and clicking `Save` flips the card's status to `edited` and locks the edited text as the apply value. `Apply N` includes edited cards in the count without requiring a separate Accept click. The user can still `Cancel edit` to revert.

### Empty-response handling

If `runOneBlock` returns an empty string (model returned nothing useful) or throws, the card flips to `empty` with an inline "Model returned an empty response" note and the error message (if any). The Accept button stays disabled for empty cards (writing an empty text is destructive) — the user must either Reject or use Edit to provide their own text. Empty cards are NOT included in the `Apply N` count.

### Per-block Retry (single-block + multi-block panels)

Both diff panels expose a "Retry" affordance that re-invokes the LLM with the same input — useful when the first response is sub-par and the user wants a fresh roll without re-picking the action from the toolbar. The single-block footer has a `Retry` button between `Edit` and `Accept` (`Reject | Edit | Retry | Accept`); the multi-block panel has a per-card `↻` glyph after the `✎` Edit button. Both are disabled while streaming and follow the same dirty-edit guard as the action-bar switch in the single-block panel: clicking Retry with unsaved edits routes through the existing `ConfirmOverlay` with copy "Re-running will replace your edited text with a fresh proposal." (multi-block panel has no edit-confirmation overlay — per-card edits are committed on the Save button and the next Retry re-streaming leaves the edit as-is until the user explicitly clicks Retry again; the card's status is `streaming` during the re-stream so the Edit button is disabled).

In the per-block runner, Retry re-runs the LLM for the touched block (same body as the initial `runOneBlock` call). In the batched runner, Retry re-invokes the LLM for that one block with the original text from `textByUuid` — the cached batched proposal for that card is abandoned, other cards keep their batched proposals. The retry callback is wired as a separate `retryBlock` prop on `MultiBlockDiffPanel` so each runner can pick the right semantics without leaking its implementation to the panel.

### Bulk accept (multi-block panel only)

The multi-block panel footer exposes an **`Accept all changed (N)`** button that flips every `pending` card whose proposal actually differs from the original to `status: "accepted"`. This is the common-case shortcut: in a 10-block subtree where 7 cards changed and 3 didn't, the user can mark the 7 changed ones in one click instead of clicking per-card ✓ seven times. The button is positioned between `Reject remaining` and `Apply N`; a keyboard shortcut `⌘⇧A` does the same thing.

**Predicate for "changed"** (a card is included in the bulk action iff all of):

- `status === "pending"` (not already `accepted`/`rejected`/`edited`/`streaming`/`empty`).
- `proposed.length > 0` (defensive — empty proposals never reach `pending` anyway, but `Apply` is disabled on empty, so we match).
- `proposed.trim() !== original.trim()` (whitespace-only diffs don't count — trailing-newline reformatting from the LLM isn't a meaningful semantic change).

**Disabled when**:

- Any card is `streaming` (would race with the in-flight stream — same gate as `Apply N`'s `!allDone`).
- The `changedPendingCount` is 0 (nothing to do — button stays visible-but-disabled, so the affordance is discoverable).

**The bulk action only marks; the user still clicks `Apply N` to commit.** This preserves the review step: bulk-accept → spot-check the unchanged `pending` cards or reject a few stragglers → apply. The bulk action never touches the `Apply N` button's disabled state directly (it only affects the count by flipping `pending` → `accepted`).

**No `Reject all changed` mirror.** `Reject remaining` already covers the symmetric case (rejects every `pending` AND `streaming` card); a stricter "reject just the changed ones" would only be useful in a workflow that needs `pending`-but-unchanged cards to survive untouched, which is the same workflow `Accept all changed` is built for in the first place. Adding a mirror would be clutter for no functional gain.

**Unchanged `pending` cards after a bulk-accept** stay `pending` and are filtered out at apply time (no `logseq.Editor.updateBlock` call for them — the text equals the original). This is the same filtering `Apply N` already does for cards that the user never touched, so the bulk action is consistent with the existing per-card flow.

### Subtree size policy

- **Soft warning at 20 blocks** — runner shows an info toast ("this will take a while"), user can proceed.
- **Hard cap at 50 blocks** — runner shows a warning toast and aborts. The cap is enforced by `walkSubtree` BEFORE the first LLM call fires, so the user is never charged for an oversized subtree.
- Empty blocks (whitespace-only) are filtered out by the walker; the cap counts only non-empty blocks.

### Batched alignment rule

`alignBatchedResponse(walked, llmOutput)` in `src/adapter/run-batched-action.ts` is the single source of truth. It parses the LLM output with `parseOutline`, flattens it with `flattenOutlineTree`, and compares the resulting line count to the walk's node count. If they differ, the runner transparently re-runs the action through `runPerBlockAction` with the same action + settings + explicit uuid, and shows an info toast noting the fallback.

The pure alignment helper is unit-tested (`src/adapter/run-batched-action.test.ts`) — happy path, drop-a-level, response too long, response too short, empty response, empty subtree, preamble + code-fence tolerance, 50-block cap, 51-vs-50 boundary.

### Authoring surface

- **Manage Actions → scope dropdown** shows `selection`, `block`, `subtree`, `subtree-per-block` (label: "subtree (per block)"), `subtree-batched` (label: "subtree (batched)").
- **Import JSON** placeholder includes a `grammar-subtree` example so users have a working starter.
- **Toolbar picker** routes both new scopes into the **Transform** bucket (they're text transformations of an entire subtree); id-prefix matching on `grammar` / `spellcheck` is bypassed when `scope` is one of the new values, so a user action like `grammar-subtree` lands in Transform rather than Fix.

### Why no seed action ships this scope

The two new scopes are building blocks, not opinions. The plugin's seed set still targets single-block rewrites (`spellcheck`, `grammar`, `rewrite-*`); users opt into the per-block subtree behaviour by writing their own action in `userActionsJson` or via Manage Actions. A one-line user action like `{ id, title, scope: "subtree-per-block", outputMode: "diff-panel", systemPrompt: "..." }` is enough. Revisit adding a `grammar-subtree` seed action only if the absence becomes a discoverability problem.

### Out of scope for this iteration

- **Parallel per-block LLM calls.** A local model on one CPU/GPU queues the requests anyway, and the per-block streaming UX is harder to follow with out-of-order completion. Sequential is the default; a `parallel: true` runtime flag is a candidate follow-up.
- **Tree-shape preservation in the diff panel.** The panel renders a flat depth-indented card list, not a collapsible tree. Larger subtrees work fine but the visual model is "list of cards" rather than "explorer view" — that's a UI complexity trade-off, not a correctness one.
- **Per-block action switching (mid-flight).** The single-block diff panel has an action-bar to switch the active action mid-stream; the multi-block panel does not. Adding it would mean a per-card action picker and a model switch in the middle of streaming — scope creep.
- **Editing the keybinding on an existing per-block action.** Same caveat as §17: `registeredInvocationIds` is one-shot, so editing the JSON for an existing action's keybinding only takes effect on plugin reload. Adding a new per-block action picks its binding up immediately.
