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
#   --domain NAME    level 3: the server's name on the internet, like music.example.com
#                    or mymusic.duckdns.org (asked when left out)
#   --url URL        level 4: the https address the apps use, like https://music.example.com
#                    or https://example.com/flow (asked when left out)
#   --proxy NAME     level 4: nginx, apache, caddy, cloudflared or other (asked when left out)
#   --proxy-at IP    level 4: where the web server or tunnel runs, when not on this machine
#   --yes            no questions: the defaults, and install what the level needs
#   --no-tailscale   leave Tailscale alone (don't install it)
#   --no-discovery   do not let the apps find the server on the network by themselves
#   --uninstall      remove the service (the library and the music stay)
#
# Without a terminal, FLOW_SERVER_PASSWORD gives the password level 3 needs and
# DUCKDNS_TOKEN the token for a DuckDNS name.
#
# Safe to run again: it updates the service and leaves the rest as it is. Run
# it with a lower level to close what a higher one opened.

set -eu

SERVICE=flow-server
UNIT="/etc/systemd/system/$SERVICE.service"
MUSIC=""
PORT=""
LEVEL=""
DOMAIN=""
URL=""
PROXY=""
PROXY_AT=""
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
    --domain) [ $# -ge 2 ] || die "--domain needs a name."; DOMAIN="$2"; shift ;;
    --yes|-y) YES=1 ;;
    --no-tailscale) TAILSCALE=0 ;;
    --no-discovery) DISCOVERY=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --url) [ $# -ge 2 ] || die "--url needs an https:// address."; URL="$2"; shift ;;
    --proxy) [ $# -ge 2 ] || die "--proxy needs nginx, apache, caddy, cloudflared or other."; PROXY="$2"; shift ;;
    --proxy-at) [ $# -ge 2 ] || die "--proxy-at needs an IP address."; PROXY_AT="$2"; shift ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# For level 3.
CADDYFILE=/etc/caddy/Caddyfile
SETUP="$REPO/apps/server/src/setup.js"
DUCK_DIR=/etc/flow-server
DUCK_UNIT=/etc/systemd/system/flow-duckdns
lan_ip() { ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }'; }
public_ip() { curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true; }
name_ip() { getent ahostsv4 "$1" 2>/dev/null | awk '{ print $1; exit }'; }
# The program listening on a TCP port, or nothing.
port_owner() { $SUDO ss -ltnpH "sport = :$1" 2>/dev/null | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -n 1; }
is_private() { printf '%s' "$1" | grep -Eq '^(10\.|127\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)'; }
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
if [ "$LEVEL" = 3 ]; then
  # First, so a machine with a web server of its own hears about level 4 before any questions.
  for p in 80 443; do
    OWNER=$(port_owner "$p")
    if [ -n "$OWNER" ] && [ "$OWNER" != caddy ]; then
      die "Port $p is in use by $OWNER. Caddy needs 80 and 443 for itself. With a web server of your own, that is level 4: sh $REPO/apps/server/install.sh --level 4"
    fi
  done
  say "Ports 80 and 443 are free for Caddy."
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

if [ "$LEVEL" -ge 3 ]; then
  step "Password (required at level $LEVEL)"
  if [ "$CUR_PASSWORD" = strong ]; then
    say "Set, and strong enough. Change it later with: node $REPO/apps/server/src/main.js set-password"
  else
    say "The server will be reachable from the internet, so it needs a strong password: at least"
    say "8 characters, with a lower-case letter, an upper-case letter and a number."
    [ "$CUR_PASSWORD" = pin ] && say "The PIN it has now is not enough. Every signed-in device enters the new one once."
    if [ -n "${FLOW_SERVER_PASSWORD:-}" ]; then
      flow set-password --level "$LEVEL" "$FLOW_SERVER_PASSWORD" || die "FLOW_SERVER_PASSWORD is not strong enough (see above)."
    elif [ -t 0 ]; then
      TRIES=1
      until flow set-password --level "$LEVEL"; do
        [ "$TRIES" -ge 3 ] && die "No password set, so level $LEVEL can't be set up. Run this again when you have one."
        TRIES=$((TRIES + 1))
        say "Try again:"
      done
    else
      die "Level $LEVEL needs a password: run this in a terminal, or give it as FLOW_SERVER_PASSWORD."
    fi
  fi
else
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
fi

TS_IP=""
if [ "$LEVEL" = 2 ]; then
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

# ---- level 3: the internet, through Caddy ----
LAN_IP=$(lan_ip)
PUBLIC_IP=""
if [ "$LEVEL" = 3 ]; then
  have curl || { [ -n "$PM" ] && install_packages curl >/dev/null; } || die "curl is needed: $(install_hint curl)"

  step "The server's name on the internet"
  say "The apps reach the server at https://<name>. Use a name you own (like music.example.com,"
  say "with a DNS A record pointing at your public address), or a free one from www.duckdns.org"
  say "(sign in, add a subdomain like mymusic.duckdns.org, and keep the token it shows at hand)."
  CUR_URL=$(info_get public_url)
  [ -z "$DOMAIN" ] && [ -n "$CUR_URL" ] && DOMAIN=${CUR_URL#https://}
  while :; do
    if [ -t 0 ] && [ "$YES" != 1 ]; then
      printf 'Name%s: ' "${DOMAIN:+ [$DOMAIN]}"
      read -r answer || answer=""
      [ -n "$answer" ] && DOMAIN=$answer
    fi
    DOMAIN=$(printf '%s' "$DOMAIN" | tr 'A-Z' 'a-z' | sed 's#^https*://##; s#[/:].*$##')
    printf '%s' "$DOMAIN" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$' && break
    [ -t 0 ] && [ "$YES" != 1 ] || die "Level 3 needs the server's name: --domain music.example.com"
    say "\"$DOMAIN\" is not a name like music.example.com."
    DOMAIN=""
  done

  DUCK_UPDATED=0
  case "$DOMAIN" in
    *.duckdns.org)
      step "DuckDNS (keeps $DOMAIN at your connection's address)"
      DUCK_SUB=${DOMAIN%.duckdns.org}
      DUCK_SUB=${DUCK_SUB##*.}
      DUCK_TOKEN=${DUCKDNS_TOKEN:-}
      if [ -z "$DUCK_TOKEN" ] && [ -f "$DUCK_DIR/duckdns.env" ]; then
        DUCK_TOKEN=$($SUDO sed -n "s/^DUCKDNS_TOKEN=//p" "$DUCK_DIR/duckdns.env")
      fi
      if [ -z "$DUCK_TOKEN" ]; then
        [ -t 0 ] || die "The DuckDNS token is needed: give it as DUCKDNS_TOKEN."
        say "The token is at the top of duckdns.org once you are signed in."
        printf 'DuckDNS token: '
        read -r DUCK_TOKEN || DUCK_TOKEN=""
      fi
      printf '%s' "$DUCK_TOKEN" | grep -Eq '^[A-Za-z0-9-]{8,64}$' || die "That doesn't look like a DuckDNS token."
      # The token goes to curl on its input, not its command line, where other users could see it.
      TMP=$(mktemp)
      printf 'DUCKDNS_DOMAIN=%s\nDUCKDNS_TOKEN=%s\n' "$DUCK_SUB" "$DUCK_TOKEN" > "$TMP"
      $SUDO mkdir -p "$DUCK_DIR"
      $SUDO install -m 600 "$TMP" "$DUCK_DIR/duckdns.env"
      cat > "$TMP" <<'EOF'
#!/bin/sh
# Written by Flow's install.sh: tells DuckDNS this connection's address.
. /etc/flow-server/duckdns.env
printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip="\n' "$DUCKDNS_DOMAIN" "$DUCKDNS_TOKEN" \
  | curl -fsS --max-time 30 -K - | grep -qx OK
EOF
      $SUDO install -m 700 "$TMP" "$DUCK_DIR/duckdns-update.sh"
      cat > "$TMP" <<'EOF'
[Unit]
Description=Flow Server: keeps the DuckDNS name at this connection's address
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh /etc/flow-server/duckdns-update.sh
EOF
      $SUDO install -m 644 "$TMP" "$DUCK_UNIT.service"
      cat > "$TMP" <<'EOF'
[Unit]
Description=Flow Server: DuckDNS update every five minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
      $SUDO install -m 644 "$TMP" "$DUCK_UNIT.timer"
      rm -f "$TMP"
      $SUDO systemctl daemon-reload
      $SUDO sh "$DUCK_DIR/duckdns-update.sh" || die "DuckDNS did not take it: check the name ($DUCK_SUB) and the token."
      $SUDO systemctl enable --now flow-duckdns.timer >/dev/null 2>&1
      DUCK_UPDATED=1
      say "DuckDNS points $DOMAIN at this connection, and is told again every five minutes."
      ;;
  esac

  step "Checking the name"
  PUBLIC_IP=$(public_ip)
  if [ -n "$PUBLIC_IP" ]; then say "This connection's public address: $PUBLIC_IP (asked api.ipify.org)"; else say "Could not find out this connection's public address; carrying on without comparing."; fi
  # A name just changed at DuckDNS can take a minute to show.
  TRIES=0
  while :; do
    NAME_IP=$(name_ip "$DOMAIN")
    if [ -n "$NAME_IP" ] && { [ -z "$PUBLIC_IP" ] || [ "$NAME_IP" = "$PUBLIC_IP" ]; }; then break; fi
    TRIES=$((TRIES + 1))
    [ "$DUCK_UPDATED" = 1 ] && [ "$TRIES" -lt 12 ] || break
    sleep 5
  done
  [ -n "$NAME_IP" ] || die "$DOMAIN is not known to DNS yet. Give its A record your public address${PUBLIC_IP:+ ($PUBLIC_IP)}, wait a few minutes, and run this again."
  is_private "$NAME_IP" && die "$DOMAIN points at $NAME_IP, a home-network address. For the internet it needs your public address${PUBLIC_IP:+ ($PUBLIC_IP)}."
  if [ -n "$PUBLIC_IP" ] && [ "$NAME_IP" != "$PUBLIC_IP" ]; then
    say "$DOMAIN points at $NAME_IP, but this connection is $PUBLIC_IP. Give its A record $PUBLIC_IP."
    ask_no "Carry on anyway (the certificate will likely fail)?" || die "Stopped. Run this again once the name points here."
  else
    say "$DOMAIN points at $NAME_IP: here."
  fi
  [ -n "$(getent ahostsv6 "$DOMAIN" 2>/dev/null | awk '$1 !~ /^::ffff:/ { print $1; exit }')" ] \
    && say "Note: $DOMAIN also has an IPv6 address (AAAA record). If that one isn't this machine, remove it: Let's Encrypt tries IPv6 first."

  step "Your router"
  say "Forward these ports on your router to this machine (${LAN_IP:-its home-network address}):"
  say "  TCP 80    Caddy gets its certificate through it, and sends http on to https"
  say "  TCP 443   https: what the apps use"
  say "It is usually under Port forwarding, Port sharing or NAT in the router's settings. Don't forward"
  say "port $PORT_NOW: everything goes through Caddy."
  if [ -t 0 ] && [ "$YES" != 1 ]; then
    printf 'Press Enter once that is done... '
    read -r answer || true
  fi

  step "Caddy (https, and its certificate)"
  if have caddy; then
    say "Found: $(caddy version 2>/dev/null | cut -d' ' -f1)"
  else
    say "Installing Caddy."
    [ "$PM" = apt-get ] && $SUDO apt-get update -qq >/dev/null 2>&1 || true
    if ! install_packages caddy >/dev/null 2>&1; then
      [ "$PM" = apt-get ] || die "Could not install Caddy. See https://caddyserver.com/docs/install, then run this again."
      say "Not in this system's packages; adding Caddy's own (https://caddyserver.com/docs/install)."
      $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | $SUDO gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
      $SUDO apt-get update -qq >/dev/null
      $SUDO apt-get install -y caddy >/dev/null || die "Could not install Caddy."
    fi
    have caddy || die "Caddy was installed but is not on the PATH."
    say "Installed: $(caddy version 2>/dev/null | cut -d' ' -f1)"
  fi
  $SUDO mkdir -p /etc/caddy
  [ -f "$CADDYFILE" ] && $SUDO cp -p "$CADDYFILE" "$CADDYFILE.flow-tmp"
  HOW=$($SUDO "$NODE" "$SETUP" caddyfile-set "$CADDYFILE" "$DOMAIN" "$PORT_NOW")
  if ! CHECK=$($SUDO caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1); then
    if [ -f "$CADDYFILE.flow-tmp" ]; then $SUDO mv "$CADDYFILE.flow-tmp" "$CADDYFILE"; fi
    printf '%s\n' "$CHECK" | tail -n 5
    die "The Caddyfile would not be valid with Flow's block, so it was left as it was ($CADDYFILE)."
  fi
  $SUDO rm -f "$CADDYFILE.flow-tmp"
  case "$HOW" in
    created) say "Wrote $CADDYFILE." ;;
    replaced-stock) say "Replaced the example Caddyfile the package comes with (kept as Caddyfile.before-flow)." ;;
    added) say "Added Flow's block to your Caddyfile; the rest is as it was (before: Caddyfile.before-flow)." ;;
    updated) say "Updated Flow's block in the Caddyfile." ;;
  esac
  CADDY_START=$(date '+%Y-%m-%d %H:%M:%S')
  $SUDO systemctl enable caddy >/dev/null 2>&1 || true
  $SUDO systemctl reload-or-restart caddy
  say "Caddy is serving https://$DOMAIN and passes it on to the Flow Server."
