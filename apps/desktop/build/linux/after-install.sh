#!/bin/bash

# The deb's install script: electron-builder's own (the link in /usr/bin, the
# sandbox, the menu entry), plus an AppArmor profile for Ubuntu 24.04 and
# newer, which only lets programs with a profile use the user namespaces
# Chromium's sandbox needs (as Chrome and VS Code do). Without it Flow does
# not start there.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/flow' -a -e '/usr/bin/flow' -a "`readlink '/usr/bin/flow'`" != '/etc/alternatives/flow' ]; then
        rm -f '/usr/bin/flow'
    fi
    update-alternatives --install '/usr/bin/flow' 'flow' '/opt/Flow/flow' 100 || ln -sf '/opt/Flow/flow' '/usr/bin/flow'
else
    ln -sf '/opt/Flow/flow' '/usr/bin/flow'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/Flow/chrome-sandbox' || true
else
    chmod 0755 '/opt/Flow/chrome-sandbox' || true
fi

# AppArmor 4 (Ubuntu 24.04 and newer): the profile that allows the namespaces.
if [ -d /etc/apparmor.d ] && [ -f /etc/apparmor.d/abi/4.0 ]; then
    cat > /etc/apparmor.d/flow <<'PROFILE'
# Flow: lets Chromium's sandbox use user namespaces (installed with Flow).
abi <abi/4.0>,
include <tunables/global>

profile flow /opt/Flow/flow flags=(unconfined) {
  userns,

  include if exists <local/flow>
}
PROFILE
    if hash apparmor_parser 2>/dev/null && [ -d /sys/kernel/security/apparmor ]; then
        apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/flow || true
    fi
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
