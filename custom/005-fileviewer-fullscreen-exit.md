# 005 — FileViewer native fullscreen exit affordance

Status: Active
Date: 2026-05-09

## Problem

`FileViewer.tsx`'s **Present → Present fullscreen** menu item calls
`el.requestFullscreen()` on the preview body and never tracks the
returned native-fullscreen state. Once the browser switches into native
fullscreen, the only way out is the browser's own Esc key — there is no
visible "minimize" / close button overlaid on the fullscreened content.
`PreviewModal.tsx` already does this correctly (PR #168 added a
`fullscreenchange` listener + an Exit Fullscreen toggle), but that fix
was never ported to `FileViewer`'s `HtmlViewer` and `LiveArtifactViewer`
present flows.

The user-visible failure mode (reported 2026-05-09): "应用 bug 全屏以后没有
缩小的按钮" — once fullscreen, there's no in-app affordance to shrink.

Upstream's PR #1048 ("redesign top bar — lift Share/Present, zoom
dropdown, focus toggle") added a `present-exit-btn` overlay, but only
for the `inTabPresent` mode (CSS-driven in-tab present where chrome is
hidden). The native `requestFullscreen()` path remained without an
in-app exit affordance even after the 0.6.0 release.

## Modified

- `apps/web/src/components/FileViewer.tsx` — both `HtmlViewer` and
  `LiveArtifactViewer` now:
  - Track `nativeFullscreen` React state.
  - Install a `fullscreenchange` listener on `document` that mirrors
    `document.fullscreenElement === previewBodyRef.current` (HtmlViewer)
    or `previewBodyRef.current ?? iframeRef.current` (LiveArtifactViewer)
    into `nativeFullscreen`. This catches both the click-driven exit and
    the browser's Esc key in lock-step (same pattern as PreviewModal.tsx
    line 143).
  - Set `nativeFullscreen = true` in the `requestFullscreen().then(...)`
    success branch so the overlay button mounts as soon as the native
    transition resolves.
  - Render an `<button className="present-exit-btn">` overlay inside the
    fullscreened element (`.viewer-body` / `.live-artifact-preview-frame-host`)
    while `nativeFullscreen` is true. Reuses the existing
    `.present-exit-btn` selector that PR #1048 added for the in-tab
    present case — same visual treatment, different trigger.
  - `exitNativeFullscreen()` calls `document.exitFullscreen()` and
    clears local state. The `fullscreenchange` listener also clears the
    state when the browser exits fullscreen on its own (Esc / F11), so
    the click path and the keyboard path stay in sync.
- `apps/web/src/index.css` — declare `position: relative` on
  `.live-artifact-preview-frame-host` so the absolute-positioned exit
  button anchors at the container's top-right when LiveArtifactViewer
  is fullscreened. `.viewer-body` already had `position: relative` for
  HtmlViewer's case (line 7863).

## Re-apply notes

- If upstream lifts `presentFullscreen` UX into a shared hook or
  promotes an in-app exit affordance into the same code, demote this
  requirement to **superseded** and adopt theirs. Tracking signals to
  watch for: a `useNativeFullscreen` hook, a `presentFullscreen` helper
  in a shared module, or a new `present-exit-btn` render path that
  fires inside the fullscreened element rather than only inside
  `inTabPresent`.
- The button label uses the existing `t('common.exitFullscreen')` key
  (already localized in 17 locales), so no i18n additions are needed
  here. If upstream renames that key, mirror the rename in this fix.
- The exit button reuses upstream's `.present-exit-btn` styling. If
  upstream removes the in-tab present mode (which is the only existing
  consumer), pin the CSS into this file's "Modified" list before
  removal.

## Test cases

Manual smoke (no automated coverage yet — adding a Vitest stub that
mocks `requestFullscreen` is feasible but jsdom does not implement the
Fullscreen API, so the listener path and overlay render need an e2e
harness with a real browser):

1. Open any HTML artifact in the project workspace.
2. Click **Present → Present fullscreen** in the toolbar.
3. Browser should enter native fullscreen.
4. A close (×) button should be visible at the top-right of the
   fullscreened content.
5. Click the × button → browser exits fullscreen, app chrome restored.
6. Re-enter native fullscreen via the same menu, then press **Esc** →
   fullscreen exits AND the overlay button unmounts in lock-step
   (no orphan button hanging around).
7. Repeat for a Live Artifact preview (LiveArtifactViewer code path).

## Verify

After re-applying or merging:

```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web test --run
```

Both should pass without regressions on FileViewer and PreviewModal
suites. The custom hunks are additive — they do not modify existing
exported APIs or test fixtures.
