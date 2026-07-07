/**
 * A tiny web server that runs the agent and renders the run to an HTML page — so
 * opening this in CodeSandbox / StackBlitz *shows* the demo instead of a blank
 * preview. It uses the exact same offline stack as `index.ts`; see `agent.ts`.
 *
 *   npm start   → open the served URL (this file)
 *   npm run cli → the same run, printed to the terminal (index.ts)
 */
import { PROMPT, RAW_USER_RESPONSE, User, createAgent } from './agent.js';

import { createServer } from 'node:http';

const esc = (s: string): string =>
    s.replace(
        /[&<>]/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string,
    );

interface RunResult {
    calls: Array<{ toolName: string; input: unknown }>;
    output: unknown;
    answer: string;
}

async function run(): Promise<RunResult> {
    const agent = await createAgent();
    const calls: RunResult['calls'] = [];
    let output: unknown;
    let answer = '';

    for await (const event of agent.run([], PROMPT)) {
        if (event.type === 'tool.start')
            calls.push({ toolName: event.toolName, input: event.input });
        else if (event.type === 'tool.done') output = event.output;
        else if (event.type === 'text.delta') answer += event.text;
        else if (event.type === 'error') throw event.error;
    }
    return { calls, output, answer };
}

function page({ calls, output, answer }: RunResult): string {
    const schemaFields = Object.keys(User.shape).length; // 4
    const rawFields = Object.keys(RAW_USER_RESPONSE).length; // 7
    const callRows = calls
        .map(
            (c) =>
                `<div class="line"><span class="tag call">tool call</span><code>${esc(c.toolName)}(${esc(JSON.stringify(c.input))})</code></div>`,
        )
        .join('');

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>A stitch as an OpenHarness agent tool</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem; background: #0b0e14; color: #d6deeb;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; color: #fff; }
  .sub { color: #8b98b0; margin: 0 0 1.75rem; }
  .pipe {
    display: flex; flex-wrap: wrap; gap: .5rem; align-items: center;
    margin: 0 0 1.75rem; font-size: .82rem;
  }
  .pipe .box {
    padding: .3rem .6rem; border-radius: 7px; background: #141a26;
    border: 1px solid #232c3d;
  }
  .pipe .arrow { color: #5b6b85; opacity: .6; }
  .pipe b { color: #7cc0ff; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .86em; }
  .card {
    background: #10151f; border: 1px solid #202838; border-radius: 12px;
    padding: 1.1rem 1.25rem; margin: 0 0 1.1rem;
  }
  .card h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em;
    color: #8b98b0; margin: 0 0 .8rem; font-weight: 600; }
  .prompt { color: #ffd27c; }
  .line { display: flex; gap: .6rem; align-items: baseline; padding: .15rem 0; flex-wrap: wrap; }
  .tag {
    flex: none; font-size: .68rem; text-transform: uppercase; letter-spacing: .05em;
    padding: .1rem .4rem; border-radius: 5px; font-weight: 600;
  }
  .tag.call { background: #2a2140; color: #c7a5ff; }
  .tag.result { background: #14261c; color: #7ee2a8; }
  .answer { color: #fff; font-size: 1.05rem; }
  .proof { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; }
  @media (max-width: 560px) { .proof { grid-template-columns: 1fr; } }
  .proof .col { background: #0c1017; border: 1px solid #202838; border-radius: 9px; padding: .75rem .85rem; }
  .proof .col h3 { margin: 0 0 .5rem; font-size: .72rem; color: #8b98b0; font-weight: 600; }
  .proof pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: .8rem; color: #b9c4d8; }
  .proof .kept { color: #7ee2a8; }
  .note { color: #7f8ca6; font-size: .82rem; border-top: 1px solid #202838; padding-top: 1rem; margin-top: 1.75rem; }
  .note a { color: #7cc0ff; }
  .badge { display:inline-block; background:#14261c; color:#7ee2a8; border-radius:5px; padding:.05rem .4rem; font-size:.72rem; }
</style>
</head>
<body>
<main>
  <h1>A stitch, running as a tool inside an OpenHarness agent</h1>
  <p class="sub">Offline &amp; deterministic — mock transport + mock model, no API key. <span class="badge">it ran on page load ↓</span></p>

  <div class="pipe">
    <span class="box"><b>stitch()</b> — validated fn</span><span class="arrow">→</span>
    <span class="box"><b>stitchTool()</b> — AI SDK tool</span><span class="arrow">→</span>
    <span class="box"><b>new Agent({ tools })</b> — agent loop</span>
  </div>

  <div class="card">
    <h2>Prompt</h2>
    <div class="prompt">“${esc(PROMPT)}”</div>
  </div>

  <div class="card">
    <h2>What the agent did</h2>
    ${callRows}
    <div class="line"><span class="tag result">tool result</span><code>${esc(JSON.stringify(output))}</code></div>
  </div>

  <div class="card">
    <h2>Final answer</h2>
    <div class="answer">${esc(answer)}</div>
  </div>

  <div class="card">
    <h2>Why this matters — capability, not credential</h2>
    <div class="proof">
      <div class="col">
        <h3>What the API returned (${rawFields} fields)</h3>
        <pre>${esc(JSON.stringify(RAW_USER_RESPONSE, null, 2))}</pre>
      </div>
      <div class="col">
        <h3>What the model saw (${schemaFields} fields)</h3>
        <pre class="kept">${esc(JSON.stringify(output, null, 2))}</pre>
      </div>
    </div>
    <p class="note" style="border:0;padding:0;margin:.85rem 0 0">
      The stitch validated and <em>shaped</em> the response against its Zod
      <code>output</code> schema before the model ever saw it. A real credential
      (<code>bearer(...)</code>, <code>oauth2(...)</code>) would stay behind this
      boundary too — the agent gets a capability, never the key.
    </p>
  </div>

  <p class="note">
    Runs offline. To make it live: delete the <code>adapter:</code> line in
    <code>agent.ts</code> to hit the real API, or set <code>OPENAI_API_KEY</code>
    for a real model. &nbsp;·&nbsp;
    <a href="https://stitchapi.dev/docs/integrations/vercel-ai">@stitchapi/vercel-ai</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/MaxGfeller/open-harness">OpenHarness</a>
  </p>
</main>
</body>
</html>`;
}

const port = Number(process.env.PORT) || 3000;

createServer(async (req, res) => {
    if (req.url && req.url !== '/') {
        res.writeHead(204);
        res.end();
        return;
    }
    try {
        const html = page(await run());
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(err instanceof Error ? err.stack : err));
    }
}).listen(port, () => {
    console.log(`▶  StitchAPI × OpenHarness demo on http://localhost:${port}`);
});