fi

# ---- level 4: the internet, through your own web server or tunnel ----
# What to add to it: the settings audio and uploads need, which a stock setup
# gets wrong (buffering, the upload size, Range, who is calling).
print_snippet() {
  UP="http://${PROXY_UPSTREAM}:$PORT_NOW"
  case "$PROXY" in
    nginx)
      say "In the server { } block for $URL_HOST that has your certificate (listen 443 ssl):"
      say ""
      if [ -n "$URL_PATH" ]; then say "    location $URL_PATH/ {"; say "        proxy_pass $UP/;"; else say "    location / {"; say "        proxy_pass $UP;"; fi
      say '        proxy_set_header Host $host;'
      say '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
      say '        proxy_set_header X-Forwarded-Proto $scheme;'
      say '        proxy_buffering off;              # songs stream as they are read'
      say '        proxy_request_buffering off;      # uploads go straight through'
      say '        client_max_body_size 2g;          # long songs'
      say '        proxy_read_timeout 1h;'
      say '        proxy_send_timeout 1h;'
      say '        access_log off;                   # audio links carry the sign-in token'
      say "    }"
      say ""
      say "and http sent on to https (in the listen 80 block: return 301 https://\$host\$request_uri;)."
      say "Then: sudo nginx -t && sudo systemctl reload nginx"
      ;;
    apache)
      say "In the <VirtualHost *:443> for $URL_HOST that has your certificate"
      say "(first: sudo a2enmod proxy proxy_http headers):"
      say ""
      say "    ProxyPreserveHost On"
      say "    ProxyPass        ${URL_PATH:-}/ $UP/ flushpackets=on timeout=3600"
      say "    ProxyPassReverse ${URL_PATH:-}/ $UP/"
      say '    RequestHeader set X-Forwarded-Proto "https"'
      say "    LimitRequestBody 0"
      say ""
      say "Apache adds X-Forwarded-For by itself. Leave audio out of its access log if you keep one:"
      say "the links carry the sign-in token. Then: sudo apachectl configtest && sudo systemctl reload apache2"
      ;;
    caddy)
      say "In your Caddyfile:"
      say ""
      say "    $URL_HOST {"
      if [ -n "$URL_PATH" ]; then say "        handle_path $URL_PATH/* {"; say "            reverse_proxy ${PROXY_UPSTREAM}:$PORT_NOW"; say "        }"; else say "        reverse_proxy ${PROXY_UPSTREAM}:$PORT_NOW"; fi
      say "    }"
      say ""
      say "Caddy passes on who is calling and streams by itself. Then: sudo systemctl reload caddy"
      ;;
    cloudflared)
      say "In the tunnel's config.yml, before the catch-all rule:"
      say ""
      say "    ingress:"
      say "      - hostname: $URL_HOST"
      say "        service: $UP"
      say "      - service: http_status:404"
      say ""
      say "Then: sudo systemctl restart cloudflared. Cloudflare passes on who is calling and that it"
      say "was https. Two things to know: its free plan takes uploads of at most 100 MB (larger songs"
      say "can't be moved to the server), and its terms limit serving mostly audio or video through it;"
      say "read them before you rely on it."
      ;;
    *)
      say "What the web server or tunnel in front has to do:"
      say "- https at $URL, with a certificate the apps accept, and plain http sent on to https"
      say "- pass ${URL_PATH:-everything}${URL_PATH:+/} on to $UP${URL_PATH:+ (without $URL_PATH)}"
      say "- add X-Forwarded-For (the caller's address) and X-Forwarded-Proto: https"
      say "- stream, not buffer: answers (songs) and request bodies (uploads)"
      say "- allow uploads of 2 GB, pass the Range header on, and allow requests of an hour"
      say "- keep audio links out of its access log: they carry the sign-in token"
      ;;
  esac
}

