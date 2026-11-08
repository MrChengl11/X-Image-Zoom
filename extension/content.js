/**
 * X Pic Zoom
 *
 * Adds mouse-wheel zoom to the full-screen photo viewer on x.com / twitter.com.
 *
 * Design notes:
 * - X currently renders the photo viewer two ways. The "classic" client paints
 *   the photo with a visible background-image layer while the <img> is
 *   transparent; the newer x-web client uses a real visible <img>. This script
 *   resolves whichever element actually paints the pixels and transforms that
 *   one.
 * - The viewer is accepted only on a tweet photo route
 *   (/<user>/status/<id>/photo/<n>) or below X's own
 *   data-testid="swipe-to-dismiss" layer. That keeps compose, crop and profile
 *   photo viewers (which have their own zoom behaviour) untouched.
 * - Zoom is an inline transform anchored under the cursor. At scale 1 every
 *   inline style change is undone. Classic viewers clip the photo in inner
 *   wrappers, so those wrappers get overflow:visible only while zoomed and are
 *   restored afterwards.
 * - While zoomed, dragging with the primary mouse button pans the photo. At
 *   scale 1 all pointer events are left untouched so X's own gestures (close,
 *   carousel, touch pinch/swipe) keep working.
 * - The non-passive wheel listener is attached to the viewer layer only, not
 *   to the window, so normal timeline scrolling keeps the compositor fast path.
 *   A passive site-wide fallback handles the first wheel if the viewer appears
 *   under a stationary cursor before pointerover installed the scoped handler.
 * - No permissions, storage, network access, or UI.
 */
