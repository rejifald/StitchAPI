// Unit coverage for the deploy-envelope gate (scripts/check-build-memory.mjs,
// #829): the cgroup parsing and the pass/fail rule. The gate itself only runs in
// CI, inside a cgroup cut to Vercel's build machine — these pin the parts that
// decide its verdict, so a refactor cannot quietly start counting page cache or
// stop failing an OOM kill.
import {
    BUDGET_BYTES,
    cgroupDir,
    cpuLimit,
    parseKeyed,
    unreclaimableBytes,
    verdict,
} from '../scripts/check-build-memory.mjs';

import { describe, expect, it } from 'vitest';

const GIB = 1024 ** 3;

describe('cgroupDir', () => {
    it('maps a container’s own cgroup namespace to the cgroup root', () => {
        expect(cgroupDir('0::/\n')).toBe('/sys/fs/cgroup');
    });

    it('maps a systemd scope to its directory', () => {
        expect(cgroupDir('0::/system.slice/run-r1.scope\n')).toBe(
            '/sys/fs/cgroup/system.slice/run-r1.scope',
        );
    });

    it('returns null on a cgroup v1 host', () => {
        expect(cgroupDir('12:memory:/docker/abc\n11:cpu:/docker/abc\n')).toBe(
            null,
        );
    });
});

describe('unreclaimableBytes', () => {
    // Trimmed from a real sample of the unfixed build, seconds before the OOM kill.
    const stat = [
        'anon 8456740864',
        'file 204800',
        'kernel 132947968',
        'shmem 0',
        'inactive_file 0',
        'active_file 204800',
    ].join('\n');

    it('counts anon + shmem + kernel', () => {
        expect(unreclaimableBytes(stat)).toBe(8456740864 + 132947968);
    });

    it('never counts page cache, however large', () => {
        const cached = stat
            .replace('file 204800', `file ${6 * GIB}`)
            .replace('inactive_file 0', `inactive_file ${6 * GIB}`);
        expect(unreclaimableBytes(cached)).toBe(unreclaimableBytes(stat));
    });

    it('counts tmpfs / shared memory', () => {
        expect(unreclaimableBytes('anon 100\nshmem 50\nkernel 10')).toBe(160);
    });

    it('sums the kernel parts where the kernel has no single `kernel` key', () => {
        expect(
            unreclaimableBytes(
                'anon 100\nkernel_stack 1\npagetables 2\npercpu 3\nsock 4\nslab 5\nvmalloc 6',
            ),
        ).toBe(121);
    });
});

describe('cpuLimit', () => {
    it('reads the quota as whole CPUs', () => {
        expect(cpuLimit('200000 100000\n')).toBe(2);
    });

    it('is null when unlimited', () => {
        expect(cpuLimit('max 100000\n')).toBe(null);
    });
});

describe('verdict', () => {
    const pass = {
        exitCode: 0,
        signal: null,
        oomKills: 0,
        peakBytes: 3.6 * GIB,
        budgetBytes: BUDGET_BYTES,
    };

    it('passes a build that finishes under budget', () => {
        expect(verdict(pass)).toEqual([]);
    });

    it('keeps a quarter of the 8 GiB machine free', () => {
        expect(BUDGET_BYTES).toBe(6 * GIB);
    });

    it('fails a build over budget even when it finishes', () => {
        expect(verdict({ ...pass, peakBytes: 6.5 * GIB })).toEqual([
            expect.stringContaining('over the 6.00 GiB budget'),
        ]);
    });

    it('fails an OOM kill even when the build reports success', () => {
        expect(verdict({ ...pass, oomKills: 1 })).toEqual([
            expect.stringContaining('OOM-killed'),
        ]);
    });

    it('fails a failed build', () => {
        expect(verdict({ ...pass, exitCode: 1, signal: 'SIGKILL' })).toEqual([
            expect.stringContaining('signal SIGKILL'),
        ]);
    });

    it('parses the oom_kill counter out of memory.events', () => {
        expect(
            parseKeyed('low 0\nhigh 0\nmax 10291\noom 7\noom_kill 2\n')
                .oom_kill,
        ).toBe(2);
    });
});
