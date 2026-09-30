#!/bin/sh
# Installs the Flow Server as a service on a Linux machine with systemd (a
# Raspberry Pi, a home server, a VPS) and makes it reachable as far as you
# choose, from the home network only up to the internet:
#
#   1  home network only
#   2  and anywhere through Tailscale
#   3  and the internet, with Caddy set up by this script
#   4  and the internet, through your own web server or tunnel
#
#   sh apps/server/install.sh [options]      from the cloned repo, as your own user
#
#   --level N        the level (default: the one chosen before; asked when there is a terminal)
#   --music DIR      the music folder (default: what the server remembers, else ~/flow-music)
#   --port N         the port (default: what the server remembers, else 7878)
#   --yes            no questions: the defaults, and install what the level needs
#   --no-tailscale   leave Tailscale alone (don't install it)
#   --no-discovery   do not let the apps find the server on the network by themselves
#   --uninstall      remove the service (the library and the music stay)
#
# Safe to run again: it updates the service and leaves the rest as it is. Run
# it with a lower level to close what a higher one opened.

set -eu

SERVICE=flow-server
UNIT="/etc/systemd/system/$SERVICE.service"
MUSIC=""
PORT=""
LEVEL=""
YES=0
TAILSCALE=1
DISCOVERY=ask
UNINSTALL=0

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --level) [ $# -ge 2 ] || die "--level needs 1, 2, 3 or 4."; LEVEL="$2"; shift ;;
    --music) [ $# -ge 2 ] || die "--music needs a folder."; MUSIC="$2"; shift ;;
    --port) [ $# -ge 2 ] || die "--port needs a number."; PORT="$2"; shift ;;
    --yes|-y) YES=1 ;;
    --no-tailscale) TAILSCALE=0 ;;
    --no-discovery) DISCOVERY=0 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option $1. See --help." ;;
  esac
  shift
done
case "$LEVEL" in ""|1|2|3|4) ;; *) die "--level is 1, 2, 3 or 4." ;; esac

# A yes/no question; --yes answers yes, and so does Enter.
ask() {
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [Y/n] ' "$1"
  read -r answer || return 1
  case "$answer" in n|N|no|No|NO) return 1 ;; *) return 0 ;; esac
}

# The same, where Enter (and --yes) means no.
ask_no() {
  [ "$YES" = 1 ] && return 1
  [ -t 0 ] || return 1
  printf '%s [y/N] ' "$1"
  read -r answer || return 1
  case "$answer" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
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
RUN_HOME=$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6)
RUN_HOME=${RUN_HOME:-$HOME}

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
    apt-get|dnf|zypper|pacman) install_hint nodejs ;;
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

# The server's own command line, as the user the service runs as (its
# settings are in that user's home).
flow() {
  if [ "$(id -un)" = "$RUN_USER" ]; then
    "$NODE" "$REPO/apps/server/src/main.js" "$@"
  elif have runuser; then
    runuser -u "$RUN_USER" -- env -u XDG_DATA_HOME HOME="$RUN_HOME" "$NODE" "$REPO/apps/server/src/main.js" "$@"
  else
    sudo -u "$RUN_USER" env -u XDG_DATA_HOME HOME="$RUN_HOME" "$NODE" "$REPO/apps/server/src/main.js" "$@"
  fi
}
info_get() { printf '%s\n' "$INFO" | sed -n "s/^$1=//p"; }
INFO=$(flow info) || die "The server's settings could not be read (see above)."
CUR_LEVEL=$(info_get level)
CUR_PASSWORD=$(info_get password)
PORT_NOW=${PORT:-$(info_get port)}
PORT_NOW=${PORT_NOW:-7878}

step "Where should the server be reachable from?"
# The default: the level chosen before; before there were levels, 2 when
# Tailscale is up here (that is what the installer set up then), else 1.
DEFAULT_LEVEL=$CUR_LEVEL
if [ -z "$DEFAULT_LEVEL" ]; then
  if have tailscale && [ -n "$($SUDO tailscale ip -4 2>/dev/null | head -n 1 || true)" ]; then DEFAULT_LEVEL=2; else DEFAULT_LEVEL=1; fi
