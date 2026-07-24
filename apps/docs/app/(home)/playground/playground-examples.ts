/**
 * Playground example presets. The playground defaults to the COMPLETE tour so
 * users see the full surface at once, and can switch DOWN to a minimal snippet
 * — simplify when you need to, rather than build up from nothing.
 */
export interface PlaygroundExample {
    /** Stable id, used as the React remount key and the active-tab marker. */
    id: string;
    /** Short tab label. */
    label: string;
    /** One-line hint shown as the tab's title/tooltip. */
    description: string;
    /** Editor contents for this preset. */
    code: string;
}

const COMPLETE_EXAMPLE = `// StitchAPI - the whole library in one runnable file.
//
// This runs in a sandboxed Web Worker against an in-browser fake API
// (demo.stitchapi.dev). No real network, nothing installed. It's the
// *complete* example on purpose: keep what you need, delete the rest -
// every numbered block stands on its own. (Use the Simple tab above for
// the bare minimum.)

// 1 - One declarative client. Config is data, not glue code: a base URL,
//     default headers, an auth credential the stitch holds for you, and a
//     full resilience policy - all described in a single object.
const api = stitch({
  name: 'demo-api',
  baseUrl: 'https://demo.stitchapi.dev',
  headers: { accept: 'application/json' },
  auth: bearer('demo-token'), // sent as Authorization: Bearer ... on every call
  retry: {
    attempts: 4,
    on: [429, 502, 503, 504],
    backoff: 'expo-jitter',
    baseDelay: 100,
    maxDelay: 400,
  },
  timeout: { total: '4s', perAttempt: '2s' }, // fail fast instead of hanging
  throttle: { rate: '50/s' }, // client-side rate limit
  circuit: { failures: 5, cooldown: 1000 }, // stop hammering a dead dep
  idempotency: { header: 'Idempotency-Key' }, // safe-retry writes (GET ignores it)
  hooks: {
    onRetry: () => console.log('   retrying after a transient failure...'),
  },
});

// 2 - Derive endpoint clients with extends: each inherits everything above.
//     pick pulls a value out of an envelope ({ data: ... } -> ...), and
//     output validates what you actually receive (pass a Zod / Standard
//     Schema validator in real code; a plain predicate works too).
const getUser = stitch({
  extends: [api],
  path: '/users/{id}',
  pick: 'data',
  output: (u) => !!u && typeof u.id === 'number' && typeof u.email === 'string',
});

// 3 - .with(...) is partial application: bind input now, reuse the call later.
const user = await getUser.with({ params: { id: 2 } })();
console.log('1) validated + picked user:');
console.log(user);

// 4 - transform reshapes the raw body before pick and validation run.
const listNames = stitch({
  extends: [api],
  path: '/users',
  transform: (body) => body.data.map((u) => u.name),
});
const names = await listNames();
console.log('2) names via transform:', names);

// 5 - Auth, proven. /auth/me echoes the capability, never the token - the
//     bearer credential from step 1 was applied for you.
const me = await stitch({ extends: [api], path: '/auth/me' })();
console.log('3) whoami:', me);

// 6 - Resilience, live. This route fails twice (__flaky=2) before it
//     succeeds; the retry policy + onRetry hook recover it. .stream() yields
//     every lifecycle event (start -> progress -> result -> done) so you can
//     watch the recovery happen instead of just awaiting a value.
const flaky = stitch({ extends: [api], path: '/users', pick: 'data' });
let recovered, attempts;
for await (const event of flaky.stream({ query: { __flaky: 2 } })) {
  if (event.type === 'result') recovered = event.data;
  if (event.type === 'done') attempts = event.attempts;
}
console.log(
  '4) recovered after ' + attempts + ' attempts, ' + recovered.length + ' users',
);

// Tip: shape any call without touching the code - use the Server knobs
// panel (status, latency, streaming, flaky failures, schema drift). They
// apply to every call the next run makes. Or try other routes by hand:
//   /users/9 (404), /status/500, /malformed (HTML), /limited (429)
console.log('done:', { users: recovered.length });
`;

const SIMPLE_EXAMPLE = `// The simplest call: give stitch a URL, await typed data back.
// Runs against the in-browser fake API (demo.stitchapi.dev) - no real network.
// Switch to the Complete tab above to see the full library in action.
const getUser = stitch('https://demo.stitchapi.dev/users/2');
const res = await getUser();
console.log(res);
`;

const VALIDATED_EXAMPLE = `// Validate what you send AND what you receive with a real schema library.
// Runs in a sandboxed Web Worker against the in-browser fake API - no real
// network, nothing installed. The imports resolve to the bundled 'stitchapi'
// and 'zod', so you can paste snippets straight from the docs.
import { stitch } from 'stitchapi';
import { z } from 'zod';

const getUser = stitch({
  baseUrl: 'https://demo.stitchapi.dev',
  path: '/users/{id}',
  pick: 'data', // pull the user out of the { data: ... } envelope
  // Pass a Zod schema (or any Standard Schema) directly.
  input: { params: z.object({ id: z.number() }) }, // typed + validated BEFORE the request
  output: z.object({ id: z.number(), email: z.string() }), // typed + validated AFTER
});

// The argument is typed from \`input\`; \`user\` is typed { id: number; email: string }
// straight from \`output\`. No cast, no codegen - both validated at runtime.
const user = await getUser({ params: { id: 2 } });
console.log(user);
`;

export const PLAYGROUND_EXAMPLES: PlaygroundExample[] = [
    {
        id: 'complete',
        label: 'Complete',
        description:
            'The full tour - config, auth, validation, retries, and streaming.',
        code: COMPLETE_EXAMPLE,
    },
    {
        id: 'simple',
        label: 'Simple',
        description: 'One URL in, typed data out.',
        code: SIMPLE_EXAMPLE,
    },
    {
        id: 'validated',
        label: 'Validated',
        description:
            'Zod schemas on input + output - typed and validated, no codegen.',
        code: VALIDATED_EXAMPLE,
    },
];
