# Brand source masters

The vector + print masters for the StitchAPI **Signal** brand — `logo`,
`logomark`, `baner_light`, `baner_dark`, each as `.svg .png .pdf .ai .eps` —
are the authoring originals behind the web-ready assets.

> [!IMPORTANT]
>
> **Not yet versioned.** The masters currently live only in iCloud:
>
> ```
> ~/Library/Mobile Documents/com~apple~CloudDocs/Work/dev/StitchAPI Logo/
>   ├── logo/        (.svg .png .pdf .ai .eps)
>   ├── logomark/
>   ├── baner_light/
>   └── baner_dark/
> ```
>
> The `.svg` exports use color classes `.st0` / `.st1` / `.st2` and historically
> baked the **old** brand blue (`#3B82F6` / a stray `#3C82F6`). When importing
> them here, recolor to the Signal palette
> ([`tokens.css`](../../../apps/docs/app/tokens.css)) and re-export the web SVGs
> in [`apps/docs/public/`](../../../apps/docs/public) from the updated masters
> rather than hand-editing fills.

Until they are committed, the **code is the source of truth** for color and the
mark — see the [brandbook](../README.md).