if [ "$LEVEL" = 4 ]; then
  step "Your web server or tunnel"
  say "Level 4 puts the Flow Server behind a web server or tunnel you run yourself. This script"
  say "doesn't change its setup; it tells you what to add, then checks the result."
  if [ -z "$PROXY" ] && [ -t 0 ] && [ "$YES" != 1 ]; then
    say "  1  nginx"
    say "  2  Apache"
    say "  3  Caddy (your own)"
    say "  4  Cloudflare Tunnel (cloudflared)"
    say "  5  something else"
    printf 'Which one [1]: '
    read -r answer || answer=""
    case "$answer" in 2) PROXY=apache ;; 3) PROXY=caddy ;; 4) PROXY=cloudflared ;; 5) PROXY=other ;; *) PROXY=nginx ;; esac
  fi
  PROXY=${PROXY:-other}
  case "$PROXY" in
    nginx) PROXY_NAME=nginx ;;
    apache) PROXY_NAME=Apache ;;
    caddy) PROXY_NAME=Caddy ;;
    cloudflared) PROXY_NAME="Cloudflare Tunnel" ;;
    other) PROXY_NAME="your web server or tunnel" ;;
    *) die "--proxy is nginx, apache, caddy, cloudflared or other." ;;
  esac

  if [ -z "$PROXY_AT" ] && [ -t 0 ] && [ "$YES" != 1 ] && ! ask "Does it run on this machine?"; then
    printf 'Its IP address (as this machine sees it): '
    read -r PROXY_AT || PROXY_AT=""
  fi
  if [ -n "$PROXY_AT" ]; then
    printf '%s' "$PROXY_AT" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || die "\"$PROXY_AT\" is not an IPv4 address."
    PROXY_UPSTREAM=${LAN_IP:-this-machine}
    say "It reaches the Flow Server at $PROXY_UPSTREAM:$PORT_NOW, and the server believes what it says about who is calling."
  else
    PROXY_UPSTREAM=127.0.0.1
  fi

  CUR_URL=$(info_get public_url)
  URL=${URL:-$CUR_URL}
  while :; do
    if [ -t 0 ] && [ "$YES" != 1 ]; then
      say "The https address the apps will use, like https://music.example.com or https://example.com/flow"
      printf 'Address%s: ' "${URL:+ [$URL]}"
      read -r answer || answer=""
      [ -n "$answer" ] && URL=$answer
    fi
    URL=$(printf '%s' "$URL" | sed 's#/*$##')
    printf '%s' "$URL" | grep -Eq '^https://([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]*(:[0-9]+)?(/[A-Za-z0-9._~-]+)*$' && break
    [ -t 0 ] && [ "$YES" != 1 ] || die "Level 4 needs the https address the apps use: --url https://music.example.com"
    say "\"$URL\" is not an https:// address like https://music.example.com."
    URL=""
  done
  URL_HOST=$(printf '%s' "$URL" | sed 's#^https://##; s#/.*$##')
  URL_PATH=$(printf '%s' "$URL" | sed 's#^https://[^/]*##')

  step "What to add to $PROXY_NAME"
  print_snippet
  say ""
  say "Don't forward port $PORT_NOW on the router: everything goes through $PROXY_NAME."
  if [ -t 0 ] && [ "$YES" != 1 ]; then
    printf 'Press Enter once it is set up (the check comes after the service)... '
    read -r answer || true
  fi
