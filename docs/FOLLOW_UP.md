# Follow-up work

- Rebase the checksum-pinned upstream payload from 0.18.0 to the current stable
  release, then repeat the renderer patch audit and the complete Mac-to-SSH
  runtime verification. The official stable feed reported 0.27.0 on 2026-08-26.
- Unpack the 0.27.0 ASAR/Webpack payload and produce a reproducible file-level
  diff against 0.18.0. The official macOS updater returns a complete signed ZIP,
  not an open source-code delta.
- Verify connector isolation from the official Grok Bot installation end to end,
  including separate email accounts, OAuth callbacks, stored tokens, and plugin
  state. The reconstructed app already has a separate bundle and secure-storage
  identity, but account-level isolation has not yet been proven.
