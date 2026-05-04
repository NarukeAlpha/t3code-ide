# Ghostty Source Snapshot

This directory vendors the reduced `libghostty-vt` source subset used by T3 Code's web terminal.

- Upstream: https://github.com/ghostty-org/ghostty
- Pinned commit: `f27aa865af5a8f33178d68ef9d9f30b05ba74036`
- Required Zig version: `0.15.2`

The vendored subset excludes Ghostty application assets and test corpus directories that upstream
marks unnecessary for `libghostty-vt` distribution builds.
