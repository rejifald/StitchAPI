/**
 * The studio band — credit + cross-links after the home page's footer
 * (docs/design/studio-band/anatomy.md). Says the studio built StitchAPI,
 * links to its other released projects, and offers to discuss a project —
 * every link leads to olekscrane.com. Server Component: everything here is
 * static (the data file is read at build time) and every interactive state
 * (hover, focus, the light/dark switch) is plain CSS, so no client JS ships.
 *
 * Rendered once, on the home page only, right after `<Footer />`
 * (app/(home)/page.tsx) — stitchapi.dev's docs pages render no footer and
 * get no band (anatomy.md §7, out of scope).
 */
import { type StudioBandLang, getStudioBandData } from './studio-band-data';

import { cn } from '@/lib/cn';

import { ArrowRight } from 'lucide-react';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

// Fixel Text carries both weights the band uses (400/500) as one family via
// next/font/local's array `src` — one @font-face per weight, so the browser
// picks the right static file for whichever `font-weight` a class applies.
// Fixel Display only ever renders at 400 here.
const fixelText = localFont({
    src: [
        {
            path: './studio-band-fonts/FixelText-Regular.woff2',
            weight: '400',
            style: 'normal',
        },
        {
            path: './studio-band-fonts/FixelText-Medium.woff2',
            weight: '500',
            style: 'normal',
        },
    ],
    variable: '--font-fixel-text-raw',
    display: 'swap',
});

const fixelDisplay = localFont({
    src: './studio-band-fonts/FixelDisplay-Regular.woff2',
    weight: '400',
    style: 'normal',
    variable: '--font-fixel-display-raw',
    display: 'swap',
});

/**
 * The "Oleks Crane" wordmark, copied path-for-path (viewBox and `d`,
 * character for character) from the brand kit's `WordmarkSvg`
 * (src/components/site/logo.tsx in the olekscrane repo). Never redraw,
 * stretch or recolour it — it takes the surrounding text colour via
 * `currentColor`. Sized by cap height: height = cap × 1.0743, width follows
 * from the viewBox, so only a height utility is set here.
 */
