# 003 — Fork release workflow (downstream installer pipeline)

Status: Active
Date: 2026-05-09

## Why

Upstream's `release-stable.yml` and `release-beta.yml` workflows are
designed for `nexu-io/open-design`'s production release surface. They
hard-require:

- Cloudflare R2 credentials (`CLOUDFLARE_R2_RELEASES_AK/SK/BUCKET/URL`,
  `vars.CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN`) for asset publish + auto-update feeds.
- Apple developer signing certificate (`APPLE_SIGNING_CERTIFICATE_BASE64`)
  + notarization credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`).
- Windows EV signing setup.

The dunzic fork doesn't own those resources. Triggering the upstream
workflows fails immediately on the R2 access probe. We still need a
way to ship installers off the fork's `main` for downstream-only
features (custom/001 HTTP proxy, custom/002 system proxy detection,
future fork-only patches).

## What

A **separate** workflow (`.github/workflows/release-fork.yml`) that:

1. Builds installers via the existing `pnpm tools-pack {mac,win,linux}
   build` commands the upstream pipeline already uses.
2. Skips Cloudflare R2 publish entirely — no R2 access probe, no feed
   upload, no `vars.CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN` reference.
3. Skips code signing / notarization. The resulting `.dmg`, NSIS `.exe`,
   and `.AppImage` are unsigned. End users get one Gatekeeper /
   SmartScreen warning on first launch.
4. Attaches all installers to a GitHub Release on this fork at tag
   `fork-vX.Y.Z`, kept as draft by default so a human can flip it
   public after a smoke test.
5. Is `workflow_dispatch`-only with explicit per-platform toggles.

The upstream workflows (`release-stable.yml`, `release-beta.yml`) are
left untouched so future merges from upstream stay clean — they simply
remain unusable on this fork until R2 + signing secrets exist.

## Added

- `.github/workflows/release-fork.yml`

## Modified

(none — this is a pure addition)

## Re-apply notes

- If upstream lands a `release-fork.yml` of their own (unlikely — it's
  a fork-shaped concern), promote this requirement to **superseded**
  and adopt theirs.
- If upstream renames the `tools-pack` CLI surface (e.g. flag changes
  on `--to nsis` / `--to dmg` / `--to appimage` / `--portable` /
  `--containerized`), update the build steps in `release-fork.yml` to
  match. The build commands here mirror `release-stable.yml` so
  diffing the two on a future sync is the fastest way to find drift.
- The `--containerized` flag for Linux relies on `electronuserland/builder`
  Docker image; GitHub-hosted ubuntu runners ship Docker so no extra
  setup. If upstream switches glibc strategy, mirror the change here.

## Verify

After triggering the workflow with a test version (e.g.
`0.5.1-fork.smoke`):

1. Each enabled platform job ends with a `release-fork-<os>` artifact
   containing the installer file(s).
2. The final `release` job creates / updates the
   `fork-v0.5.1-fork.smoke` GitHub Release on
   `https://github.com/dunzic/open-design`.
3. Download each installer and confirm it launches (Gatekeeper /
   SmartScreen prompts are expected and not a failure).

## Not tracked here

- Signing certificates / notarization — out of scope until the fork
  decides to invest in code-signing infrastructure.
- Auto-update feed — without R2 (or another asset host) there's
  nowhere to publish the YAML feed electron-builder consumes; the fork
  ships installers as one-shot downloads only.
