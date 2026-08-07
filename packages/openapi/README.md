# @stitchapi/openapi

[![npm](https://img.shields.io/npm/v/@stitchapi/openapi?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/openapi)

**Eject selected operations from an OpenAPI document into ready-to-own
[StitchAPI](https://stitchapi.dev) source.** A build-time code generator, kept
separate from the zero-dep `stitchapi` runtime so it can take build-time
dependencies (a YAML parser, validator emitters) without ever touching the core.

You pick which operations to generate, the files land in a directory you own, and
the generator does not come back to manage them — _eject, not managed
regeneration_ (see [ADR 0013](https://github.com/rejifald/StitchAPI/blob/main/docs/adr/0013-gen-selective-eject-codegen-from-openapi.md)).

## Usage

No install needed — run it with `npx` / `pnpm dlx`:

```bash
# pick by tag (or --only <id>, --grep <substr>, or --all)
npx @stitchapi/openapi ./openapi.yaml --tag pet --out ./src/pet-client

# preview without writing anything
npx @stitchapi/openapi ./openapi.json --all --dry-run
```

| Flag                 | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `<spec>`             | an OpenAPI 3.x document (JSON or YAML)                            |
| `--out, -o <dir>`    | output directory (required unless `--dry-run`)                    |
| `--all`              | generate every operation (otherwise pass a selector)              |
| `--tag <t>`          | only operations with this tag (repeatable)                        |
| `--only <id>`        | only this operationId / export name (repeatable)                  |
| `--grep <substr>`    | only operations whose path contains this substring                |
| `--layout dir\|flat` | `dir` = one folder per operation (default); `flat` = one file     |
| `--validator <t>`    | `types-only` (default). valibot/zod tiers are not implemented yet |
| `--force`            | overwrite files it did not generate (it refuses by default)       |
| `--dry-run`          | print the files to stdout instead of writing them                 |

## What it emits

A `client.ts` [seam](https://stitchapi.dev) (base URL + auth, with `// TODO`s),
one stitch per operation typed via `stitch<T>()`, and **atomic** component types
placed by fan-in — a schema used by ≥2 operations goes to `_shared/`, one used by
a single operation lives **inside that operation's directory** so deleting the
operation deletes its private types too. A `.stitch-gen.json` manifest records the
ownership graph and every path the run wrote — so a re-run replaces what it
generated last time and **refuses to overwrite anything else**, naming the files
and exiting non-zero unless you pass `--force`.

```
src/pet-client/
  client.ts          # the seam: baseUrl + auth (edit the TODOs)
  _shared/pet.ts     # used by ≥2 operations
  get-pet-by-id/
    index.ts         # export const getPetById = client.stitch<Pet>({ ... })
  ...
  .stitch-gen.json   # ownership manifest
```

The output is **yours to edit** — set the base URL and auth in `client.ts`, then:

```ts
import { getPetById } from './pet-client';

const pet = await getPetById({ params: { petId: 1 } }); // typed as Pet
```

### Notes

- **`types-only` is the default** (the lightest frontend tier): it emits TS types
  and a typed `stitch<T>()` but **no runtime validator**, so response validation
  and drift are off until the `valibot`/`zod` tiers ship. A notice tells you so.
- **Auth** maps `securitySchemes` → `bearer` / `apiKey` / `basic` with `env()`
  placeholders; the secret is never emitted. oauth2 is flagged for manual setup.
- The generated client imports from `stitchapi` — add it to your project:
  `npm i stitchapi`.

## Library API

The generator is also a pure library:

```ts
import { type OpenApiDoc, planGen } from '@stitchapi/openapi';

const result = planGen(doc as OpenApiDoc, { tags: 'pet' }); // or tags: ['pet', 'store']
for (const f of result.files) console.log(f.path, f.contents);
```

## License

Apache-2.0