fi

# ---- down from level 3 or 4: close what it opened ----
CADDY_OFF=0
if [ "${CUR_LEVEL:-0}" = 4 ] && [ "$LEVEL" != 4 ]; then
  step "Closing level 4"
  say "Take Flow out of your web server's or tunnel's setup: this script never changed it."
  flow --trusted-proxy "" info >/dev/null
  if [ "$LEVEL" -lt 3 ]; then
    flow --public-url "" info >/dev/null
    say "The server no longer tells the apps an internet address."
  fi
fi
if [ "${CUR_LEVEL:-0}" = 3 ] && [ "$LEVEL" != 3 ]; then
  step "Closing level 3"
  if [ -f "$CADDYFILE" ] && have caddy; then
    LEFT=$($SUDO "$NODE" "$SETUP" caddyfile-remove "$CADDYFILE")
    if [ "$LEFT" = empty ]; then
      $SUDO systemctl disable --now caddy >/dev/null 2>&1 || true
      CADDY_OFF=1
      say "Caddy served only Flow: stopped and turned off (still installed)."
    else
      $SUDO systemctl reload-or-restart caddy || true
      say "Flow's block is out of the Caddyfile; Caddy keeps serving the rest."
    fi
  fi
  if [ -f "$DUCK_UNIT.timer" ]; then
    $SUDO systemctl disable --now flow-duckdns.timer >/dev/null 2>&1 || true
    $SUDO rm -f "$DUCK_UNIT.timer" "$DUCK_UNIT.service" "$DUCK_DIR/duckdns-update.sh" "$DUCK_DIR/duckdns.env"
    $SUDO systemctl daemon-reload
    say "DuckDNS updates stopped (the name is still yours at duckdns.org)."
  fi
  if [ "$LEVEL" -lt 3 ]; then
    flow --public-url "" info >/dev/null
    say "The server no longer tells the apps an internet address."
  fi
