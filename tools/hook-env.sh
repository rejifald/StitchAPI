# Sourced ahead of every lefthook job, via the `{setup}` template in
# lefthook.yml. (Not lefthook's own top-level `rc:` key — as of 2.1.10 that key
# passes config validation but is never sourced for `jobs`.) Sourced, never
# executed, so it sets PATH for the job that follows it in the same shell.
#
# Git hooks run in a NON-INTERACTIVE, non-login shell. That shell never reads
# ~/.zshrc, ~/.bashrc, or ~/.profile, so a PATH assembled there — by a Node
# version manager (nvm, fnm, asdf) or by corepack's shims — is simply absent.
# Every job then dies with `sh: pnpm: command not found`, from a checkout where
# `pnpm` plainly works in the terminal. GUI git clients, editor commit UIs, and
# agent sessions all hit this; a plain `git commit` from a configured terminal
# does not, which is why it looks intermittent.
#
# So put the usual locations back on PATH. Every step below is a no-op when the
# tool is already reachable, so a normal terminal commit is unaffected.

# ---- your own setup first ---------------------------------------------------
# A personal, uncommitted ~/.lefthookrc is sourced here if you have one — first,
# so whatever it puts on PATH wins and every fallback below stays a no-op. This
# is the escape hatch for a toolchain the guesses below won't find.
if [ -s "$HOME/.lefthookrc" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.lefthookrc"
fi

# ---- node -------------------------------------------------------------------
# nvm is a shell function, not a binary: until nvm.sh is sourced, a
# non-interactive shell has no node at all. `--no-use` keeps the sourcing cheap,
# then select the version the user made default.
if ! command -v node >/dev/null 2>&1 && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use >/dev/null 2>&1
    nvm use --silent default >/dev/null 2>&1 ||
        nvm use --silent node >/dev/null 2>&1
fi

# ---- pnpm -------------------------------------------------------------------
# The standalone installer drops pnpm under $PNPM_HOME — ~/Library/pnpm on
# macOS, ~/.local/share/pnpm on Linux — and adds it to PATH from a shell rc.
if ! command -v pnpm >/dev/null 2>&1; then
    for _lh_dir in "$PNPM_HOME" "$HOME/Library/pnpm" "$HOME/.local/share/pnpm"; do
        if [ -n "$_lh_dir" ] && [ -x "$_lh_dir/pnpm" ]; then
            PATH="$_lh_dir:$PATH"
            break
        fi
    done
    unset _lh_dir
fi

# Last resort: package.json pins the package manager via `packageManager`, so
# corepack (bundled with Node) can produce a matching pnpm shim on demand.
# `--install-directory` writes it under .git/ instead of into the Node
# installation, so this never mutates the machine's global toolchain and is
# discarded with the clone.
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
    # --absolute-git-dir, not --git-dir: the latter prints a bare `.git` in a
    # normal clone, which would put a RELATIVE entry on PATH and lose pnpm the
    # moment a job changed directory.
    _lh_shims="$(git rev-parse --absolute-git-dir 2>/dev/null)/lefthook-shims"
    if [ ! -x "$_lh_shims/pnpm" ]; then
        mkdir -p "$_lh_shims" 2>/dev/null &&
            corepack enable --install-directory "$_lh_shims" pnpm >/dev/null 2>&1
    fi
    [ -x "$_lh_shims/pnpm" ] && PATH="$_lh_shims:$PATH"
    unset _lh_shims
fi

export PATH

# Still missing? Say what to do, rather than leaving `command not found` as the
# only clue. Don't exit non-zero — the job itself reports the real failure.
if ! command -v pnpm >/dev/null 2>&1; then
    echo "lefthook: pnpm is not on PATH for this hook's shell." >&2
    if command -v node >/dev/null 2>&1; then
        echo "  Fix it once with: corepack enable" >&2
    else
        echo "  node is missing too — point this shell at your Node install," >&2
        echo "  then run: corepack enable" >&2
    fi
    echo "  Machine-specific PATH tweaks belong in ~/.lefthookrc (sourced above)." >&2
fi

