import type { OkResponse } from '../common.js';

export type PreviewCommentStatus =
  | 'open'
  | 'attached'
  | 'applying'
  | 'needs_review'
  | 'resolved'
  | 'failed';

export interface PreviewCommentPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PreviewCommentSelectionKind = 'element' | 'pod';

export interface PreviewCommentMember {
  elementId: string;
  selector: string;
  label: string;
  text: string;
  position: PreviewCommentPosition;
  htmlHint: string;
}

// Fork-only (custom/007): identifier provenance for this target.
//   - 'stable':       the artifact authored a `data-od-id` attribute.
//   - 'screen-label': the artifact authored a `data-screen-label`.
//   - 'auto':         the iframe selection bridge synthesized a
//                     `data-od-auto-id` because the artifact lacks any
//                     stable annotation. The selector points at an
//                     attribute that does NOT exist in the source file
//                     — the agent must locate the element via outerHtml
//                     instead. Auto-ids are regenerated on every srcdoc
//                     rebuild, so they work for one-shot Picker / Pods
//                     attachments only; Inspect overrides + saved
//                     comments refuse to persist them.
export type PreviewCommentIdKind = 'stable' | 'screen-label' | 'auto';

export interface PreviewCommentTarget {
  filePath: string;
  elementId: string;
  selector: string;
  label: string;
  text: string;
  position: PreviewCommentPosition;
  htmlHint: string;
  selectionKind?: PreviewCommentSelectionKind;
  memberCount?: number;
  podMembers?: PreviewCommentMember[];
  // Fork-only (custom/007).
  idKind?: PreviewCommentIdKind;
  outerHtml?: string;
}

export interface PreviewComment {
  id: string;
  projectId: string;
  conversationId: string;
  filePath: string;
  elementId: string;
  selector: string;
  label: string;
  text: string;
  position: PreviewCommentPosition;
  htmlHint: string;
  selectionKind?: PreviewCommentSelectionKind;
  memberCount?: number;
  podMembers?: PreviewCommentMember[];
  note: string;
  status: PreviewCommentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface PreviewCommentUpsertRequest {
  target: PreviewCommentTarget;
  note: string;
}

export interface PreviewCommentStatusRequest {
  status: PreviewCommentStatus;
}

export interface PreviewCommentResponse {
  comment: PreviewComment;
}

export interface PreviewCommentsResponse {
  comments: PreviewComment[];
}

export interface PreviewCommentDeleteResponse extends OkResponse {}
