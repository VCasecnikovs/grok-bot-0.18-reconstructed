import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MCP_OAUTH_LOOPBACK_CALLBACK_URL,
  resolveMcpOAuthLoopbackCallbackUrl,
} from "../source/shared/node/mcp/mcp-oauth-callback-url.ts";

test("connector OAuth defaults to the official callback but accepts a separate reconstructed loopback", () => {
  assert.equal(
    resolveMcpOAuthLoopbackCallbackUrl({}),
    DEFAULT_MCP_OAUTH_LOOPBACK_CALLBACK_URL,
  );
  assert.equal(
    resolveMcpOAuthLoopbackCallbackUrl({
      SAND_MCP_OAUTH_CALLBACK_URL: "http://localhost:8788/callback",
    }),
    "http://localhost:8788/callback",
  );
});

test("connector OAuth isolation rejects non-loopback or ambiguous callbacks", () => {
  for (const value of [
    "https://localhost:8788/callback",
    "http://example.com:8788/callback",
    "http://localhost/callback",
    "http://localhost:8788/other",
    "http://user@localhost:8788/callback",
    "http://localhost:8788/callback?slot=other",
  ]) {
    assert.throws(
      () =>
        resolveMcpOAuthLoopbackCallbackUrl({
          SAND_MCP_OAUTH_CALLBACK_URL: value,
        }),
      /SAND_MCP_OAUTH_CALLBACK_URL/,
    );
  }
});
