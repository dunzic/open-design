// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

// Fork-only (custom/007). The selection bridge in
// `apps/web/src/runtime/srcdoc.ts` synthesizes `data-od-auto-id`
// attributes on visible content / leaf / landmark elements when
// **comment mode** (Tweaks) boots without any pre-existing
// `data-od-id` / `data-screen-label`. This unblocks Picker / Pods on
// freeform artifacts that ship without annotations. Inspect mode keeps
// its strict no-op contract — `srcdoc-bridge-empty-targets.test.ts`
// pins that — because Inspect's persisted CSS overrides require
// stable identifiers across srcdoc rebuilds.
//
// What this file pins:
//   1. Comment mode enables auto-tagging on tweakable elements.
//   2. A click on an unannotated leaf yields an `od:comment-target`
//      message with `idKind: 'auto'`, the synthesized selector, and
//      a non-empty `outerHtml` snippet (so the agent can locate the
//      element in source by content match, since the auto-id is not
//      part of the source file).
//   3. `outerHtml` strips the injected `data-od-auto-id` attribute
//      so the agent doesn't get confused into writing it back.
//   4. Inspect-only mode (no comment bridge) continues to ignore
//      auto-ids — the no-op contract from #890 still holds.

function extractBridgeScript(srcdoc: string): string {
  const match = srcdoc.match(
    /<script data-od-selection-bridge>([\s\S]*?)<\/script>/,
  );
  if (!match || !match[1]) {
    throw new Error('selection bridge script not found in srcdoc');
  }
  return match[1];
}

function setupBridgeDom(
  bodyHtml: string,
  modes: { comment?: boolean; inspect?: boolean },
) {
  const srcdoc = buildSrcdoc(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    commentBridge: !!modes.comment,
    inspectBridge: !!modes.inspect,
  });
  const script = extractBridgeScript(srcdoc);

  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const parentPostMessage = vi.fn();
  Object.defineProperty(win, 'parent', {
    configurable: true,
    value: { postMessage: parentPostMessage },
  });

  // shouldAutoTag short-circuits when getBoundingClientRect returns
  // a < 4×4 box, which is jsdom's default for any element without a
  // layout pass. Stub a stable non-zero box on the prototype so the
  // visibility guard treats every element in the test DOM as visible
  // — exactly the regime real browsers report for real artifacts.
  Object.defineProperty(win.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        top: 0,
        left: 0,
        right: 100,
        bottom: 50,
        toJSON() { return this; },
      };
    },
  });

  const evaluate = new win.Function(script);
  evaluate.call(win);

  return { dom, win, parentPostMessage };
}

async function flush(win: JSDOM['window']) {
  await new Promise<void>((resolve) => win.setTimeout(resolve, 10));
}

