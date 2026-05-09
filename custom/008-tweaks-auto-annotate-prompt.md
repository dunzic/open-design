# 008 — Empty-state hint adds "auto-annotate" composer prefill

Status: Active
Date: 2026-05-09

## Problem

Custom/006 (i18n the empty-state hint) tells the user **what's wrong**
("this artifact has no `data-od-id` annotations"), but the recovery
path is still manual: open the chat, type a prompt asking the agent
to add the attribute, hit Send. Custom/007 (synthetic auto-ids) lets
Picker / Pods work without annotations, but the synthetic locators
are one-shot — the agent ends up modifying source by outerHtml match
rather than by stable id.

For users who actually want long-term-stable Inspect / saved-comment
support back, the right answer is still "have the agent re-emit the
artifact with `data-od-id`". This customization adds a one-click
shortcut for that path: an **Auto-fix** button on the empty-state
hint banner that prefills the chat composer with a ready-to-go prompt
asking for annotation. The user reviews / edits / hits Send.

## What

A new button rendered inside the existing
`.inspect-empty-hint-container`, only when `liveCommentTargets.size
=== 0` (i.e. when the empty-state copy is showing). Clicking it
dispatches a `window` `CustomEvent('od:chat-prefill', { detail:
{ text } })`. ChatComposer registers a one-time listener that absorbs
the prompt into its draft state and focuses the textarea. The user
still has to hit Send — the click is a one-step shortcut, not an
auto-submit.

**Decoupling rationale**: routing the prefill via a
`window`-scoped CustomEvent avoids threading a `setComposerDraft`
callback through `FileViewer` → `FileWorkspace` → `ProjectView` →
`ChatPane` → `ChatComposer`. The event channel is symmetric (any
future affordance can prefill the same way) and the bridge has a
single-line listener teardown on unmount.

## Modified

- `apps/web/src/i18n/types.ts` — adds two new `Dict` keys:
  - `fileViewer.inspectEmptyHint.autoAnnotateLabel` (button label)
  - `fileViewer.inspectEmptyHint.autoAnnotatePrompt` (the prompt
    text the composer absorbs)
- `apps/web/src/i18n/locales/{en,zh-CN,zh-TW,ja,ko,fr,de,es-ES,pt-BR,ru,ar,fa,id,pl,hu,uk,tr,th}.ts`
  — 18 locale dictionaries get the two new keys with locale-native
  copy. The Chinese prompt matches the user's reference text verbatim;
  other locales follow the same structure (region list +
  `<area>-<role>-<n>` naming pattern + concrete examples).
- `apps/web/src/components/FileViewer.tsx` — empty-state hint banner:
  - New `<button class="inspect-empty-hint-action"
    data-testid="inspect-empty-hint-auto-annotate">` rendered
    alongside the no-targets copy.
  - On click: `window.dispatchEvent(new CustomEvent('od:chat-prefill',
    { detail: { text: t(...autoAnnotatePrompt) } }))`.
- `apps/web/src/components/ChatComposer.tsx` — adds a `useEffect`
  hook that registers `window.addEventListener('od:chat-prefill',
  ...)`. The handler appends the prompt to the existing draft (with a
  blank-line separator) so unsent text isn't clobbered, focuses the
  textarea, and places the caret at end. Honors a `replace: true`
  flag in detail for callers that want clobber semantics.
- `apps/web/src/index.css` — `.inspect-empty-hint-action` styles
  (pill button, accent color, hover invert). Keeps the action visible
  inside the dashed-border hint container without overflowing.

## Test cases

```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web exec vitest run \
  tests/components/FileViewer.inspect-empty-hint.test.tsx \
  tests/i18n/locales.test.ts
```

`tests/components/FileViewer.inspect-empty-hint.test.tsx` (5 cases)
adds two new assertions for this customization:

- Clicking the auto-fix button dispatches `od:chat-prefill` with a
  detail object whose `text` references `data-od-id` (verifies the
  i18n key resolves to a real prompt, not the placeholder fallback).
- The auto-fix button does NOT render when the artifact already has
  annotations — only the empty-state path exposes it.

`tests/i18n/locales.test.ts` continues to enforce that every locale
declares both new keys.

## Re-apply notes

- If upstream gives ChatComposer its own imperative "set draft"
  affordance (e.g. exposes `composerHandleRef` from `ChatPane`'s
  parent), switch the FileViewer click handler to use that instead of
  the window CustomEvent. The event listener in ChatComposer can stay
  as a public extension point for other prefill sources, or be
  removed if no caller needs it.
- The prompt copy lives in 18 locales. If upstream changes the
  preferred annotation pattern (e.g. switches from
  `data-od-id` to `data-tweak-id` or adopts a different naming
  convention), update all 18 strings together to keep
  `tests/i18n/locales.test.ts` happy and avoid mixed-locale guidance
  reaching the agent.
- The button's CSS rule
  (`.inspect-empty-hint-action`) shares space with custom/006's
  Close button (`.orbit-artifact-ghost`) inside the dashed container.
  If upstream restructures `inspect-empty-hint-container` (e.g.
  flattens it or moves the close button), reconcile pointer-events +
  layout so the new button still receives clicks.
- The `od:chat-prefill` event name is fork-only; if upstream adopts a
  similar pattern with a different name, rename in lockstep at both
  ChatComposer (listener) and FileViewer (dispatcher).
