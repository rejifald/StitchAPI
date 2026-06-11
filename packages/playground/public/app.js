// StitchAPI Playground — vanilla JS, no framework, no build step.
//
// Flow:
//   1. fetch('/api/demos') -> group by `group` -> render a card per demo.
//   2. Click Run -> open EventSource('/api/run/:id'), render a live timeline as
//      `meta` / `play` / `stitch` / `fail` / `end` events arrive.
//   3. CLOSE the EventSource on `end` AND `fail` (and on transport error) so it
//      never auto-reconnects and re-runs the demo forever.

'use strict';

(function () {
    /* ---- tiny DOM helpers ---------------------------------------------- */

    /** Create an element with optional className, text, and attributes. */
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = String(text);
        return node;
    }

    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    /** Safe pretty-print of an arbitrary value as indented JSON. */
    function pretty(value) {
        try {
            if (typeof value === 'string') return value;
            return JSON.stringify(value, null, 2);
        } catch (_e) {
            return String(value);
        }
    }

    /** Coerce anything to a short, safe one-line string. */
    function str(v) {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        try {
            return JSON.stringify(v);
        } catch (_e) {
            return String(v);
        }
    }

    /* ---- boot ----------------------------------------------------------- */

    const root = document.getElementById('root');

    function showPageError(message) {
        clear(root);
        const box = el('div', 'page-msg bad');
        box.appendChild(el('strong', null, 'Could not load the playground. '));
        box.appendChild(document.createTextNode(message || 'Unknown error.'));
        root.appendChild(box);
    }

    fetch('/api/demos', { headers: { accept: 'application/json' } })
        .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function (demos) {
            if (!Array.isArray(demos))
                throw new Error('Unexpected response shape.');
            render(demos);
        })
        .catch(function (err) {
            showPageError(err && err.message ? err.message : String(err));
        });

    /* ---- render the catalogue ------------------------------------------ */

    function render(demos) {
        clear(root);

        if (demos.length === 0) {
            root.appendChild(
                el('div', 'page-msg', 'No features registered yet.'),
            );
            return;
        }

        // Group by `group`, preserving first-seen order.
        const order = [];
        const byGroup = new Map();
        demos.forEach(function (d) {
            const g = (d && d.group) || 'Other';
            if (!byGroup.has(g)) {
                byGroup.set(g, []);
                order.push(g);
            }
            byGroup.get(g).push(d || {});
        });

        order.forEach(function (groupName) {
            const section = el('section', 'group');
            section.dataset.group = groupName; // lets CSS tint each category

            const head = el('div', 'group-head');
            head.appendChild(el('h2', null, groupName));
            head.appendChild(el('span', 'rule'));
            section.appendChild(head);

            const grid = el('div', 'grid');
            byGroup.get(groupName).forEach(function (demo) {
                grid.appendChild(buildCard(demo));
            });
            section.appendChild(grid);
            root.appendChild(section);
        });
    }

    function buildCard(demo) {
        const id = demo.id;
        const card = el('article', 'card');

        const head = el('div', 'card-head');
        head.appendChild(
            el('h3', null, demo.title || id || 'Untitled feature'),
        );
        if (demo.blurb) head.appendChild(el('p', 'blurb', demo.blurb));
        card.appendChild(head);

        const actions = el('div', 'card-actions');
        const btn = el('button', 'run-btn');
        btn.type = 'button';
        setButtonIdle(btn);
        const status = el('span', 'card-status');
        actions.appendChild(btn);
        actions.appendChild(status);
        card.appendChild(actions);

        const panel = el('div', 'panel');
        card.appendChild(panel);

        // Per-card run state. Only one live EventSource per card at a time.
        const state = { source: null };

        btn.addEventListener('click', function () {
            if (!id) {
                renderSys(panel, 'This feature has no id — cannot run.', true);
                return;
            }
            // Guard against double-clicks / stale streams: tear down any prior run.
            run(id, btn, status, panel, card, state);
        });

        return card;
    }

    function setButtonIdle(btn) {
        clear(btn);
        btn.appendChild(document.createTextNode('Run '));
        btn.appendChild(el('span', null, '▶')); // ▶
        btn.disabled = false;
    }

    function setButtonRunning(btn) {
        clear(btn);
        btn.appendChild(el('span', 'spin'));
        btn.appendChild(document.createTextNode('Running…'));
        btn.disabled = true;
    }

    /* ---- run a single demo over SSE ------------------------------------ */

    function run(id, btn, status, panel, card, state) {
        // Reset any previous stream/state for a clean re-run.
        if (state.source) {
            try {
                state.source.close();
            } catch (_e) {
                /* ignore */
            }
            state.source = null;
        }

        clear(panel);
        status.className = 'card-status';
        status.textContent = '';
        card.classList.add('is-running');
        setButtonRunning(btn);

        let logEl = null; // container that receives event rows (after the note banner)
        let playSeen = false; // have we rendered at least one play divider?
        let finished = false; // guard so end/fail/error only finalize once

        function ensureLog() {
            if (!logEl) {
                logEl = el('div', 'log');
                panel.appendChild(logEl);
            }
            return logEl;
        }

        function autoscroll() {
            // Keep the latest row in view as the stream grows.
            panel.scrollTop = panel.scrollHeight;
        }

        function finish(kind, message) {
            if (finished) return;
            finished = true;
            try {
                if (state.source) state.source.close();
            } catch (_e) {
                /* ignore */
            }
            state.source = null;
            card.classList.remove('is-running');
            setButtonIdle(btn);
            if (kind === 'ok') {
                status.className = 'card-status ok';
                status.textContent = 'done';
            } else if (kind === 'fail') {
                status.className = 'card-status err';
                status.textContent = 'failed';
                if (message) renderSys(ensureLog(), message, true);
            }
            autoscroll();
        }

        let source;
        try {
            source = new EventSource('/api/run/' + encodeURIComponent(id));
        } catch (err) {
            finish(
                'fail',
                'Could not open event stream: ' +
                    (err && err.message ? err.message : String(err)),
            );
            return;
        }
        state.source = source;

        // meta: { id, title, note?, plays }
        source.addEventListener('meta', function (e) {
            const data = parse(e.data);
            if (!data) return;
            if (data.note) {
                // Subtle banner above the log.
                const note = el('div', 'note', data.note);
                panel.appendChild(note);
            }
            ensureLog();
            autoscroll();
        });

        // play: { index, label? } — a new run starts
        source.addEventListener('play', function (e) {
            const data = parse(e.data) || {};
            const log = ensureLog();
            // Only show a divider when it adds signal: a label, or 2nd+ play.
            const hasLabel =
                data.label != null && String(data.label).length > 0;
            if (hasLabel || playSeen) {
                const div = el('div', 'play-divider');
                const idx =
                    typeof data.index === 'number' ? data.index + 1 : null;
                const label = hasLabel
                    ? String(data.label)
                    : idx != null
                      ? 'play ' + idx
                      : 'next play';
                div.appendChild(
                    el('span', 'label', (idx != null ? '◇ ' : '') + label),
                );
                div.appendChild(el('span', 'line'));
                log.appendChild(div);
            }
            playSeen = true;
            autoscroll();
        });

        // stitch: { play, type, at, ...fields }
        source.addEventListener('stitch', function (e) {
            const ev = parse(e.data);
            if (!ev || typeof ev !== 'object') return;
            renderStitch(ensureLog(), ev);
            autoscroll();
        });

        // fail: { message } — server-side failure. MUST close.
        source.addEventListener('fail', function (e) {
            const data = parse(e.data) || {};
            finish('fail', 'Run failed: ' + (data.message || 'unknown error'));
        });

        // end: {} — run complete. MUST close.
        source.addEventListener('end', function () {
            finish('ok');
        });

        // Transport-level error (network drop, server gone). Close to stop the
        // browser's automatic reconnect-and-rerun loop.
        source.onerror = function () {
            if (finished) return;
            // If the connection is closed for good, surface it; otherwise the
            // browser would silently retry. We stop either way.
            finish('fail', 'Connection to the event stream was lost.');
        };
    }

    function parse(raw) {
        if (raw == null) return null;
        try {
            return JSON.parse(raw);
        } catch (_e) {
            return null;
        }
    }

    /* ---- render one stitch event as a compact row ---------------------- */

    function renderStitch(log, ev) {
        const type = ev.type;
        switch (type) {
            case 'start':
                return log.appendChild(rowStart(ev));
            case 'progress':
                return log.appendChild(rowProgress(ev));
            case 'drift':
                return log.appendChild(rowDrift(ev));
            case 'result':
                return log.appendChild(rowResult(ev));
            case 'error':
                return log.appendChild(rowError(ev));
            case 'done':
                return log.appendChild(rowDone(ev));
            case 'delta':
                return log.appendChild(rowDelta(ev));
            default:
                return log.appendChild(rowUnknown(ev));
        }
    }

    /** Shared row scaffold: <div.ev.ev-TYPE><span.glyph/><div.body/></div> */
    function evRow(typeClass, glyph) {
        const row = el('div', 'ev ev-' + typeClass);
        row.appendChild(el('span', 'glyph', glyph));
        const body = el('div', 'body');
        row.appendChild(body);
        return { row: row, body: body };
    }

    function rowStart(ev) {
        const r = evRow('start', '→'); // →
        const method = (ev.method || 'GET').toUpperCase();
        r.body.appendChild(el('span', 'method', method));
        r.body.appendChild(document.createTextNode(' '));
        r.body.appendChild(el('span', 'url', ev.url || '(no url)'));
        if (ev.name) {
            r.body.appendChild(el('span', 'meta', ev.name));
        }
        // Show input only when it carries something.
        if (ev.input && hasContent(ev.input)) {
            r.body.appendChild(el('span', 'meta', 'input ' + str(ev.input)));
        }
        return r.row;
    }

    function rowProgress(ev) {
        const phase = ev.phase || 'request';
        const emph = phase === 'retry' || phase === 'throttled';
        const r = evRow(
            'progress' + (emph ? ' emph' : ''),
            glyphForPhase(phase),
        );
        r.body.appendChild(el('span', 'phase', phase));

        if (ev.attempt != null) {
            r.body.appendChild(el('span', 'meta', 'attempt ' + ev.attempt));
        }
        if (ev.waitedMs != null) {
            const w = el('span', 'waited');
            w.textContent = ' waited ' + ev.waitedMs + 'ms';
            r.body.appendChild(w);
        }
        if (ev.detail) {
            r.body.appendChild(el('span', 'meta', String(ev.detail)));
        }
        return r.row;
    }

    function rowDrift(ev) {
        const f = ev.finding || {};
        const level =
            f.level === 'error' || f.level === 'warn' ? f.level : 'info';
        const r = evRow('drift lvl-' + level, glyphForDrift(level));

        const tag = el('span', 'tag', level);
        r.body.appendChild(tag);
        if (f.path) r.body.appendChild(el('span', 'path', f.path));
        if (f.change) r.body.appendChild(el('span', 'meta', f.change));
        if (f.detail) {
            r.body.appendChild(document.createElement('br'));
            r.body.appendChild(el('span', 'detail', String(f.detail)));
        }
        return r.row;
    }

    function rowResult(ev) {
        const r = evRow('result', '✓'); // ✓
        const head = el('div', 'head');
        head.appendChild(document.createTextNode('result'));
        if (ev.status != null)
            head.appendChild(el('span', 'meta', 'status ' + ev.status));
        if (ev.attempts != null)
            head.appendChild(el('span', 'meta', 'attempts ' + ev.attempts));
        r.body.appendChild(head);
        // Pretty-print the value, indented, in a <pre>.
        const pre = el('pre', null, pretty(ev.value));
        r.body.appendChild(pre);
        return r.row;
    }

    function rowError(ev) {
        const r = evRow('error', '✗'); // ✗
        const head = el('div', 'head');
        head.appendChild(document.createTextNode(ev.name ? ev.name : 'error'));
        if (ev.status != null)
            head.appendChild(el('span', 'meta', 'status ' + ev.status));
        if (ev.attempts != null)
            head.appendChild(el('span', 'meta', 'attempts ' + ev.attempts));
        r.body.appendChild(head);
        if (ev.message) {
            const msg = el('div', 'msg', String(ev.message));
            r.body.appendChild(msg);
        }
        return r.row;
    }

    function rowDone(ev) {
        const ok = ev.ok !== false;
        const r = evRow('done ' + (ok ? 'ok' : 'bad'), ok ? '●' : '●'); // ●
        const parts = [];
        parts.push(ok ? 'done' : 'done (failed)');
        if (ev.ms != null) parts.push(ev.ms + 'ms');
        if (ev.attempts != null)
            parts.push(
                ev.attempts + (ev.attempts === 1 ? ' attempt' : ' attempts'),
            );
        r.body.appendChild(document.createTextNode(parts.join(' · ')));
        return r.row;
    }

    // `delta` isn't in the documented set, but the runtime can emit streamed
    // chunks. Render it as a quiet chunk row rather than dropping it.
    function rowDelta(ev) {
        const r = evRow('delta', '…'); // …
        r.body.appendChild(el('span', 'phase', 'delta'));
        if (ev.chunk !== undefined) {
            const pre = el('pre', null, pretty(ev.chunk));
            r.body.appendChild(pre);
        }
        return r.row;
    }

    function rowUnknown(ev) {
        const r = evRow('sys', '·');
        r.body.appendChild(el('span', 'phase', String(ev.type || 'event')));
        r.body.appendChild(el('span', 'meta', str(ev)));
        return r.row;
    }

    /** A client/transport-level line (not a stitch event). */
    function renderSys(log, message, bad) {
        const row = el('div', 'ev ev-sys' + (bad ? ' bad' : ''));
        row.appendChild(el('span', 'glyph', bad ? '⚠' : '·')); // ⚠ / ·
        row.appendChild(el('span', 'body', message));
        log.appendChild(row);
        return row;
    }

    /* ---- glyph + helper lookups ---------------------------------------- */

    function glyphForPhase(phase) {
        switch (phase) {
            case 'auth':
                return '⚿'; // ⚿ key-ish
            case 'request':
                return '↑'; // ↑
            case 'throttled':
                return '⏱'; // ⏱
            case 'retry':
                return '↻'; // ↻
            case 'paginate':
                return '»'; // »
            default:
                return '·';
        }
    }

    function glyphForDrift(level) {
        if (level === 'error') return '✖'; // ✖
        if (level === 'warn') return '⚠'; // ⚠
        return 'ⓘ'; // ⓘ
    }

    function hasContent(obj) {
        if (obj == null || typeof obj !== 'object') return false;
        return Object.keys(obj).some(function (k) {
            const v = obj[k];
            if (v == null) return false;
            if (typeof v === 'object') return Object.keys(v).length > 0;
            return true;
        });
    }
})();