fi
say "  1  Home network only"
say "       No internet exposure. Risk: very low."
say "  2  Home network and Tailscale"
say "       Also from anywhere, through Tailscale: a free account, and its app on each"
say "       device. No router settings. Risk: low."
say "  3  Home network and the internet, set up with Caddy"
say "       From any device, no extra app. Needs a domain name (a free DuckDNS one works)"
say "       and ports 80 and 443 forwarded on your router. Risk: low to medium."
say "  4  Home network and the internet, through your own web server or tunnel"
say "       (nginx, Apache, Cloudflare Tunnel...). You set it up, its certificate and the"
say "       router; this script checks it. Risk: high if not set up properly."
say "  Levels 3 and 4 need a strong password (8+ characters, upper and lower case, a number)."
if [ -z "$LEVEL" ]; then
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then
    LEVEL=$DEFAULT_LEVEL
  else
    while :; do
      printf 'Level [%s]: ' "$DEFAULT_LEVEL"
      read -r answer || answer=""
      case "$answer" in
        "") LEVEL=$DEFAULT_LEVEL; break ;;
        1|2|3|4) LEVEL=$answer; break ;;
        *) say "1, 2, 3 or 4, please." ;;
      esac
    done
  fi
fi
say "Level $LEVEL.${CUR_LEVEL:+ (It was $CUR_LEVEL.)}"
if [ "$LEVEL" -ge 3 ]; then
  die "Level $LEVEL is not in this installer yet; it comes with the next update. Level 1 or 2 works now."
fi

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

step "Finding the server on the network (optional)"
say "With this on, the Flow apps find the server by themselves on your home network: an app with"
say "no Home address sends a small UDP question and the server answers with its name and port."
say "It tells them what /api/hello already tells anyone on the network, never the PIN or the library,"
say "and only devices on private addresses get an answer. It opens UDP 7878 for your home network."
if [ "$DISCOVERY" = ask ]; then
  if ask "Turn it on?"; then DISCOVERY=1; else DISCOVERY=0; fi
fi
if [ "$DISCOVERY" = 1 ]; then say "On."; else say "Off. The address is typed into Flow (--discovery on the server turns it on later)."; fi

step "PIN or password (optional at level $LEVEL)"
if [ "$CUR_PASSWORD" != none ]; then
  say "Set already. Change it later with: node $REPO/apps/server/src/main.js set-password"
else
  if [ "$LEVEL" = 2 ]; then
    say "Without one, anyone on your home network or your tailnet can use the server."
  else
    say "Without one, anyone on your home network can use the server, which is often fine."
  fi
  if ask_no "Set a PIN or password now (4 or more characters)?"; then
    TRIES=1
    until flow set-password --level "$LEVEL"; do
      if [ "$TRIES" -ge 3 ]; then say "Not set; later: node $REPO/apps/server/src/main.js set-password"; break; fi
      TRIES=$((TRIES + 1))
      say "Try again:"
    done
  else
    say "None. Later: node $REPO/apps/server/src/main.js set-password"
  fi
fi

TS_IP=""
if [ "$LEVEL" -ge 2 ]; then
  step "Tailscale (reach the server away from home)"
  if ! have tailscale; then
    say "Not installed. Tailscale makes a private network between your devices, so the apps"
    say "reach the server from anywhere, with no port opened on your router."
    if [ "$TAILSCALE" = 1 ] && ask "Install Tailscale (the official script from tailscale.com)?"; then
      have curl || die "curl is needed for that: $(install_hint curl)"
      curl -fsSL https://tailscale.com/install.sh | $SUDO sh
    else
      say "Skipped: level 2 works once Tailscale is here. Later: curl -fsSL https://tailscale.com/install.sh | sh"
    fi
  fi
  if have tailscale; then
    TS_IP=$($SUDO tailscale ip -4 2>/dev/null | head -n 1 || true)
    if [ -z "$TS_IP" ]; then
      say "Not logged in yet. Open the link it prints, in a browser, to add this machine:"
      $SUDO tailscale up || true
      TS_IP=$($SUDO tailscale ip -4 2>/dev/null | head -n 1 || true)
    fi
    if [ -n "$TS_IP" ]; then say "This machine's Tailscale address: $TS_IP"; else say "Not on a tailnet yet; run this again after: sudo tailscale up"; fi
  fi
fi

