#!/bin/sh
# Installs the Flow Server as a service on a Linux machine with systemd (a
# Raspberry Pi, a home server, a VPS), opens its port for the home network and
# for Tailscale, and sets Tailscale up so the apps can reach it away from home.
#
#   sh apps/server/install.sh [options]      from the cloned repo, as your own user
#
#   --music DIR      the music folder (default: what the server remembers, else ~/flow-music)
#   --port N         the port (default: what the server remembers, else 7878)
#   --yes            no questions: install ffmpeg and Tailscale too
#   --no-tailscale   leave Tailscale alone
#   --uninstall      remove the service (the library and the music stay)
#
# Safe to run again: it updates the service and leaves the rest as it is.

set -eu

SERVICE=flow-server
UNIT="/etc/systemd/system/$SERVICE.service"
MUSIC=""
PORT=""
YES=0
TAILSCALE=1
UNINSTALL=0

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --music) [ $# -ge 2 ] || die "--music needs a folder."; MUSIC="$2"; shift ;;
    --port) [ $# -ge 2 ] || die "--port needs a number."; PORT="$2"; shift ;;
    --yes|-y) YES=1 ;;
    --no-tailscale) TAILSCALE=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option $1. See --help." ;;
  esac
  shift
done

# A yes/no question; --yes answers yes, and so does Enter.
ask() {
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [Y/n] ' "$1"
  read -r answer || return 1
  case "$answer" in n|N|no|No|NO) return 1 ;; *) return 0 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  have sudo || die "Run this as root, or install sudo."
  SUDO="sudo"
fi

[ "$(uname -s)" = "Linux" ] || die "This installs a service on Linux. On Windows or macOS, run: node apps/server/src/main.js"
have systemctl && [ -d /run/systemd/system ] || die "This needs systemd. Without it, run: node apps/server/src/main.js"

if [ "$UNINSTALL" = 1 ]; then
  step "Removing the service"
  $SUDO systemctl disable --now "$SERVICE" 2>/dev/null || true
  $SUDO rm -f "$UNIT"
  $SUDO systemctl daemon-reload
  say "Removed. The library (~/.local/share/flow-server) and the music are still there."
  exit 0
fi

# A relative music folder means the one from where this was run.
case "$MUSIC" in ""|/*) ;; *) MUSIC="$PWD/$MUSIC" ;; esac

REPO=$(cd "$(dirname "$0")/../.." && pwd)
[ -f "$REPO/apps/server/src/main.js" ] || die "Run this from a clone of the Flow repo."
RUN_USER=${SUDO_USER:-$(id -un)}

# The package manager, to say (or run) how to install what is missing.
PM=""
for candidate in apt-get dnf pacman zypper apk; do
  if have "$candidate"; then PM="$candidate"; break; fi
done

install_hint() {
  case "$PM" in
    apt-get) say "  sudo apt-get install -y $1" ;;
    dnf) say "  sudo dnf install -y $1" ;;
    pacman) say "  sudo pacman -S --noconfirm $1" ;;
    zypper) say "  sudo zypper install -y $1" ;;
    *) say "  install $1 with your package manager" ;;
  esac
}

install_packages() {
  case "$PM" in
    apt-get) $SUDO apt-get install -y "$@" ;;
    dnf) $SUDO dnf install -y "$@" ;;
    pacman) $SUDO pacman -S --noconfirm "$@" ;;
    zypper) $SUDO zypper install -y "$@" ;;
    *) return 1 ;;
  esac
}

step "Checking Node.js"
if ! have node; then
  say "Node.js 18 or newer is needed and not installed. Install it, then run this again:"
  case "$PM" in
    apt-get|dnf|zypper) install_hint nodejs ;;
    pacman) install_hint nodejs ;;
    *) say "  https://nodejs.org/" ;;
  esac
  exit 1
fi
NODE=$(command -v node)
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js $NODE_MAJOR is too old, 18 or newer is needed (https://nodejs.org/)."
say "Node.js $("$NODE" -v) at $NODE"

step "Linking @flow/core"
# Without npm the workspace link is not made; the server needs it.
mkdir -p "$REPO/node_modules/@flow"
if [ ! -e "$REPO/node_modules/@flow/core/package.json" ]; then
  rm -f "$REPO/node_modules/@flow/core"
  ln -s ../../packages/core "$REPO/node_modules/@flow/core"
  say "Linked node_modules/@flow/core"
else
  say "Already there"
fi
[ "$RUN_USER" = "$(id -un)" ] || chown -h "$RUN_USER" "$REPO/node_modules/@flow/core" 2>/dev/null || true

step "ffmpeg (optional)"
if have ffmpeg; then
  say "Found. Songs put into the music folder by hand get their length, tags and loudness."
else
  say "Not installed. It gives songs put into the music folder by hand their length, tags and loudness."
  if [ -n "$PM" ] && ask "Install ffmpeg?"; then
    install_packages ffmpeg || say "Could not install it; the server works without."
  else
    say "Skipped. Later:"
    install_hint ffmpeg
  fi
fi

step "The service"
ARGS=""
[ -n "$MUSIC" ] && ARGS="$ARGS --music $MUSIC"
[ -n "$PORT" ] && ARGS="$ARGS --port $PORT"
TMP=$(mktemp)
cat > "$TMP" <<EOF
[Unit]
Description=Flow Server: hosts a Flow library and streams it to the Flow apps
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO/apps/server
ExecStart=$NODE src/main.js$ARGS
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
$SUDO install -m 644 "$TMP" "$UNIT"
rm -f "$TMP"
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE" >/dev/null 2>&1
$SUDO systemctl restart "$SERVICE"
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  say "Running, and started with the machine."
else
  say "It did not start. See: journalctl -u $SERVICE -n 30"
  exit 1
fi

# The port the server ended up on (an earlier --port is remembered by it).
PORT_NOW=$(journalctl -u "$SERVICE" -n 40 --no-pager 2>/dev/null | sed -n 's/.*Enter in Flow.s settings: [0-9.]*:\([0-9]*\).*/\1/p' | tail -n 1)
PORT_NOW=${PORT_NOW:-${PORT:-7878}}