(() => {
  'use strict';

  if (window.__xPicZoomInstalled) return;
  window.__xPicZoomInstalled = true;

  const MIN_SCALE = 1;
  const MAX_SCALE = 8;
  const WHEEL_ZOOM_SPEED = 0.0015;
  const MIN_WHEEL_FACTOR = 0.8;
  const MAX_WHEEL_FACTOR = 1.25;
  const DRAG_THRESHOLD = 3;
  const CLICK_SUPPRESS_MS = 350;

  /**
   * @type {Map<HTMLElement, {
   *   scale: number,
   *   tx: number,
   *   ty: number,
   *   src: string,
   *   kind: 'image' | 'background',
   *   original: Array<{property: string, value: string, priority: string}> | null,
   *   unlocked: Array<{
   *     element: HTMLElement,
   *     styles: Array<{property: string, value: string, priority: string}>
   *   }> | null,
   *   dragging: boolean
   * }>}
   */
  const states = new Map();

  // Surfaces that currently have a non-identity transform. Pointer handlers
  // bail out immediately when this is empty, so normal X clicks stay cheap.
  const zoomedSurfaces = new Set();

  let visibilityObserver = null;
  let drag = null;
  let suppressClickUntil = 0;
  let suppressClickTimer = 0;

  /** @param {Event} event */
  function consume(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function hasNonIdentityTransform(element) {
    const transform = getComputedStyle(element).transform;
    if (!transform || transform === 'none') return false;

    try {
      const matrix = new DOMMatrixReadOnly(transform);
      return !(
        matrix.a === 1 &&
        matrix.b === 0 &&
        matrix.c === 0 &&
        matrix.d === 1 &&
        matrix.e === 0 &&
        matrix.f === 0
      );
    } catch {
      return true;
    }
  }

  function rectContains(rect, x, y) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function isMediaUrl(url) {
    return typeof url === 'string' && url.includes('pbs.twimg.com/media/');
  }

  function isVisibleImage(img) {
    if (!(img instanceof HTMLImageElement) || !img.isConnected) return false;
    if (img.getAttribute('aria-hidden') === 'true') return false;
    if (!isMediaUrl(img.currentSrc || img.src)) return false;

    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;

    const style = getComputedStyle(img);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0
    );
  }

  function elementCoversPoint(element, x, y) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || !rectContains(rect, x, y)) {
      return false;
    }
    const style = getComputedStyle(element);
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      Number(style.opacity) > 0
    );
  }

  function coversMostOfViewport(rect) {
    return rect.width >= innerWidth * 0.6 && rect.height >= innerHeight * 0.6;
  }

  function photoRouteKey(pathname) {
    // Also matches /i/web/status/<id>/photo/<n>.
    const match = pathname.match(/\/status\/([^/]+)\/photo\/(\d+)\/?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  }

  function isTweetPhotoRoute() {
    return photoRouteKey(location.pathname) !== null;
  }

  /**
   * Returns the dialog/overlay that owns an element, if it looks like a
   * supported photo viewer layer.
   * @returns {Element | null}
   */
  function viewerRootFor(element) {
    if (!(element instanceof Element)) return null;

    // X's own photo viewer hook (React Native Web testID). Classic clients
    // use it on every carousel slide.
    const swipeLayer = element.closest('[data-testid="swipe-to-dismiss"]');
    if (swipeLayer) return swipeLayer;

    let node = element;
    for (let depth = 0; node && depth < 20; depth += 1, node = node.parentElement) {
      if (node.matches('[role="dialog"], [aria-modal="true"]')) {
        // Only the tweet photo route is in scope. In particular, x-web's
        // profile-photo viewer (/<user>/photo) has native wheel zoom already.
        if (!isTweetPhotoRoute()) return null;
        if (coversMostOfViewport(node.getBoundingClientRect())) return node;
        // A small dialog can be a control popover inside a full-screen
        // viewer; keep walking and let a qualifying fixed ancestor win.
        continue;
      }

      const style = getComputedStyle(node);
      if (style.position !== 'fixed') continue;

      if (!isTweetPhotoRoute()) return null;
      if (coversMostOfViewport(node.getBoundingClientRect())) {
        return node;
      }
    }
    return null;
  }

  function isCandidateImage(img, x, y) {
    return (
      img instanceof HTMLImageElement &&
      !img.closest('article') &&
      isVisibleImage(img) &&
      viewerRootFor(img) !== null &&
      rectContains(img.getBoundingClientRect(), x, y)
    );
  }

  function isBackgroundSurface(element, x, y) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    if (element.closest('article')) return false;

    const background =
      element.style.backgroundImage || getComputedStyle(element).backgroundImage;
    if (!isMediaUrl(background)) return false;
    return elementCoversPoint(element, x, y);
  }

  function hasVideoAbove(stack, index, root, x, y) {
    for (let above = 0; above < index; above += 1) {
      const upper = stack[above];
      if (
        upper instanceof HTMLVideoElement &&
        root.contains(upper) &&
        elementCoversPoint(upper, x, y)
      ) {
        return true;
      }
    }
    return false;
  }

  function hasCoveringVideoIn(root, x, y) {
    for (const video of root.querySelectorAll('video')) {
      if (elementCoversPoint(video, x, y)) return true;
    }
    return false;
  }

  /**
   * Returns the element that actually paints the photo under the cursor:
   * either a visible <img> (x-web) or X's visible background-image layer
   * (classic). Returns null for videos and anything outside a supported viewer.
   * @returns {HTMLElement | null}
   */
  function findViewerSurfaceAt(x, y) {
    const stack = document.elementsFromPoint(x, y);

    // Reply drawers render ordinary tweet cards as <article>. Wheel over them
    // belongs to that card, not to the photo behind the drawer.
    if (stack[0] instanceof Element && stack[0].closest('article')) return null;

    const root = viewerRootFor(stack[0]);
    if (!root) return null;

    // 1. A real, visible <img> (new x-web viewer).
    for (let index = 0; index < stack.length; index += 1) {
      const node = stack[index];
      if (
        node instanceof HTMLImageElement &&
        root.contains(node) &&
        isCandidateImage(node, x, y)
      ) {
        if (hasVideoAbove(stack, index, root, x, y)) return null;
        return node;
      }
    }

    // A video in front of a photo always wins.
    if (hasCoveringVideoIn(root, x, y)) return null;

    // 2. Classic viewer: the pixels come from a background-image layer while
    //    the <img> is opacity:0. Find the painted layer in the active slide.
    const inlineCandidates = [];
    if (root.matches('[style*="pbs.twimg.com"]')) inlineCandidates.push(root);
    for (const element of root.querySelectorAll('[style*="pbs.twimg.com"]')) {
      inlineCandidates.push(element);
    }

    const backgroundCandidates = [];
    for (const element of inlineCandidates) {
      if (isBackgroundSurface(element, x, y)) backgroundCandidates.push(element);
    }

    if (!backgroundCandidates.length) {
      // Rare fallback for stylesheet-driven backgrounds.
      const divs = [];
      if (root instanceof HTMLDivElement) divs.push(root);
      for (const div of root.querySelectorAll('div')) divs.push(div);
      for (const div of divs) {
        if (isBackgroundSurface(div, x, y)) backgroundCandidates.push(div);
      }
    }

    if (backgroundCandidates.length) {
      // Smallest painted layer is the photo, not a larger background wrapper.
      let best = backgroundCandidates[0];
      let bestArea = Infinity;
      for (const element of backgroundCandidates) {
        const rect = element.getBoundingClientRect();
        const area = rect.width * rect.height;
        if (area < bestArea) {
          best = element;
          bestArea = area;
        }
      }
      return best;
    }

    // 3. A visible image that is not hit-testable (pointer-events:none).
    for (const img of root.querySelectorAll('img')) {
      if (isCandidateImage(img, x, y)) return img;
    }
    return null;
  }

  /** @returns {boolean} */
  function isViewerControlAt(x, y, zoomedSurface = null) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return false;

    const control = hit.closest(
      'button, [role="button"], [role="menuitem"], [data-testid="app-bar-close"], a[href], input, textarea, [contenteditable="true"]'
    );
    if (!control) return false;

    // A wrapper that contains the photo is not a control worth protecting;
    // otherwise a role="button" around the photo would disable panning.
    if (
      zoomedSurface &&
      (control === zoomedSurface || control.contains(zoomedSurface))
    ) {
      return false;
    }
    return true;
  }

  function watchVisibility(surface) {
    if (!('IntersectionObserver' in window)) return;

    if (!visibilityObserver) {
      visibilityObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) continue;
            const state = states.get(entry.target);
            if (state && state.scale > MIN_SCALE) {
              clearTransform(entry.target, state);
            }
          }
        },
        { threshold: 0 }
      );
    }
    visibilityObserver.observe(surface);
  }

  function snapshotStyle(element, properties) {
    return properties.map((property) => ({
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    }));
  }

  function restoreStyle(element, snapshot) {
    for (const { property, value, priority } of snapshot) {
      if (value) element.style.setProperty(property, value, priority);
      else element.style.removeProperty(property);
    }
  }

  // X clips the classic painted layer inside nested overflow:hidden wrappers.
  // Unlock those (but never the viewer/swipe layer itself) while zoomed.
  function unlockClipping(surface, state) {
    const boundary =
      surface.closest(
        '[data-testid="swipe-to-dismiss"], [role="dialog"], [aria-modal="true"]'
      ) || viewerRootFor(surface);

    const unlocked = [];
    let node = surface.parentElement;
    for (
      let depth = 0;
      node && depth < 12 && node !== boundary;
      depth += 1, node = node.parentElement
    ) {
      if (!(node instanceof HTMLElement)) continue;
      const computed = getComputedStyle(node);
      if (computed.overflowX === 'visible' && computed.overflowY === 'visible') {
        continue;
      }

      unlocked.push({
        element: node,
        styles: snapshotStyle(node, ['overflow', 'overflow-x', 'overflow-y']),
      });
      node.style.setProperty('overflow', 'visible', 'important');
    }

    state.unlocked = unlocked.length ? unlocked : null;
  }

  function detachDragListeners() {
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('pointercancel', onPointerUp, true);
  }

  function cancelDragFor(surface) {
    if (!drag || drag.surface !== surface) return;
    drag = null;
    detachDragListeners();
  }

  function stopDrag() {
    if (!drag) return;
    const { surface, state } = drag;
    drag = null;
    state.dragging = false;
    applyTransform(surface, state);
    detachDragListeners();
  }

  /**
   * Restores the surface's original inline styles, clipping wrappers and
   * forgets the zoom.
   */
  function clearTransform(surface, state) {
    state.scale = MIN_SCALE;
    state.tx = 0;
    state.ty = 0;
    state.dragging = false;
    zoomedSurfaces.delete(surface);

    if (state.original) {
      restoreStyle(surface, state.original);
      state.original = null;
    }

    if (state.unlocked) {
      for (const item of state.unlocked) {
        restoreStyle(item.element, item.styles);
      }
      state.unlocked = null;
    }

    if (visibilityObserver) visibilityObserver.unobserve(surface);
    cancelDragFor(surface);
  }

  function applyTransform(surface, state) {
    if (
      state.scale <= MIN_SCALE + 0.0001 &&
      state.tx === 0 &&
      state.ty === 0
    ) {
      clearTransform(surface, state);
      return;
    }

    if (!state.original) {
      state.original = snapshotStyle(surface, [
        'transform',
        'transform-origin',
        'will-change',
        'cursor',
      ]);
      if (state.kind === 'background') unlockClipping(surface, state);
      watchVisibility(surface);
    }

    surface.style.setProperty('transform-origin', '0 0', 'important');
    surface.style.setProperty(
      'transform',
      `translate(${state.tx.toFixed(2)}px, ${state.ty.toFixed(2)}px) scale(${state.scale.toFixed(4)})`,
      'important'
    );
    surface.style.setProperty('will-change', 'transform', 'important');
    surface.style.setProperty(
      'cursor',
      state.dragging ? 'grabbing' : 'grab',
      'important'
    );
    zoomedSurfaces.add(surface);
  }

  /**
   * Scales the surface around the screen point (clientX, clientY), keeping
   * the content under the cursor in place. Translation is clamped so the
   * surface always covers its original frame.
   */
  function zoomAt(surface, state, clientX, clientY, requestedScale) {
    // X's desktop photo surfaces are untransformed. If some design/animation
    // does put a transform on the painted node, do not overwrite it and
    // restore a stale snapshot later; leave that surface alone.
    if (!state.original && hasNonIdentityTransform(surface)) return false;

    const nextScale = clamp(requestedScale, MIN_SCALE, MAX_SCALE);
    if (Math.abs(nextScale - state.scale) < 0.0001) return false;

    const rect = surface.getBoundingClientRect();
    const baseWidth = rect.width / state.scale;
    const baseHeight = rect.height / state.scale;
    const baseLeft = rect.left - state.tx;
    const baseTop = rect.top - state.ty;
    const ratio = nextScale / state.scale;

    let tx = clientX - baseLeft - ratio * (clientX - baseLeft - state.tx);
    let ty = clientY - baseTop - ratio * (clientY - baseTop - state.ty);

    state.scale = nextScale;
    state.tx = clamp(tx, baseWidth - baseWidth * nextScale, 0);
    state.ty = clamp(ty, baseHeight - baseHeight * nextScale, 0);

    if (nextScale <= MIN_SCALE + 0.0001) {
      state.scale = MIN_SCALE;
      state.tx = 0;
      state.ty = 0;
    }

    applyTransform(surface, state);
    return true;
  }

  function sourceKey(surface) {
    if (surface instanceof HTMLImageElement) {
      return surface.currentSrc || surface.src || '';
    }
    return (
      surface.style.backgroundImage ||
      getComputedStyle(surface).backgroundImage ||
      ''
    );
  }

  function getState(surface) {
    const src = sourceKey(surface);
    let state = states.get(surface);

    if (!state) {
      state = {
        scale: MIN_SCALE,
        tx: 0,
        ty: 0,
        src,
        kind: surface instanceof HTMLImageElement ? 'image' : 'background',
        original: null,
        unlocked: null,
        dragging: false,
      };
      states.set(surface, state);
      return state;
    }

    // The carousel can swap the media in place.
    if (state.src !== src) {
      clearTransform(surface, state);
      state.src = src;
    }
    return state;
  }

  // X creates and removes lightbox nodes constantly. Dropping detached
  // entries keeps this Map bounded during a long browsing session.
  function pruneDetachedStates() {
    if (states.size <= 32) return;
    for (const surface of states.keys()) {
      if (surface.isConnected) continue;
      if (visibilityObserver) visibilityObserver.unobserve(surface);
      cancelDragFor(surface);
      zoomedSurfaces.delete(surface);
      states.delete(surface);
    }
  }

  const wheelRoots = new WeakSet();
  let viewerPresence = { at: -Infinity, open: false };

  /**
   * A non-passive wheel listener is only ever attached to a viewer layer, so
   * normal timeline scrolling keeps the compositor fast path.
   */
  function installViewerWheelListener(root) {
    if (!(root instanceof Element) || wheelRoots.has(root)) return;
    wheelRoots.add(root);
    root.addEventListener('wheel', onWheel, { capture: true, passive: false });
  }

  function photoViewerMayBeOpen() {
    // Cheap and exact for the common x-web route; no cache needed.
    if (isTweetPhotoRoute()) return true;

    const now = performance.now();
    if (now - viewerPresence.at < 300) return viewerPresence.open;

    const open = Boolean(document.querySelector('[data-testid="swipe-to-dismiss"]'));
    viewerPresence = { at: now, open };
    return open;
  }

  function onPointerOver(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target instanceof HTMLImageElement) {
      if (!isVisibleImage(target)) return;
    } else if (
      !target.closest(
        '[data-testid="swipe-to-dismiss"], [role="dialog"], [aria-modal="true"]'
      )
    ) {
      return;
    }

    const root = viewerRootFor(target);
    if (root) installViewerWheelListener(root);
  }

  // Passive safety net: if the viewer appeared under a stationary cursor and
  // no pointerover installed the root listener yet, the first wheel still
  // zooms. It cannot preventDefault, but X locks the page behind the viewer.
  function onWheelFallback(event) {
    if (event.defaultPrevented) return;
    if (!photoViewerMayBeOpen()) return;
    handleWheel(event, false);
  }

  function onWheel(event) {
    handleWheel(event, true);
  }

  function handleWheel(event, allowConsume) {
    if (event.defaultPrevented) return;
    // Ctrl/Cmd+wheel is browser page zoom (and precision-trackpad pinch).
    // Leave it to the browser; only the plain wheel zooms the photo.
    if (event.ctrlKey || event.metaKey) return;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;

    pruneDetachedStates();

    const surface = findViewerSurfaceAt(event.clientX, event.clientY);
    if (!surface) return;

    // Wheel over a real close/next/link control is not a photo zoom gesture.
    // Links or button wrappers that contain the photo itself are exempt.
    if (isViewerControlAt(event.clientX, event.clientY, surface)) return;

    if (!allowConsume) {
      const root = viewerRootFor(surface);
      if (root) installViewerWheelListener(root);
    }

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= Math.max(innerHeight, 1);

    const state = getState(surface);
    const factor = clamp(
      Math.exp(-delta * WHEEL_ZOOM_SPEED),
      MIN_WHEEL_FACTOR,
      MAX_WHEEL_FACTOR
    );

    const changed = zoomAt(
      surface,
      state,
      event.clientX,
      event.clientY,
      state.scale * factor
    );

    // If the user scrolls mid-drag, rebase the pan so the next pointermove
    // continues from the newly zoomed position instead of undoing it.
    if (changed && drag && drag.surface === surface) {
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      drag.startTx = state.tx;
      drag.startTy = state.ty;
    }

    // Consume only a wheel that actually changed the zoom. A no-op wheel at
    // 100% or 8x is left for the page/other handlers. The passive fallback
    // must never call preventDefault.
    if (changed && allowConsume) consume(event);
  }

  function suppressClicks() {
    clearTimeout(suppressClickTimer);
    suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
    suppressClickTimer = setTimeout(() => {
      suppressClickUntil = 0;
    }, CLICK_SUPPRESS_MS);
  }

  function onClick(event) {
    const suppressionActive = Date.now() <= suppressClickUntil;
    if (suppressionActive) {
      suppressClickUntil = 0;
      clearTimeout(suppressClickTimer);
      // This is the synthetic click from the drag that just ended. Its
      // target may be the backdrop or a control; never let it through.
      consume(event);
      return;
    }
    if (zoomedSurfaces.size === 0) return;

    const surface = findViewerSurfaceAt(event.clientX, event.clientY);

    // A deliberate click on Close/Prev/Next must still work; a fresh
    // pointerdown has already cleared any old drag suppression.
    if (isViewerControlAt(event.clientX, event.clientY, surface)) return;

    if (surface) {
      const state = getState(surface);
      if (state.scale > MIN_SCALE + 0.0001) consume(event);
    }
  }

  function onPointerDown(event) {
    // A fresh press begins a new gesture; don't let an old drag's synthetic
    // click suppression swallow a deliberate control click.
    suppressClickUntil = 0;
    clearTimeout(suppressClickTimer);

    if (drag || zoomedSurfaces.size === 0) return;
    if (event.button !== 0 || !event.isPrimary || event.pointerType === 'touch') return;

    const surface = findViewerSurfaceAt(event.clientX, event.clientY);
    if (!surface) return;
    if (isViewerControlAt(event.clientX, event.clientY, surface)) return;

    const state = getState(surface);
    if (state.scale <= MIN_SCALE + 0.0001) return;

    drag = {
      surface,
      state,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTx: state.tx,
      startTy: state.ty,
      moved: false,
    };

    state.dragging = true;
    applyTransform(surface, state);

    window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
    window.addEventListener('pointerup', onPointerUp, { capture: true, passive: false });
    window.addEventListener('pointercancel', onPointerUp, { capture: true, passive: false });
    consume(event);
  }

  function onPointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    // The pointerup can be lost (alt-tab, window blur, OS gesture). If the
    // primary button is no longer held, end the pan instead of panning on
    // every future mouse move.
    if ((event.buttons & 1) === 0) {
      stopDrag();
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
      drag.moved = true;
    }

    const { surface, state } = drag;
    const rect = surface.getBoundingClientRect();
    const baseWidth = rect.width / state.scale;
    const baseHeight = rect.height / state.scale;
    const minTx = baseWidth - baseWidth * state.scale;
    const minTy = baseHeight - baseHeight * state.scale;

    state.tx = clamp(drag.startTx + dx, minTx, 0);
    state.ty = clamp(drag.startTy + dy, minTy, 0);
    applyTransform(surface, state);
    consume(event);
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    const { surface, state, moved } = drag;
    drag = null;
    state.dragging = false;
    applyTransform(surface, state);
    detachDragListeners();

    if (moved) suppressClicks();
    consume(event);
  }

  // Cancel X's own mousedown handling only while the photo is zoomed, so a
  // drag pans instead of starting a swipe/dismiss gesture.
  function onMouseDown(event) {
    if (zoomedSurfaces.size === 0 || event.button !== 0) return;

    const surface = findViewerSurfaceAt(event.clientX, event.clientY);
    if (!surface) return;
    if (isViewerControlAt(event.clientX, event.clientY, surface)) return;

    const state = getState(surface);
    if (state.scale <= MIN_SCALE + 0.0001) return;
    consume(event);
  }

  function onDragStart(event) {
    if (drag) {
      consume(event);
      return;
    }
    if (zoomedSurfaces.size === 0) return;

    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;

    const state = states.get(target);
    if (state && state.scale > MIN_SCALE + 0.0001) consume(event);
  }

  function onImageLoad(event) {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;

    const state = states.get(img);
    if (!state) return;

    const src = sourceKey(img);
    if (src && state.src !== src) {
      clearTransform(img, state);
      state.src = src;
    }
  }

  function resetAllTransforms() {
    for (const [surface, state] of states) clearTransform(surface, state);
  }

  // The viewer-specific non-passive listener is installed lazily on the
  // viewer root; this site-wide pair is non-blocking for scrolling.
  window.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
  window.addEventListener('wheel', onWheelFallback, { capture: false, passive: true });
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false });
  window.addEventListener('mousedown', onMouseDown, { capture: true, passive: false });
  window.addEventListener('blur', stopDrag);
  window.addEventListener('click', onClick, true);
  window.addEventListener('dragstart', onDragStart, true);
  // Image load events do not reach a window-level capture listener in
  // Chromium; document capture does see them.
  document.addEventListener('load', onImageLoad, true);
  window.addEventListener('resize', resetAllTransforms, { passive: true });

  // X's photo carousel uses pushState and only the /photo/<n> segment changes;
  // popstate alone is not enough. Poll the pathname, but only wipe transforms
  // when moving between two photo routes (index/status change). Opening or
  // closing the viewer must not clear a zoom the user just applied.
  let lastPathname = location.pathname;
  let lastPhotoKey = photoRouteKey(lastPathname);
  setInterval(() => {
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    viewerPresence = { at: -Infinity, open: false };

    const nextPhotoKey = photoRouteKey(lastPathname);
    if (lastPhotoKey && nextPhotoKey && lastPhotoKey !== nextPhotoKey) {
      resetAllTransforms();
    }
    lastPhotoKey = nextPhotoKey;
  }, 300);
})();
