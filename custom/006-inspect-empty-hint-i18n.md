# 006 — i18n the Inspect / Picker empty-annotation hint

Status: Active
Date: 2026-05-09

## Problem

Upstream PR #1005 ("fix(web): surface empty-annotation state for
Inspect/Picker") landed in 0.6.0. It teaches `FileViewer.HtmlViewer` to
render two distinct hint banners when the user opens **Inspect** or
**Tweaks → Picker** mode:

- *No annotations on this artifact*: "This artifact has no `data-od-id`
  annotations yet — ask the agent to add them to the sections you want
  to {inspect|comment on}."
- *Annotations exist but nothing selected*: "Click any element with
  `data-od-id` to {tune its style|leave a comment}."

The PR author flagged the i18n gap themselves in the commit body:

> i18n: the existing inspect-empty-hint copy is hardcoded English;
> rolling it into the 17-locale Dict is a separate cleanup.

This file is that cleanup. The hint is the only signal a user gets when
the picker silently no-ops on an unannotated artifact (the most common
failure mode reported by Chinese users running Picker on freeform PRD
→ HTML output that did not pass through a skill), so the copy needs to
be visible in every UI locale, not just English.

## Modified

- `apps/web/src/i18n/types.ts` — adds five new `Dict` keys under
  `fileViewer.inspectEmptyHint.*`: `noTargetsInspect`,
  `noTargetsComment`, `clickToTune`, `clickToComment`, `closeAria`.
  Every value uses a single `{tag}` placeholder that the FileViewer
  renderer substitutes with an inline `<code>data-od-id</code>` chunk
  at render time.
- `apps/web/src/i18n/locales/{en,zh-CN,zh-TW,ja,ko,fr,de,es-ES,pt-BR,ru,ar,fa,id,pl,hu,uk,tr,th}.ts`
  — 18 locale dictionaries, each gets the 5 keys with locale-native
  copy. The `{tag}` marker is preserved verbatim in every locale (the
  existing `tests/i18n/locales.test.ts` placeholder-alignment check
  pins this contract).
- `apps/web/src/components/FileViewer.tsx`:
  - Adds `Fragment` to the React import line.
  - Adds a small `renderHintWithCode(template: string)` helper near
    `summarizeMember` (around line 2273) that splits the translated
    string at `{tag}` and emits an alternating sequence of text
    fragments and `<code>data-od-id</code>` markup nodes. If a locale
    omits the marker, the helper falls back to plain text — empty
    behaviour, never a runtime error.
  - Replaces the four hardcoded English JSX expressions in the
    `inspect-empty-hint-container` block (around line 4934) with
    `t(...)` lookups + `renderHintWithCode(...)`.
  - Replaces the hardcoded `title` / `aria-label` (`"Close Inspect
    Hint"`) on the dismiss button with
    `t('fileViewer.inspectEmptyHint.closeAria')`.

## Re-apply notes

- The `data-testid` values (`inspect-empty-hint`,
  `inspect-empty-hint-no-targets`) are unchanged so upstream's
  `tests/components/FileViewer.inspect-empty-hint.test.tsx` keeps
  passing without locale-specific assertions. If upstream tightens
  those tests to assert on text content (e.g.
  `expect(...).toHaveTextContent('Click any element')`), remove the
  English-string assertion or migrate it to the i18n key, since the
  default locale is still English.
- If upstream lands its own `fileViewer.inspectEmptyHint.*` keys
  (likely path: a follow-up to #1005), demote this requirement to
  **superseded** and drop the local keys. Keep the per-locale
  translations only where upstream's wording diverges from this fork.
- The five new keys must stay under `fileViewer.*` namespace because
  the surrounding banner is FileViewer-specific. Resist generalizing
  to `common.*` until a second consumer appears.
- If upstream ever changes the `{tag}` literal (e.g. wraps
  `data-screen-label` instead of `data-od-id`), update
  `renderHintWithCode` to take the literal as a parameter, then
  thread it from the call site.

## Test cases

```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web exec vitest run \
  tests/i18n/locales.test.ts \
  tests/components/FileViewer.inspect-empty-hint.test.tsx
```

Expected:

- `tests/i18n/locales.test.ts > keeps locale dictionaries aligned with
  English keys and placeholders` passes — guarantees every locale has
  the 5 new keys AND each value preserves the `{tag}` placeholder.
- `tests/components/FileViewer.inspect-empty-hint.test.tsx` 3/3 passes
  — the existing #1005 assertions key off `data-testid` and the
  embedded `<code>` text, both of which still hold in the localized
  render path.
- Manual: switch the UI locale to Chinese (Settings → Language →
  简体中文), open a file with no `data-od-id`, enter **Tweaks → Picker**,
  the banner should read "此产物尚未标注 `data-od-id`，请让代理为你想评论的
  区块加上这个属性。" without breaking layout.

## Verify

After re-applying or merging:

```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web test --run
```

Both must remain green.
