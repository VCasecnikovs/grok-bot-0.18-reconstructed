import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { GatewayConnection } from "./gateway-descriptor-cache.js";
import { stageCurrentHostBundle } from "./host-runtime-bundle.js";

export const SSH_REMOTE_CONFIG_FILENAME = "self-hosted-gateway.json";
export const SSH_REMOTE_LOCAL_PORTS = { exec: 31337, auxiliary: 31339, gateway: 31340, vnc: 36080, vncFork: 36081, browser: 38790 } as const;
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new", "-o", "LogLevel=ERROR"] as const;
const IMAGE = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest";
const UPLOAD_ROOT = "$HOME/.local/share/grok-bot-remote/upload";

interface SshGatewaySettings { readonly host: string }
export interface SshRemoteStatus { readonly configured: boolean; readonly host: string | null; readonly ready: boolean; readonly detail: string }
export interface SshInstallResult extends SshRemoteStatus { readonly containerName: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

export function normalizeSshDestination(value: unknown): string {
  const host = typeof value === "string" ? value.trim() : "";
  if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) || host.startsWith("-")) {
    throw new Error("SSH server must be an SSH config alias, hostname, IPv4 address, or user@host. Put custom ports and keys in ~/.ssh/config.");
  }
  return host;
}

export function parseSshGatewaySettings(value: unknown): SshGatewaySettings | null {
  if (!isRecord(value) || !isRecord(value.ssh)) return null;
  try { return { host: normalizeSshDestination(value.ssh.host) }; } catch { return null; }
}

export function createSshGatewayConfig(host: string, token: string): GatewayConnection & { readonly ssh: SshGatewaySettings } {
  return {
    baseUrl: `http://127.0.0.1:${SSH_REMOTE_LOCAL_PORTS.gateway}`,
    token,
    vncProxy: {
      primaryUrl: `http://127.0.0.1:${SSH_REMOTE_LOCAL_PORTS.vnc}/vnc.html`,
      forkBaseUrl: `http://127.0.0.1:${SSH_REMOTE_LOCAL_PORTS.vncFork}`,
      networkToken: "",
    },
    ssh: { host: normalizeSshDestination(host) },
  };
}

function run(command: string, args: readonly string[], input?: Buffer | string, timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", timedOut = false;
    const append = (chunk: Buffer): void => { output += chunk.toString(); if (output.length > 200_000) output = output.slice(-200_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); reject(new Error(`${command} could not start: ${error.message}`)); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(output.trim());
      else reject(new Error(timedOut ? `${command} timed out.` : output.trim() || `${command} exited with code ${String(code)}.`));
    });
    child.stdin.end(input);
  });
}

function sshArgs(host: string, remoteCommand: string): string[] {
  return [...SSH_OPTIONS, normalizeSshDestination(host), remoteCommand];
}

async function upload(host: string, name: "host-main.cjs" | "box-exec-daemon.cjs" | "codex-auth.json", bytes: Buffer): Promise<void> {
  await run("ssh", sshArgs(host, `umask 077; mkdir -p "${UPLOAD_ROOT}"; cat > "${UPLOAD_ROOT}/${name}"`), bytes);
}

