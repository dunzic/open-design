# 007 — Tweaks no-annotation fallback (synthetic data-od-auto-id)

Status: Active
Date: 2026-05-09

## Problem

When the agent emits an HTML artifact without `data-od-id` /
`data-screen-label` annotations (a freeform PRD → HTML pass through a
Claude-Code-compatible CLI without a skill, for example), **Tweaks →
Picker** and **Tweaks → Pods** silently no-op. The iframe
selection-bridge's `closestTarget()` walks up to `<html>` looking for
either attribute, finds nothing, and bails — clicks emit no
`od:comment-target` postMessage, pod-stroke intersections find zero
targets in `liveCommentTargets`, and the user is left poking at a page
with no UX response.

Upstream PR #1005 (custom/006 i18n) flagged this gap explicitly and
deferred the fix:

> The follow-up scenario from #890 ("parent has data-od-id, target
> child does not → adjustments hit the parent") is a different bug
> that needs **either synthetic-id fallback or a UI affordance to
> descend into the click target**. Leaving that to a follow-up so this
> PR stays narrow.

This customization is the synthetic-id fallback half of that
follow-up. Picker and Pods now work on freeform artifacts; the chat
attachment thread still gets enough context (an `outerHtml` snippet
plus the agent guidance header) to locate the right element in source
without relying on the synthesized id surviving across edits.

Inspect mode is intentionally NOT extended this way — Inspect's
per-element CSS overrides persist into the
`<style data-od-inspect-overrides>` block keyed by `elementId`, and
auto-ids regenerate fresh on every srcdoc rebuild. Persisting
overrides keyed off auto-ids would silently lose them on next reload.
The bridge's `applyOverride` has an explicit guard refusing
`[data-od-auto-id=...]` selectors as a belt-and-braces safety net.

## Modified

- `apps/web/src/runtime/srcdoc.ts` — selection-bridge IIFE:
  - **`shouldAutoTag(el)`** — heuristic that decides whether an
    element deserves a synthetic id. Tags interactive leaves
    (`button`, `a`, `img`, `video`, form controls, `iframe`,
    `canvas`, `svg`), semantic landmarks
    (`section`, `article`, `nav`, `header`, `footer`, `aside`,
    `main`, `figure`), elements with explicit `role`, and any element
    that has its own non-whitespace text node. Skips invisible
    elements (rect < 4×4), already-tagged elements, and SVG subtree
    leaves (the `<svg>` root is enough).
  - **`injectAutoIds()`** — eager scan that walks `document.body`
    once, calling `setAttribute('data-od-auto-id', 'auto-N')` on every
    qualifying element. Idempotent because `shouldAutoTag` short-
    circuits on already-tagged nodes.
  - **`closestTarget()`** — accepts `data-od-auto-id` only when
    `commentEnabled` is true (Picker / Pods). Inspect-only mode walks
    past auto-ids.
  - **`targetFrom()`** — payload now carries `idKind:
    'stable' | 'screen-label' | 'auto'` and, for auto-id targets, a
    truncated `outerHtml` snippet (capped at 1500 chars) with the
    injected attribute stripped so the agent doesn't try to write
    `data-od-auto-id` back into the source artifact.
  - **`allTargets()`** — query union grows to
    `[data-od-id], [data-screen-label], [data-od-auto-id]` only when
    comment mode is active.
  - **`od:comment-mode` message handler** — calls `injectAutoIds()`
    on every `enabled: true` toggle so re-entering Tweaks on a
    different artifact re-tags it.
  - **Initial boot** — also injects auto-ids when the bridge boots
    with `commentEnabled` already true (the host seeds
    `initialCommentMode`); guards on `document.readyState`.
  - **`applyOverride()`** — short-circuits on selectors starting with
    `[data-od-auto-id=`, refusing to persist Inspect overrides keyed
    off unstable ids.
- `packages/contracts/src/api/comments.ts` — adds
  `PreviewCommentIdKind = 'stable' | 'screen-label' | 'auto'` and two
  optional fields to `PreviewCommentTarget`: `idKind?` and
  `outerHtml?`.
- `packages/contracts/src/api/chat.ts` — same two optional fields on
  `ChatCommentAttachment`. Imports `PreviewCommentIdKind` from
  `./comments`.
- `apps/web/src/types.ts` — re-exports `PreviewCommentIdKind` so the
  app surface mirrors the contracts.
