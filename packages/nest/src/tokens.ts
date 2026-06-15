// Injection tokens. `STITCH_SEAM` is the default seam (forRoot's shared-defaults
// seam); `STITCH_STORE` / `STITCH_TRACE` expose the app-wide shared infrastructure
// so feature modules (forFeature) can build their own seam over it.

/** The default seam — the shared-defaults seam created by `forRoot`/`forRootAsync`. */
export const STITCH_SEAM = Symbol('STITCH_SEAM');

/** The app-wide shared store (a borrowed view when you pass one; else an owned `memoryStore`). */
export const STITCH_STORE = Symbol('STITCH_STORE');

/** The app-wide shared trace sink, or `false` when tracing is off (the default). */
export const STITCH_TRACE = Symbol('STITCH_TRACE');