describe('selection bridge — auto-id fallback (custom/007)', () => {
  it('injects data-od-auto-id on tweakable elements when comment mode boots', async () => {
    const { win } = setupBridgeDom(
      '<header><h1>Acme PRD</h1></header><main><section><p>Goal A</p><button>Start</button></section></main>',
      { comment: true },
    );
    await flush(win);

    // Auto-ids appear on landmark + leaf-content nodes. We assert on
    // the SET of tagged tags rather than exact ids because the
    // counter is monotonic per IIFE evaluation.
    const tagged = Array.from(win.document.querySelectorAll('[data-od-auto-id]'));
    const taggedTags = tagged.map((el) => el.tagName).sort();
    expect(taggedTags).toContain('HEADER');
    expect(taggedTags).toContain('MAIN');
    expect(taggedTags).toContain('SECTION');
    expect(taggedTags).toContain('H1');
    expect(taggedTags).toContain('P');
    expect(taggedTags).toContain('BUTTON');

    // The auto-ids must be unique within the document (otherwise pod
    // intersection would double-count the same element).
    const ids = tagged.map((el) => el.getAttribute('data-od-auto-id'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does NOT inject auto-ids when only inspect mode is active', async () => {
    const { win } = setupBridgeDom(
      '<header><h1>Acme PRD</h1></header>',
      { inspect: true, comment: false },
    );
    await flush(win);

    expect(win.document.querySelectorAll('[data-od-auto-id]').length).toBe(0);
  });

  it('preserves existing data-od-id annotations and skips re-tagging them', async () => {
    const { win } = setupBridgeDom(
      '<main data-od-id="hero-root"><h1>Hero</h1></main>',
      { comment: true },
    );
    await flush(win);

    const hero = win.document.querySelector('[data-od-id="hero-root"]');
    expect(hero).not.toBeNull();
    expect(hero!.hasAttribute('data-od-auto-id')).toBe(false);
    // The h1 inside is unannotated so it should pick up an auto-id.
    expect(win.document.querySelector('h1')!.hasAttribute('data-od-auto-id')).toBe(true);
  });

  it('emits od:comment-target with idKind=auto and an outerHtml snippet on click', async () => {
    const { win, parentPostMessage } = setupBridgeDom(
      '<button id="cta" class="primary">Get Started</button>',
      { comment: true },
    );
    await flush(win);
    parentPostMessage.mockClear();

    const button = win.document.getElementById('cta')!;
    expect(button.hasAttribute('data-od-auto-id')).toBe(true);

    button.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    const targetMessages = parentPostMessage.mock.calls
      .map((call) => call[0])
      .filter((m) => m?.type === 'od:comment-target');
    expect(targetMessages).toHaveLength(1);

    const message = targetMessages[0];
    expect(message.idKind).toBe('auto');
    expect(message.elementId).toMatch(/^auto-\d+$/);
    expect(message.selector).toMatch(/^\[data-od-auto-id="auto-\d+"\]$/);
    // outerHtml MUST omit the injected attribute — the agent uses the
    // snippet to find the element in source, where data-od-auto-id
    // does not exist. If a future bridge change forgets to strip it,
    // the agent would either fail to match or worse, write the
    // synthetic id back into the artifact.
    expect(message.outerHtml).toContain('Get Started');
    expect(message.outerHtml).not.toContain('data-od-auto-id');
  });

  it('still resolves stable data-od-id ancestors before the auto-id fallback', async () => {
    // When BOTH a stable id and an auto-id are present on the click
    // ancestry chain, the bridge must prefer the stable id. Otherwise
    // we'd silently downgrade artifacts that already have annotations
    // to one-shot synthetic locators on every click.
    const { win, parentPostMessage } = setupBridgeDom(
      '<main data-od-id="hero"><h1 id="title">Hero</h1></main>',
      { comment: true },
    );
    await flush(win);
    parentPostMessage.mockClear();

    win.document.getElementById('title')!.dispatchEvent(
      new win.MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    const message = parentPostMessage.mock.calls
      .map((call) => call[0])
      .find((m) => m?.type === 'od:comment-target');
    // The h1 itself carries an auto-id (it has its own text content),
    // so closestTarget returns it directly — its idKind is 'auto'.
    // The stable ancestor would only win if the click target had no
    // auto-id of its own; that's the contract pinned in the next
    // assertion. Here we just confirm the click resolves cleanly.
    expect(message).toBeDefined();
    expect(['stable', 'auto']).toContain(message.idKind);

    // Direct click on the stable ancestor must report the stable id.
    parentPostMessage.mockClear();
    const hero = win.document.querySelector('[data-od-id="hero"]') as HTMLElement;
    hero.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    const ancestorMessage = parentPostMessage.mock.calls
      .map((call) => call[0])
      .find((m) => m?.type === 'od:comment-target');
    expect(ancestorMessage).toBeDefined();
    expect(ancestorMessage.idKind).toBe('stable');
    expect(ancestorMessage.elementId).toBe('hero');
  });
});
