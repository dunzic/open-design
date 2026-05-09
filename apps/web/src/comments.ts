import type {
  ChatCommentAttachment,
  ChatMessage,
  PreviewCommentIdKind,
  PreviewCommentMember,
  PreviewComment,
  PreviewCommentSelectionKind,
  PreviewCommentTarget,
} from './types';

export interface PreviewCommentSnapshot {
  filePath: string;
  elementId: string;
  selector: string;
  label: string;
  text: string;
  position: { x: number; y: number; width: number; height: number };
  htmlHint: string;
  selectionKind?: PreviewCommentSelectionKind;
  memberCount?: number;
  podMembers?: PreviewCommentMember[];
  // Fork-only (custom/007). When idKind === 'auto' the selector is a
  // synthetic data-od-auto-id from the iframe selection bridge, so the
  // popover renders a "synthetic locator" affordance and the chat
  // attachment renderer falls back to outerHtml-based location.
  idKind?: PreviewCommentIdKind;
  outerHtml?: string;
}

export interface CommentOverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function targetFromSnapshot(snapshot: PreviewCommentSnapshot): PreviewCommentTarget {
  const podMembers = normalizeMembers(snapshot.podMembers);
  return {
    filePath: snapshot.filePath,
    elementId: snapshot.elementId,
    selector: snapshot.selector,
    label: snapshot.label,
    text: trimContextText(snapshot.text),
    position: normalizePosition(snapshot.position),
    htmlHint: trimHtmlHint(snapshot.htmlHint),
    selectionKind: snapshot.selectionKind === 'pod' ? 'pod' : 'element',
    memberCount:
      snapshot.selectionKind === 'pod'
        ? (podMembers.length > 0
            ? podMembers.length
            : Number.isFinite(snapshot.memberCount)
              ? Math.round(snapshot.memberCount as number)
              : 0)
        : undefined,
    podMembers: podMembers.length > 0 ? podMembers : undefined,
    idKind: snapshot.idKind,
    outerHtml: trimOuterHtml(snapshot.outerHtml),
  };
}

export function overlayBoundsFromSnapshot(
  snapshot: PreviewCommentSnapshot,
  scale: number,
): CommentOverlayBounds {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const position = normalizePosition(snapshot.position);
  return {
    left: position.x * safeScale,
    top: position.y * safeScale,
    width: Math.max(1, position.width * safeScale),
    height: Math.max(1, position.height * safeScale),
  };
}

export function liveSnapshotForComment(
  comment: PreviewComment,
  snapshots: Map<string, PreviewCommentSnapshot>,
): PreviewCommentSnapshot | null {
  const snapshot = snapshots.get(comment.elementId);
  if (!snapshot || snapshot.filePath !== comment.filePath) return null;
  return snapshot;
}

export function commentToAttachment(
  comment: PreviewComment,
  order: number,
): ChatCommentAttachment {
  const podMembers = normalizeMembers(comment.podMembers);
  // Saved comments always have stable identifiers — the host refuses
  // to call onSavePreviewComment when a snapshot's idKind is 'auto'
  // (per Save-comment guard in FileViewer's BoardComposerPopover).
  // Force idKind to 'stable' for safety so the chat attachment renderer
  // never emits synthetic-locator scaffolding for persisted entries.
  return {
    id: comment.id,
    order,
    filePath: comment.filePath,
    elementId: comment.elementId,
    selector: comment.selector,
    label: comment.label,
    comment: comment.note,
    currentText: trimContextText(comment.text),
    pagePosition: normalizePosition(comment.position),
    htmlHint: trimHtmlHint(comment.htmlHint),
    selectionKind: comment.selectionKind === 'pod' ? 'pod' : 'element',
    memberCount:
      comment.selectionKind === 'pod'
        ? (podMembers.length > 0
            ? podMembers.length
            : typeof comment.memberCount === 'number'
              ? Math.round(comment.memberCount)
              : 0)
        : undefined,
    podMembers: podMembers.length > 0 ? podMembers : undefined,
    source: 'saved-comment',
    idKind: 'stable',
  };
}

export function commentsToAttachments(comments: PreviewComment[]): ChatCommentAttachment[] {
  return comments.map((comment, index) => commentToAttachment(comment, index + 1));
}

export function buildBoardCommentAttachments(input: {
  target: PreviewCommentTarget;
  notes: string[];
}): ChatCommentAttachment[] {
  const podMembers = normalizeMembers(input.target.podMembers);
  const selectionKind = input.target.selectionKind === 'pod' ? 'pod' : 'element';
  const memberCount =
    selectionKind === 'pod'
      ? (podMembers.length > 0
          ? podMembers.length
          : typeof input.target.memberCount === 'number'
            ? Math.round(input.target.memberCount)
            : 0)
      : undefined;
  return input.notes
    .map((note) => note.trim())
    .filter(Boolean)
    .map((note, index) => ({
      id: `${input.target.elementId}-board-${index + 1}`,
      order: index + 1,
      filePath: input.target.filePath,
      elementId: input.target.elementId,
      selector: input.target.selector,
      label: input.target.label,
      comment: note,
      currentText: trimContextText(input.target.text),
      pagePosition: normalizePosition(input.target.position),
      htmlHint: trimHtmlHint(input.target.htmlHint),
      selectionKind,
      memberCount,
      podMembers: podMembers.length > 0 ? podMembers : undefined,
      source: 'board-batch',
      idKind: input.target.idKind,
      outerHtml: trimOuterHtml(input.target.outerHtml),
    }));
}

