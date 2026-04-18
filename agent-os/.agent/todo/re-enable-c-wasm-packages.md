# Re-enable disabled WASM packages (curl, wget, sqlite3, git)

## Context

The C-based WASM packages (curl, wget, sqlite3) fail to compile because the vanilla wasi-sdk sysroot lacks `<netdb.h>` and other POSIX networking headers. A patched wasi-libc sysroot is needed. git's WASM binary is also not yet built.

curl was removed from the `build-essential` meta-package as a temporary workaround.

## Steps

1. Build the patched wasi-libc sysroot: `cd registry/native && ./scripts/patch-wasi-libc.sh`
2. Rebuild C WASM binaries: `cd registry && make build-wasm-c copy-wasm`
3. Verify curl, wget, sqlite3 binaries appear in their `wasm/` dirs
4. Add curl back to `build-essential` meta-package (`software/build-essential/src/index.ts` and `package.json`)
5. Build and test git WASM binary
6. Remove the "Disabled packages" section from `registry/CLAUDE.md`
7. Publish all packages
