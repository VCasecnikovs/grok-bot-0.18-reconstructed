import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadInstallerModule() {
  const output = path.join(repoRoot, ".build", "tests", "ssh-remote-installer.mjs");
  await mkdir(path.dirname(output), { recursive: true });
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ["source/electron-main/box/ssh-remote-host-installer.ts"],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node26",
  });
  return import(`${pathToFileURL(output).href}?${Date.now()}`);
}

test("SSH installer accepts aliases and rejects destinations that could become options or shell", async () => {
  const installer = await loadInstallerModule();
  for (const value of ["bakeneko", "vladik@example.com", "root@192.0.2.4", "my-server_2"]) {
    assert.equal(installer.normalizeSshDestination(` ${value} `), value);
  }
  for (const value of ["", "-oProxyCommand=bad", "host name", "host;touch", "host:2222", "user@", "a@b@c"] ) {
    assert.throws(() => installer.normalizeSshDestination(value), /SSH server/);
  }
});

test("SSH gateway config is loopback-only and carries the SSH destination", async () => {
  const installer = await loadInstallerModule();
  const config = installer.createSshGatewayConfig("vladik@example.com", "a".repeat(64));
  assert.equal(config.baseUrl, "http://127.0.0.1:31340");
  assert.equal(config.vncProxy.primaryUrl, "http://127.0.0.1:36080/vnc.html");
  assert.equal(config.vncProxy.forkBaseUrl, "http://127.0.0.1:36081");
  assert.deepEqual(config.ssh, { host: "vladik@example.com" });
  assert.equal(installer.parseSshGatewaySettings(config)?.host, "vladik@example.com");
  assert.equal(installer.parseSshGatewaySettings({ ...config, ssh: { host: "-bad" } }), null);
});

test("remote deployment binds services to SSH loopback and persists Codex auth", async () => {
  const installer = await loadInstallerModule();
  assert.match(installer.SSH_REMOTE_INSTALL_SCRIPT, /--publish 127\.0\.0\.1:1340:1340/);
  assert.match(installer.SSH_REMOTE_INSTALL_SCRIPT, /--publish 127\.0\.0\.1:6081:6081/);
  assert.match(installer.SSH_REMOTE_INSTALL_SCRIPT, /--restart unless-stopped/);
  assert.match(installer.SSH_REMOTE_INSTALL_SCRIPT, /codex-home:\/root\/\.codex/);
  assert.match(installer.SSH_REMOTE_INSTALL_SCRIPT, /SAND_AUTO_REVIEW_MODE=off/);
  assert.match(installer.SSH_REMOTE_INSTALL_SCRIPT, /\[\[ ! -O .*auth\.json.*\]\] \|\| chmod 600/);
  assert.doesNotMatch(installer.SSH_REMOTE_INSTALL_SCRIPT, /0\.0\.0\.0:1340:1340/);
});
