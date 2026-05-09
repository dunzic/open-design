// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

// custom/005 — when the user enters native browser fullscreen via the
// Present > Present fullscreen menu, the FileViewer must render an in-app
// "Exit fullscreen" overlay button inside the fullscreened element. Without
// this, browser fullscreen leaves no visible affordance to shrink the view
// — Esc works but is not discoverable. The host mirrors
// `document.fullscreenElement` into React via a `fullscreenchange` listener
// (same pattern as PreviewModal.tsx, regression-pinned in
// preview-modal-fullscreen.test.tsx) so the click path and the keyboard
// path stay in lock-step.
//
// jsdom does not implement requestFullscreen on plain elements, so we
// drive the state machine by faking `document.fullscreenElement` and
// dispatching `fullscreenchange` ourselves — exactly what the browser does
// after a successful native transition.

function dispatchFullscreenChange() {
  act(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
}

function setNativeFullscreenElement(el: Element | null) {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => el,
  });
}

function htmlFile(): ProjectFile {
  return {
    name: 'page.html',
    path: 'page.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'page.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

describe('FileViewer HtmlViewer native fullscreen exit', () => {
  afterEach(() => {
    cleanup();
    setNativeFullscreenElement(null);
  });

  it('renders the .present-exit-btn overlay when fullscreenchange reports the viewer body is fullscreen', () => {
    const { container } = render(
      <FileViewer
        projectId="project-1"
        file={htmlFile()}
        liveHtml="<html><body>hi</body></html>"
      />,
    );

    // No native fullscreen yet — overlay must not be in the DOM.
    expect(container.querySelector('.present-exit-btn')).toBeNull();

    const viewerBody = container.querySelector('.viewer-body') as HTMLElement;
    expect(viewerBody).toBeTruthy();

    // Simulate the browser entering fullscreen on the viewer body.
    setNativeFullscreenElement(viewerBody);
    dispatchFullscreenChange();

    const exitBtn = container.querySelector(
      'button.present-exit-btn',
    ) as HTMLButtonElement | null;
    expect(exitBtn).toBeTruthy();
    // Reuses the existing common.exitFullscreen i18n key (17 locales).
    expect(exitBtn?.getAttribute('aria-label')).toBeTruthy();
  });

  it('drops the overlay when the browser exits fullscreen via Esc (state mirror, no click)', () => {
    const { container } = render(
      <FileViewer
        projectId="project-1"
        file={htmlFile()}
        liveHtml="<html><body>hi</body></html>"
      />,
    );

    const viewerBody = container.querySelector('.viewer-body') as HTMLElement;
    setNativeFullscreenElement(viewerBody);
    dispatchFullscreenChange();
    expect(container.querySelector('.present-exit-btn')).toBeTruthy();

    // User presses Esc — browser exits fullscreen and fires fullscreenchange
    // (in some browsers the keydown is consumed and never reaches JS, which
    // is exactly why the listener is the safety net).
    setNativeFullscreenElement(null);
    dispatchFullscreenChange();

    expect(container.querySelector('.present-exit-btn')).toBeNull();
  });

  it('calls document.exitFullscreen and clears the overlay on click', () => {
    const exitFullscreen = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });

    const { container } = render(
      <FileViewer
        projectId="project-1"
        file={htmlFile()}
        liveHtml="<html><body>hi</body></html>"
      />,
    );

    const viewerBody = container.querySelector('.viewer-body') as HTMLElement;
    setNativeFullscreenElement(viewerBody);
    dispatchFullscreenChange();
    const exitBtn = container.querySelector(
      'button.present-exit-btn',
    ) as HTMLButtonElement;
    expect(exitBtn).toBeTruthy();

    fireEvent.click(exitBtn);
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    // The click path also clears React state directly (no need to wait for
    // fullscreenchange), so the button unmounts immediately.
    expect(container.querySelector('.present-exit-btn')).toBeNull();
  });

  it('ignores fullscreenchange events for elements that are not the viewer body', () => {
    const { container } = render(
      <FileViewer
        projectId="project-1"
        file={htmlFile()}
        liveHtml="<html><body>hi</body></html>"
      />,
    );

    // Some other element on the page is the active fullscreen target — this
    // viewer's overlay must not appear on transitions that leave a different
    // element fullscreen (e.g. a native <video>).
    const other = document.createElement('div');
    document.body.appendChild(other);
    setNativeFullscreenElement(other);
    dispatchFullscreenChange();

    expect(container.querySelector('.present-exit-btn')).toBeNull();
    document.body.removeChild(other);
  });
});
