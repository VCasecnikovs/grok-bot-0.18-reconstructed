# Follow-up work

## Verified on 2026-08-27

- The official stable feed moved from 0.27.0 to 0.29.0. It returned one complete
  signed macOS ZIP (`126619529` bytes), not a blockmap, Webpack delta, or source
  patch. The downloaded ZIP SHA-256 was
  `50774819e699e389811d83317f436e71aac40b9374f62434deececb9e295cac1`;
  its `app.asar` SHA-256 was
  `f3f242c2f8068479e59ed8cf5ffd41d74f57be709ea478494782ead00fdc17ac`.
- The 0.29.0 ASAR was unpacked and compared with 0.18.0. The renderer grew from
  130 to 342 assets, the Settings entrypoint contract changed, the desktop bridge
  added 52 paths and removed 18 paths, and the bundled `dist/host` runtime was
  removed. Replacing the version label or renderer would therefore disconnect
  the working Bakeneko host; this is a protocol port, not a safe payload rebase.
- The official and reconstructed apps use different bundle IDs, Electron profile
  directories, Sand data roots, secret files, and client-persistence directories.
  The remaining connector collision was fixed: official connector OAuth keeps
  `http://localhost:8787/callback`, while the reconstructed app uses the validated
  loopback-only `http://localhost:8788/callback`.

## Still open

- Port the Mac client, desktop bridge, coordinator protocol, and self-hosted host
  together to the post-0.28 architecture before claiming 0.29 compatibility.
  The production reconstruction remains honestly versioned as 0.18 rather than
  shipping an unverified 0.29 renderer over the 0.18 host.
- Run one interactive OAuth sign-in for a dedicated email/connector account in
  the reconstructed app and verify that its server-side plugin state is distinct
  from the account used by the official Grok Bot. Local token and callback
  isolation is now enforced, but two separate third-party accounts are required
  to prove provider-side isolation.