function StudioBandWordmark({ className }: { className?: string }) {
    return (
        <svg
            viewBox="41 -740 5771 752"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
            className={className}
        >
            <path d="M41 -347L41 -353Q41 -430 66.5 -496Q92 -562 138 -610Q184 -658 247.5 -685Q311 -712 386 -712L386 -712L393 -712Q468 -712 531.5 -685Q595 -658 641 -610Q687 -562 712.5 -496.5Q738 -431 738 -354L738 -354L738 -346Q738 -269 712.5 -203.5Q687 -138 641 -90Q595 -42 531.5 -15Q468 12 393 12L393 12L386 12Q311 12 247.5 -15.5Q184 -43 138.5 -91Q93 -139 67 -205Q41 -271 41 -347L41 -347ZM177 -353L177 -347Q177 -293 192.5 -248.5Q208 -204 236 -172.5Q264 -141 302.5 -123.5Q341 -106 387 -106L387 -106L394 -106Q439 -106 477 -123.5Q515 -141 543 -172.5Q571 -204 586.5 -248.5Q602 -293 602 -347L602 -347L602 -353Q602 -407 586.5 -451.5Q571 -496 543.5 -528Q516 -560 477.5 -577.5Q439 -595 393 -595L393 -595L386 -595Q341 -595 302.5 -577.5Q264 -560 236 -528Q208 -496 192.5 -451.5Q177 -407 177 -353L177 -353ZM847 0L847 -720L971 -720L971 0L847 0ZM1362 9L1353 9Q1294 9 1244.5 -10Q1195 -29 1159.5 -63Q1124 -97 1104.5 -145Q1085 -193 1085 -250L1085 -250L1085 -264Q1085 -321 1105 -370Q1125 -419 1160.5 -454Q1196 -489 1245 -509Q1294 -529 1351 -529L1351 -529L1357 -529Q1411 -529 1456.5 -511Q1502 -493 1535 -461.5Q1568 -430 1586.5 -386Q1605 -342 1605 -289L1605 -289L1605 -222L1208 -222L1208 -221Q1215 -164 1256.5 -129.5Q1298 -95 1361 -95L1361 -95L1366 -95Q1414 -95 1454.5 -114Q1495 -133 1518 -162L1518 -162L1587 -87Q1550 -42 1488.5 -16.5Q1427 9 1362 9L1362 9ZM1211 -305L1487 -305Q1483 -361 1446 -396.5Q1409 -432 1352 -432L1352 -432L1351 -432Q1297 -432 1259.5 -397.5Q1222 -363 1211 -305L1211 -305ZM1720 0L1720 -720L1844 -720L1844 -301L1852 -301L2062 -520L2202 -520L1962 -279L2208 0L2059 0L1852 -246L1844 -246L1844 0L1720 0ZM2477 10L2477 10Q2408 10 2345.5 -8.5Q2283 -27 2233 -65L2233 -65L2295 -154Q2331 -125 2380 -108Q2429 -91 2477 -91L2477 -91Q2521 -91 2544 -106Q2567 -121 2567 -148L2567 -148Q2567 -166 2556 -177.5Q2545 -189 2524 -197Q2503 -205 2473.5 -212.5Q2444 -220 2406 -232L2406 -232Q2378 -240 2351 -250Q2324 -260 2302.5 -276Q2281 -292 2268 -315.5Q2255 -339 2255 -373L2255 -373Q2255 -446 2309 -488Q2363 -530 2454 -530L2454 -530Q2511 -530 2566.5 -513Q2622 -496 2664 -464L2664 -464L2605 -377Q2574 -400 2531 -414.5Q2488 -429 2447 -429L2447 -429Q2407 -429 2388 -415.5Q2369 -402 2369 -379L2369 -379Q2369 -353 2400 -339Q2431 -325 2496 -309L2496 -309Q2529 -301 2563 -290.5Q2597 -280 2624 -263Q2651 -246 2668.5 -219Q2686 -192 2686 -151L2686 -151Q2686 -114 2671 -84Q2656 -54 2628.5 -33Q2601 -12 2562.5 -1Q2524 10 2477 10ZM3358 11L3357 11Q3281 11 3217.5 -16Q3154 -43 3108.5 -91Q3063 -139 3037.5 -204.5Q3012 -270 3012 -348L3012 -348L3012 -352Q3012 -430 3037.5 -495.5Q3063 -561 3109 -609Q3155 -657 3218 -684Q3281 -711 3357 -711L3357 -711Q3448 -711 3519.5 -670Q3591 -629 3636 -560L3636 -560L3536 -488Q3506 -539 3463.5 -565Q3421 -591 3363 -591L3363 -591L3362 -591Q3313 -591 3273.5 -573.5Q3234 -556 3206 -524.5Q3178 -493 3163 -449Q3148 -405 3148 -352L3148 -352L3148 -347Q3148 -295 3163 -251Q3178 -207 3206 -175.5Q3234 -144 3273.5 -126.5Q3313 -109 3361 -109L3361 -109L3362 -109Q3422 -109 3467 -136Q3512 -163 3540 -211L3540 -211L3637 -140Q3595 -71 3522.5 -30Q3450 11 3358 11L3358 11ZM3727 0L3727 -357.5L3649 -304.9L3602 -374.5L4143.8 -740L4190.8 -670.4L3851 -441.2L3851 0ZM4258 10L4258 10Q4218 10 4184.5 -1.5Q4151 -13 4127 -33Q4103 -53 4089.5 -82Q4076 -111 4076 -145L4076 -145L4076 -152Q4076 -321 4390 -321L4390 -321L4432 -321L4432 -344Q4432 -382 4404 -405Q4376 -428 4324 -428L4324 -428L4321 -428Q4280 -428 4235.5 -414Q4191 -400 4152 -375L4152 -375L4101 -465Q4149 -495 4207 -513Q4265 -531 4328 -531L4328 -531L4334 -531Q4381 -531 4420 -519Q4459 -507 4488 -483Q4517 -459 4533 -424Q4549 -389 4549 -342L4549 -342L4549 -107Q4549 -80 4554 -53Q4559 -26 4567 0L4567 0L4449 0Q4444 -12 4440.5 -28.5Q4437 -45 4435 -62L4435 -62Q4402 -29 4357 -9.5Q4312 10 4258 10ZM4283 -90L4283 -90Q4327 -90 4366 -107.5Q4405 -125 4432 -154L4432 -154L4432 -241L4397 -241Q4294 -241 4245 -220.5Q4196 -200 4196 -158L4196 -158L4196 -154Q4196 -126 4220 -108Q4244 -90 4283 -90ZM4693 0L4693 -520L4791 -520Q4796 -504 4800.5 -481Q4805 -458 4807 -441L4807 -441Q4844 -486 4893.5 -508Q4943 -530 4997 -530L4997 -530L5000 -530Q5092 -530 5140 -478.5Q5188 -427 5188 -332L5188 -332L5188 0L5064 0L5064 -306Q5064 -363 5039 -392.5Q5014 -422 4959 -422L4959 -422L4955 -422Q4892 -422 4854.5 -383Q4817 -344 4817 -281L4817 -281L4817 0L4693 0ZM5569 9L5560 9Q5501 9 5451.5 -10Q5402 -29 5366.5 -63Q5331 -97 5311.5 -145Q5292 -193 5292 -250L5292 -250L5292 -264Q5292 -321 5312 -370Q5332 -419 5367.5 -454Q5403 -489 5452 -509Q5501 -529 5558 -529L5558 -529L5564 -529Q5618 -529 5663.5 -511Q5709 -493 5742 -461.5Q5775 -430 5793.5 -386Q5812 -342 5812 -289L5812 -289L5812 -222L5415 -222L5415 -221Q5422 -164 5463.5 -129.5Q5505 -95 5568 -95L5568 -95L5573 -95Q5621 -95 5661.5 -114Q5702 -133 5725 -162L5725 -162L5794 -87Q5757 -42 5695.5 -16.5Q5634 9 5569 9L5569 9ZM5418 -305L5694 -305Q5690 -361 5653 -396.5Q5616 -432 5559 -432L5559 -432L5558 -432Q5504 -432 5466.5 -397.5Q5429 -363 5418 -305L5418 -305Z" />
        </svg>
    );
}

