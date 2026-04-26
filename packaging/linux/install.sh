#!/usr/bin/env bash
# One-shot installer for the RemoteDesk server on a Debian/Ubuntu VPS.
#
# Usage (as root):
#   PUBLIC_HOST=remote.example.com ./install.sh
#
# What it does:
#   1. Installs docker engine + compose plugin if missing.
#   2. Clones (or refreshes) the repo into /opt/remotedesk.
#   3. Generates a random TURN_SECRET into /etc/remotedesk.env.
#   4. Renders coturn.conf from the template.
#   5. Installs and enables the systemd unit.

set -euo pipefail

PUBLIC_HOST="${PUBLIC_HOST:-}"
REPO_URL="${REPO_URL:-https://github.com/asscol/RDPnew.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/remotedesk}"

if [[ -z "$PUBLIC_HOST" ]]; then
  echo "ERROR: PUBLIC_HOST env var is required (e.g. remote.example.com)" >&2
  exit 1
fi
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must be run as root" >&2
  exit 1
fi

echo "==> Installing prerequisites"
apt-get update -y
apt-get install -y ca-certificates curl gnupg git gettext-base ufw

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

echo "==> Fetching repo into $INSTALL_DIR"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --all --prune
  git -C "$INSTALL_DIR" reset --hard origin/main
else
  rm -rf "$INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo "==> Configuring environment"
ENV_FILE=/etc/remotedesk.env
if [[ ! -f "$ENV_FILE" ]]; then
  TURN_SECRET="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
PUBLIC_HOST=$PUBLIC_HOST
TURN_SECRET=$TURN_SECRET
EOF
  chmod 600 "$ENV_FILE"
  echo "    created $ENV_FILE"
else
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

echo "==> Rendering coturn config"
mkdir -p /etc/coturn
PUBLIC_HOST="$PUBLIC_HOST" TURN_SECRET="$TURN_SECRET" \
  envsubst '${PUBLIC_HOST} ${TURN_SECRET}' \
  < "$INSTALL_DIR/packaging/linux/coturn.conf" \
  > /etc/coturn/turnserver.conf

# Replace the bind-mount target so docker-compose picks up the rendered file.
cp /etc/coturn/turnserver.conf "$INSTALL_DIR/packaging/linux/coturn.conf.rendered"
sed -i 's|./coturn.conf|./coturn.conf.rendered|' \
  "$INSTALL_DIR/packaging/linux/docker-compose.yml" || true

echo "==> Opening firewall ports"
ufw allow 22/tcp || true
ufw allow 8080/tcp comment 'remotedesk-signaling' || true
ufw allow 3478 comment 'remotedesk-stun-turn' || true
ufw allow 5349 comment 'remotedesk-turns' || true
ufw allow 49160:49200/udp comment 'remotedesk-turn-relay' || true

echo "==> Installing systemd unit"
install -m 0644 "$INSTALL_DIR/packaging/linux/remotedesk-server.service" \
  /etc/systemd/system/remotedesk-server.service
systemctl daemon-reload
systemctl enable --now remotedesk-server

echo
echo "Done. Service status:"
systemctl --no-pager status remotedesk-server | head -20 || true
echo
echo "Web UI: http://$PUBLIC_HOST:8080/"
echo "Put nginx + Let's Encrypt in front of :8080 for HTTPS in production."