export const SSH_REMOTE_INSTALL_SCRIPT = String.raw`set -euo pipefail
image="public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest"
upload_root="$HOME/.local/share/grok-bot-remote/upload"
legacy_app_root="/srv/codex-klava/apps/grok-bot-0.18-reconstructed"
legacy_data_root="/srv/codex-klava/data/grok-bot"

[[ $(uname -m) == x86_64 ]] || { echo "The Grok Bot image requires an x86_64 Linux server." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is not installed or is not available to this SSH user." >&2; exit 1; }

if [[ -d "$legacy_data_root/sand-data" && -w "$legacy_data_root" && -w "$legacy_app_root" ]]; then
  app_root="$legacy_app_root"
  data_root="$legacy_data_root"
  container_name="grok-bot-bakeneko"
else
  app_root="$HOME/.local/share/grok-bot-remote/app"
  data_root="$HOME/.local/share/grok-bot-remote/data"
  container_name="grok-bot-remote"
fi

install -d -m 755 "$app_root/runtime/box-exec-daemon"
install -d -m 700 "$data_root" "$data_root/sand-data" "$data_root/workspace" "$data_root/codex-home"
install -m 600 "$upload_root/host-main.cjs" "$app_root/runtime/host-main.cjs"
install -m 600 "$upload_root/box-exec-daemon.cjs" "$app_root/runtime/box-exec-daemon/main.cjs"
if [[ ! -s "$data_root/codex-home/auth.json" ]]; then
  if [[ -s "$HOME/.codex/auth.json" ]]; then
    install -m 600 "$HOME/.codex/auth.json" "$data_root/codex-home/auth.json"
  elif [[ -s "$upload_root/codex-auth.json" ]]; then
    install -m 600 "$upload_root/codex-auth.json" "$data_root/codex-home/auth.json"
  else
    echo "Codex is not signed in on this server or the Mac running Grok Bot." >&2
    exit 1
  fi
fi
if [[ ! -s "$data_root/gateway-token" ]]; then
  umask 077
  if command -v openssl >/dev/null; then openssl rand -hex 32 > "$data_root/gateway-token"
  else od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$data_root/gateway-token"
  fi
fi
chmod 600 "$data_root/gateway-token"
[[ ! -O "$data_root/codex-home/auth.json" ]] || chmod 600 "$data_root/codex-home/auth.json"

docker pull "$image" >/dev/null
if docker container inspect "$container_name" >/dev/null 2>&1; then
  if [[ "$container_name" == "grok-bot-remote" ]]; then
    [[ $(docker inspect -f '{{index .Config.Labels "com.grok-bot.remote"}}' "$container_name") == 1 ]] || { echo "Container $container_name is not owned by Grok Bot." >&2; exit 1; }
  else
    docker inspect -f '{{range .Mounts}}{{println .Destination}}{{end}}' "$container_name" | grep -qx '/home/box/sand-host/host-main.cjs' || { echo "Container $container_name is not the existing Grok Bot runtime." >&2; exit 1; }
  fi
  docker rm --force "$container_name" >/dev/null
fi

gateway_token=$(tr -d '\n' < "$data_root/gateway-token")
docker run -d \
  --name "$container_name" \
  --label com.grok-bot.remote=1 \
  --restart unless-stopped \
  --env SAND_SUPERVISOR_ENABLED=1 \
  --env SAND_BOX_AUTO_UPDATE=0 \
  --env SAND_USE_EXISTING_BOX_EXEC_DAEMON=1 \
  --env SAND_TREE_SITTER_NODE_DEPS=/home/box/deps \
  --env NODE_PATH=/home/box/deps \
  --env SAND_GATEWAY_BIND_HOST=0.0.0.0 \
  --env SAND_HOST_PORT=1340 \
  --env SAND_AUTO_REVIEW_MODE=off \
  --env "SAND_GATEWAY_TOKEN=$gateway_token" \
  --publish 127.0.0.1:1337:1337 \
  --publish 127.0.0.1:1339:1339 \
  --publish 127.0.0.1:1340:1340 \
  --publish 127.0.0.1:6080:6080 \
  --publish 127.0.0.1:6081:6081 \
  --publish 127.0.0.1:8790:8790 \
  --volume "$data_root/sand-data:/home/box/sand-data" \
  --volume "$data_root/workspace:/workspace" \
  --volume "$data_root/codex-home:/root/.codex" \
  --volume "$app_root/runtime/host-main.cjs:/home/box/sand-host/host-main.cjs:ro" \
  --volume "$app_root/runtime/box-exec-daemon/main.cjs:/home/box/sand-host/box-exec-daemon/main.cjs:ro" \
  "$image" >/dev/null

for _ in $(seq 1 180); do
  if curl -fsS -H "Authorization: Bearer $gateway_token" http://127.0.0.1:1340/health >/dev/null 2>&1; then
    docker exec "$container_name" sh -lc 'test "$SAND_AUTO_REVIEW_MODE" = off && test -w /root/.codex/auth.json'
    rm -f "$upload_root/codex-auth.json"
    printf 'GROK_BOT_REMOTE_RESULT\t%s\t%s\n' "$gateway_token" "$container_name"
    exit 0
  fi
  sleep 1
done
docker logs --tail 80 "$container_name" >&2
exit 1
`;

async function readConfig(settingsPath: string): Promise<(GatewayConnection & { ssh: SshGatewaySettings }) | null> {
  try {
    const value: unknown = JSON.parse(await readFile(join(dirname(settingsPath), SSH_REMOTE_CONFIG_FILENAME), "utf8"));
    const ssh = parseSshGatewaySettings(value);
    if (ssh == null || !isRecord(value) || typeof value.baseUrl !== "string") return null;
    return value as unknown as GatewayConnection & { ssh: SshGatewaySettings };
  } catch { return null; }
}

