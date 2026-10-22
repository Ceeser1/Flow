#!/bin/bash

# The deb's remove script: electron-builder's own, plus Flow's AppArmor
# profile (after-install.sh) going with it.

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'flow' '/usr/bin/flow'
else
    rm -f '/usr/bin/flow'
fi

if [ -f /etc/apparmor.d/flow ]; then
    if hash apparmor_parser 2>/dev/null && [ -d /sys/kernel/security/apparmor ]; then
        apparmor_parser --remove /etc/apparmor.d/flow 2>/dev/null || true
    fi
    rm -f /etc/apparmor.d/flow
fi