fi
# A proxy on another machine is trusted at level 4 only.
[ "$LEVEL" = 4 ] && [ -n "$PROXY_AT" ] || [ -z "$(info_get trusted_proxies)" ] || flow --trusted-proxy "" info >/dev/null

step "The service"
ARGS=" --level $LEVEL"
[ "$LEVEL" = 3 ] && ARGS="$ARGS --public-url https://$DOMAIN"
[ "$LEVEL" = 4 ] && ARGS="$ARGS --public-url $URL"
[ "$LEVEL" = 4 ] && [ -n "$PROXY_AT" ] && ARGS="$ARGS --trusted-proxy $PROXY_AT"
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
# Tailscale reaches the server at level 2, and above it when it is here anyway.
TS_FIREWALL=0
if [ "$LEVEL" = 2 ] || { [ "$LEVEL" -ge 3 ] && have tailscale; }; then TS_FIREWALL=1; fi
if have ufw && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  # The home network(s): the directly attached IPv4 subnets, not Tailscale's or Docker's.
  SUBNETS=$(ip -4 route 2>/dev/null | awk '$1 ~ /\// && /scope link/ && $0 !~ /tailscale|docker|br-|veth/ { print $1 }' | sort -u)
  for subnet in $SUBNETS; do
    $SUDO ufw allow from "$subnet" to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW open to $subnet"
    if [ "$DISCOVERY" = 1 ]; then
      # The apps find the server by a UDP question on Flow's default port, from the home network only.
      $SUDO ufw allow from "$subnet" to any port 7878 proto udp >/dev/null && say "ufw: UDP 7878 (finding the server) open to $subnet"
    fi
  done
  if [ "$TS_FIREWALL" = 1 ]; then
    $SUDO ufw allow in on tailscale0 to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW open to Tailscale"
  elif $SUDO ufw status 2>/dev/null | grep -q "^$PORT_NOW/tcp on tailscale0 "; then
    # Down from level 2: Tailscale no longer reaches the server.
    $SUDO ufw delete allow in on tailscale0 to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW closed to Tailscale (level 1)"
  fi
  if [ "$LEVEL" = 4 ] && [ -n "$PROXY_AT" ] && ! is_private "$PROXY_AT"; then
    # A proxy on a machine of its own on the internet (a VPS): only it gets in.
    $SUDO ufw allow from "$PROXY_AT" to any port "$PORT_NOW" proto tcp >/dev/null && say "ufw: port $PORT_NOW open to $PROXY_AT (your proxy)"
  fi
  if [ "$LEVEL" = 3 ]; then
    $SUDO ufw allow 80,443/tcp >/dev/null && say "ufw: ports 80 and 443 open (Caddy, from anywhere)"
  elif [ "$CADDY_OFF" = 1 ]; then
    $SUDO ufw delete allow 80,443/tcp >/dev/null 2>&1 && say "ufw: ports 80 and 443 closed again"
  fi
