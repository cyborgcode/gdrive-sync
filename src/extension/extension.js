import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const STATUS_FILE = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gdrive-sync', 'status.json']);
const CLI = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'gdrive-sync']);
const SECTIONS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'gdrive-sync', 'extension.json']);
const STALE_SECONDS = 20;
const MAX_TRANSFERS = 5;
const MAX_ACTIVITY = 12;

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatBytes(bytes) {
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (bytes >= 1000 && i < units.length - 1) {
        bytes /= 1000;
        i++;
    }
    return `${bytes.toFixed(i === 0 || bytes >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds) {
    if (seconds < 60)
        return `${Math.max(1, Math.round(seconds))} s`;
    if (seconds < 3600)
        return `${Math.round(seconds / 60)} min`;
    return `${Math.round(seconds / 3600)} h`;
}

function ago(timestamp) {
    const seconds = Date.now() / 1000 - timestamp;
    return seconds < 60 ? 'just now' : `${formatDuration(seconds)} ago`;
}

// St.BoxLayout gained "orientation" in GNOME 48 and deprecated "vertical"
function verticalBox(params = {}) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function makeLabel(styleClass, ellipsize = Pango.EllipsizeMode.END, params = {}) {
    const label = new St.Label({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...params});
    label.clutter_text.ellipsize = ellipsize;
    return label;
}

function setWrapped(label, wrapped) {
    label.clutter_text.line_wrap = wrapped;
    label.clutter_text.ellipsize = wrapped ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
}

function loadExpanded() {
    const expanded = {activity: true, folders: true};
    try {
        const [, contents] = GLib.file_get_contents(SECTIONS_FILE);
        const saved = JSON.parse(new TextDecoder().decode(contents));
        for (const key of Object.keys(expanded)) {
            if (typeof saved[key] === 'boolean')
                expanded[key] = saved[key];
        }
    } catch {
        // No saved choice yet: both sections start expanded
    }
    return expanded;
}

function saveExpanded(expanded) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SECTIONS_FILE), 0o755);
        GLib.file_set_contents(SECTIONS_FILE, JSON.stringify(expanded));
    } catch (e) {
        console.error(`gdrive-sync: could not save section state: ${e.message}`);
    }
}

function openPath(path) {
    try {
        Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(path, null),
            global.create_app_launch_context(0, -1));
    } catch (e) {
        console.error(`gdrive-sync: could not open ${path}: ${e.message}`);
    }
}

// St greys out non-reactive widgets; these rows stay reactive for full contrast but ignore clicks and focus
const InfoRow = GObject.registerClass(
class InfoRow extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false});
        this.syncSensitive();
    }

    syncSensitive() {
        this.reactive = true;
        this.can_focus = false;
        return true;
    }
});

// Runs its action without closing the menu, so the progress it starts stays visible
const ActionItem = GObject.registerClass(
class ActionItem extends PopupMenu.PopupImageMenuItem {
    _init(text, icon, action) {
        super._init(text, icon);
        this._action = action;
    }

    activate(_event) {
        this._action();
    }
});

// Clickable section title with a GNOME-style arrow; toggles its section without closing the menu
const SectionHeader = GObject.registerClass(
class SectionHeader extends PopupMenu.PopupBaseMenuItem {
    _init(onToggle) {
        super._init();
        this._onToggle = onToggle;
        this.label = makeLabel('gdrive-sync-section', Pango.EllipsizeMode.END, {x_expand: true, opacity: 200});
        this.add_child(this.label);
        this.label_actor = this.label;
        this._arrow = PopupMenu.arrowIcon(St.Side.RIGHT);
        this._arrow.pivot_point = new Graphene.Point({x: 0.5, y: 0.6});
        this.add_child(this._arrow);
        this.add_accessible_state(Atk.StateType.EXPANDABLE);
    }

    setExpanded(expanded, animate) {
        const open = this.text_direction === Clutter.TextDirection.RTL ? -90 : 90;
        this._arrow.ease({
            rotation_angle_z: expanded ? open : 0,
            duration: animate ? 250 : 0,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
        });
        if (expanded)
            this.add_accessible_state(Atk.StateType.EXPANDED);
        else
            this.remove_accessible_state(Atk.StateType.EXPANDED);
    }

    setExpandable(expandable) {
        this._arrow.visible = expandable;
    }

    activate(_event) {
        this._onToggle();
    }
});

const HeaderRow = GObject.registerClass(
class HeaderRow extends InfoRow {
    _init() {
        super._init();
        const column = verticalBox({x_expand: true});
        this._title = makeLabel('gdrive-sync-title');
        this._subtitle = makeLabel('gdrive-sync-small', Pango.EllipsizeMode.END, {opacity: 190});
        column.add_child(this._title);
        column.add_child(this._subtitle);
        this.add_child(column);
    }

    update(title, subtitle) {
        this._title.text = title;
        this._subtitle.text = subtitle;
        this._subtitle.visible = subtitle !== '';
    }
});

const NoteRow = GObject.registerClass(
class NoteRow extends InfoRow {
    _init(icon) {
        super._init();
        this.add_child(new St.Icon({gicon: icon, style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.START}));
        this._text = makeLabel('gdrive-sync-small', Pango.EllipsizeMode.NONE, {x_expand: true});
        setWrapped(this._text, true);
        this.add_child(this._text);
    }

    update(text) {
        this._text.text = text;
    }
});

const ProgressRow = GObject.registerClass(
class ProgressRow extends InfoRow {
    _init() {
        super._init();
        this._bar = new BarLevel.BarLevel({style_class: 'slider gdrive-sync-progress', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._percent = makeLabel('gdrive-sync-percent');
        this.add_child(this._bar);
        this.add_child(this._percent);
    }

    update(percent) {
        this._bar.value = Math.min(1, percent / 100);
        this._percent.text = `${percent}%`;
    }
});

const TransferRow = GObject.registerClass(
class TransferRow extends InfoRow {
    _init(icons) {
        super._init();
        this._icons = icons;
        this._icon = new St.Icon({style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.START});
        this.add_child(this._icon);
        const column = verticalBox({x_expand: true});
        this._path = makeLabel('gdrive-sync-path', Pango.EllipsizeMode.START);
        this._detail = makeLabel('gdrive-sync-small', Pango.EllipsizeMode.END, {opacity: 190});
        this._bar = new BarLevel.BarLevel({style_class: 'slider gdrive-sync-progress', x_expand: true});
        column.add_child(this._path);
        column.add_child(this._detail);
        column.add_child(this._bar);
        this.add_child(column);
    }

    update(transfer) {
        const upload = transfer.direction === 'up';
        this._icon.gicon = upload ? this._icons.up : this._icons.down;
        this._path.text = transfer.name;
        const verb = upload ? 'Uploading' : 'Downloading';
        const parts = [];
        if (!transfer.bytes) {
            parts.push(`${verb} · waiting for Google Drive…`, formatBytes(transfer.size || 0));
        } else {
            parts.push(`${verb} ${transfer.percent}%`,
                `${formatBytes(transfer.bytes)} of ${formatBytes(transfer.size || 0)}`);
            if (transfer.speed > 0)
                parts.push(`${formatBytes(transfer.speed)}/s`);
            if (transfer.eta)
                parts.push(`${formatDuration(transfer.eta)} left`);
        }
        this._detail.text = parts.join(' · ');
        this._bar.value = Math.min(1, (transfer.percent || 0) / 100);
    }
});

const ActivityRow = GObject.registerClass(
class ActivityRow extends InfoRow {
    _init(icons) {
        super._init();
        this._icons = icons;
        this._time = makeLabel('gdrive-sync-time', Pango.EllipsizeMode.NONE, {opacity: 160});
        this._icon = new St.Icon({style_class: 'popup-menu-icon'});
        this._text = makeLabel('gdrive-sync-small gdrive-sync-path', Pango.EllipsizeMode.MIDDLE, {x_expand: true});
        this.add_child(this._time);
        this.add_child(this._icon);
        this.add_child(this._text);
    }

    update(entry) {
        this._time.text = GLib.DateTime.new_from_unix_local(Math.floor(entry.time)).format('%H:%M:%S');
        this._icon.gicon = this._icons.activity[entry.kind] ?? this._icons.activity.info;
        this._text.text = entry.text;
    }
});

const FolderRow = GObject.registerClass(
class FolderRow extends PopupMenu.PopupBaseMenuItem {
    _init(icons, onOpen) {
        super._init();
        this._icons = icons;
        this._icon = new St.Icon({style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.START});
        this.add_child(this._icon);
        const column = verticalBox({x_expand: true});
        this._name = makeLabel('gdrive-sync-path');
        this._detail = makeLabel('gdrive-sync-small', Pango.EllipsizeMode.END, {opacity: 190});
        column.add_child(this._name);
        column.add_child(this._detail);
        this.add_child(column);
        this.connect('activate', () => onOpen(this._folderPath));
    }

    update(folder) {
        this._folderPath = folder.path;
        this._name.text = folder.name;
        const details = {
            synced: `Synced ${folder.last_sync ? ago(folder.last_sync) : ''}`,
            syncing: 'Syncing now…',
            pending: 'Waiting for the first sync',
            waiting: 'Waiting for an internet connection',
            retiring: 'No longer starred: moving it to the Trash',
        };
        const error = folder.state === 'error' && folder.error;
        this._detail.text = error ? folder.error : details[folder.state] ?? '';
        setWrapped(this._detail, Boolean(error));
        this._icon.gicon = this._icons.folder[folder.state] ?? this._icons.folder.synced;
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.5, 'Google Drive Sync');
        this._cancellable = new Gio.Cancellable();
        this._status = null;
        this._reading = false;
        this._transferRows = new Map();
        this._folderRows = new Map();
        this._folderKey = '';

        const themed = names => Gio.ThemedIcon.new_from_names(names);
        const bundled = name => Gio.icon_new_for_string(`${extensionPath}/icons/${name}.svg`);
        const syncing = themed(['emblem-synchronizing-symbolic', 'view-refresh-symbolic']);
        const warning = themed(['dialog-warning-symbolic']);
        const offline = themed(['network-offline-symbolic']);
        const trash = themed(['user-trash-symbolic']);
        const cloud = themed(['weather-overcast-symbolic', 'folder-remote-symbolic']);
        this._icons = {
            panel: {idle: cloud, syncing, offline: cloud, error: warning},
            up: bundled('gdrive-upload-symbolic'),
            down: bundled('gdrive-download-symbolic'),
            activity: {
                up: bundled('gdrive-upload-symbolic'),
                down: bundled('gdrive-download-symbolic'),
                delete: trash,
                conflict: themed(['dialog-information-symbolic']),
                error: themed(['dialog-error-symbolic', 'dialog-warning-symbolic']),
                info: syncing,
            },
            folder: {synced: bundled('gdrive-synced-symbolic'), syncing, pending: syncing, waiting: offline,
                error: warning, retiring: trash},
        };

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({gicon: this._icons.panel.idle, style_class: 'system-status-icon'});
        this._label = makeLabel('gdrive-sync-label', Pango.EllipsizeMode.NONE, {visible: false});
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._expanded = loadExpanded();
        this._buildMenu(warning);
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._renderMenu();
                this._refresh();
            }
        });

        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu(warningIcon) {
        this._header = new HeaderRow();
        this.menu.addMenuItem(this._header);
        this._warning = new NoteRow(warningIcon);
        this.menu.addMenuItem(this._warning);
        this._progressRow = new ProgressRow();
        this.menu.addMenuItem(this._progressRow);

        // Panel menus only shrink to fit the screen through a scrollable part
        const scrolled = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        if (typeof scroll.set_child === 'function')
            scroll.set_child(scrolled.actor);
        else
            scroll.add_actor(scrolled.actor);
        const holder = new PopupMenu.PopupMenuSection();
        holder.actor.add_child(scroll);
        this.menu.addMenuItem(holder);

        this._transferSection = new PopupMenu.PopupMenuSection();
        scrolled.addMenuItem(this._transferSection);
        this._activitySeparator = new PopupMenu.PopupSeparatorMenuItem();
        scrolled.addMenuItem(this._activitySeparator);
        this._activityHeader = new SectionHeader(() => this._toggle('activity'));
        this._activityHeader.label.text = 'Activity';
        scrolled.addMenuItem(this._activityHeader);
        this._activitySection = new PopupMenu.PopupMenuSection();
        scrolled.addMenuItem(this._activitySection);
        this._activityRows = [];
        for (let i = 0; i < MAX_ACTIVITY; i++) {
            const row = new ActivityRow(this._icons);
            this._activityRows.push(row);
            this._activitySection.addMenuItem(row);
        }
        this._foldersSeparator = new PopupMenu.PopupSeparatorMenuItem();
        scrolled.addMenuItem(this._foldersSeparator);
        this._foldersHeader = new SectionHeader(() => this._toggle('folders'));
        scrolled.addMenuItem(this._foldersHeader);
        this._foldersSection = new PopupMenu.PopupMenuSection();
        scrolled.addMenuItem(this._foldersSection);
        this._activityHeader.setExpanded(this._expanded.activity, false);
        this._foldersHeader.setExpanded(this._expanded.folders, false);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._syncItem = new ActionItem('Sync now', 'view-refresh-symbolic', () => this._run([CLI, 'now']));
        this.menu.addMenuItem(this._syncItem);
        this._startItem = new ActionItem('Start the sync service', 'media-playback-start-symbolic',
            () => this._run(['systemctl', '--user', 'start', 'gdrive-sync.service']));
        this.menu.addMenuItem(this._startItem);
        this._openFolder = new PopupMenu.PopupImageMenuItem('Open Google Drive folder', 'folder-symbolic');
        this._openFolder.connect('activate', () => openPath(this._status.folder));
        this.menu.addMenuItem(this._openFolder);
    }

    _toggle(key) {
        this._expanded[key] = !this._expanded[key];
        saveExpanded(this._expanded);
        const header = key === 'activity' ? this._activityHeader : this._foldersHeader;
        header.setExpanded(this._expanded[key], true);
        this._renderMenu();
    }

    _run(argv) {
        try {
            const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE);
            proc.wait_async(this._cancellable, (p, result) => {
                try {
                    p.wait_finish(result);
                } catch {
                    return;
                }
                this._refresh();
            });
        } catch (e) {
            console.error(`gdrive-sync: could not run ${argv.join(' ')}: ${e.message}`);
        }
    }

    _refresh() {
        if (this._reading || this._cancellable.is_cancelled())
            return;
        this._reading = true;
        Gio.File.new_for_path(STATUS_FILE).load_contents_async(this._cancellable, (file, result) => {
            this._reading = false;
            let status = null;
            try {
                const [, contents] = file.load_contents_finish(result);
                status = JSON.parse(new TextDecoder().decode(contents));
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
            }
            if (status && (status.state === 'stopped' || Date.now() / 1000 - status.updated > STALE_SECONDS))
                status = null;
            this._status = status;
            this._render();
        });
    }

    _render() {
        const s = this._status;
        let icon = this._icons.panel.idle;
        let text = '';
        if (!s) {
            icon = this._icons.panel.offline;
        } else if (s.state === 'syncing') {
            icon = this._icons.panel.syncing;
            const percent = s.progress?.percent;
            if (percent !== null && percent !== undefined)
                text = `${percent}%`;
        } else if (s.state === 'offline') {
            icon = this._icons.panel.offline;
        } else if (s.state === 'error') {
            icon = this._icons.panel.error;
        }
        this._icon.gicon = icon;
        this._icon.opacity = !s || s.state === 'offline' ? 128 : 255;
        this._label.text = text;
        this._label.visible = text !== '';
        if (this.menu.isOpen)
            this._renderMenu();
    }

    _headerText(s) {
        const now = Date.now() / 1000;
        if (s.state === 'syncing' && s.current) {
            const c = s.current;
            const title = c.count > 1 ? `Syncing ${c.folder} (${c.index} of ${c.count})` : `Syncing ${c.folder}`;
            const queued = s.sync_requested ? ' · another sync queued' : '';
            const p = s.progress;
            if (!p || !p.total_files)
                return [title, `${c.phase || 'Working'}…${queued}`];
            const parts = [`${p.files} of ${plural(p.total_files, 'file')}`,
                `${formatBytes(p.bytes)} of ${formatBytes(p.total_bytes)}`];
            if (p.speed > 0)
                parts.push(`${formatBytes(p.speed)}/s`);
            if (p.eta)
                parts.push(`${formatDuration(p.eta)} left`);
            return [title, parts.join(' · ') + queued];
        }
        if (s.state === 'syncing' || !s.last_sync)
            return [s.message, ''];
        let subtitle = `Last synced ${ago(s.last_sync)}`;
        if (s.next_sync && s.next_sync > now)
            subtitle += ` · next check in ${formatDuration(s.next_sync - now)}`;
        return [s.message, subtitle];
    }

    _renderMenu() {
        const s = this._status;
        const running = s !== null;
        this._syncItem.visible = running;
        this._startItem.visible = !running;
        this._openFolder.visible = running;
        this._transferSection.actor.visible = running;

        if (!running) {
            this._header.update("The sync service isn't running", 'Start it to keep your starred folders in sync');
            this._warning.visible = false;
            this._progressRow.visible = false;
            for (const item of [this._activitySeparator, this._activityHeader, this._foldersSeparator,
                this._foldersHeader])
                item.visible = false;
            this._activitySection.actor.visible = false;
            this._foldersSection.actor.visible = false;
            return;
        }

        const [title, subtitle] = this._headerText(s);
        this._header.update(title, subtitle);
        this._warning.visible = Boolean(s.warning);
        if (s.warning)
            this._warning.update(s.warning);

        const percent = s.progress?.percent;
        this._progressRow.visible = s.state === 'syncing' && percent !== null && percent !== undefined;
        if (this._progressRow.visible)
            this._progressRow.update(percent);

        this._renderTransfers(s.transfers.slice(0, MAX_TRANSFERS));

        const activity = s.activity.slice(0, MAX_ACTIVITY);
        this._activitySeparator.visible = activity.length > 0;
        this._activityHeader.visible = activity.length > 0;
        this._activitySection.actor.visible = activity.length > 0 && this._expanded.activity;
        this._activityRows.forEach((row, i) => {
            row.visible = i < activity.length;
            if (row.visible)
                row.update(activity[i]);
        });

        this._renderFolders(s.folders);
    }

    _renderTransfers(transfers) {
        const seen = new Set();
        for (const transfer of transfers) {
            seen.add(transfer.name);
            let row = this._transferRows.get(transfer.name);
            if (!row) {
                row = new TransferRow(this._icons);
                this._transferRows.set(transfer.name, row);
                this._transferSection.addMenuItem(row);
            }
            row.update(transfer);
        }
        for (const [name, row] of this._transferRows) {
            if (!seen.has(name)) {
                row.destroy();
                this._transferRows.delete(name);
            }
        }
    }

    _renderFolders(folders) {
        const key = folders.map(f => f.id).join('\n');
        if (key !== this._folderKey) {
            this._foldersSection.removeAll();
            this._folderRows.clear();
            for (const folder of folders) {
                const row = new FolderRow(this._icons, path => {
                    this.menu.close();
                    openPath(path);
                });
                this._folderRows.set(folder.id, row);
                this._foldersSection.addMenuItem(row);
            }
            this._folderKey = key;
        }
        this._foldersSeparator.visible = true;
        this._foldersHeader.visible = true;
        this._foldersHeader.label.text = folders.length
            ? `Synced folders (${folders.length})`
            : 'Synced folders: none yet — star one of your folders in Google Drive';
        this._foldersHeader.setExpandable(folders.length > 0);
        this._foldersSection.actor.visible = folders.length > 0 && this._expanded.folders;
        for (const folder of folders)
            this._folderRows.get(folder.id).update(folder);
    }

    _onDestroy() {
        GLib.Source.remove(this._timeoutId);
        this._cancellable.cancel();
        super._onDestroy();
    }
});

export default class GDriveSyncExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