- `apps/web/src/comments.ts`:
  - `PreviewCommentSnapshot` interface gains `idKind?` and
    `outerHtml?`.
  - `targetFromSnapshot` threads them into `PreviewCommentTarget`.
  - `commentToAttachment` (saved-comment path) hard-codes
    `idKind: 'stable'` — saved comments never carry synthetic ids,
    so this is a defensive override against a stale snapshot
    leaking auto-id metadata into the persisted shape.
  - `buildBoardCommentAttachments` (board-batch path) propagates
    target.idKind and target.outerHtml.
  - `trimOuterHtml(value)` helper: collapses whitespace and re-caps
    at 1500 chars.
  - `renderCommentAttachmentContext` emits a one-time `Locator note:`
    header above the per-target list whenever any attachment uses an
    auto id — explicit instructions for the agent to locate via
    `outerHtml` content, NOT by searching for the
    `[data-od-auto-id="..."]` selector. Each per-target block also
    gains an `idKind:` line, and auto targets get an `outerHtml:` line.
- `apps/web/src/components/FileViewer.tsx` — `snapshotFromData`
  parses `idKind` (validates against the union) and `outerHtml`
  (length-caps at 1500 chars) from the inbound `od:comment-target`
  postMessage payload.

## Test cases

```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web exec vitest run \
  tests/runtime/srcdoc-bridge-auto-id.test.ts \
  tests/runtime/srcdoc-bridge-empty-targets.test.ts \
  tests/comments.synthetic-locator.test.ts \
  tests/comments.test.ts
```

`tests/runtime/srcdoc-bridge-auto-id.test.ts` (5 cases) covers:

- Comment mode boot injects `data-od-auto-id` on landmark + leaf nodes.
- Inspect-only mode does NOT inject auto-ids.
- Existing `data-od-id` ancestors are preserved (no double-tagging).
- Click on an unannotated leaf yields `od:comment-target` with
  `idKind: 'auto'`, an `[data-od-auto-id="auto-N"]` selector, and a
  non-empty `outerHtml` with the injected attribute stripped.
- A click that traverses up to a stable-id ancestor still resolves
  to the stable id (no silent downgrade).

`tests/runtime/srcdoc-bridge-empty-targets.test.ts` keeps its #890
contract: Inspect-only mode + no annotations → empty `targets: []`
broadcast, no synthetic targets, click on an unannotated element
yields no `od:comment-target` payload.

`tests/comments.synthetic-locator.test.ts` (5 cases) covers the
chat-attachment renderer:

- `idKind` and `outerHtml` survive the snapshot → target → attachment
  pipeline.
- `Locator note:` header + `outerHtml:` line appear for synthetic
  attachments.
- Stable-id attachments do NOT trigger the locator-note header.
- Missing `outerHtml` falls back to a deterministic placeholder line.
- Saved comments are forced through the stable codepath.

## Re-apply notes

- If upstream lands its own synthetic-id fallback, demote this
  requirement to **superseded** and drop the parallel implementation.
  Tracking signals to watch for: anything in `srcdoc.ts` that adds a
  `data-od-auto-id` attribute, references `idKind`, or writes an
  `outerHtml` field into `od:comment-target`. Upstream's version may
  pick a different attribute name or emit a `cssPath` instead of
  `outerHtml`; mirror their wire format in that case.
- The `shouldAutoTag` heuristic is intentionally narrow — it tags
  leaves + landmarks, not every wrapper `<div>`. If users start
  reporting "I clicked the card background but the click went to the
  outer wrapper", relax the heuristic to also tag direct children of
  landmarks. Be aware that tagging every `<div>` aggressively expands
  pod target counts and degrades stroke-intersection performance on
  big artifacts.
- `applyOverride`'s auto-id refusal is a safety net, not a feature
  gate — users in Inspect mode will simply see no Inspect Panel for
  unannotated elements (the existing #1005 hint banner already tells
  them to ask the agent to add data-od-id). If we later support
  Inspect on auto-ids, also extend the persistence layer to use
  auto-id + outerHtml-derived locators so re-applies survive
  rebuilds.
- The `outerHtml` cap is 1500 chars at both the bridge layer and
  `trimOuterHtml`. Chat tokens scale linearly with attachment count,
  so don't lift this cap without measuring the per-turn token impact.
