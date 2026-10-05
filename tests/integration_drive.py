"""Manual end-to-end test against the real Google Drive (needs the gdrive remote).

usage: python3 tests/integration_drive.py WORKDIR FOLDER_ID
The folder must be a disposable folder you own.
"""
import os
import signal
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_gdrive_sync import gds, write  # noqa: E402

WORK, TWO_WAY = sys.argv[1:3]
RUN_ID = time.strftime("%H%M%S")
RCLONE = os.path.expanduser("~/.local/share/gdrive-sync/rclone")
results = []


def check(name, ok, detail=""):
    results.append(ok)
    print("%s  %s %s" % ("PASS" if ok else "FAIL", name, detail), flush=True)


def rclone(*args):
    return subprocess.run([RCLONE, *args], capture_output=True, text=True).stdout


def remote_files(folder_id):
    return set(rclone("lsf", "-R", "--files-only", "--drive-skip-gdocs", "--drive-skip-shortcuts",
                      "gdrive,root_folder_id=%s:" % folder_id).splitlines())


env = {k: os.path.join(WORK, k.lower()) for k in ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR")}
env["HOME"] = os.path.expanduser("~")
paths = gds.Paths(env)
os.makedirs(os.path.dirname(paths.config_file), exist_ok=True)
with open(paths.config_file, "w") as f:
    f.write("[gdrive-sync]\nremote = gdrive\nfolder = %s/GoogleDrive\nrclone = %s\ninterval_minutes = 60\n"
            % (WORK, RCLONE))
d = gds.Daemon(paths, gds.Config(paths))
os.makedirs(d.cfg.folder, exist_ok=True)
starred = [{"id": TWO_WAY, "name": "gdrive-sync-selftest"}]
d.query_starred = lambda: list(starred)
_real_trash = gds.move_to_trash
gds.move_to_trash = lambda path, data_home, use_gio=True: _real_trash(path, data_home, use_gio=False)


def rec(folder_id):
    return d.state["folders"].get(folder_id)


def lpath(folder_id):
    return d.local_path(rec(folder_id))


print("--- 1. initial sync", flush=True)
check("cycle ok", d.run_cycle() == "ok")
check("two-way folder synced", rec(TWO_WAY)["last_sync"] and not rec(TWO_WAY)["error"], str(rec(TWO_WAY)["error"]))
check("seed file downloaded", os.path.exists(os.path.join(lpath(TWO_WAY), "x.txt")))
check("marker not uploaded", gds.MARKER not in remote_files(TWO_WAY))

print("--- 2. local change uploads", flush=True)
write(os.path.join(lpath(TWO_WAY), "sub", "from-laptop.txt"), "hello")
d.run_cycle()
check("new local file is in Drive", "sub/from-laptop.txt" in remote_files(TWO_WAY))

print("--- 3. remote change downloads", flush=True)
write(os.path.join(WORK, "remote.txt"), "from drive")
rclone("copyto", os.path.join(WORK, "remote.txt"), "gdrive,root_folder_id=%s:from-drive.txt" % TWO_WAY)
d.run_cycle()
check("new Drive file is local", os.path.exists(os.path.join(lpath(TWO_WAY), "from-drive.txt")))

print("--- 4. conflict keeps both versions", flush=True)
write(os.path.join(lpath(TWO_WAY), "x.txt"), "laptop version")
time.sleep(2)
write(os.path.join(WORK, "x2.txt"), "drive version, newer")
rclone("copyto", os.path.join(WORK, "x2.txt"), "gdrive,root_folder_id=%s:x.txt" % TWO_WAY)
d.run_cycle()
with open(os.path.join(lpath(TWO_WAY), "x.txt")) as f:
    check("newer version wins", f.read() == "drive version, newer")
check("older version kept", any(n.startswith("x.txt.conflict") for n in os.listdir(lpath(TWO_WAY))))

print("--- 6. folder renamed in Google Drive", flush=True)
starred[0]["name"] = "gdrive-sync-selftest renamed"
d.run_cycle()
check("local folder renamed", rec(TWO_WAY)["local"] == "gdrive-sync-selftest renamed"
      and os.path.isdir(lpath(TWO_WAY)), rec(TWO_WAY)["local"])
check("still syncing after rename", not rec(TWO_WAY)["needs_resync"] and not rec(TWO_WAY)["error"])

print("--- 7. unstarred folder: final sync, then Trash", flush=True)
write(os.path.join(lpath(TWO_WAY), "last-minute.txt"), "edit just before unstarring")
old_path = lpath(TWO_WAY)
starred.pop(0)
d.run_cycle()
check("kept after first miss", rec(TWO_WAY) is not None and os.path.isdir(old_path))
d.run_cycle()
check("removed after second miss", rec(TWO_WAY) is None and not os.path.exists(old_path))
check("last edit reached Drive before removal", "last-minute.txt" in remote_files(TWO_WAY))
check("offline copy is in the Trash",
      os.path.isdir(os.path.join(env["XDG_DATA_HOME"], "Trash", "files", "gdrive-sync-selftest renamed")))

print("--- 8. service loop: Sync now, live status, local-change trigger, clean stop", flush=True)
starred.insert(0, {"id": TWO_WAY, "name": "gdrive-sync-selftest renamed"})
seen = {"states": set(), "percent": False}


start_sync = d.last_sync


def driver():
    deadline = time.time() + 300
    while time.time() < deadline and (d.last_sync == start_sync or d.current is not None or d.phase == "syncing"):
        time.sleep(0.5)
    status, t_wait = {}, time.time()
    while time.time() - t_wait < 5 and status.get("state") != "idle":
        time.sleep(0.5)
        status = gds.read_json(paths.status_file, {})
    check("status file written", status.get("state") == "idle", status.get("message", ""))
    check("re-starred folder downloaded again", rec(TWO_WAY) is not None and os.path.exists(
        os.path.join(lpath(TWO_WAY), "last-minute.txt")))
    with open(os.path.join(lpath(TWO_WAY), "big-%s.bin" % RUN_ID), "wb") as f:
        f.write(os.urandom(600_000))
    t0 = time.time()
    while time.time() - t0 < 120 and "big-%s.bin" % RUN_ID not in remote_files(TWO_WAY):
        st = gds.read_json(paths.status_file, {})
        seen["states"].add(st.get("state"))
        if (st.get("progress") or {}).get("percent") is not None:
            seen["percent"] = True
        time.sleep(1)
    check("local change synced without asking", "big-%s.bin" % RUN_ID in remote_files(TWO_WAY),
          "%.0fs" % (time.time() - t0))
    check("status showed syncing with a percentage", "syncing" in seen["states"] and seen["percent"],
          str(seen))
    before = d.last_sync
    os.kill(os.getpid(), signal.SIGUSR1)
    t0 = time.time()
    while time.time() - t0 < 120 and d.last_sync == before:
        time.sleep(0.5)
    check("Sync now triggers a cycle", d.last_sync != before)
    os.kill(os.getpid(), signal.SIGTERM)


threading.Thread(target=driver, daemon=True).start()
d.run()
final = gds.read_json(paths.status_file, {})
check("stopped cleanly", final.get("state") == "stopped")
print("\n%d/%d checks passed" % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
