'use client';

import { useEffect } from 'react';

const SETTLE_MS = 150;

/**
 * Twoslash's hover popups (fumadocs-twoslash) open on `pointerenter` over an
 * annotated token. Browsers re-run hit-testing on scroll, so a token sliding
 * under a stationary cursor fires real pointerenter/pointerleave events with
 * no mouse movement at all — on a code block dense with annotated tokens
 * (e.g. reference/helpers.mdx, 14 of them), that flaps popups open and closed
 * while scrolling. `capture: true` on window also catches scroll from nested
 * scrollers (a wide code block's own horizontal scrollbar), which slides
 * tokens the same way. See global.css for the pointer-events rule this drives.
 */
export function TwoslashScrollGuard() {
    useEffect(() => {
        const root = document.documentElement;
        let settleTimer: ReturnType<typeof setTimeout>;

        const onScroll = () => {
            root.setAttribute('data-scrolling', 'true');
            clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
                root.setAttribute('data-scrolling', 'false');
            }, SETTLE_MS);
        };

        window.addEventListener('scroll', onScroll, {
            passive: true,
            capture: true,
        });
        return () => {
            window.removeEventListener('scroll', onScroll, { capture: true });
            clearTimeout(settleTimer);
        };
    }, []);

    return null;
}
