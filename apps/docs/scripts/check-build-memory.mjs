// Run this app's production build inside a box the size of Vercel's build machine,
// and fail when it does not fit (#829).
//
// Vercel builds the docs on its standard build machine: 2 CPUs, 8 GB, no swap.
// From 2026-09-19 every production deploy was OOM-killed inside `next build` there
// (Vercel then reports `routes-manifest.json couldn't be found`, which is only the
// aftermath), while CI built the same commits green on a 4-CPU / 16 GB runner.
// Nothing that ran before merge was as small as the machine that deploys.
//
// This script closes that gap. CI starts it inside a cgroup cut to that machine
// (the `verify-docs` job in .github/workflows/verify.yml), and it:
//
//   1. runs this app's `build` script — the command Vercel runs;
//   2. samples the cgroup's memory every SAMPLE_MS; and
//   3. fails when the build exits non-zero, when the kernel OOM-killed anything
//      in the cgroup, or when the peak crosses BUDGET_BYTES.
//
// What it measures: anon + shmem + kernel from the cgroup's memory.stat, plus any
// swap in use — the memory the kernel cannot give back. Page cache is left out on
// purpose: the kernel drops it before it OOM-kills anything, and it grows into
// whatever limit it is given, so `memory.peak` (which counts it) sits near the
// ceiling for any build and says nothing about this one.
//
// Why 6 GiB: the machine has 8. The build does not have it to itself — the Vercel
// CLI that drives it and the page cache its own reads need share the same 8 — and a
// budget at the ceiling passes a build one content change away from the OOM kill.
// 6 GiB keeps a quarter of the machine free. For scale: on the commits #829 lists,
// `next build` (Turbopack) peaked at 7.3–7.9 GiB and was OOM-killed at the 8 GiB
// ceiling; the webpack build that replaced it peaks at 3.9–4.2 GiB. Raise the number
// only as a conscious act — here, in the same PR, saying why — the way the core
// package's bundle-size ceilings work.
//
// It needs Linux with cgroup v2 and a memory limit on its own cgroup; anywhere else
// it refuses to run rather than pass. To reproduce the CI gate on a laptop, run it
// in a container with the same limits, e.g.
//
//     docker run --rm --cpus 2 --memory 8g --memory-swap 8g -v "$PWD":/src:ro \
//         node:24-bookworm bash -c 'git clone -q /src /w && cd /w && corepack enable \
//         && pnpm install --frozen-lockfile && pnpm --filter @stitchapi/docs check:build-memory'
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GIB = 1024 ** 3;

/** Unreclaimable memory the build may peak at. See the header before changing it. */
export const BUDGET_BYTES = 6 * GIB;

const SAMPLE_MS = 250;

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * GiB with two decimals, for the report.
 * @param {number} bytes
 */
export function gib(bytes) {
    return `${(bytes / GIB).toFixed(2)} GiB`;
}

/**
 * The cgroup v2 directory this process runs in, from the text of
 * /proc/self/cgroup (`0::/system.slice/x.scope`, or `0::/` inside a container's
 * own cgroup namespace). `null` when there is no v2 entry (cgroup v1 host).
 * @param {string} procSelfCgroup
 * @returns {string | null}
 */
export function cgroupDir(procSelfCgroup) {
    const line = procSelfCgroup
        .split('\n')
        .find((entry) => entry.startsWith('0::'));
    if (!line) return null;
    const path = line.slice(3).trim();
    return path === '/' ? '/sys/fs/cgroup' : `/sys/fs/cgroup${path}`;
}

/**
 * A cgroup v2 flat-keyed file (memory.stat, memory.events) as numbers.
 * @param {string} text
 * @returns {Record<string, number | undefined>}
 */
export function parseKeyed(text) {
    /** @type {Record<string, number | undefined>} */
    const values = {};
    for (const line of text.trim().split('\n')) {
        const [key, value] = line.split(' ');
        if (key && value !== undefined) values[key] = Number(value);
    }
    return values;
}

/**
 * The memory in a cgroup that the kernel cannot reclaim: anonymous memory, shmem
 * (tmpfs and shared anonymous mappings, which memory.stat files under `file`), and
 * kernel memory. `kernel` is a single key on current kernels; older ones only
 * report its parts.
 * @param {string} memoryStat
 * @returns {number}
 */
export function unreclaimableBytes(memoryStat) {
    const stat = parseKeyed(memoryStat);
    const kernel =
        stat.kernel ??
        (stat.kernel_stack ?? 0) +
            (stat.pagetables ?? 0) +
            (stat.percpu ?? 0) +
            (stat.sock ?? 0) +
            (stat.slab ?? 0) +
            (stat.vmalloc ?? 0);
    return (stat.anon ?? 0) + (stat.shmem ?? 0) + kernel;
}

/**
 * Whole CPUs a cgroup's cpu.max allows (`200000 100000` → 2), or null if unlimited.
 * @param {string} cpuMax
 * @returns {number | null}
 */
export function cpuLimit(cpuMax) {
    const [quota, period] = cpuMax.trim().split(/\s+/);
    if (quota === 'max' || !Number(period)) return null;
    return Math.max(1, Math.floor(Number(quota) / Number(period)));
}

/**
 * Why the build fails the gate — empty when it passes.
 * @param {{ exitCode: number, signal: string | null, oomKills: number, peakBytes: number, budgetBytes: number }} run
 * @returns {string[]}
 */
