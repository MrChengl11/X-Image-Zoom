import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const extensionPath = path.join(root, 'extension');
const mockHtml = readFileSync(path.join(here, 'mock-x.html'), 'utf8');
const classicHtml = readFileSync(path.join(here, 'mock-classic.html'), 'utf8');
const profileHtml = readFileSync(path.join(here, 'mock-profile.html'), 'utf8');
const nestedHtml = readFileSync(path.join(here, 'mock-nested.html'), 'utf8');
const sampleSvg = readFileSync(path.join(here, 'sample.svg'), 'utf8');
const MOCK_URL = 'https://x.com/mockuser/status/123/photo/1';

// One fresh, throwaway Edge profile per run. Windows can keep helper-process
// locks on a profile briefly after the browser closes, so using the OS temp
// directory avoids EPERM errors when cleaning up.
const profileDir = mkdtempSync(path.join(os.tmpdir(), 'x-pic-zoom-edge-'));

let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error.message}`);
  }
}

async function geometry(page) {
  return page.evaluate(() => {
    const img = document.querySelector('#photo');
    const rect = img.getBoundingClientRect();
    let matrix;
    try {
      matrix = new DOMMatrixReadOnly(getComputedStyle(img).transform);
    } catch {
      matrix = new DOMMatrixReadOnly();
    }
    const scale = matrix.a || 1;
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      scale,
      tx: matrix.e,
      ty: matrix.f,
      baseLeft: rect.left - matrix.e,
      baseTop: rect.top - matrix.f,
      inlineTransform: img.style.transform,
    };
  });
}

async function wheel(page, x, y, deltaY, times = 1) {
  await page.mouse.move(x, y);
  for (let i = 0; i < times; i += 1) {
    await page.mouse.wheel(0, deltaY);
  }
  await page.waitForTimeout(120);
}

console.log('Launching Microsoft Edge with the unpacked extension...');

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'msedge',
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeFirstRunExperience',
  ],
});

try {
  await context.route('https://x.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname === '/mock' ||
      url.pathname === '/mockuser/status/123/photo/1'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: mockHtml,
      });
    } else if (url.pathname === '/classicuser/status/456/photo/1') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: classicHtml,
      });
    } else if (url.pathname === '/someuser/photo') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: profileHtml,
      });
    } else if (url.pathname === '/nesteduser/status/789/photo/1') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: nestedHtml,
      });
    } else if (url.pathname === '/sample.svg') {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: sampleSvg,
      });
    } else {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    }
  });

  await context.route('https://pbs.twimg.com/media/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: sampleSvg,
    });
  });

  const page = await context.newPage();
  await page.goto(MOCK_URL, { waitUntil: 'load' });
  await page.waitForSelector('#photo', { state: 'visible' });
  await page.waitForTimeout(400);
  await page.evaluate(() => window.scrollTo(0, 0));

  const photoBox = await page.locator('#photo').boundingBox();
  if (!photoBox) throw new Error('photo has no bounding box');

  const cx = photoBox.x + photoBox.width * 0.4;
  const cy = photoBox.y + photoBox.height * 0.3;
  const before = await geometry(page);

  let zoomed = before;

  await step('unpacked extension loads in an isolated world', async () => {
    // A content script runs in an isolated world: its window expando must not
    // be visible to the page. The bundled test never injects content.js into
    // the page itself, so a zoom here proves Edge loaded the real extension.
    const pageFlag = await page.evaluate(() => typeof window.__xPicZoomInstalled);
    assert.equal(pageFlag, 'undefined', 'content script must not run in the page world');

    await wheel(page, cx, cy, -120);
    const g = await geometry(page);
    assert.ok(
      g.scale > 1.05,
      'Edge did not load the unpacked extension (check manifest/icons and --load-extension)'
    );
    await wheel(page, cx, cy, 120, 4);
  });

  await step('wheel over the photo zooms in', async () => {
    await wheel(page, cx, cy, -120);
    zoomed = await geometry(page);
    assert.ok(
      zoomed.scale > 1.05,
      `expected scale > 1.05, got ${zoomed.scale.toFixed(3)}`
    );
    assert.equal(await page.evaluate(() => window.scrollY), 0, 'page scrolled while zooming');
  });

  await step('zoom is anchored under the cursor', async () => {
    const localBefore = {
      x: (cx - before.baseLeft - before.tx) / before.scale,
      y: (cy - before.baseTop - before.ty) / before.scale,
    };
    const localAfter = {
      x: (cx - zoomed.baseLeft - zoomed.tx) / zoomed.scale,
      y: (cy - zoomed.baseTop - zoomed.ty) / zoomed.scale,
    };
    assert.ok(
      Math.abs(localAfter.x - localBefore.x) < 0.75,
      `cursor content drifted on x: ${localBefore.x.toFixed(2)} -> ${localAfter.x.toFixed(2)}`
    );
    assert.ok(
      Math.abs(localAfter.y - localBefore.y) < 0.75,
      `cursor content drifted on y: ${localBefore.y.toFixed(2)} -> ${localAfter.y.toFixed(2)}`
    );
  });

  await step('dragging pans a zoomed photo without clicking through', async () => {
    // Some designs wrap the lightbox photo in a role="button" container; that
    // must not be mistaken for a close/next control and disable panning.
    await page.evaluate(() => {
      document.getElementById('photo-link').setAttribute('role', 'button');
    });

    const start = await geometry(page);
    const clicksBefore = await page.evaluate(() => window.__mockClicks);

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 60, cy - 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const end = await geometry(page);
    const dx = end.tx - start.tx;
    const dy = end.ty - start.ty;
    assert.ok(Math.abs(dx + 60) < 6, `expected about -60px pan on x, got ${dx.toFixed(1)}`);
    assert.ok(Math.abs(dy + 40) < 6, `expected about -40px pan on y, got ${dy.toFixed(1)}`);
    assert.ok(Math.abs(end.scale - start.scale) < 0.001, 'pan changed the zoom level');

    const clicksAfter = await page.evaluate(() => window.__mockClicks);
    assert.equal(clicksAfter, clicksBefore, 'a drag leaked a click to the page');

    await page.evaluate(() => {
      document.getElementById('photo-link').removeAttribute('role');
    });
  });

  await step('a plain click on a zoomed photo does not reach the page', async () => {
    // Let the post-drag suppression window expire so this specifically tests
    // the "zoomed image" click rule.
    await page.waitForTimeout(450);
    const clicksBefore = await page.evaluate(() => window.__mockClicks);
    const hashBefore = await page.evaluate(() => location.hash);

    await page.mouse.click(cx, cy);
    await page.waitForTimeout(120);

    const clicksAfter = await page.evaluate(() => window.__mockClicks);
    const hashAfter = await page.evaluate(() => location.hash);
    assert.equal(clicksAfter, clicksBefore, 'a plain click leaked to X listeners');
    assert.equal(hashAfter, hashBefore, 'a plain click followed the photo link');

    await wheel(page, cx, cy, 120, 8);
  });

  await step('a lost pointerup ends the pan', async () => {
    await wheel(page, cx, cy, -120);
    assert.ok((await geometry(page)).scale > 1, 'photo should be zoomed');

    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 40, cy - 20, { steps: 4 });
    await page.waitForTimeout(80);

    // Simulate the missing pointerup: a move with no primary button held.
    await page.evaluate(
      ({ x, y }) => {
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            buttons: 0,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          })
        );
      },
      { x: cx - 20, y: cy - 10 }
    );
    await page.waitForTimeout(80);

    const before = await geometry(page);
    await page.mouse.move(cx + 60, cy + 30, { steps: 4 });
    await page.waitForTimeout(80);
    const after = await geometry(page);
    assert.ok(
      Math.abs(after.tx - before.tx) < 1 && Math.abs(after.ty - before.ty) < 1,
      'pan continued after a lost pointerup'
    );

    await page.mouse.up();
    await wheel(page, cx, cy, 120, 8);
  });

  await step('releasing a pan over a control does not dismiss the viewer', async () => {
    await wheel(page, cx, cy, -120);
    assert.ok((await geometry(page)).scale > 1, 'photo should be zoomed');

    const closeBox = await page.locator('#close').boundingBox();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(
      closeBox.x + closeBox.width / 2,
      closeBox.y + closeBox.height / 2,
      { steps: 8 }
    );
    await page.mouse.up();
    await page.waitForTimeout(150);

    assert.equal(
      await page.evaluate(() => document.getElementById('viewer').hidden),
      false,
      'a pan released over a control dismissed the viewer'
    );

    await wheel(page, cx, cy, 120, 8);
  });

  await step('scrolling down returns to 100% and clears inline styles', async () => {
    await wheel(page, cx, cy, 120, 4);
    const g = await geometry(page);
    assert.ok(g.scale <= 1.0001, `expected 100%, got ${(g.scale * 100).toFixed(1)}%`);
    assert.equal(g.inlineTransform, '', 'inline transform was not removed');
  });

  await step('a no-op wheel at 100% is not swallowed', async () => {
    const result = await page.evaluate(
      ({ x, y }) => {
        const img = document.querySelector('#photo');
        const event = new WheelEvent('wheel', {
          deltaY: 120,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        });
        img.dispatchEvent(event);
        return { prevented: event.defaultPrevented, transform: img.style.transform };
      },
      { x: cx, y: cy }
    );
    assert.equal(result.prevented, false, 'downward wheel at 100% must pass through');
    assert.equal(result.transform, '', 'downward wheel at 100% must not zoom');
  });

  await step('ctrl+wheel is left to the browser', async () => {
    const result = await page.evaluate(
      ({ x, y }) => {
        const img = document.querySelector('#photo');
        const event = new WheelEvent('wheel', {
          deltaY: -120,
          ctrlKey: true,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        });
        img.dispatchEvent(event);
        return { prevented: event.defaultPrevented, transform: img.style.transform };
      },
      { x: cx, y: cy }
    );
    assert.equal(result.prevented, false, 'ctrl+wheel must not be consumed');
    assert.equal(result.transform, '', 'ctrl+wheel must not zoom the photo');
  });

  await step('zoom is capped at 8x', async () => {
    await wheel(page, cx, cy, -120, 20);
    const g = await geometry(page);
    assert.ok(g.scale > 7.99 && g.scale <= 8.0001, `expected 8x, got ${g.scale.toFixed(2)}x`);
  });

  await step('zooming out from max resets cleanly', async () => {
    await wheel(page, cx, cy, 120, 24);
    const g = await geometry(page);
    assert.ok(g.scale <= 1.0001, `expected 100%, got ${(g.scale * 100).toFixed(1)}%`);
    assert.equal(g.inlineTransform, '', 'inline transform was not removed');
  });

  await step('changing the photo source (carousel) resets zoom', async () => {
    await wheel(page, cx, cy, -120, 2);
    assert.ok((await geometry(page)).scale > 1, 'photo should be zoomed');

    await page.evaluate(() => {
      document.querySelector('#photo').src = 'https://pbs.twimg.com/media/mock.svg?next-photo';
    });
    await page.waitForFunction(() => {
      const img = document.querySelector('#photo');
      return img.complete && img.naturalWidth > 0;
    });
    await page.waitForTimeout(150);

    const g = await geometry(page);
    assert.equal(g.inlineTransform, '', 'src change should clear the transform');
    assert.ok(g.scale <= 1.0001, `src change should reset scale, got ${g.scale.toFixed(3)}`);
  });

  await step('opening the photo route does not wipe an existing zoom', async () => {
    await page.evaluate(() => {
      history.pushState({}, '', '/mock');
    });
    await page.waitForTimeout(400);

    await wheel(page, cx, cy, -120);
    assert.ok((await geometry(page)).scale > 1, 'photo should zoom off-route too');

    await page.evaluate(() => {
      history.pushState({}, '', '/mockuser/status/123/photo/1');
    });
    await page.waitForTimeout(400);

    const g = await geometry(page);
    assert.ok(g.scale > 1.05, 'opening the photo route wiped the zoom');

    await wheel(page, cx, cy, 120, 8);
  });

  await step('photo URL change resets zoom', async () => {
    await wheel(page, cx, cy, -120);
    assert.ok((await geometry(page)).scale > 1, 'photo should be zoomed');

    await page.evaluate(() => {
      history.pushState({}, '', '/mockuser/status/123/photo/2');
    });
    await page.waitForTimeout(450);

    const after = await geometry(page);
    assert.equal(after.inlineTransform, '', 'URL change did not clear the zoom');

    await page.evaluate(() => {
      history.pushState({}, '', '/mockuser/status/123/photo/1');
    });
    await page.waitForTimeout(350);
  });

  await step('closing the viewer clears zoom', async () => {
    await wheel(page, cx, cy, -120, 3);
    assert.ok((await geometry(page)).scale > 1, 'photo should be zoomed before closing');

    await page.waitForTimeout(450); // let click suppression from drag expire
    await page.click('#close');
    await page.waitForFunction(() => !document.querySelector('#photo').style.transform);
    assert.equal(
      await page.evaluate(() => document.getElementById('viewer').hidden),
      true,
      'viewer did not close'
    );
  });

  await step('viewer reopens and zooms again', async () => {
    await page.click('#thumb');
    await page.waitForFunction(() => !document.getElementById('viewer').hidden);
    await page.waitForTimeout(150);

    await wheel(page, cx, cy, -120);
    const g = await geometry(page);
    assert.ok(g.scale > 1.05, `expected zoom after reopening, got ${g.scale.toFixed(3)}`);
  });

  await step('small photos still zoom inside the viewer', async () => {
    await wheel(page, cx, cy, 120, 8);
    await page.evaluate(() => {
      const img = document.getElementById('photo');
      img.style.width = '80px';
      img.style.height = '60px';
    });
    await page.waitForTimeout(80);

    const box = await page.locator('#photo').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    await wheel(page, x, y, -120);
    const g = await geometry(page);
    assert.ok(g.scale > 1.05, 'an 80x60 photo in the viewer did not zoom');

    await wheel(page, x, y, 120, 8);
    await page.evaluate(() => {
      const img = document.getElementById('photo');
      img.style.width = '';
      img.style.height = '';
    });
    await page.waitForTimeout(80);
  });

  await step('a surface with its own transform is left alone', async () => {
    await page.evaluate(() => {
      document.getElementById('photo').style.transform = 'translate(80px, 40px)';
    });

    const box = await page.locator('#photo').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);

    const transform = await page.evaluate(
      () => document.getElementById('photo').style.transform
    );
    assert.equal(
      transform,
      'translate(80px, 40px)',
      'extension overwrote an existing transform'
    );

    await page.evaluate(() => {
      document.getElementById('photo').style.transform = '';
    });
  });

  await step('fixed-overlay fallback detects the viewer', async () => {
    await wheel(page, cx, cy, 120, 6);
    await page.evaluate(() => {
      const viewer = document.getElementById('viewer');
      viewer.removeAttribute('role');
      viewer.removeAttribute('aria-modal');
      document.querySelector('[data-testid="swipe-to-dismiss"]').removeAttribute('data-testid');
    });

    await wheel(page, cx, cy, -120);
    const g = await geometry(page);
    assert.ok(g.scale > 1.05, `fallback detection failed, scale ${g.scale.toFixed(3)}`);
  });

  await step('background video does not block a pointer-events:none photo', async () => {
    // The viewer's own attributes were removed by the previous step, so this
    // also exercises the fixed-overlay fallback plus an occluded background
    // <video> that must not be mistaken for the active media.
    await wheel(page, cx, cy, 120, 8);
    await page.evaluate(() => {
      document.getElementById('bg-video').hidden = false;
      document.getElementById('photo').style.pointerEvents = 'none';
    });

    await wheel(page, cx, cy, -120);
    const g = await geometry(page);
    assert.ok(g.scale > 1.05, `background video blocked zoom, scale ${g.scale.toFixed(3)}`);

    await page.evaluate(() => {
      document.getElementById('photo').style.pointerEvents = '';
      document.getElementById('bg-video').hidden = true;
    });
    await wheel(page, cx, cy, 120, 8);
  });

  await step('a video in the viewer blocks photo zoom', async () => {
    await wheel(page, cx, cy, 120, 8);
    await page.evaluate(() => {
      document.getElementById('viewer-video').hidden = false;
    });

    await wheel(page, cx, cy, -120);
    const g = await geometry(page);
    assert.equal(g.inlineTransform, '', 'a video slide must block photo zoom');

    await page.evaluate(() => {
      document.getElementById('viewer-video').hidden = true;
    });
  });

  await step('tweet cards in a viewer drawer keep their own wheel', async () => {
    await wheel(page, cx, cy, 120, 8);
    await page.evaluate(() => {
      document.getElementById('drawer-panel').hidden = false;
    });

    const box = await page.locator('#drawer-photo').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);

    const result = await page.evaluate(() => ({
      drawer: document.getElementById('drawer-photo').style.transform,
      photo: document.getElementById('photo').style.transform,
    }));
    assert.equal(result.drawer, '', 'drawer article image must not zoom');
    assert.equal(result.photo, '', 'photo behind a drawer article must not zoom');

    await page.evaluate(() => {
      document.getElementById('drawer-panel').hidden = true;
    });
  });

  await step('wheel over the viewer backdrop does not zoom', async () => {
    await wheel(page, cx, cy, 120, 8);
    const g0 = await geometry(page);
    await wheel(page, 60, 800, -120, 2);
    const g1 = await geometry(page);
    assert.equal(g1.inlineTransform, '', 'backdrop wheel must not create a transform');
    assert.ok(Math.abs(g1.scale - g0.scale) < 0.0001, 'backdrop wheel changed scale');
  });

  await step('resizing the window resets zoom', async () => {
    await wheel(page, cx, cy, -120, 2);
    assert.ok((await geometry(page)).scale > 1, 'photo should be zoomed');

    await page.setViewportSize({ width: 1100, height: 820 });
    await page.waitForFunction(() => !document.querySelector('#photo').style.transform);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(150);
  });

  await step('clicking the backdrop still closes the zoomed viewer', async () => {
    await wheel(page, cx, cy, -120, 2);
    assert.ok((await geometry(page)).scale > 1, 'photo should be zoomed');

    // The zoomed photo covers most of the viewport; (5,5) is guaranteed
    // backdrop even at high zoom for this 1280x900 viewport.
    await page.mouse.click(5, 5);
    await page.waitForFunction(() => document.getElementById('viewer').hidden === true);
    await page.waitForFunction(() => !document.querySelector('#photo').style.transform);
  });

  await step('regular dialogs with images are left alone', async () => {
    await page.evaluate(() => {
      document.getElementById('small-dialog').hidden = false;
    });
    const box = await page.locator('#small-dialog-photo').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);

    const transform = await page.evaluate(
      () => document.getElementById('small-dialog-photo').style.transform
    );
    assert.equal(transform, '', 'regular dialog image must not be transformed');

    await page.evaluate(() => {
      document.getElementById('small-dialog').hidden = true;
    });
  });

  await step('timeline images do not hijack the wheel', async () => {
    await page.evaluate(() => {
      document.getElementById('viewer').hidden = true;
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(300);

    const thumbBox = await page.locator('#thumb').boundingBox();
    await page.mouse.move(
      thumbBox.x + thumbBox.width / 2,
      thumbBox.y + thumbBox.height / 2
    );
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.wheel(0, 320);
    await page.waitForTimeout(300);

    const scrollAfter = await page.evaluate(() => window.scrollY);
    const thumbTransform = await page.evaluate(
      () => document.getElementById('thumb').style.transform
    );
    assert.ok(
      scrollAfter > scrollBefore,
      `timeline did not scroll (before=${scrollBefore}, after=${scrollAfter})`
    );
    assert.equal(thumbTransform, '', 'timeline thumbnail was transformed');
  });

  await step('passive wheel fallback works before pointerover', async () => {
    // A fresh tab: the mouse never moved over the photo, so no viewer-root
    // wheel listener is installed yet. The passive site-wide fallback must
    // still zoom the first wheel after the viewer appears.
    const fresh = await context.newPage();
    try {
      await fresh.goto(MOCK_URL, { waitUntil: 'load' });
      await fresh.waitForSelector('#photo', { state: 'visible' });
      await fresh.waitForTimeout(250);

      const box = await fresh.locator('#photo').boundingBox();
      const result = await fresh.evaluate(
        ({ x, y }) => {
          const img = document.querySelector('#photo');
          const event = new WheelEvent('wheel', {
            deltaY: -120,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          });
          img.dispatchEvent(event);
          return { prevented: event.defaultPrevented, transform: img.style.transform };
        },
        { x: box.x + box.width * 0.4, y: box.y + box.height * 0.3 }
      );

      assert.equal(result.prevented, false, 'passive fallback must not preventDefault');
      assert.ok(result.transform !== '', 'passive fallback did not zoom the photo');
    } finally {
      await fresh.close();
    }
  });

  await step('classic background-image viewer zooms the painted layer', async () => {
    const classic = await context.newPage();
    try {
      await classic.goto('https://x.com/classicuser/status/456/photo/1', {
        waitUntil: 'load',
      });
      await classic.waitForSelector('#classic-surface');
      await classic.waitForTimeout(250);

      const box = await classic.locator('#classic-surface').boundingBox();
      const x = box.x + box.width * 0.4;
      const y = box.y + box.height * 0.3;

      await classic.mouse.move(x, y);
      await classic.mouse.wheel(0, -120);
      await classic.waitForTimeout(150);

      const zoomed = await classic.evaluate(() => ({
        surfaceTransform: document.querySelector('#classic-surface').style.transform,
        imageTransform: document.querySelector('#classic-img').style.transform,
        clipOverflow: getComputedStyle(document.querySelector('#classic-clip')).overflow,
        rootOverflow: getComputedStyle(
          document.querySelector('#classic-image-root')
        ).overflow,
      }));
      assert.ok(
        zoomed.surfaceTransform.includes('scale'),
        'classic painted background layer was not zoomed'
      );
      assert.equal(
        zoomed.imageTransform,
        '',
        'the transparent <img> must not be transformed'
      );
      assert.equal(zoomed.clipOverflow, 'visible', 'clip overflow was not unlocked');
      assert.equal(
        zoomed.rootOverflow,
        'visible',
        'image-root overflow was not unlocked'
      );
      const offscreenTransform = await classic.evaluate(
        () => document.getElementById('classic-offscreen-surface').style.transform
      );
      assert.equal(
        offscreenTransform,
        '',
        'an off-screen carousel slide must not be transformed'
      );

      await classic.mouse.wheel(0, 120);
      await classic.mouse.wheel(0, 120);
      await classic.mouse.wheel(0, 120);
      await classic.waitForTimeout(200);

      const reset = await classic.evaluate(() => ({
        surfaceTransform: document.querySelector('#classic-surface').style.transform,
        clipOverflow: getComputedStyle(document.querySelector('#classic-clip')).overflow,
        rootOverflow: getComputedStyle(
          document.querySelector('#classic-image-root')
        ).overflow,
      }));
      assert.equal(reset.surfaceTransform, '', 'classic zoom did not reset');
      assert.equal(reset.clipOverflow, 'hidden', 'clip overflow was not restored');
      assert.equal(
        reset.rootOverflow,
        'hidden',
        'image-root overflow was not restored'
      );
    } finally {
      await classic.close();
    }
  });

  await step('a small dialog nested in a full-screen viewer still zooms', async () => {
    const nested = await context.newPage();
    try {
      await nested.goto('https://x.com/nesteduser/status/789/photo/1', {
        waitUntil: 'load',
      });
      await nested.waitForSelector('#nested-img', { state: 'visible' });
      await nested.waitForTimeout(250);

      const box = await nested.locator('#nested-img').boundingBox();
      await nested.mouse.move(
        box.x + box.width * 0.5,
        box.y + box.height * 0.5
      );
      await nested.mouse.wheel(0, -120);
      await nested.waitForTimeout(150);

      const transform = await nested.evaluate(
        () => document.getElementById('nested-img').style.transform
      );
      assert.ok(
        transform.includes('scale'),
        'nested small-dialog viewer did not zoom'
      );
    } finally {
      await nested.close();
    }
  });

  await step('profile photo viewer keeps its own native wheel zoom', async () => {
    const profile = await context.newPage();
    try {
      await profile.goto('https://x.com/someuser/photo', { waitUntil: 'load' });
      await profile.waitForSelector('#profile-photo', { state: 'visible' });
      await profile.waitForTimeout(250);

      const box = await profile.locator('#profile-photo').boundingBox();
      await profile.mouse.move(
        box.x + box.width * 0.5,
        box.y + box.height * 0.5
      );
      await profile.mouse.wheel(0, -120);
      await profile.waitForTimeout(150);

      const result = await profile.evaluate(() => ({
        nativeWheel: window.__nativeWheel,
        transform: document.getElementById('profile-photo').style.transform,
      }));
      assert.ok(
        result.nativeWheel > 0,
        'profile viewer did not receive its native wheel event'
      );
      assert.equal(
        result.transform,
        '',
        'extension must not transform the profile photo viewer'
      );
    } finally {
      await profile.close();
    }
  });

  await page.evaluate(() => {
    document.getElementById('viewer').hidden = false;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(150);
  await wheel(page, cx, cy, -120, 2);
  await page.screenshot({ path: path.join(here, 'screenshot.png') });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await context.close();
}
