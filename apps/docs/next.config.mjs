import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
    reactStrictMode: true,
    // The playground consumes the in-repo sandbox engine (@stitchapi/sandbox), a
    // workspace package that ships raw TS/TSX source — Next must transpile it.
    transpilePackages: ['@stitchapi/sandbox'],
};

export default withMDX(config);
