#!/bin/sh
# Starts the Flow Server (the flow-server service) and shows whether it runs.
sudo systemctl start flow-server
sleep 2
systemctl is-active --quiet flow-server && echo "Flow Server is running." || echo "Flow Server did not start. See: journalctl -u flow-server -n 20"
echo
printf "Press Enter to close. "
read -r _
