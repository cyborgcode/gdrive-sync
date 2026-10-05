import json
import os
import sys
import time

from gi.repository import Gio, GLib

OUT, SCENARIO, RUNTIME = sys.argv[1:4]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)


def call(dest, path, iface, method, params=None, reply=None):
    return bus.call_sync(dest, path, iface, method, params, reply, Gio.DBusCallFlags.NONE, 15000, None)


def has_name(name):
    return call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner",
                GLib.Variant("(s)", (name,))).unpack()[0]


def shot(name):
    ok, _ = call("org.gnome.Shell.Screenshot", "/org/gnome/Shell/Screenshot", "org.gnome.Shell.Screenshot",
                 "Screenshot", GLib.Variant("(bbs)", (False, False, "%s/%s.png" % (OUT, name))),
                 GLib.VariantType("(bs)")).unpack()
    print("%s screenshot %s: %s" % (time.strftime("%H:%M:%S"), name, "ok" if ok else "FAILED"), flush=True)


def helper(method, *args):
    params = GLib.Variant("(s)", args) if args else None
    call("local.TestHelper", "/local/TestHelper", "local.TestHelper", method, params)


# The shell only accepts screenshot requests from this well-known name
call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
     GLib.Variant("(su)", ("org.gnome.SettingsDaemon.MediaKeys", 0)))
deadline = time.time() + 90
while not (has_name("org.gnome.Shell.Screenshot") and has_name("local.TestHelper")):
    if time.time() > deadline:
        sys.exit("shell did not come up")
    time.sleep(0.5)
time.sleep(4)

STATUS_DIR = os.path.join(RUNTIME, "gdrive-sync")


def put_status(status):
    os.makedirs(STATUS_DIR, exist_ok=True)
    status["updated"] = time.time()
    with open(os.path.join(STATUS_DIR, "status.json.tmp"), "w") as f:
        json.dump(status, f)
    os.replace(os.path.join(STATUS_DIR, "status.json.tmp"), os.path.join(STATUS_DIR, "status.json"))


def base(now):
    folders = [
        {"id": "1", "name": "Academic Year 2026-2027", "path": "/tmp/x/Academic Year 2026-2027", "mode": "two-way",
         "state": "synced", "last_sync": now - 130, "error": None},
        {"id": "2", "name": "AI", "path": "/tmp/x/AI", "mode": "download", "state": "syncing",
         "last_sync": None, "error": None},
        {"id": "3", "name": "logo", "path": "/tmp/x/logo", "mode": "two-way", "state": "synced",
         "last_sync": now - 60, "error": None},
        {"id": "4", "name": "مواضيع باك 2015-2021  sujets bac tunisie", "path": "/tmp/x/m", "mode": "download",
         "state": "pending", "last_sync": None, "error": None},
        {"id": "5", "name": "Sel3a m5alet", "path": "/tmp/x/s", "mode": "download", "state": "pending",
         "last_sync": None, "error": None},
        {"id": "6", "name": "EXTProduction Mega EDITING PACK", "path": "/tmp/x/e", "mode": "download",
         "state": "pending", "last_sync": None, "error": None},
        {"id": "7", "name": "Revision Bac 2020  ( section math ) (Bechir hizem)", "path": "/tmp/x/r",
         "mode": "download", "state": "synced", "last_sync": now - 500, "error": None},
    ]
    activity = [
        {"time": now - 1, "kind": "down", "text": "Downloaded AI/Deep Learning/lecture-04-transformers.pdf"},
        {"time": now - 3, "kind": "down", "text": "Downloaded AI/Deep Learning/lecture-03.pdf"},
        {"time": now - 9, "kind": "up", "text": "Uploaded Academic Year 2026-2027/Fall/MATH241/notes.odt"},
        {"time": now - 20, "kind": "conflict", "text": "Kept the older version as logo/Icon/logo.svg.conflict1"},
        {"time": now - 21, "kind": "delete", "text": "Deleted in Google Drive: logo/old-draft.png"},
        {"time": now - 40, "kind": "info", "text": "AI: checking for changes…"},
        {"time": now - 41, "kind": "info", "text": "Sync requested"},
        {"time": now - 60, "kind": "down", "text": "Downloaded AI/a.pdf"},
        {"time": now - 61, "kind": "down", "text": "Downloaded AI/b.pdf"},
        {"time": now - 62, "kind": "down", "text": "Downloaded AI/c.pdf"},
        {"time": now - 63, "kind": "down", "text": "Downloaded AI/d.pdf"},
        {"time": now - 64, "kind": "error", "text": "logo: googleapi: Error 403: Rate limit exceeded"},
    ]
    return {"version": 1, "pid": 1, "warning": None, "offline_dir": "/tmp/x", "mount_dir": "/tmp/y",
            "last_sync": now - 130, "next_sync": now + 170, "folders": folders, "activity": activity,
            "mount": {"running": True, "transfers": [], "queued_uploads": 0}, "transfers": [],
            "current": None, "progress": None}


