#!/bin/sh
# Stops the Flow Server until the next start (or the next reboot, if it is enabled).
sudo systemctl stop flow-server
systemctl is-active --quiet flow-server && echo "Flow Server is still running." || echo "Flow Server is stopped."
echo
printf "Press Enter to close. "
read -r _
