'use client';

import { foldReferralSource } from '@/lib/referral-attribution';

import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next';

/* A client component because `beforeSend` is a function prop: it cannot cross the
   server/client boundary from the root layout, and marking the layout itself
   `'use client'` would strip its `metadata` export. The rewrite rule — and why the
   npm front door is invisible without it — lives in lib/referral-attribution.ts. */
export function AnalyticsWithReferrals() {
    return (
        <Analytics
            beforeSend={(event: BeforeSendEvent) => ({
                ...event,
                url: foldReferralSource(event.url),
            })}
        />
    );
}
