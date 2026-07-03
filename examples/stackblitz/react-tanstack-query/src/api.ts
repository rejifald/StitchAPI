import { stitch } from 'stitchapi';

export interface User {
    id: number;
    name: string;
    email: string;
}

// The same endpoint declaration as the plain quick start. Here it feeds TanStack
// Query as the queryFn — StitchAPI does not replace TanStack Query, it fills it.
export const getUsers = stitch<User[]>('https://demo.stitchapi.dev/users');
