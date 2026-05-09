import { describe, expect, it } from 'vitest';
import {
  buildBoardCommentAttachments,
  commentsToAttachments,
  messageContentWithCommentAttachments,
  targetFromSnapshot,
} from '../src/comments';
import type { PreviewComment } from '../src/types';

// Fork-only (custom/007). Pin the chat-attachment renderer behavior
// for synthetic locators (idKind === 'auto'). The bridge synthesizes
// these when Tweaks runs on an artifact that lacks data-od-id /
// data-screen-label, and the host has to thread idKind + outerHtml
// all the way to the `<attached-preview-comments>` block sent to the
// agent. Without these signals the agent would search the source for
// a [data-od-auto-id="..."] selector that does not exist there.

describe('synthetic-locator attachments (custom/007)', () => {
  it('preserves idKind and outerHtml when threading a snapshot to a target', () => {
    const target = targetFromSnapshot({
      filePath: 'page.html',
      elementId: 'auto-7',
      selector: '[data-od-auto-id="auto-7"]',
      label: 'button.cta-primary',
      text: 'Get Started',
      position: { x: 100, y: 200, width: 160, height: 48 },
      htmlHint: '<button class="cta-primary">',
      idKind: 'auto',
      outerHtml: '<button class="cta-primary">Get Started</button>',
    });

    expect(target.idKind).toBe('auto');
    expect(target.outerHtml).toBe('<button class="cta-primary">Get Started</button>');
  });

  it('emits a "Locator note" header and an outerHtml line for synthetic targets', () => {
    const attachments = buildBoardCommentAttachments({
      target: {
        filePath: 'page.html',
        elementId: 'auto-3',
        selector: '[data-od-auto-id="auto-3"]',
        label: 'h1',
        text: 'Welcome to Acme',
        position: { x: 10, y: 20, width: 480, height: 64 },
        htmlHint: '<h1>',
        idKind: 'auto',
        outerHtml: '<h1>Welcome to Acme</h1>',
      },
      notes: ['Make this title 20% smaller'],
    });

    const content = messageContentWithCommentAttachments('', attachments);

    expect(content).toContain('Locator note: targets marked `idKind: auto`');
    expect(content).toContain('idKind: auto');
    expect(content).toContain('outerHtml: <h1>Welcome to Acme</h1>');
    // The agent guidance must instruct outerHtml-based location
    // explicitly; if a future renderer regresses we want this to fail
    // before silently shipping confusing prompts.
    expect(content).toMatch(/Locate those elements in source via the `outerHtml`/);
  });

  it('omits the "Locator note" header when every attachment uses a stable id', () => {
    const attachments = buildBoardCommentAttachments({
      target: {
        filePath: 'page.html',
        elementId: 'hero-title',
        selector: '[data-od-id="hero-title"]',
        label: 'h1.hero-title',
        text: 'Welcome',
        position: { x: 0, y: 0, width: 320, height: 48 },
        htmlHint: '<h1 data-od-id="hero-title">',
        idKind: 'stable',
      },
      notes: ['Tighter type please'],
    });

    const content = messageContentWithCommentAttachments('', attachments);

    expect(content).toContain('idKind: stable');
    expect(content).not.toContain('Locator note:');
    expect(content).not.toMatch(/^outerHtml:/m);
  });

  it('falls back to a placeholder line when an auto-id attachment is missing outerHtml', () => {
    // The bridge only emits empty outerHtml when something throws while
    // serializing — we still want a deterministic chat block so the
    // agent sees a clear "fall back to other hints" signal instead of
    // a missing field that's easy to miss.
    const attachments = buildBoardCommentAttachments({
      target: {
        filePath: 'page.html',
        elementId: 'auto-9',
        selector: '[data-od-auto-id="auto-9"]',
        label: 'div',
        text: 'Pricing',
        position: { x: 0, y: 0, width: 200, height: 60 },
        htmlHint: '<div class="pricing">',
        idKind: 'auto',
        outerHtml: undefined,
      },
      notes: ['Move below testimonials'],
    });

    const content = messageContentWithCommentAttachments('', attachments);

    expect(content).toContain('outerHtml: (unavailable — fall back to currentText + htmlHint)');
  });

  it('forces saved comments through the stable codepath even if a stale snapshot lingered', () => {
    // Saved comments should never carry idKind=auto in their persisted
    // shape (the host's Save-comment guard refuses synthetic targets),
    // but commentToAttachment hard-codes idKind to 'stable' as a
    // belt-and-braces safety net. Pin that.
    const attachments = commentsToAttachments([
      {
        id: 's1',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        filePath: 'page.html',
        elementId: 'hero-title',
        selector: '[data-od-id="hero-title"]',
        label: 'h1.hero-title',
        text: 'Welcome',
        position: { x: 0, y: 0, width: 320, height: 48 },
        htmlHint: '<h1 data-od-id="hero-title">',
        note: 'Make it bolder',
        status: 'open',
        createdAt: 1,
        updatedAt: 1,
      } satisfies PreviewComment,
    ]);

    expect(attachments[0]?.idKind).toBe('stable');
    expect(messageContentWithCommentAttachments('', attachments)).not.toContain('Locator note:');
  });
});