elif have firewall-cmd && $SUDO firewall-cmd --state >/dev/null 2>&1; then
  $SUDO firewall-cmd --permanent --add-port="$PORT_NOW/tcp" >/dev/null
  [ "$DISCOVERY" = 1 ] && $SUDO firewall-cmd --permanent --add-port=7878/udp >/dev/null
  if [ "$LEVEL" = 3 ]; then
    $SUDO firewall-cmd --permanent --add-service=http --add-service=https >/dev/null && say "firewalld: http and https open (Caddy)"
  elif [ "$CADDY_OFF" = 1 ]; then
    $SUDO firewall-cmd --permanent --remove-service=http --remove-service=https >/dev/null 2>&1 && say "firewalld: http and https closed again"
  fi
  if [ "$TS_FIREWALL" = 1 ]; then
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
  say "firewalld: port $PORT_NOW$([ "$DISCOVERY" = 1 ] && printf ' and UDP 7878') open (to every network the zone covers, not only your LAN)$([ "$TS_FIREWALL" = 1 ] && printf ', and Tailscale trusted')"
else
  say "No active firewall found (ufw, firewalld): nothing to open."
  [ "$LEVEL" = 1 ] && [ -n "$(have tailscale && $SUDO tailscale ip -4 2>/dev/null | head -n 1 || true)" ] \
    && say "Without one, Tailscale still reaches the server; the apps are just not told its Tailscale address."
