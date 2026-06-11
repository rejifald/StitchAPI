import { stitch } from 'stitchapi';
import { z } from 'zod';

// A single user. Because StitchAPI infers the return type straight from the Zod
// schema, `users[0].first_name` is fully typed below — no manual interfaces.
const userSchema = z.object({
    id: z.number(),
    email: z.string().email(),
    first_name: z.string(),
    last_name: z.string(),
    avatar: z.string().url(),
});

// `validate` runs against the *whole* response, before `unwrap` extracts a
// field from it — so the schemas describe the full envelopes the API returns.
const usersResponseSchema = z.object({
    page: z.number(),
    per_page: z.number(),
    total: z.number(),
    total_pages: z.number(),
    data: z.array(userSchema),
});

const userResponseSchema = z.object({
    data: userSchema,
});

// GET /api/users?per_page=6 — validated, then `unwrap: 'data'` returns just the
// array of users (and its type is inferred as User[]).
const findUsers = stitch({
    path: '/api/users',
    validate: usersResponseSchema,
    unwrap: 'data',
});

// GET /api/users/{id} — a URL Template, validated and unwrapped to one user.
const findUser = stitch({
    path: '/api/users/{id}',
    validate: userResponseSchema,
    unwrap: 'data',
});

const app = document.querySelector<HTMLDivElement>('#app')!;

async function render() {
    const users = await findUsers({ query: { per_page: 6 } });
    const featured = await findUser({ params: { id: 7 } });

    app.innerHTML = `
        <h2>All users <span class="hint">(GET /api/users?per_page=6, unwrapped + validated)</span></h2>
        <ul>
            ${users
                .map(
                    (u) => `
                <li>
                    <img src="${u.avatar}" alt="${u.first_name}" />
                    <span>
                        <strong>${u.first_name} ${u.last_name}</strong><br />
                        <span class="email">${u.email}</span>
                    </span>
                </li>`,
                )
                .join('')}
        </ul>

        <h2>Featured user <span class="hint">(GET /api/users/{id} URL Template, id = 7)</span></h2>
        <pre>${JSON.stringify(featured, null, 2)}</pre>
    `;
}

render().catch((error: unknown) => {
    app.innerHTML = `<pre>${error instanceof Error ? error.message : String(error)}</pre>`;
});