step "The service"
ARGS=" --level $LEVEL"
if [ "$DISCOVERY" = 1 ]; then ARGS="$ARGS --discovery"; else ARGS="$ARGS --no-discovery"; fi
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
  say "Running at level $LEVEL, and started with the machine."
else
  say "It did not start. See: journalctl -u $SERVICE -n 30"
  exit 1
fi

step "Firewall"
if have ufw && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  # The home network(s): the directly attached IPv4 subnets, not Tailscale's or Docker's.
  SUBNETS=$(ip -4 route 2>/dev/null | awk '$1 ~ /\// && /scope link/ && $0 !~ /tailscale|docker|br-|veth/ { print $1 }')
  for subnet in $SUBNETS; do
    $SUDO ufw allow from "$subnet" to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW open to $subnet"
    if [ "$DISCOVERY" = 1 ]; then
      # The apps find the server by a UDP question on Flow's default port, from the home network only.
      $SUDO ufw allow from "$subnet" to any port 7878 proto udp >/dev/null && say "ufw: UDP 7878 (finding the server) open to $subnet"
    fi
  done
  if [ "$LEVEL" -ge 2 ]; then
    $SUDO ufw allow in on tailscale0 to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW open to Tailscale"
  elif $SUDO ufw status 2>/dev/null | grep -q "^$PORT_NOW/tcp on tailscale0 "; then
    # Down from level 2: Tailscale no longer reaches the server.
    $SUDO ufw delete allow in on tailscale0 to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW closed to Tailscale (level 1)"
  fi
elif have firewall-cmd && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-port="$PORT_NOW/tcp" >/dev/null
  [ "$DISCOVERY" = 1 ] && $SUDO firewall-cmd --permanent --add-port=7878/udp >/dev/null
  if [ "$LEVEL" -ge 2 ]; then
    $SUDO firewall-cmd --permanent --zone=trusted --add-interface=tailscale0 >/dev/null 2>&1 || true
  elif $SUDO firewall-cmd --permanent --zone=trusted --query-interface=tailscale0 >/dev/null 2>&1; then
    say "Tailscale is in firewalld's trusted zone (level 2 put it there). Other things you use over"
    say "Tailscale may need that too."
    if ask "Take it out, so Tailscale no longer reaches this machine's ports?"; then
      $SUDO firewall-cmd --permanent --zone=trusted --remove-interface=tailscale0 >/dev/null 2>&1 || true
      say "firewalld: Tailscale no longer trusted"
    fi
  fi
  $SUDO firewall-cmd --reload >/dev/null
  say "firewalld: port $PORT_NOW$([ "$DISCOVERY" = 1 ] && printf ' and UDP 7878') open (to every network the zone covers, not only your LAN)$([ "$LEVEL" -ge 2 ] && printf ', and Tailscale trusted')"
else
  say "No active firewall found (ufw, firewalld): nothing to open."
  [ "$LEVEL" = 1 ] && [ -n "$(have tailscale && $SUDO tailscale ip -4 2>/dev/null | head -n 1 || true)" ] \
    && say "Without one, Tailscale still reaches the server; the apps are just not told its Tailscale address."
fi

step "Done"
# What the server said on starting, this run only.
MAIN_PID=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)
journalctl -u "$SERVICE" _PID="${MAIN_PID:-0}" -o cat -n 14 --no-pager 2>/dev/null || true
say ""
say "In Flow: Settings, Streaming, Download and Synchronization, then the Home address above."
if [ "$LEVEL" = 2 ] && [ -n "$TS_IP" ]; then
  say "Flow fills in the Remote address ($TS_IP:$PORT_NOW) by itself once it has connected at home."
  say "Install Tailscale on the PC and phone too (same account), or the Remote address does not work."
fi
if [ "$LEVEL" = 1 ] && [ "${CUR_LEVEL:-1}" != 1 ]; then
  say "Away from home the server is no longer reachable; clear Flow's Remote address."
  have tailscale && say "Tailscale itself is still installed (sudo tailscale down takes this machine off the tailnet)."
fi
say ""
say "Update later:  cd $REPO && git pull && sudo systemctl restart $SERVICE"
say "PIN:           node $REPO/apps/server/src/main.js set-password"
say "Other level:   sh $REPO/apps/server/install.sh --level N"