fi

CERT_OK=0
if [ "$LEVEL" = 3 ]; then
  step "The certificate"
  say "Caddy asks Let's Encrypt for a certificate for $DOMAIN. Let's Encrypt checks it by reaching"
  say "this machine from the internet on port 80, so a certificate proves the router lets it in."
  WAITED=0
  while :; do
    if "$NODE" "$SETUP" cert-ok "$DOMAIN"; then CERT_OK=1; break; fi
    [ "$WAITED" -ge 120 ] && break
    [ "$WAITED" = 0 ] && printf 'Waiting for it (up to 2 minutes)'
    printf '.'
    sleep 5
    WAITED=$((WAITED + 5))
  done
  [ "$WAITED" -gt 0 ] && say ""
  if [ "$CERT_OK" = 1 ]; then
    say "Caddy has a valid certificate for $DOMAIN: the internet reaches this machine."
  else
    say "No certificate yet. What Caddy said last:"
    journalctl -u caddy --since "$CADDY_START" -o cat --no-pager 2>/dev/null | grep -i '"error"' | tail -n 3 | cut -c 1-400 || true
    say ""
    say "Usually one of these:"
    say "- Ports 80 and 443 are not forwarded on the router to ${LAN_IP:-this machine}."
    say "- Your provider gives you no public IPv4 of your own (CGNAT or DS-Lite, common with cable and"
    say "  fibre): if the internet address your router shows is not ${PUBLIC_IP:-the one above}, incoming"
    say "  connections can't reach you. Ask the provider for a public IPv4, or use level 2 (Tailscale)."
    say "- $DOMAIN doesn't point here (see \"Checking the name\")."
    say "Caddy keeps trying by itself. Fix it and run this again, or check with:"
    say "  node $REPO/apps/server/src/main.js doctor https://$DOMAIN"
  fi
  if [ "$CERT_OK" = 1 ]; then
    step "Checking it the way the apps will"
    # On this machine, past the router: whether Caddy and the server work together.
    flow doctor --connect-to 127.0.0.1 "https://$DOMAIN" || say "Fix what failed above, then run this again."
    say ""
    if "$NODE" "$SETUP" reach "$DOMAIN"; then
      say "https://$DOMAIN is reachable through your router too."
    else
      say "From here, https://$DOMAIN can't be reached through your router. Many routers can't reach"
      say "their own public address from inside, so this may be fine."
    fi
    say "For the outside view (port 443 on the router, above all), run this from a machine outside"
    say "your home network, like a laptop on a phone's hotspot:"
    say "  node apps/server/src/main.js doctor https://$DOMAIN"
  fi
