import { installSuffix } from './release';

// Append the documented npm dist-tag to the first-party packages inside every
// ```package-install``` block, at build time, so authors keep writing bare names
// (`stitchapi`, `@stitchapi/react`) while readers always get a copy-paste install
// command that pulls the *documented* release rather than the stale `latest` tag.
//
// This runs BEFORE fumadocs' `remarkNpm` plugin (which expands the block into the
// per-package-manager tabs) — see source.config.ts, where remarkPlugins is passed
// as a function so we can prepend instead of append. The transform is a pure
// rewrite of the code node's text, unit-tested in remark-install-channel.test.ts.
//
// Drift-proofing: the suffix comes from lib/release.ts (derived from the canonical
// core version). On a prerelease it is `@rc`; once `1.0.0` ships stable it becomes
// `''` and this plugin turns into a no-op — no per-page edits at release time.

/** Minimal mdast shapes — avoids a direct @types/mdast dependency. */
interface CodeNode {
    type: 'code';
    lang?: string | null;
    value: string;
}
interface ParentNode {
    children?: Node[];
}
type Node = (CodeNode | ParentNode) & { type?: string };

const isCode = (node: Node): node is CodeNode =>
    node.type === 'code' &&
    typeof (node as CodeNode).value === 'string';

/** True for a first-party token that has no explicit version/tag yet. */
function needsSuffix(token: string): boolean {
    if (token === 'stitchapi') return true; // unscoped core, bare
    if (token.startsWith('@stitchapi/')) {
        // A scoped spec carries a tag as a second `@` (e.g. `@stitchapi/react@rc`).
        return token.indexOf('@', 1) === -1;
    }
    return false; // third-party (react, zod, …) or already-tagged → leave alone
}

/** Append `installSuffix` to every bare first-party token in an install line. */
export function addInstallChannel(spec: string, suffix = installSuffix): string {
    if (!suffix) return spec; // stable channel → bare installs are already correct
    return spec.replace(/\S+/g, (token) =>
        needsSuffix(token) ? token + suffix : token,
    );
}

/** remark plugin: rewrite ```package-install``` blocks in place. */
export function remarkInstallChannel() {
    return (tree: Node): void => {
        const visit = (node: Node): void => {
            if (isCode(node) && node.lang === 'package-install') {
                node.value = addInstallChannel(node.value);
                return;
            }
            const children = (node as ParentNode).children;
            if (Array.isArray(children)) children.forEach(visit);
        };
        visit(tree);
    };
}