step "Firewall"
if have ufw && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  # The home network(s): the directly attached IPv4 subnets, not Tailscale's or Docker's.
  SUBNETS=$(ip -4 route 2>/dev/null | awk '$1 ~ /\// && /scope link/ && $0 !~ /tailscale|docker|br-|veth/ { print $1 }')
  for subnet in $SUBNETS; do
    $SUDO ufw allow from "$subnet" to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW open to $subnet"
    # The apps find the server by a UDP question on Flow's default port, from the home network only.
    $SUDO ufw allow from "$subnet" to any port 7878 proto udp >/dev/null && say "ufw: UDP 7878 (finding the server) open to $subnet"
  done
  $SUDO ufw allow in on tailscale0 to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW open to Tailscale"
elif have firewall-cmd && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-port="$PORT_NOW/tcp" >/dev/null
  $SUDO firewall-cmd --permanent --add-port=7878/udp >/dev/null
  $SUDO firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 >/dev/null 2>&1 || true
  $SUDO firewall-cmd --reload >/dev/null
  say "firewalld: port $PORT_NOW and UDP 7878 open (to every network the zone covers, not only your LAN), and Tailscale trusted"
else
  say "No active firewall found (ufw, firewalld): nothing to open."
fi

TS_IP=""
if [ "$TAILSCALE" = 1 ]; then
  step "Tailscale (reach the server away from home)"
  if ! have tailscale; then
    say "Not installed. Tailscale makes a private network between your devices, so the apps"
    say "reach the server from anywhere, with no port opened on your router."
    if ask "Install Tailscale (the official script from tailscale.com)?"; then
      have curl || die "curl is needed for that: $(install_hint curl)"
      curl -fsSL https://tailscale.com/install.sh | $SUDO sh
    else
      say "Skipped. Later: curl -fsSL https://tailscale.com/install.sh | sh"
    fi
  fi
  if have tailscale; then
    TS_IP=$($SUDO tailscale ip -4 2>/dev/null | head -n 1 || true)
    if [ -z "$TS_IP" ]; then
      say "Not logged in yet. Open the link it prints, in a browser, to add this machine:"
      $SUDO tailscale up || true
      TS_IP=$($SUDO tailscale ip -4 2>/dev/null | head -n 1 || true)
    fi
    [ -n "$TS_IP" ] && say "This machine's Tailscale address: $TS_IP"
    # The server looks for Tailscale every five minutes; a restart is at once.
    $SUDO systemctl restart "$SERVICE"
    sleep 2
  fi
fi

step "Done"
journalctl -u "$SERVICE" -n 12 --no-pager 2>/dev/null | sed 's/^.*node\[[0-9]*\]: //' || true
say ""
say "In Flow: Settings, Streaming, Download and Synchronization, then the Home address above."
if [ -n "$TS_IP" ]; then
  say "Flow fills in the Remote address ($TS_IP:$PORT_NOW) by itself once it has connected at home."
  say "Install Tailscale on the PC too (same account), or the Remote address does not work."
fi
say ""
say "Update later:  cd $REPO && git pull && sudo systemctl restart $SERVICE"
say "PIN:           node $REPO/apps/server/src/main.js set-password"