export function verdict({
    exitCode,
    signal,
    oomKills,
    peakBytes,
    budgetBytes,
}) {
    const problems = [];
    if (oomKills > 0) {
        problems.push(
            `the kernel OOM-killed ${oomKills} process(es) — the build does not fit the machine at all`,
        );
    }
    if (exitCode !== 0) {
        problems.push(
            `the build exited with ${signal ? `signal ${signal}` : `code ${exitCode}`}`,
        );
    }
    if (peakBytes > budgetBytes) {
        problems.push(
            `the build peaked at ${gib(peakBytes)}, over the ${gib(budgetBytes)} budget`,
        );
    }
    return problems;
}

function read(path) {
    return readFileSync(path, 'utf8');
}

/** The largest processes in the cgroup right now, by resident memory. */
function largestProcesses(dir, count = 4) {
    const processes = [];
    for (const pid of read(`${dir}/cgroup.procs`).trim().split('\n')) {
        try {
            const rss = /^VmRSS:\s+(\d+) kB/m.exec(read(`/proc/${pid}/status`));
            const cmdline = read(`/proc/${pid}/cmdline`)
                .split('\0')
                .join(' ')
                .trim();
            if (rss) processes.push({ rss: Number(rss[1]) * 1024, cmdline });
        } catch {
            // The process exited between listing and reading — skip it.
        }
    }
    return processes
        .sort((a, b) => b.rss - a.rss)
        .slice(0, count)
        .map(
            ({ rss, cmdline }) =>
                `${gib(rss).padStart(10)}  ${cmdline.slice(0, 160)}`,
        );
}

async function main() {
    const say = (message) => console.log(`[build-memory] ${message}`);
    let dir;
    try {
        dir = cgroupDir(read('/proc/self/cgroup'));
    } catch {
        dir = null;
    }
    const limit = dir ? read(`${dir}/memory.max`).trim() : 'max';
    if (!dir || limit === 'max') {
        console.error(
            '[build-memory] not inside a memory-limited cgroup v2, so there is nothing to\n' +
                'measure against. CI runs this in a scope cut to Vercel’s build machine; see the\n' +
                'header of scripts/check-build-memory.mjs for the same run in a container.',
        );
        process.exit(2);
    }

    const cpus = cpuLimit(read(`${dir}/cpu.max`));
    const env = { ...process.env };
    // Next sizes its build workers from os.cpus(), which inside a cgroup still counts
    // the host's CPUs; Vercel's 2-core machine reports 2. CIRCLE_NODE_TOTAL is Next's
    // own override for that count (next/dist/server/config-shared.js), and nothing
    // else in this build reads it.
    if (cpus && !env.CIRCLE_NODE_TOTAL) env.CIRCLE_NODE_TOTAL = String(cpus);

    say(
        `envelope: ${cpus ?? 'unlimited'} CPUs, ${gib(Number(limit))} memory; ` +
            `budget ${gib(BUDGET_BYTES)} unreclaimable`,
    );

    const oomBefore = parseKeyed(read(`${dir}/memory.events`)).oom_kill ?? 0;
    const started = Date.now();
    let peak = 0;
    let peakAt = 0;
    let atPeak = [];
    let snapshotAt = 0;
    const swapFile = `${dir}/memory.swap.current`;
    const sample = () => {
        let swap = 0;
        try {
            swap = Number(read(swapFile));
        } catch {
            // No swap accounting on this kernel: nothing can be swapped to count.
        }
        const bytes = unreclaimableBytes(read(`${dir}/memory.stat`)) + swap;
        if (bytes <= peak) return;
        peak = bytes;
        peakAt = Date.now() - started;
        // Listing processes costs a few ms; only refresh it as the peak climbs.
        if (bytes - snapshotAt >= 64 * 1024 ** 2) {
            atPeak = largestProcesses(dir);
            snapshotAt = bytes;
        }
    };
    const timer = setInterval(sample, SAMPLE_MS);

    const child = spawn('pnpm', ['run', 'build'], {
        cwd: appRoot,
        env,
        stdio: 'inherit',
    });
    const { exitCode, signal } = await new Promise((settle) => {
        child.on('exit', (code, sig) =>
            settle({ exitCode: code ?? 1, signal: sig }),
        );
        child.on('error', (error) => {
            console.error(error);
            settle({ exitCode: 1, signal: null });
        });
    });
    clearInterval(timer);
    sample();

    const oomKills =
        (parseKeyed(read(`${dir}/memory.events`)).oom_kill ?? 0) - oomBefore;
    const minutes = (ms) =>
        `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
    const problems = verdict({
        exitCode,
        signal,
        oomKills,
        peakBytes: peak,
        budgetBytes: BUDGET_BYTES,
    });

    say(
        `peak ${gib(peak)} at ${minutes(peakAt)} of ${minutes(Date.now() - started)} ` +
            `(budget ${gib(BUDGET_BYTES)}, ceiling ${gib(Number(limit))})`,
    );
    say('largest processes at the peak:');
    for (const line of atPeak) console.log(`    ${line}`);

    if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
            process.env.GITHUB_STEP_SUMMARY,
            [
                '### Docs build in Vercel’s build envelope',
                '',
                '| CPUs | ceiling | budget | peak (unreclaimable) | OOM kills | result |',
                '| --- | --- | --- | --- | --- | --- |',
                `| ${cpus ?? 'unlimited'} | ${gib(Number(limit))} | ${gib(BUDGET_BYTES)} | ${gib(peak)} | ${oomKills} | ${problems.length ? 'fail' : 'pass'} |`,
                '',
            ].join('\n'),
        );
    }

    if (problems.length > 0) {
        for (const problem of problems) {
            console.log(`::error title=Docs build memory::${problem}`);
        }
        say(
            'this build would not deploy on Vercel’s 8 GB machine with room to spare — ' +
                'see scripts/check-build-memory.mjs',
        );
        process.exit(1);
    }
    say('ok — the build fits Vercel’s build machine with room to spare');
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    await main();
}
