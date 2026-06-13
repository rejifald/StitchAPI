# Brand master files

Vector and print masters for the StitchAPI logo — the editable originals the web exports are derived from.
Each asset ships as `.svg`, `.png`, `.pdf`, `.ai`, and `.eps`.

## Status: not yet imported

The masters currently live **only in iCloud** and are not versioned here:

```
~/Library/Mobile Documents/com~apple~CloudDocs/Work/dev/StitchAPI Logo/
  ├── logo/          # full lockup (mark + wordmark)
  ├── logomark/      # mark only
  ├── baner_light/   # light banner
  └── baner_dark/    # dark banner
```

To import them, copy each set into a matching subfolder here, e.g.:

```sh
SRC="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Work/dev/StitchAPI Logo"
for kind in logo logomark baner_light baner_dark; do
  mkdir -p "docs/brand/source/$kind"
  cp "$SRC/$kind/"* "docs/brand/source/$kind/"
done
```

> Run this in a terminal with permission to read iCloud Drive (Full Disk Access) — a sandboxed shell is blocked
> from this path by macOS.

## Before committing

-   **Normalize the blue.** The exported `.svg` masters carry a stray `#3C82F6`; the canonical brand blue is
    **`#3B82F6`** (see [`../README.md` §7](../README.md#7-maintenance--open-items)).
-   The `.svg` color classes are `.st0 / .st1 / .st2`; `.st0` is a 159²-px tile background — drop it when exporting
    a transparent mark.
-   These are binaries; this repo commits brand PNGs/SVGs directly (no Git LFS today) — follow that convention
    unless a master is very large.