// Every focusable link in the band gets the same focus-visible ring, and every
// arrow gets the same rest → hover treatment; sharing the class strings keeps
// the four link sites (wordmark, all-projects, each item, the ask) in lockstep
// with anatomy.md §5's states table instead of drifting independently.
//
// `outline-hidden` sets the shared --tw-outline-style var to "none" so it wins
// over the browser's own default focus ring — but that var is what every
// `outline-*` utility (incl. `outline-2` below) reads for its outline-style,
// so left alone it silently keeps OUR ring invisible too. Reset the var back
// under focus-visible so `outline-2` actually renders `solid`.
const focusRing =
    'outline-hidden focus-visible:[--tw-outline-style:solid] focus-visible:rounded-[2px] focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-band-accent';

/** 16px, lucide `arrow-right`, stroke 1.5 — accent + 3px move on hover only. */
function StudioBandArrow() {
    return (
        <ArrowRight
            aria-hidden
            strokeWidth={1.5}
            // Tailwind v4's translate-x-* sets the standalone CSS `translate`
            // property (not `transform`), so that's what has to transition.
            className="size-4 shrink-0 text-band-subtle transition-[color,translate] duration-200 ease-out group-hover:text-band-accent motion-safe:group-hover:translate-x-[3px]"
        />
    );
}

function StudioBandLink({
    href,
    className,
    children,
}: {
    href: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <a
            href={href}
            className={cn(
                'group inline-flex min-h-6 items-center gap-1.5 font-fixel-text text-sm leading-5 font-medium',
                focusRing,
                className,
            )}
        >
            {children}
        </a>
    );
}

export function StudioBand({ lang }: { lang: StudioBandLang }) {
    const data = getStudioBandData(lang);

    return (
        <section
            lang={data.lang}
            aria-labelledby="studio-band-title"
            className={cn(
                fixelText.variable,
                fixelDisplay.variable,
                'w-full border-t border-band-line bg-band-bg',
            )}
        >
            {/* Full-bleed background + top rule above; content in the footer's
                own column (max-w-5xl, matching gutters). */}
            <div className="mx-auto max-w-5xl px-6 py-10 lg:py-12">
                <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-4">
                    <h2
                        id="studio-band-title"
                        className="flex flex-wrap items-baseline gap-3"
                    >
                        <span className="font-fixel-display text-[22.86px] leading-none tracking-[-0.01em] text-band-muted">
                            {data.title}
                        </span>
                        {/* SVG is aria-hidden; this label supplies "Oleks Crane" so the
                            heading reads "{title} Oleks Crane". */}
                        <a
                            href={data.studio.href}
                            aria-label={data.studio.name}
                            className={cn('text-band-ink', focusRing)}
                        >
                            <StudioBandWordmark className="h-[17.19px] w-auto" />
                        </a>
                    </h2>
                    <StudioBandLink
                        href={data.all.href}
                        className="text-band-muted transition-colors hover:text-band-ink"
                    >
                        {data.all.label}
                        <StudioBandArrow />
                    </StudioBandLink>
                </div>

                <ul className="mt-7 grid grid-cols-1 gap-5 sm:mt-8 sm:grid-cols-2 sm:gap-x-8 sm:gap-y-6 lg:grid-cols-4 lg:gap-8">
                    {data.related.slice(0, 3).map((item) => (
                        <li key={item.href}>
                            <a
                                href={item.href}
                                className={cn('group flex flex-col', focusRing)}
                            >
                                <div className="flex items-center gap-2">
                                    <span className="font-fixel-text text-base leading-6 font-medium text-band-ink">
                                        {item.name}
                                    </span>
                                    <StudioBandArrow />
                                </div>
                                <p className="mt-2 font-fixel-text text-sm leading-[21px] text-band-muted">
                                    {item.tagline}
                                </p>
                            </a>
                        </li>
                    ))}
                    {data.ask ? (
                        <li
                            className={cn(
                                'border-t border-band-line pt-6',
                                'sm:col-span-2',
                                'lg:col-span-1 lg:col-start-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-7',
                            )}
                        >
                            <p className="font-fixel-text text-base leading-6 font-medium text-band-ink">
                                {data.ask.heading}
                            </p>
                            <p className="mt-2.5 font-fixel-text text-sm leading-[21px] text-band-muted">
                                {data.ask.body}
                            </p>
                            <StudioBandLink
                                href={data.ask.href}
                                className="mt-4 text-band-ink"
                            >
                                {data.ask.label}
                                <StudioBandArrow />
                            </StudioBandLink>
                        </li>
                    ) : null}
                </ul>
            </div>
        </section>
    );
}
