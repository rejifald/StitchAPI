// The seed data behind our fake API. No third-party service required — this is
// the "API" the live example stitches against.
export interface User {
    id: number;
    email: string;
    first_name: string;
    last_name: string;
    avatar: string;
}

export const USERS: User[] = [
    { id: 1, email: 'george.bluth@example.com', first_name: 'George', last_name: 'Bluth', avatar: 'https://i.pravatar.cc/150?img=1' },
    { id: 2, email: 'janet.weaver@example.com', first_name: 'Janet', last_name: 'Weaver', avatar: 'https://i.pravatar.cc/150?img=2' },
    { id: 3, email: 'emma.wong@example.com', first_name: 'Emma', last_name: 'Wong', avatar: 'https://i.pravatar.cc/150?img=3' },
    { id: 4, email: 'eve.holt@example.com', first_name: 'Eve', last_name: 'Holt', avatar: 'https://i.pravatar.cc/150?img=4' },
    { id: 5, email: 'charles.morris@example.com', first_name: 'Charles', last_name: 'Morris', avatar: 'https://i.pravatar.cc/150?img=5' },
    { id: 6, email: 'tracey.ramos@example.com', first_name: 'Tracey', last_name: 'Ramos', avatar: 'https://i.pravatar.cc/150?img=6' },
    { id: 7, email: 'michael.lawson@example.com', first_name: 'Michael', last_name: 'Lawson', avatar: 'https://i.pravatar.cc/150?img=7' },
    { id: 8, email: 'lindsay.ferguson@example.com', first_name: 'Lindsay', last_name: 'Ferguson', avatar: 'https://i.pravatar.cc/150?img=8' },
    { id: 9, email: 'tobias.funke@example.com', first_name: 'Tobias', last_name: 'Funke', avatar: 'https://i.pravatar.cc/150?img=9' },
    { id: 10, email: 'byron.fields@example.com', first_name: 'Byron', last_name: 'Fields', avatar: 'https://i.pravatar.cc/150?img=10' },
    { id: 11, email: 'george.edwards@example.com', first_name: 'George', last_name: 'Edwards', avatar: 'https://i.pravatar.cc/150?img=11' },
    { id: 12, email: 'rachel.howell@example.com', first_name: 'Rachel', last_name: 'Howell', avatar: 'https://i.pravatar.cc/150?img=12' },
];
