import importlib.machinery
import importlib.util
import json
import os
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("gds", os.path.join(HERE, "..", "src", "gdrive-sync"))
_spec = importlib.util.spec_from_loader("gds", _loader)
gds = importlib.util.module_from_spec(_spec)
_loader.exec_module(gds)


def write(path, text="x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


class NamingTests(unittest.TestCase):
    def test_local_name_cleans_drive_names(self):
        self.assertEqual(gds.local_name("Chapter 2\nCurrent week"), "Chapter 2 Current week")
        self.assertEqual(gds.local_name("a/b"), "a／b")
        self.assertEqual(gds.local_name("  .. "), "Untitled folder")
        self.assertEqual(gds.local_name(""), "Untitled folder")
        self.assertEqual(gds.local_name("مواضيع باك"), "مواضيع باك")
        self.assertLessEqual(len(gds.local_name("é" * 300).encode()), 200)

    def test_only_folders_you_own_are_queried(self):
        self.assertIn("'me' in owners", gds.STARRED_QUERY)
        self.assertIn("starred = true", gds.STARRED_QUERY)
        self.assertIn("trashed = false", gds.STARRED_QUERY)


class ClassifyTests(unittest.TestCase):
    def test_kinds(self):
        c = gds.classify
        self.assertEqual(c(["Bisync critical error: cannot find prior Path1 or Path2 listings, likely"]), "needs_resync")
        self.assertEqual(c(["Empty prior Path1 listing. Cannot sync to an empty directory: /x"]), "needs_resync")
        self.assertEqual(c(['too many deletes (>50%, 2 of 3) on Path1 "local"']), "too_many_deletes")
        self.assertEqual(c(["Empty current Path1 listing. Cannot sync to an empty directory: /x"]), "empty_local")
        self.assertEqual(c(["Empty current Path2 listing. Cannot sync"]), "empty_remote")
        self.assertEqual(c(['Get "https://www.googleapis.com/": dial tcp: lookup www.googleapis.com: no such host']), "offline")
        self.assertEqual(c(["googleapi: Error 404: File not found: ., notFound"]), "not_found")
        self.assertEqual(c(['oauth2: "invalid_client" "The OAuth client was not found."']), "auth")
        self.assertEqual(c(["something else"]), "error")
        self.assertEqual(c([]), "error")

    def test_friendly_errors_mention_command(self):
        text = gds.friendly_error("too_many_deletes", "AI", [])
        self.assertIn('gdrive-sync confirm-deletes "AI"', text)
        self.assertIn("boom", gds.friendly_error("error", "AI", ["boom"]))


class DescribeTests(unittest.TestCase):
    def test_transfers_and_deletes(self):
        d = gds.describe
        self.assertEqual(d("Copied (new)", "info", "sub/a.pdf", "*drive.Object", "F"),
                         ("down", "Downloaded F/sub/a.pdf", True, "F/sub/a.pdf", "Downloaded {n} files to F"))
        self.assertEqual(d("Copied (replaced existing)", "info", "a.pdf", "*local.Object", "F"),
                         ("up", "Uploaded F/a.pdf", False, "F/a.pdf", "Uploaded {n} files from F"))
        self.assertEqual(d("Deleted", "info", "sub/a.pdf", "*drive.Object", "F"),
                         ("delete", "Deleted in Google Drive: F/sub/a.pdf", False, "F/sub",
                          "Deleted {n} files in Google Drive: F"))
        self.assertEqual(d("Deleted", "info", "a.pdf", "*local.Object", "F"),
                         ("delete", "Deleted on this computer: F/a.pdf", True, "F", "Deleted {n} files on this computer: F"))

    def test_conflicts_lead_to_their_folder(self):
        self.assertEqual(gds.describe("Moved (server-side) to: sub/seed.txt.conflict1", "info", "sub/seed.txt",
                                      "*local.Object", "F"),
                         ("conflict", "Kept the older version as F/sub/seed.txt.conflict1", True, "F/sub", None))
        event = gds.describe("- WARNING           New or changed in both paths                - seed.txt",
                             "notice", "", "", "F")
        self.assertEqual((event.kind, event.text, event.path), ("conflict", "Changed on both sides: F/seed.txt", "F"))

    def test_noise_and_errors(self):
        self.assertIsNone(gds.describe("Set directory modification time (using DirSetModTime)", "info", "x", "string", "F"))
        self.assertIsNone(gds.describe("Building Path1 and Path2 listings", "info", "", "", "F"))
        self.assertIsNone(gds.describe("Resync is copying files from Path1 to Path2", "notice", "", "", "F"))
        self.assertIsNone(gds.describe("Bisync aborted. Please try again.", "error", "", "", "F"))
        self.assertEqual(gds.describe("boom", "error", "", "", "F"), ("error", "F: boom", False, None, None))


class ProgressTests(unittest.TestCase):
    def test_progress_from_stats(self):
        p = gds.progress_from_stats({"bytes": 50, "totalBytes": 200, "transfers": 1, "totalTransfers": 4, "speed": 9.5})
        self.assertEqual((p["percent"], p["files"], p["total_files"], p["speed"]), (25, 1, 4, 9.5))
        self.assertIsNone(gds.progress_from_stats({})["percent"])
        self.assertEqual(gds.progress_from_stats({"transfers": 1, "totalTransfers": 2})["percent"], 50)

    def test_transfer_entry_direction_and_defaults(self):
        down = gds.transfer_entry({"name": "a.ai", "size": 10, "srcFs": "gdrive{3MAIo}:", "dstFs": "/home/x"}, "logo")
        self.assertEqual((down["name"], down["direction"], down["bytes"], down["percent"]), ("logo/a.ai", "down", 0, 0))
        up = gds.transfer_entry({"name": "b", "srcFs": "/home/x", "dstFs": "gdrive:", "percentage": 40}, "F")
        self.assertEqual((up["direction"], up["percent"]), ("up", 40))


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_tree_signature_detects_changes(self):
        folder = os.path.join(self.root, "F")
        write(os.path.join(folder, "a.txt"), "1")
        sig1, count = gds.tree_signature([folder])
        self.assertEqual(count, 1)
        write(os.path.join(folder, ".~lock.a.txt#"), "lock")
        self.assertEqual(gds.tree_signature([folder])[0], sig1, "lock files must not trigger a sync")
        os.makedirs(os.path.join(folder, "empty-dir"))
        sig2, _ = gds.tree_signature([folder])
        self.assertNotEqual(sig1, sig2)
        os.rename(os.path.join(folder, "a.txt"), os.path.join(folder, "b.txt"))
        self.assertNotEqual(gds.tree_signature([folder])[0], sig2)

    def test_tree_signature_skips_what_bisync_excludes(self):
        folder = os.path.join(self.root, "F")
        write(os.path.join(folder, "report.odt"))
        sig, count = gds.tree_signature([folder])
        for rel in (gds.MARKER, "a/.~lock.report.odt#", "~$doc.docx", ".Trash-1000/files/x", "movie.mkv.part",
                    "sub/#10.mp4.282d4537.partial", "x.crdownload", ".goutputstream-AB12", "a/.Trash-1000/y"):
            write(os.path.join(folder, rel))
        # "a" and "sub" are real folders and count; everything inside them here is excluded
        self.assertEqual(gds.tree_signature([folder])[1], count + 2)
        write(os.path.join(folder, "sub", gds.MARKER))
        self.assertEqual(gds.tree_signature([folder])[1], count + 3, "only the top-level marker is excluded")
        self.assertNotEqual(gds.tree_signature([folder])[0], sig)

    def test_tree_signature_sees_a_move_to_another_synced_folder(self):
        a, b = os.path.join(self.root, "A"), os.path.join(self.root, "B")
        write(os.path.join(a, "x", "f.txt"))
        os.makedirs(os.path.join(b, "x"))
        dirs = [os.path.join(a, "x"), os.path.join(b, "x")]
        times = [os.stat(d).st_mtime_ns for d in dirs]
        sig = gds.tree_signature([a, b])[0]
        self.assertEqual(gds.tree_signature([b, a])[0], sig, "independent of order")
        os.rename(os.path.join(a, "x", "f.txt"), os.path.join(b, "x", "f.txt"))
        for d, t in zip(dirs, times):
            os.utime(d, ns=(t, t))  # leave the file's synced folder as the only difference
        self.assertNotEqual(gds.tree_signature([a, b])[0], sig)

    def test_tree_signature_sees_a_same_size_edit(self):
        path = os.path.join(self.root, "F", "a.txt")
        write(path, "1")
        sig = gds.tree_signature([os.path.dirname(path)])[0]
        st = os.stat(path)
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns + 1))
        self.assertNotEqual(gds.tree_signature([os.path.dirname(path)])[0], sig)

    def test_move_to_trash_fallback_writes_trashinfo(self):
        data_home = os.path.join(self.root, "share")
        target = os.path.join(self.root, "My Folder")
        write(os.path.join(target, "f.txt"))
        gds.move_to_trash(target, data_home, use_gio=False)
        self.assertFalse(os.path.exists(target))
        self.assertTrue(os.path.exists(os.path.join(data_home, "Trash", "files", "My Folder", "f.txt")))
        with open(os.path.join(data_home, "Trash", "info", "My Folder.trashinfo")) as f:
            info = f.read()
        self.assertIn("Path=" + target.replace(" ", "%20"), info)
        write(os.path.join(target, "g.txt"))
        gds.move_to_trash(target, data_home, use_gio=False)
        self.assertTrue(os.path.exists(os.path.join(data_home, "Trash", "files", "My Folder.2", "g.txt")))

    def test_nested_skip(self):
        self.assertEqual(gds.nested_skip({"A", "B", "C"}, {"A": {"x", "B"}, "B": set(), "C": {"y"}}), {"B"})
        self.assertEqual(gds.nested_skip({"A"}, {"A": {"A"}}), set())


class DaemonLogicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        home = self.tmp.name
        env = {"HOME": home, "XDG_RUNTIME_DIR": os.path.join(home, "run")}
        self.paths = gds.Paths(env)
        os.makedirs(os.path.dirname(self.paths.config_file))
        with open(self.paths.config_file, "w") as f:
            f.write("[gdrive-sync]\nremote = gdrive\nfolder = %s/GoogleDrive\nrclone = /bin/true\n" % home)
        self.daemon = gds.Daemon(self.paths, gds.Config(self.paths))
        os.makedirs(self.daemon.cfg.folder)

    def tearDown(self):
        self.tmp.cleanup()

    def test_activity_folds_bursts_and_repeats(self):
        note, root = self.daemon.note, self.daemon.cfg.folder
        for name in ("AI/x/a.pdf", "AI/x/b.pdf", "AI/c.pdf"):
            note("down", "Downloaded " + name, os.path.join(root, name), "Downloaded {n} files to AI")
        note("error", "logo: boom")
        note("error", "logo: boom")
        note("down", "Downloaded AI/d.pdf", os.path.join(root, "AI/d.pdf"), "Downloaded {n} files to AI")
        rows = [(a["id"], a["text"], a["path"]) for a in self.daemon.activity]
        self.assertEqual(rows, [(3, "Downloaded AI/d.pdf", os.path.join(root, "AI/d.pdf")),
                                (2, "logo: boom", None),
                                (1, "Downloaded 3 files to AI", os.path.join(root, "AI"))])

    def test_activity_bursts_only_fold_while_recent(self):
        note, root = self.daemon.note, self.daemon.cfg.folder
        note("up", "Uploaded F/a", os.path.join(root, "F/a"), "Uploaded {n} files from F")
        self.daemon.activity[0]["time"] -= gds.GROUP_SECONDS + 1
        note("up", "Uploaded F/b", os.path.join(root, "F/b"), "Uploaded {n} files from F")
        self.assertEqual([a["text"] for a in self.daemon.activity], ["Uploaded F/b", "Uploaded F/a"])

    def test_config_and_remote_spec(self):
        self.assertEqual(self.daemon.cfg.remote_spec("ID1"), "gdrive,root_folder_id=ID1:")
        self.assertTrue(self.daemon.cfg.folder.endswith("/GoogleDrive"))
        self.assertEqual(self.daemon.cfg.interval, 300)

    def test_new_folders_get_unique_names_and_existing_dirs_are_respected(self):
        offline = self.daemon.cfg.folder
        write(os.path.join(offline, "Labs", "someone-elses-file.txt"))
        starred = [{"id": "A", "name": "Labs"}, {"id": "B", "name": "Labs"}, {"id": "C", "name": "AI"}]
        active, retire = self.daemon.reconcile(starred, set())
        names = {r["id"]: r["local"] for r in active}
        self.assertEqual(names, {"A": "Labs (2)", "B": "Labs (3)", "C": "AI"})
        self.assertEqual([r["id"] for r in active], ["C", "A", "B"], "sorted by name")
        self.assertEqual(retire, [])

    def test_marker_lets_a_reinstall_adopt_its_folder(self):
        offline = self.daemon.cfg.folder
        write(os.path.join(offline, "Labs", gds.MARKER), "A\n")
        active, _ = self.daemon.reconcile([{"id": "A", "name": "Labs"}], set())
        self.assertEqual(active[0]["local"], "Labs")

    def test_unstarred_folder_retires_only_after_two_misses(self):
        self.daemon.reconcile([{"id": "A", "name": "Labs"}], set())
        _, retire = self.daemon.reconcile([], set())
        self.assertEqual(retire, [])
        _, retire = self.daemon.reconcile([], set())
        self.assertEqual([r["id"] for r in retire], ["A"])
        active, retire = self.daemon.reconcile([{"id": "A", "name": "Labs"}], set())
        self.assertEqual(([r["id"] for r in active], retire), (["A"], []))
        self.assertNotIn("retiring", active[0])

    def test_nested_folders_are_not_synced_separately(self):
        active, _ = self.daemon.reconcile([{"id": "P", "name": "Parent"},
                                           {"id": "K", "name": "Kid"}], {"K"})
        self.assertEqual([r["id"] for r in active], ["P"])

    def test_ensure_local_creates_dir_and_marker(self):
        active, _ = self.daemon.reconcile([{"id": "A", "name": "AI"}], set())
        rec = active[0]
        rec["needs_resync"] = False
        rec["last_sync"] = time.time()
        self.daemon.ensure_local(rec)
        path = self.daemon.local_path(rec)
        with open(os.path.join(path, gds.MARKER)) as f:
            self.assertEqual(f.read().strip(), "A")
        self.assertTrue(rec["needs_resync"], "a recreated folder must resync instead of looking emptied")

    def test_status_snapshot_is_serializable(self):
        self.daemon.reconcile([{"id": "A", "name": "AI"}], set())
        status = self.daemon.snapshot_status()
        json.dumps(status)
        self.assertEqual(status["folders"][0]["state"], "pending")
        self.assertEqual(status["folder"], self.daemon.cfg.folder)


if __name__ == "__main__":
    unittest.main()
