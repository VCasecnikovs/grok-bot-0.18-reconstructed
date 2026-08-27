export const DEFAULT_MCP_OAUTH_LOOPBACK_CALLBACK_URL =
  "http://localhost:8787/callback";

export function resolveMcpOAuthLoopbackCallbackUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env.SAND_MCP_OAUTH_CALLBACK_URL?.trim();
  if (raw == null || raw.length === 0)
    return DEFAULT_MCP_OAUTH_LOOPBACK_CALLBACK_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SAND_MCP_OAUTH_CALLBACK_URL must be a valid URL.");
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname) ||
    url.port.length === 0 ||
    url.pathname !== "/callback" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(
      "SAND_MCP_OAUTH_CALLBACK_URL must be an http://localhost:<port>/callback URL.",
    );
  }
  return url.toString();
}