if SCENARIO == "synthetic":
    helper("CloseMenu")
    time.sleep(2)
    shot("1-not-running-panel")
    helper("OpenMenu")
    time.sleep(2)
    shot("2-not-running-menu")
    helper("CloseMenu")

    now = time.time()
    s = base(now)
    s.update(state="syncing", message='Syncing "AI" (2 of 4)',
             current={"id": "2", "folder": "AI", "index": 2, "count": 4, "phase": "Applying changes"},
             progress={"percent": 42, "bytes": 120e6, "total_bytes": 285e6, "files": 12, "total_files": 30,
                       "speed": 1.6e6, "eta": 103},
             transfers=[{"name": "AI/Deep Learning/lecture-05-diffusion.pdf", "direction": "down", "percent": 63,
                         "bytes": 6.3e6, "size": 10e6, "speed": 1.1e6, "eta": 4},
                        {"name": "AI/Datasets/mnist-sample.zip", "direction": "down", "percent": 0,
                         "bytes": 0, "size": 52e6, "speed": 0, "eta": None},
                        {"name": "AI/Datasets/cifar.zip", "direction": "down", "percent": 12,
                         "bytes": 2e6, "size": 17e6, "speed": 0.4e6, "eta": 37},
                        {"name": "AI/Papers/attention.pdf", "direction": "down", "percent": 88,
                         "bytes": 1.9e6, "size": 2.2e6, "speed": 0.3e6, "eta": 1}],
             warning="This Google Drive connection uses rclone's shared client ID, which Google is retiring. "
                     "Run: gdrive-sync reconnect")
    s["mount"]["transfers"] = [{"name": "Google Drive/philooo.pdf", "direction": "up", "percent": 35,
                                "bytes": 160e3, "size": 455e3, "speed": 100e3, "eta": 3}]
    for i in range(4):
        put_status(s)
        time.sleep(1)
    shot("3-syncing-panel")
    helper("OpenMenu")
    time.sleep(2)
    put_status(s)
    time.sleep(1.5)
    shot("4-syncing-menu")
    helper("CloseMenu")

    s = base(time.time())
    s["folders"][1].update(state="error", error='Paused: more than half of the files were deleted on one side. '
                                                'If that was intentional, run: gdrive-sync confirm-deletes "AI"')
    s["folders"][3].update(state="synced", last_sync=time.time() - 30)
    s.update(state="error", message="1 folder(s) need attention")
    for i in range(3):
        put_status(s)
        time.sleep(1)
    shot("5-error-panel")
    helper("OpenMenu")
    time.sleep(1.5)
    put_status(s)
    time.sleep(1.5)
    shot("6-error-menu")
    helper("CloseMenu")

elif SCENARIO == "sections":
    now = time.time()
    s = base(now)
    for f in s["folders"]:
        f.update(state="synced", last_sync=now - 90)
    s.update(state="idle", message="Up to date", folder="/tmp/x")
    put_status(s)
    time.sleep(2)
    helper("OpenMenu")
    time.sleep(1.5)
    put_status(s)
    time.sleep(1.5)
    shot(os.environ.get("PREFIX", "") + "a-start")
    if not os.environ.get("NO_TOGGLE"):
        helper("ToggleSection", "activity")
        time.sleep(1)
        shot("b-activity-collapsed")
        helper("ToggleSection", "folders")
        time.sleep(1)
        shot("c-both-collapsed")
        helper("CloseMenu")
        time.sleep(1)
        put_status(s)
        helper("OpenMenu")
        time.sleep(1.5)
        shot("d-reopened")
        helper("ToggleSection", "folders")
        time.sleep(1)
        shot("e-folders-expanded-again")
    helper("CloseMenu")

elif SCENARIO == "live":
    helper("OpenMenu")
    for i in range(int(os.environ.get("SHOTS") or 3)):
        time.sleep(float(os.environ.get("EVERY") or 4))
        shot("live-%d" % i)
    if os.environ.get("CLICK_SYNC"):
        helper("Click", "Sync now")
        time.sleep(3)
        shot("live-after-sync-now")
    helper("CloseMenu")
