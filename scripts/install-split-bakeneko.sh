#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
remote_host=${1:-bakeneko}
remote_app_root=${GROK_BOT_REMOTE_APP_ROOT:-/srv/codex-klava/apps/grok-bot-0.18-reconstructed}
remote_data_root=${GROK_BOT_REMOTE_DATA_ROOT:-/srv/codex-klava/data/grok-bot}
container_name=${GROK_BOT_REMOTE_CONTAINER:-grok-bot-bakeneko}
image=${GROK_BOT_BOX_IMAGE:-public.ecr.aws/k0i0n2g5/cursorenvironments/universal:sand-box-latest}
app_name="Grok Bot 0.18 Reconstructed.app"
app_source="$repo_root/dist/$app_name"
app_target="/Applications/$app_name"
settings_root="$HOME/.grokbot-reconstructed"

for command in node npm jq rsync ssh ditto codesign; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 1; }
done
if pgrep -f -x "$app_target/Contents/MacOS/Grok Bot" >/dev/null; then
  echo "Close $app_name before installing." >&2
  exit 1
fi

remote_ip=${GROK_BOT_REMOTE_IP:-$(ssh "$remote_host" 'tailscale ip -4 | sed -n "1p"')}
case "$remote_ip" in
  ""|*[!0-9.]*) echo "Could not resolve the remote Tailscale IPv4 address." >&2; exit 1 ;;
esac

cd "$repo_root"
if [[ ! -d node_modules ]]; then npm ci; fi
npm run bootstrap
npm run package

ssh "$remote_host" "install -d -m 755 '$remote_app_root/runtime/box-exec-daemon' && install -d -m 700 '$remote_data_root' '$remote_data_root/sand-data'"
rsync -a --checksum "$repo_root/.build/fidelity-clean-runtime/dist/host/host-main.cjs" "$remote_host:$remote_app_root/runtime/host-main.cjs"
rsync -a --checksum "$repo_root/.build/fidelity-clean-runtime/dist/box-exec-daemon/main.cjs" "$remote_host:$remote_app_root/runtime/box-exec-daemon/main.cjs"

ssh "$remote_host" bash -s -- "$remote_app_root" "$remote_data_root" "$container_name" "$image" "$remote_ip" <<'REMOTE'
set -euo pipefail
app_root=$1
data_root=$2
container_name=$3
image=$4
remote_ip=$5

[[ $(uname -m) == x86_64 ]] || { echo "The reconstructed box image requires an x86_64 remote host." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is not installed on the remote host." >&2; exit 1; }
command -v openssl >/dev/null || { echo "OpenSSL is not installed on the remote host." >&2; exit 1; }
[[ -s "$HOME/.codex/auth.json" ]] || { echo "Run 'codex login' on the remote host first." >&2; exit 1; }

install -d -m 700 "$data_root/codex-home"
if [[ ! -s "$data_root/codex-home/auth.json" ]]; then
  install -m 600 "$HOME/.codex/auth.json" "$data_root/codex-home/auth.json"
fi
if [[ ! -s "$data_root/gateway-token" ]]; then
  openssl rand -hex -out "$data_root/gateway-token" 32
fi
chmod 600 "$data_root/gateway-token"
[[ ! -O "$data_root/codex-home/auth.json" ]] || chmod 600 "$data_root/codex-home/auth.json"
docker pull "$image" >/dev/null
if docker container inspect "$container_name" >/dev/null 2>&1; then
  docker stop "$container_name" >/dev/null
  docker rm "$container_name" >/dev/null
fi

gateway_token=$(tr -d '\n' < "$data_root/gateway-token")
docker run -d \
  --name "$container_name" \
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
  --publish "$remote_ip:1337:1337" \
  --publish "$remote_ip:1339:1339" \
  --publish "$remote_ip:1340:1340" \
  --publish "$remote_ip:16080:6080" \
  --publish "$remote_ip:16081:6081" \
  --publish "$remote_ip:8790:8790" \
  --volume "$data_root/sand-data:/home/box/sand-data" \
  --volume "$data_root/codex-home:/root/.codex" \
  --volume "$app_root/runtime/host-main.cjs:/home/box/sand-host/host-main.cjs:ro" \
  --volume "$app_root/runtime/box-exec-daemon/main.cjs:/home/box/sand-host/box-exec-daemon/main.cjs:ro" \
  "$image" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS -H "Authorization: Bearer $gateway_token" "http://$remote_ip:1340/health" >/dev/null 2>&1; then
    docker exec "$container_name" sh -lc 'test "$SAND_AUTO_REVIEW_MODE" = off && test -w /root/.codex/auth.json'
    exit 0
  fi
  sleep 1
done
docker logs --tail 80 "$container_name" >&2
exit 1
REMOTE

mkdir -p "$settings_root"
chmod 700 "$settings_root"
jq -n \
  --arg baseUrl "http://$remote_ip:1340" \
  --arg primaryUrl "http://$remote_ip:16080/vnc.html" \
  --arg forkBaseUrl "http://$remote_ip:16081" \
  --rawfile token <(ssh "$remote_host" "cat '$remote_data_root/gateway-token'") \
  '{baseUrl:$baseUrl,token:($token|gsub("[[:space:]]+$";"")),vncProxy:{primaryUrl:$primaryUrl,forkBaseUrl:$forkBaseUrl,networkToken:""}}' \
  > "$settings_root/self-hosted-gateway.json.incoming"
chmod 600 "$settings_root/self-hosted-gateway.json.incoming"
mv "$settings_root/self-hosted-gateway.json.incoming" "$settings_root/self-hosted-gateway.json"

if [[ -f "$settings_root/settings.json" ]]; then
  jq '.boxRuntime="remote" | .inferenceProvider="codex" | .localToolPermission="always"' "$settings_root/settings.json"
else
  jq -n '{boxRuntime:"remote",inferenceProvider:"codex",localToolPermission:"always"}'
fi > "$settings_root/settings.json.incoming"
chmod 600 "$settings_root/settings.json.incoming"
mv "$settings_root/settings.json.incoming" "$settings_root/settings.json"

ditto "$app_source" "$app_target"
codesign --verify --deep --strict "$app_target"
/usr/bin/touch "$app_target"
"/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister" -f "$app_target" >/dev/null
/usr/bin/killall Dock >/dev/null 2>&1 || true
node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const connection = JSON.parse(await readFile(process.env.HOME + "/.grokbot-reconstructed/self-hosted-gateway.json", "utf8"));
  const response = await fetch(connection.baseUrl + "/health", { headers: { authorization: "Bearer " + connection.token } });
  const health = await response.json();
  if (!response.ok || health.ok !== true) process.exit(1);
'

echo "Installed $app_target"
echo "Bakeneko runtime: $remote_host ($remote_ip), container $container_name"
echo "Open the reconstructed app; the official Grok Bot app is untouched."
