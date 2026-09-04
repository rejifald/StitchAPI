import { stitch } from 'stitchapi';

export interface User {
    id: number;
    name: string;
    email: string;
}

// A stitch is an endpoint declared once and called like a local function —
// no client instance, no codegen, no config files. The explicit generic types
// the parsed JSON result; swap it for an `output:` schema to also validate it.
export const getUsers = stitch<User[]>(
    'https://jsonplaceholder.typicode.com/users',
);