fi

if [ "$LEVEL" = 4 ]; then
  step "Checking it the way the apps will"
  # A web server on this machine is checked past the router; a tunnel or one
  # elsewhere where the name leads.
  if [ -z "$PROXY_AT" ] && [ "$PROXY" != cloudflared ]; then
    DOCTOR_VIA="--connect-to 127.0.0.1"
  else
    DOCTOR_VIA=""
  fi
  # shellcheck disable=SC2086
  if flow doctor $DOCTOR_VIA "$URL"; then
    say ""
    say "Your setup works from here."
  else
    say ""
    say "Fix what failed with the snippet above (\"What to add to $PROXY_NAME\"), then check again:"
    say "  node $REPO/apps/server/src/main.js doctor $DOCTOR_VIA $URL"
  fi
  say "For the outside view (the router above all), run this from a machine outside your home"
  say "network, like a laptop on a phone's hotspot:"
  say "  node apps/server/src/main.js doctor $URL"
fi

step "Done"
# What the server said on starting, this run only.
MAIN_PID=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null || true)
journalctl -u "$SERVICE" _PID="${MAIN_PID:-0}" -o cat -n 14 --no-pager 2>/dev/null || true
say ""
say "In Flow: Settings, Streaming, Download and Synchronization, then the Home address above."
if [ "$LEVEL" = 3 ]; then
  say "Remote Server: https://$DOMAIN (Flow fills it in by itself once it has connected at home;"
  say "away from home it needs nothing else on the device). The password is the one set above."
  [ "$CERT_OK" = 1 ] || say "It works once Caddy has its certificate (see above)."
fi
if [ "$LEVEL" = 4 ]; then
  say "Remote Server: $URL (Flow fills it in by itself once it has connected at home)."
  say "The password is the one set above."
fi
if [ "$LEVEL" = 2 ] && [ -n "$TS_IP" ]; then
  say "Flow fills in the Remote address ($TS_IP:$PORT_NOW) by itself once it has connected at home."
  say "Install Tailscale on the PC and phone too (same account), or the Remote address does not work."
fi
if [ "$LEVEL" -lt 3 ] && [ "${CUR_LEVEL:-1}" -ge 3 ]; then
  say "The server is no longer reachable from the internet. If Flow's Remote address is its https"
  say "address, clear it$([ "$LEVEL" = 2 ] && printf ' (the Tailscale one works instead)')."
elif [ "$LEVEL" = 1 ] && [ "${CUR_LEVEL:-1}" != 1 ]; then
  say "Away from home the server is no longer reachable; clear Flow's Remote address."
  have tailscale && say "Tailscale itself is still installed (sudo tailscale down takes this machine off the tailnet)."
fi
say ""
say "Update later:  cd $REPO && git pull && sudo systemctl restart $SERVICE"
say "PIN:           node $REPO/apps/server/src/main.js set-password"
say "Other level:   sh $REPO/apps/server/install.sh --level N"
