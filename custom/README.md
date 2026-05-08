# Custom Requirements (downstream fork)

This directory tracks every local-only change applied on top of upstream
`git@github.com:nexu-io/open-design.git`. The goal is to make `git merge` from upstream
predictable: when conflicts hit a tracked file we already touched, this
folder tells you why we touched it and how to re-apply.

## Conventions

- One Markdown file per discrete requirement / session, prefixed with a
  three-digit serial. Keep them small and self-contained.
- Each file lists the file paths it touched (under "Modified" / "Added"),
  short rationale, and a "Re-apply notes" section for when an upstream
  rewrite blows the change away.
- Cross-cutting state (e.g. `.env`, `docker-compose.yml`) is mentioned in
  every requirement that touched it — so a search inside this directory
  surfaces all the reasons a tracked file diverges from upstream.

## Index

| #   | Title | Date | Status |
| --- | ----- | ---- | ------ |
| 001 | [Daemon respects host HTTP_PROXY / HTTPS_PROXY](001-daemon-http-proxy-env.md) | 2026-05-08 | Active |
| 002 | [Daemon detects OS system proxy (Windows registry / macOS scutil)](002-daemon-system-proxy-detection.md) | 2026-05-08 | Active |


## Merge policy — **三原则**

When merging from upstream (nexu-io/open-design ), apply these three
principles in order. They resolve every routine merge decision; anything
that doesn't fit gets escalated as a new `custom/NNN-*.md` requirement.

### 1. 私有化定制优先 (ours wins on conflict)

For any file listed under "Modified" in a `custom/NNN-*.md`, **conflicts
resolve to the local side**. Upstream's version of that hunk is reviewed
but not applied — the customization is the contract, and upstream
improvements are opt-in additions on top of it.

```bash
# inside an in-progress merge, for each documented conflicting file:
git checkout --ours <path>
git add <path>
```

If the conflict reveals that upstream already implements the same intent
in a better way (e.g. the customization is now obsolete or strictly
inferior), demote the requirement to **superseded** in its `NNN-*.md`
file before deciding to drop the local hunk.

### 2. 上游新功能直接吸收 (absorb new upstream features)

Files NOT mentioned in any `custom/NNN-*.md` take upstream's version
without question — even when the new feature is one we don't need today.
This keeps the fork close to upstream so future syncs stay cheap, and
forward-compatible additions (new tables, new API endpoints, new
frontend modules) are immediately available if a customization later
wants to build on them.

### 3. 每次合并必须验证 (verify after every merge)

After resolving conflicts and before declaring the merge done, run the
**post-merge self-test**:

```bash
# 没有的话需要按项目新建
./custom/post-merge-check.sh
```

It chains:   《首次项目需要进行项目盘点建立路线》.

Then run each customization's per-NNN verification block (e.g. the
runtime self-heal smoke test .

### Pre-merge survey

Before pulling, confirm what's locally divergent:

```bash
# files we've intentionally diverged
# 《首次项目需要进行按需替换》
git diff  
git log --oneline main..origin/main      # what's coming
git log --oneline origin/main..main      # what's local-only
```

## What's NOT tracked here  《首次项目需要进行按需替换》

- `.env` — gitignored (contains secrets). Diverged values are documented
  per-requirement, so a fresh checkout can be reproduced from the docs.
- `~/.open-design/` — daemon profile state, lives outside the repo.
- `~/open-design-backups/` — pgBackRest repo (data files), lives outside the
  repo.