export function messageContentWithCommentAttachments(
  content: string,
  commentAttachments: ChatCommentAttachment[],
): string {
  if (commentAttachments.length === 0) return content;
  const visibleContent = content.trim() || '(No extra typed instruction.)';
  return `${visibleContent}${renderCommentAttachmentContext(commentAttachments)}`;
}

export function historyWithCommentAttachmentContext(
  history: ChatMessage[],
  messageId: string,
): ChatMessage[] {
  return history.map((message) => {
    const commentAttachments = message.commentAttachments ?? [];
    if (message.id !== messageId || message.role !== 'user' || commentAttachments.length === 0) return message;
    return {
      ...message,
      content: messageContentWithCommentAttachments(message.content, commentAttachments),
    };
  });
}

export function mergeAttachedComments(
  current: PreviewComment[],
  next: PreviewComment,
): PreviewComment[] {
  const byId = new Map(current.map((comment) => [comment.id, comment]));
  byId.set(next.id, next);
  return Array.from(byId.values());
}

export function removeAttachedComment(
  current: PreviewComment[],
  commentId: string,
): PreviewComment[] {
  return current.filter((comment) => comment.id !== commentId);
}

export function simplePositionLabel(position: PreviewComment['position']): string {
  const normalized = normalizePosition(position);
  return `x${normalized.x} y${normalized.y}`;
}

export function selectionKindLabel(
  selectionKind: PreviewCommentSelectionKind | undefined,
  memberCount?: number,
): string {
  if (selectionKind === 'pod') {
    return memberCount && memberCount > 0 ? `Pod · ${memberCount} items` : 'Pod';
  }
  return 'Element';
}

export function trimContextText(value: string): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function trimHtmlHint(value: string): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

// Fork-only (custom/007). The bridge already caps outerHtml at 1500 chars
// — this normalization mirrors trimHtmlHint so the chat attachment block
// stays line-bounded even if a future bridge change relaxes the cap.
export function trimOuterHtml(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.length > 1500 ? `${collapsed.slice(0, 1497)}...` : collapsed;
}

function renderCommentAttachmentContext(commentAttachments: ChatCommentAttachment[]): string {
  const lines = [
    '',
    '',
    '<attached-preview-comments>',
    'Scope: apply the user request to the attached preview target by default. Preserve unrelated elements.',
  ];
  // Fork-only (custom/007): if any attachment uses a synthetic locator
  // (the in-memory data-od-auto-id minted by the iframe selection
  // bridge for unannotated artifacts), emit a one-time agent guidance
  // header so the model knows to look at outerHtml instead of trying
  // to find the selector in source. The header sits above the
  // per-target list so the model reads it first.
  const hasSynthetic = commentAttachments.some((item) => item.idKind === 'auto');
  if (hasSynthetic) {
    lines.push(
      'Locator note: targets marked `idKind: auto` carry a synthetic `data-od-auto-id` that is NOT present in the source file. Locate those elements in source via the `outerHtml` block (matching tag + attributes + inner content), NOT by searching for the selector. Do not write the auto-id back to source.',
    );
  }
  commentAttachments.forEach((item) => {
    const position = normalizePosition(item.pagePosition);
    const selectionKind = item.selectionKind === 'pod' ? 'pod' : 'element';
    const idKind = item.idKind ?? 'stable';
    lines.push(
      '',
      `${item.order}. ${item.elementId}`,
      `targetKind: ${selectionKind}`,
      `idKind: ${idKind}`,
      `file: ${item.filePath}`,
      `selector: ${item.selector}`,
      `label: ${item.label || '(unlabeled)'}`,
      `position: x${position.x} y${position.y} ${position.width}x${position.height}`,
      `currentText: ${trimContextText(item.currentText || '') || '(empty)'}`,
      `htmlHint: ${trimHtmlHint(item.htmlHint || '') || '(none)'}`,
      `comment: ${item.comment}`,
    );
    // Synthetic locators: emit the full outerHtml snippet as a separate
    // line block so the agent has substring text to match against
    // source. We do NOT split this into multiple lines — outerHtml
    // already had its whitespace collapsed in trimOuterHtml.
    if (idKind === 'auto') {
      const outer = trimOuterHtml(item.outerHtml ?? '');
      if (outer) {
        lines.push(`outerHtml: ${outer}`);
      } else {
        lines.push('outerHtml: (unavailable — fall back to currentText + htmlHint)');
      }
    }
    if (selectionKind === 'pod') {
      lines.push(`memberCount: ${item.memberCount || item.podMembers?.length || 0}`);
      (item.podMembers ?? []).slice(0, 8).forEach((member, memberIndex) => {
        lines.push(
          `member.${memberIndex + 1}: ${member.elementId} | ${member.label || '(unlabeled)'} | ${member.selector}`,
        );
      });
    }
  });
  lines.push('</attached-preview-comments>');
  return lines.join('\n');
}

function normalizePosition(input: PreviewComment['position']): PreviewComment['position'] {
  return {
    x: finite(input?.x),
    y: finite(input?.y),
    width: finite(input?.width),
    height: finite(input?.height),
  };
}

function finite(value: number | undefined): number {
  return Number.isFinite(value) ? Math.round(value as number) : 0;
}

function normalizeMembers(input: PreviewCommentMember[] | undefined): PreviewCommentMember[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((member) => ({
      elementId: String(member.elementId || '').trim(),
      selector: String(member.selector || '').trim(),
      label: String(member.label || '').trim(),
      text: trimContextText(String(member.text || '')),
      position: normalizePosition(member.position),
      htmlHint: trimHtmlHint(String(member.htmlHint || '')),
    }))
    .filter((member) => member.elementId && member.selector);
}
