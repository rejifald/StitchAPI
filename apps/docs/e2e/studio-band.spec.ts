import { expect, test } from '@playwright/test';

/**
 * The studio band — credit + cross-links after the home page's footer
 * (docs/design/studio-band/anatomy.md; app/(home)/components/studio-band.tsx).
 * Proves the band renders on the home page with the data file's links, and
 * that its colour tokens switch with the `.dark` class next-themes puts on
 * `<html>` (RootProvider, default "system") — the same signal a real
 * light/dark toggle flips, live, with no reload.
 */

const BAND = 'section:has(#studio-band-title)';

test.describe('studio band', () => {
    test('renders after the footer with the three related links, the all-projects link, and the ask', async ({
        page,
    }) => {
        await page.goto('/');

        const band = page.locator(BAND);
        await expect(band).toBeVisible();

        // A sibling *after* <footer>, not inside it — the footer keeps its own
        // baselines and the band's background/rule stay full-bleed.
        const bandFollowsFooter = await page.evaluate((sel) => {
            const footerEl = document.querySelector('footer');
            const bandEl = document.querySelector(sel);
            if (!footerEl || !bandEl) return false;
            return !!(
                footerEl.compareDocumentPosition(bandEl) &
                Node.DOCUMENT_POSITION_FOLLOWING
            );
        }, BAND);
        expect(bandFollowsFooter).toBe(true);

        // The wordmark's SVG is aria-hidden; its link's aria-label supplies
        // "Oleks Crane" to the *accessible name* (not the rendered text —
        // aria-label never appears in textContent), so the <h2> reads
        // "Other projects by the studio Oleks Crane".
        await expect(
            band.getByRole('heading', { level: 2 }),
        ).toHaveAccessibleName('Other projects by the studio Oleks Crane');
        const wordmark = band.getByRole('link', { name: 'Oleks Crane' });
        await expect(wordmark).toHaveAttribute(
            'href',
            'https://olekscrane.com/work/stitchapi',
        );
        // Same tab: no target/rel on any band link, so olekscrane.com still
        // gets the host's origin as the referrer.
        await expect(wordmark).not.toHaveAttribute('target');

        const allProjects = band.getByRole('link', { name: /all projects/i });
        await expect(allProjects).toHaveAttribute(
            'href',
            'https://olekscrane.com/work',
        );
        await expect(allProjects).not.toHaveAttribute('target');

        for (const [name, slug] of [
            ['Yakir', 'yakir'],
            ['Langtell', 'langtell'],
            ['Pervigil', 'pervigil'],
        ] as const) {
            const item = band.getByRole('link', { name: new RegExp(name) });
            await expect(item).toHaveAttribute(
                'href',
                `https://olekscrane.com/work/${slug}`,
            );
            await expect(item).not.toHaveAttribute('target');
        }

        await expect(band.getByText('Have something to build?')).toBeVisible();
        await expect(band.getByText('Tell me what you')).toBeVisible();
        const ask = band.getByRole('link', { name: /discuss a project/i });
        await expect(ask).toHaveAttribute(
            'href',
            'https://olekscrane.com/contact',
        );
        await expect(ask).not.toHaveAttribute('target');
    });

    test('colours switch with the .dark class on <html>, live', async ({
        page,
    }) => {
        // Pin the starting scheme so the assertion doesn't depend on the
        // runner's own OS preference — next-themes ("system") would otherwise
        // resolve the band's initial light/dark state from it.
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto('/');
        const band = page.locator(BAND);

        await page.evaluate(() =>
            document.documentElement.classList.remove('dark'),
        );
        const lightBg = await band.evaluate(
            (el) => getComputedStyle(el).backgroundColor,
        );
        expect(lightBg, '--band-bg light is #ffffff').toBe(
            'rgb(255, 255, 255)',
        );

        // The same signal next-themes flips on a real toggle — no reload.
        await page.evaluate(() =>
            document.documentElement.classList.add('dark'),
        );
        const darkBg = await band.evaluate(
            (el) => getComputedStyle(el).backgroundColor,
        );
        expect(darkBg, '--band-bg dark is #0b0e0c').toBe('rgb(11, 14, 12)');
        expect(darkBg).not.toBe(lightBg);
    });

    test('docs pages render no footer and get no band', async ({ page }) => {
        await page.goto('/docs');
        await expect(page.locator(BAND)).toHaveCount(0);
    });

    test('keyboard focus shows the 2px accent outline', async ({ page }) => {
        await page.goto('/');
        const band = page.locator(BAND);
        await band.scrollIntoViewIfNeeded();

        const wordmark = band.getByRole('link', { name: 'Oleks Crane' });
        await wordmark.focus();
        const outline = await wordmark.evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
                style: cs.outlineStyle,
                width: cs.outlineWidth,
                color: cs.outlineColor,
                offset: cs.outlineOffset,
            };
        });
        // `outline-style` matters as much as the width/color here: the shared
        // --tw-outline-style custom property Tailwind's outline-hidden (used
        // to suppress the browser's own default ring) sets to "none" is the
        // same one every outline-* utility reads its style from — left
        // unreset on :focus-visible, the ring computes width/color/offset
        // correctly but never actually paints (regression: no fix landed,
        // this failed with style "none").
        expect(outline.style).toBe('solid');
        expect(outline.width).toBe('2px');
        expect(outline.offset).toBe('3px');
        expect(outline.color).toBe('rgb(180, 52, 59)'); // --band-accent light
    });

    test('content column shares left/right edges with the footer', async ({
        page,
    }) => {
        for (const width of [1440, 375]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto('/');

            const footerBox = await page.locator('footer > div').boundingBox();
            const bandBox = await page.locator(`${BAND} > div`).boundingBox();
            if (!footerBox || !bandBox) {
                throw new Error(
                    `could not measure the footer/band column at ${width}px`,
                );
            }

            const leftDiff = Math.abs(bandBox.x - footerBox.x);
            const rightDiff = Math.abs(
                bandBox.x + bandBox.width - (footerBox.x + footerBox.width),
            );
            // Same column as the footer, not just the same max-width: the
            // band used to pad its own max-w-5xl div, eating 48px out of
            // that column instead of bounding it before centering — a
            // regression that only showed above the 375 breakpoint, where
            // max-w-5xl never binds and the two happen to coincide anyway.
            expect(leftDiff, `left edge at ${width}px`).toBeLessThan(1);
            expect(rightDiff, `right edge at ${width}px`).toBeLessThan(1);
        }
    });
});
