# gdrive-sync

Keeps your starred Google Drive folders on your Ubuntu computer, synced both ways, and usable without internet. Built on [rclone](https://rclone.org) bisync, with a GNOME Shell panel indicator.

## How it works

- Star a folder you own in Google Drive (web or phone). Within a few minutes it appears in `~/GoogleDrive`.
- Changes sync both ways: every 5 minutes, and a few seconds after you change something locally.
- Unstarring a folder syncs it one last time, then moves the local copy to the Trash.
- If a file changed on both sides, the newer version wins and the older one is kept next to it with a numbered suffix.
- Not synced: folders shared with you (even if starred), Google Docs/Sheets/Slides, shortcuts, and editor lock/temp files.

## Requirements

- Ubuntu (other systemd-based distros may work)
- Python 3.8+
- GNOME 45 or newer for the panel indicator (optional; the command line works without it)

## Install

```sh
git clone https://github.com/cyborgcode/gdrive-sync.git
cd gdrive-sync
bash src/install.sh
```

Run it as your normal user, not with `sudo`. The installer downloads a checksum-verified rclone, signs you in to Google Drive, and starts the sync service. Log out and back in once to see the cloud icon in the top bar.

Options: `--dir DIR` to use another folder, `--remote NAME` to use another rclone remote, `--yes` for no questions. See `--help`.

### Use your own Google client ID

Google is retiring rclone's shared sign-in. Running the installer in a terminal walks you through creating your own free client ID (about 5 minutes) and signs you in with it.

## Usage

```sh
gdrive-sync status                    # what's synced, progress, recent activity
gdrive-sync now                       # sync right away
gdrive-sync reconnect                 # sign in to Google again
gdrive-sync confirm-deletes FOLDER    # allow a large deletion that sync paused on
```

The panel indicator shows the same status, live progress, and a **Sync now** button.

To change how often it checks Drive, edit `interval_minutes` in `~/.config/gdrive-sync/config.ini`, then run `systemctl --user restart gdrive-sync`.

## Uninstall

```sh
bash src/install.sh --uninstall           # keeps your files, settings and Google sign-in
bash src/install.sh --uninstall --purge   # also removes settings and sync state
```

## Development

```sh
python3 -m unittest discover -s tests -p "test_*.py"   # unit tests
./build.sh    # runs the tests and builds dist/gdrive-sync-installer.sh, a single-file installer
```

After changing the code, run `bash src/install.sh` again to update your installed copy.
