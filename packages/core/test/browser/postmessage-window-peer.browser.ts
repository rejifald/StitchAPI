// `channel.window` is BOUND to its peer window, proved where only a browser can prove it.
//
// The node suite (`test/postmessage.spec.ts`) fakes `event.source` with object identity. What it
// cannot fake is the platform behaviour the binding rests on: an iframe's `contentWindow` is ONE
// `WindowProxy` across reloads and navigations and a NEW one across a remount, `event.source` IS
// that object, and a frame's `window.parent` IS the host's window. ADR 0009 (amendment 2026-09-17)
// carries the argument.
//
// The page is the shape that surfaced the bug: several SAME-ORIGIN frames — `blob:` documents,
// which inherit the host's origin, as in a gallery of preview tiles — with one host channel per
// frame, and frames announcing `template/ready` + `template/content-height` to `window.parent`.
// Every origin is fake and answered by `page.route`: no server, no network. The surface is bundled
// from `src/` when this file loads, so a run tests the source under review, never a stale `lib/`.
//
// NEGATIVE ASSERTIONS WITHOUT SLEEPS. A browser dispatches a message event to every `'message'`
// listener on the window in the same task, and posted messages queue in the order they were
// posted. So "channel B never heard frame A" is settled by waiting for a LATER message B must hear
// (a flush): once that is in, everything dispatched before it was already accepted or dropped.
import { type Page, expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import { join } from 'node:path';

const HOST = 'https://host.test';
const FOREIGN = 'https://foreign.test';

const [surface] = buildSync({
    entryPoints: [join(__dirname, '../../src/postmessage.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
}).outputFiles;
if (surface === undefined) throw new Error('esbuild produced no bundle');

// The host document. `listen` builds one channel per frame in a gallery tile's own spelling — a
// thunk over the frame, one origin for every tile — and records what it hears as `event:payload`.
const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body><script type="module">
import { channel } from '/postmessage.mjs';
const heard = {};
const hosts = {};
const frames = {};
const hear = async (ch, type, into) => {
    for await (const ev of ch.events(type).stream())
        if (ev.type === 'delta') into.push(type.slice('template/'.length) + ':' + ev.chunk);
};
window.harness = {
    heard,
    frames,
    kept: {},
    listen(key, target) {
        const into = (heard[key] = []);
        const ch = channel.window({ target, origins: location.origin });
        void hear(ch, 'template/ready', into);
        void hear(ch, 'template/content-height', into);
        hosts[key] = ch;
    },
    update: (key, value) => hosts[key].emit('template/update')({ body: value }),
    say: (key, tag) => frames[key].contentWindow.say(tag),
    async blob(name) {
        const html = await (await fetch('/frame.html?name=' + name)).text();
        return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    },
    // Replace whatever element sits at \`key\` with a NEW <iframe>, and wait for its document to
    // announce itself.
    async mount(key, name) {
        frames[key]?.remove();
        const frame = document.createElement('iframe');
        frame.src = await this.blob(name);
        document.body.append(frame);
        frames[key] = frame;
        while (!frame.contentWindow?.announced) await new Promise((r) => setTimeout(r, 10));
        await frame.contentWindow.announced;
    },
};
</script>`;

// A preview document. Every new DOCUMENT announces itself once, as a real preview does; `say`
// speaks again on demand (the flush); `updates` is what its own channel accepted from the host.
const framePage = (
    name: string,
): string => `<!doctype html><meta charset="utf-8"><body><script type="module">
import { channel } from '${HOST}/postmessage.mjs';
const toHost = channel.window({ target: () => window.parent, origins: location.origin });
const ready = toHost.emit('template/ready');
const height = toHost.emit('template/content-height');
window.updates = [];
void (async () => {
    for await (const ev of toHost.events('template/update').stream())
        if (ev.type === 'delta') window.updates.push(ev.chunk);
})();
window.say = async (tag) => {
    await ready({ body: tag });
    await height({ body: tag });
};
// Post from THIS window to a sibling frame: a same-origin window that is not the sibling's parent.
window.postToSibling = (index, envelope) => parent.frames[index].postMessage(envelope, location.origin);
// One macrotask first, so the \`updates\` subscription above is live before anyone is told to talk.
window.announced = new Promise((r) => setTimeout(r, 0)).then(() => window.say(${JSON.stringify(name)}));
</script>`;

// A document at a FOREIGN origin that talks to its parent the way a preview would.
const FOREIGN_PAGE = `<!doctype html><script>
parent.postMessage({ type: 'template/ready', payload: 'foreign' }, '*');
</script>`;

interface Harness {
    heard: Record<string, string[]>;
    frames: Record<string, HTMLIFrameElement>;
    kept: Record<string, unknown>;
    listen(
        key: string,
        target: Window | (() => Window | null | undefined),
    ): void;
    update(key: string, value: string): Promise<void>;
    say(key: string, tag: string): Promise<void>;
    blob(name: string): Promise<string>;
    mount(key: string, name: string): Promise<void>;
}
type HostWindow = Window & { harness: Harness };
type FrameWindow = Window & {
    updates: string[];
    postToSibling(index: number, envelope: unknown): void;
};

// Resolves once channel `key` has heard `tag` on both events.
const heardBoth = async (
    page: Page,
    key: string,
    tag: string,
): Promise<void> => {
    await page.waitForFunction(
        ([k, t]) => {
            const heard = (window as unknown as HostWindow).harness.heard[k];
            return (
                heard?.includes(`ready:${t}`) === true &&
                heard.includes(`content-height:${t}`)
            );
        },
        [key, tag] as const,
    );
};

const heardBy = (page: Page, key: string): Promise<string[]> =>
    page.evaluate(
        (k) => [...((window as unknown as HostWindow).harness.heard[k] ?? [])],
        key,
    );

let pageErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route(`${HOST}/**`, async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/postmessage.mjs')
            await route.fulfill({
                contentType: 'text/javascript',
                body: surface.text,
            });
        else if (url.pathname === '/frame.html')
            await route.fulfill({
                contentType: 'text/html',
                body: framePage(url.searchParams.get('name') ?? ''),
            });
        else await route.fulfill({ contentType: 'text/html', body: HOST_PAGE });
    });
    await page.route(`${FOREIGN}/**`, (route) =>
        route.fulfill({ contentType: 'text/html', body: FOREIGN_PAGE }),
    );
    await page.goto(`${HOST}/`);
    await page.waitForFunction(() => 'harness' in window);
});

test.afterEach(() => {
    expect(pageErrors).toEqual([]);
});

test('two same-origin frames, two host channels: a message from frame A never reaches channel B, nor B channel A', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        h.listen('A', () => h.frames['A']?.contentWindow);
        h.listen('B', () => h.frames['B']?.contentWindow);
        await Promise.all([h.mount('A', 'A'), h.mount('B', 'B')]);
        // Both frames have announced. Each now speaks once more, AFTER both announcements.
        await h.say('A', 'flush-A');
        await h.say('B', 'flush-B');
    });
    await heardBoth(page, 'A', 'flush-A');
    await heardBoth(page, 'B', 'flush-B');

    expect(await heardBy(page, 'A')).toEqual([
        'ready:A',
        'content-height:A',
        'ready:flush-A',
        'content-height:flush-A',
    ]);
    expect(await heardBy(page, 'B')).toEqual([
        'ready:B',
        'content-height:B',
        'ready:flush-B',
        'content-height:flush-B',
    ]);
});

test('a reload and a re-minted `src` keep the WindowProxy: the channel stays bound, and still exclusive', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        h.listen('A', () => h.frames['A']?.contentWindow);
        h.listen('B', () => h.frames['B']?.contentWindow);
        await Promise.all([h.mount('A', 'A'), h.mount('B', 'B')]);
    });
    // A frame's `announced` settles when it POSTS; wait until the host has actually heard both
    // first documents, so nothing from them is still in flight when the slate is wiped.
    await heardBoth(page, 'A', 'A');
    await heardBoth(page, 'B', 'B');

    await page.evaluate(() => {
        const h = (window as unknown as HostWindow).harness;
        const before = h.frames['A']!.contentWindow!;
        h.kept['before'] = before;
        // A Window passed DIRECTLY, not a thunk: it must stay bound across navigation too.
        h.listen('A-direct', before);
        h.heard['A']!.length = 0;
        h.heard['B']!.length = 0;
        before.location.reload();
    });
    await heardBoth(page, 'A', 'A');

    await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        // The template changed: a new blob is minted into the SAME element.
        h.frames['A']!.src = await h.blob('A-remint');
    });
    await heardBoth(page, 'A', 'A-remint');

    const sameWindow = await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        await h.say('B', 'flush-B');
        return h.frames['A']!.contentWindow === h.kept['before'];
    });
    await heardBoth(page, 'B', 'flush-B');

    expect(sameWindow).toBe(true);
    const reloadedAndReminted = [
        'ready:A',
        'content-height:A',
        'ready:A-remint',
        'content-height:A-remint',
    ];
    expect(await heardBy(page, 'A')).toEqual(reloadedAndReminted);
    expect(await heardBy(page, 'A-direct')).toEqual(reloadedAndReminted);
    expect(await heardBy(page, 'B')).toEqual([
        'ready:flush-B',
        'content-height:flush-B',
    ]);
});

test('a remount is a new window: a thunk target follows it, a Window passed directly does not', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        h.listen('thunk', () => h.frames['A']?.contentWindow);
        await h.mount('A', 'A');
    });
    await heardBoth(page, 'thunk', 'A');

    const sameWindow = await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        const before = h.frames['A']!.contentWindow!;
        h.listen('direct', before);
        // The tile re-renders with a NEW <iframe> element.
        await h.mount('A', 'A-remount');
        await h.say('A', 'flush');
        return h.frames['A']!.contentWindow === before;
    });
    await heardBoth(page, 'thunk', 'flush');

    expect(sameWindow).toBe(false);
    expect(await heardBy(page, 'thunk')).toEqual([
        'ready:A',
        'content-height:A',
        'ready:A-remount',
        'content-height:A-remount',
        'ready:flush',
        'content-height:flush',
    ]);
    expect(await heardBy(page, 'direct')).toEqual([]);
});

test("a frame's own channel is bound to `window.parent`: a same-origin sibling cannot speak for the host", async ({
    page,
}) => {
    const updatesOfA = (): Promise<string[]> =>
        page.evaluate(() => [
            ...(
                (window as unknown as HostWindow).harness.frames['A']!
                    .contentWindow as FrameWindow
            ).updates,
        ]);

    await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        h.listen('A', () => h.frames['A']?.contentWindow);
        await Promise.all([h.mount('A', 'A'), h.mount('B', 'B')]);
        await h.update('A', 'host-1');
    });
    await expect.poll(updatesOfA).toEqual(['host-1']);

    await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        const index = [...document.querySelectorAll('iframe')].indexOf(
            h.frames['A']!,
        );
        // Frame B posts the host's own envelope to frame A — same origin, wrong window.
        (h.frames['B']!.contentWindow as FrameWindow).postToSibling(index, {
            type: 'template/update',
            payload: 'sibling-B',
        });
        await h.update('A', 'host-2');
    });
    // The sibling's message was posted first, so it would sit between the two host updates.
    await expect.poll(updatesOfA).toEqual(['host-1', 'host-2']);
});

test('a frame navigated to a foreign origin keeps its WindowProxy, so the origin gate is what drops it', async ({
    page,
}) => {
    await page.evaluate(async () => {
        const h = (window as unknown as HostWindow).harness;
        h.listen('A', () => h.frames['A']?.contentWindow);
        await h.mount('A', 'A');
    });
    await heardBoth(page, 'A', 'A');

    const fromTheSameWindow = await page.evaluate(async (foreign) => {
        const h = (window as unknown as HostWindow).harness;
        const before = h.frames['A']!.contentWindow;
        const seen = new Promise<boolean>((resolve) => {
            addEventListener('message', (e) => {
                if (e.origin === foreign) resolve(e.source === before);
            });
        });
        h.frames['A']!.src = `${foreign}/`;
        return seen;
    }, FOREIGN);

    // The peer check PASSES this message — the posting window is still the channel's target…
    expect(fromTheSameWindow).toBe(true);
    // …so it is the origin gate alone that keeps it out.
    expect(await heardBy(page, 'A')).toEqual(['ready:A', 'content-height:A']);
});