async function writeConfig(settingsPath: string, config: GatewayConnection & { ssh: SshGatewaySettings }): Promise<void> {
  const directory = dirname(settingsPath), target = join(directory, SSH_REMOTE_CONFIG_FILENAME), temporary = `${target}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function gatewayReady(connection: GatewayConnection): Promise<boolean> {
  try {
    const response = await fetch(`${connection.baseUrl}/health`, { headers: connection.token == null ? {} : { authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1_000) });
    return response.ok && (await response.json() as { ok?: unknown }).ok === true;
  } catch { return false; }
}

let tunnel: { readonly host: string; readonly child: ChildProcess; stderr: string } | undefined;

export async function ensureSshGatewayTunnel(connection: GatewayConnection, ssh: SshGatewaySettings): Promise<void> {
  if (await gatewayReady(connection)) return;
  if (tunnel != null && (tunnel.host !== ssh.host || tunnel.child.exitCode != null)) {
    tunnel.child.kill("SIGTERM");
    tunnel = undefined;
  }
  if (tunnel == null) {
    const forwards = [
      [SSH_REMOTE_LOCAL_PORTS.exec, 1337], [SSH_REMOTE_LOCAL_PORTS.auxiliary, 1339], [SSH_REMOTE_LOCAL_PORTS.gateway, 1340],
      [SSH_REMOTE_LOCAL_PORTS.vnc, 6080], [SSH_REMOTE_LOCAL_PORTS.vncFork, 6081], [SSH_REMOTE_LOCAL_PORTS.browser, 8790],
    ].flatMap(([local, remote]) => ["-L", `127.0.0.1:${local}:127.0.0.1:${remote}`]);
    const child = spawn("ssh", [...SSH_OPTIONS, "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-N", "-T", ...forwards, ssh.host], { stdio: ["ignore", "ignore", "pipe"] });
    tunnel = { host: ssh.host, child, stderr: "" };
    child.stderr?.on("data", (chunk: Buffer) => { if (tunnel?.child === child) tunnel.stderr = `${tunnel.stderr}${chunk.toString()}`.slice(-20_000); });
    child.once("error", (error) => { if (tunnel?.child === child) tunnel.stderr = error.message; });
    process.once("exit", () => child.kill("SIGTERM"));
  }
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await gatewayReady(connection)) return;
    if (tunnel == null || tunnel.child.exitCode != null) throw new Error(tunnel?.stderr.trim() || "The SSH tunnel stopped before Grok Bot became reachable.");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(tunnel.stderr.trim() || "The SSH tunnel connected, but Grok Bot did not become reachable.");
}

export async function getSshRemoteStatus(settingsPath: string): Promise<SshRemoteStatus> {
  const config = await readConfig(settingsPath);
  if (config == null) return { configured: false, host: null, ready: false, detail: "Choose an SSH server to install Grok Bot." };
  try {
    await ensureSshGatewayTunnel(config, config.ssh);
    return { configured: true, host: config.ssh.host, ready: true, detail: `Connected to ${config.ssh.host} through SSH.` };
  } catch (error) {
    return { configured: true, host: config.ssh.host, ready: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

let installInFlight: Promise<SshInstallResult> | undefined;

export function installSshRemoteBox(settingsPath: string, value: unknown): Promise<SshInstallResult> {
  const host = normalizeSshDestination(value);
  if (installInFlight == null) installInFlight = (async () => {
    await run("ssh", sshArgs(host, "true"), undefined, 15_000).catch((error) => { throw new Error(`SSH key login to ${host} failed. ${error instanceof Error ? error.message : String(error)}`); });
    const bundle = await stageCurrentHostBundle(settingsPath);
    await upload(host, "host-main.cjs", await readFile(bundle.path));
    await upload(host, "box-exec-daemon.cjs", await readFile(bundle.boxExecDaemonPath));
    try { await upload(host, "codex-auth.json", await readFile(join(homedir(), ".codex", "auth.json"))); } catch {}
    const output = await run("ssh", [...SSH_OPTIONS, host, "bash", "-s"], SSH_REMOTE_INSTALL_SCRIPT);
    const match = output.match(/(?:^|\n)GROK_BOT_REMOTE_RESULT\t([0-9a-f]{64})\t([A-Za-z0-9_.-]+)(?:\n|$)/);
    if (match == null) throw new Error("The remote installer finished without a valid connection descriptor.");
    const config = createSshGatewayConfig(host, match[1]!);
    await writeConfig(settingsPath, config);
    await ensureSshGatewayTunnel(config, config.ssh);
    return { configured: true, host, ready: true, detail: `Installed and connected through SSH to ${host}.`, containerName: match[2]! };
  })().finally(() => { installInFlight = undefined; });
  return installInFlight;
}
