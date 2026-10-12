# Flow Server installation guide

Turns `flow-server-3.3.3.tar.gz` into a Flow Server on a Linux machine with
systemd (Raspberry Pi OS, Debian, Ubuntu). Run the commands on that machine.

1. **Install Node.js, ffmpeg and curl.** `node -v` must show v18 or newer.
   ```sh
   sudo apt update && sudo apt install -y nodejs ffmpeg curl
   node -v
   ```

2. **Get the tarball onto the machine.** Download it there:
   ```sh
   cd ~ && wget https://github.com/Ceeser1/Flow/releases/download/v3.3.3/flow-server-3.3.3.tar.gz
   ```
   Or copy it from your Windows PC (PowerShell on the PC; `hostname -I` on the
   server shows its IP):
   ```powershell
   scp "$HOME\Downloads\flow-server-3.3.3.tar.gz" pi@192.168.1.50:~
   ```

3. **Unpack it into `~/Flow`.** Keep that folder; the server runs from it.
   ```sh
   mkdir -p ~/Flow ~/flow-music
   tar xzf ~/flow-server-3.3.3.tar.gz -C ~/Flow --strip-components=1
   ```
   `~/flow-music` is the music folder. Copy songs in now, or upload them from
   the apps later.

4. **Run the installer** as your normal user (not with `sudo`):
   ```sh
   cd ~/Flow && sh apps/server/install.sh
   ```
   Answer its questions:
   - **Level:** `1` = home network only, `2` = also on the go through
     Tailscale (recommended). Levels 3 and 4 put the server on the internet;
     see `apps/server/README.md` first.
   - **Downloads by the server:** optional. With yes, install yt-dlp in a
     second terminal when it asks, using the file name it prints
     (`yt-dlp_linux_aarch64` on a 64-bit Pi), then press Enter:
     ```sh
     wget https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64
     sudo mv yt-dlp_linux_aarch64 /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp
     ```
   - **Find the server on the network:** yes.
   - **Password:** optional at levels 1 and 2.
   - **Tailscale** (level 2): open the link it prints and sign in.

   Ignore the `git pull` hint it prints at the end; step 8 is how to update.

5. **Check that it runs.** It should say `active (running)`; the log shows the
   addresses for the apps.
   ```sh
   systemctl status flow-server
   journalctl -u flow-server -n 30
   ```

6. **Give the server a fixed IP** in your router (DHCP reservation), so its
   address doesn't change.

7. **Connect the apps.** In Flow, open Settings → Streaming, Download and
   Synchronization and set Home Server to `http://<server IP>:7878` (filled
   in by itself with discovery on). Enter the password if you set one. For
   level 2, install Tailscale on the device, sign in to the same account and
   connect once at home; Flow then fills in Remote Server by itself.

8. **Update later** by unpacking the new tarball over `~/Flow` and restarting.
   The library (`~/.local/share/flow-server`) and the songs are not touched.
   ```sh
   tar xzf ~/flow-server-X.Y.Z.tar.gz -C ~/Flow --strip-components=1
   sudo systemctl restart flow-server
   ```

**Useful commands**
```sh
node ~/Flow/apps/server/src/main.js set-password   # set or change the password
journalctl -u flow-server -f                       # live log
sh ~/Flow/apps/server/install.sh --level 2         # change the level
sh ~/Flow/apps/server/install.sh --uninstall       # remove the service (library and music stay)
```
