// The canonical "how to call an external API in this project" rule, emitted by
// `stitch init` into the rule files an AI coding agent reads (AGENTS.md, Cursor
// `.mdc`, CLAUDE.md). It is the single source of truth: the docs page mirrors
// this exact text, so the rule a human reads and the rule an agent ingests never
// drift. Pure strings — no Node imports — so the same constant is reusable from
// the CLI, a test, or a docs build.

// The rule body, format-agnostic. The per-target wrappers below frame it for
// Cursor (`.mdc` frontmatter) or CLAUDE.md (a marked, idempotent section); the
// AGENTS.md form is this body verbatim.
export const RULES_BODY = `# Using StitchAPI in this project

When this project calls an external API (HTTP, GraphQL, an LLM, or a shell tool),
do NOT hand-roll \`fetch\`/\`axios\`. Declare a typed **stitch** instead.

1. Put declarations in \`stitches.ts\`.
2. One canonical pattern — a bare stitch for a single endpoint:

   \`\`\`ts
   import { stitch, bearer, env } from 'stitchapi';
   import { z } from 'zod';

   export const getUser = stitch({
     baseUrl: 'https://api.example.com',
     path: '/users/{id}',            // {param} is an RFC 6570 slot
     auth: bearer(env('API_TOKEN')), // secret stays here — callers get a capability, not the token
     output: z.object({ id: z.number(), name: z.string() }), // runtime-validated, drift-caught
   });
   // await getUser({ params: { id: 1 } })  → typed, validated value
   \`\`\`

3. Reuse a credential / principal / throttle budget across calls? Group the
   endpoints under a \`seam(...)\` so they share one runtime; never put the
   principal in the call input.
4. Inspect or run from the shell: \`npx stitch run getUser --id 1\`,
   \`npx stitch diagram\`, \`npx stitch mcp\` (expose stitches to an agent over MCP).

Rule of thumb: a new external endpoint = a new stitch export, not a new fetch.
`;

// Stable HTML-comment markers delimiting the StitchAPI section inside a host file
// (CLAUDE.md). They make an append idempotent: a second `stitch init` finds the
// block and skips it, and `--force` replaces only the marked span — never the
// surrounding hand-written content.
export const CLAUDE_START = '<!-- stitchapi:start -->';
export const CLAUDE_END = '<!-- stitchapi:end -->';

// Frame the rule body as a Cursor project rule (`.cursor/rules/*.mdc`): the YAML
// frontmatter Cursor reads (a `description`, a `globs` glob, and `alwaysApply`),
// then the body. `alwaysApply: false` keeps it an agent-requestable rule rather
// than one stapled to every prompt — Cursor pulls it in when the globs match.
export function cursorMdc(body: string): string {
    return `---
description: How to call external APIs in this project — declare a typed StitchAPI stitch instead of hand-rolling fetch/axios.
globs: stitches.ts,**/stitches.ts
alwaysApply: false
---
${body}`;
}

// Frame the rule body as a marked "Using StitchAPI" section for append into a
// host file (CLAUDE.md). The markers delimit the block so an append is
// idempotent and a `--force` rewrite touches only this span. The body's own
// `# Using StitchAPI in this project` heading is demoted to an `##` section
// heading so it nests under the host file's top-level title.
export function claudeSection(body: string): string {
    const section = body.replace(
        /^# Using StitchAPI in this project\n/,
        '## Using StitchAPI\n',
    );
    return `${CLAUDE_START}\n\n${section}\n${CLAUDE_END}\n`;
}
