export const appName = 'StitchAPI';

// Canonical production origin — the single source of truth for absolute URLs
// (metadataBase, sitemap, robots, Open Graph images, llms.txt examples).
export const siteUrl = 'https://stitchapi.dev';

export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const blogRoute = '/blog';

export const npmUrl = 'https://www.npmjs.com/package/stitchapi';

// GitHub repository, used for "edit on GitHub" / source links.
export const gitConfig = {
    user: 'rejifald',
    repo: 'StitchAPI',
    branch: 'main',
};

export const contributeRoute = '/contribute';

// Derived from `gitConfig` so a repo move stays a one-line change. These back the
// /contribute page and anything else that needs to point a visitor at the project's
// feedback and contribution paths.
export const repoUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
export const issuesUrl = `${repoUrl}/issues`;
export const newIssueUrl = `${repoUrl}/issues/new/choose`;
export const contributingUrl = `${repoUrl}/blob/${gitConfig.branch}/CONTRIBUTING.md`;
export const securityPolicyUrl = `${repoUrl}/blob/${gitConfig.branch}/SECURITY.md`;
// Private vulnerability reporting. Deliberately NOT the issue tracker: a security
// problem filed in public is disclosed to everyone before a fix exists.
export const securityAdvisoryUrl = `${repoUrl}/security/advisories/new`;
