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
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const STATUS_FILE = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gdrive-sync', 'status.json']);
const CLI = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'gdrive-sync']);
const SECTIONS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'gdrive-sync', 'extension.json']);
const STALE_SECONDS = 20;
const MAX_TRANSFERS = 5;
const MAX_ACTIVITY = 12;
// How long the pointer rests on a header or row before it expands
const HOVER_DELAY = 350;
// Grace period before a hover-opened section closes, so crossing a gap doesn't shut it
const LEAVE_DELAY = 250;
// Room kept free below Quick Settings, and the least height the lists keep on a very short screen
const SCREEN_MARGIN = 12;
const MIN_LISTS_HEIGHT = 120;

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

// Activity can point at a file that has since moved or been deleted: open the closest folder still there
function openNearest(path) {
    while (!GLib.file_test(path, GLib.FileTest.EXISTS) && GLib.path_get_dirname(path) !== path)
        path = GLib.path_get_dirname(path);
    openPath(path);
}

// Height easing for rows and sections. While an actor has a fixed height Clutter reports that as its
// preferred height, so clear it before measuring. Measure at the width from the last layout pass: once a
// relayout is queued, actor.width reports the preferred width instead, which is too wide for wrapped text.
function laidOutWidth(actor) {
    return actor.get_allocation_box().get_width();
}

function naturalHeight(actor, forWidth) {
    actor.remove_transition('natural-height');
    actor.height = -1;
    return actor.get_preferred_height(forWidth)[1];
}

// Clips the content while the height moves, then hands sizing back to the layout. Only the natural height
// eases, with a zero minimum: an eased height is fractional, its allocation is rounded down, and the scroll
// view shows a scrollbar whenever content's minimum height exceeds its allocation even by a fraction.
function easeHeight(actor, from, to, duration, done = () => {}) {
    actor.remove_transition('natural-height');
    actor.set({min_height: 0, natural_height: from, clip_to_allocation: true});
    actor.ease({
        natural_height: to,
        duration,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
            actor.set({height: -1, clip_to_allocation: false});
            done();
        },
    });
}

// Calls onEnter once the pointer has rested on actor for HOVER_DELAY, and onLeave when it leaves or the menu
// closes. Uses crossing events, not the hover property, so rows that can't be clicked get no hover highlight.
// Returns a function that drops a pending onEnter.
function onHoverIntent(actor, onEnter, onLeave = () => {}) {
    let id = 0;
    const cancel = () => {
        if (id)
            GLib.Source.remove(id);
        id = 0;
    };
    actor.connect('enter-event', () => {
        cancel();
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_DELAY, () => {
            id = 0;
            onEnter();
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('leave-event', () => {
        cancel();
        onLeave();
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('notify::mapped', () => {
        if (!actor.mapped) {
            cancel();
            onLeave();
        }
    });
    actor.connect('destroy', cancel);
    return cancel;
}

// A row whose label is cut off shows all of it on hover: the text wraps and the row eases taller, then
// eases back and ellipsizes again when the pointer leaves
function expandOnHover(row, label) {
    const text = label.clutter_text;
    const mode = text.ellipsize;
    const wrap = on => {
        text.line_wrap = on;
        text.ellipsize = on ? Pango.EllipsizeMode.NONE : mode;
    };
    let full = false;
    const show = wanted => {
        if (wanted === full || (wanted && !text.get_layout().is_ellipsized()))
            return;
        full = wanted;
        if (!row.mapped) {
            naturalHeight(row, -1);
            row.clip_to_allocation = false;
            wrap(wanted);
            return;
        }
        const from = row.height;
        const width = laidOutWidth(row);
        wrap(false);
        const short = naturalHeight(row, width);
        wrap(true);
        const [, tall] = row.get_preferred_height(width);
        // Stays wrapped while shrinking, so the clip covers the extra lines instead of them snapping away
        easeHeight(row, from, wanted ? tall : short, 200, () => wrap(wanted));
    };
    onHoverIntent(row, () => show(true), () => show(false));
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

// Clickable section title with a GNOME-style arrow; toggles its section without closing the menu,
// and opens it when the pointer rests on it
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

    get expandable() {
        return this._arrow.visible;
    }

    activate(_event) {
        this._onToggle();
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
        this._path = makeLabel(null, Pango.EllipsizeMode.START);
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

// Entries with a path open it on click; the others behave like InfoRow
const ActivityRow = GObject.registerClass(
class ActivityRow extends PopupMenu.PopupBaseMenuItem {
    _init(icons, clickable, onOpen) {
        super._init({reactive: clickable, can_focus: clickable, style_class: 'gdrive-sync-activity'});
        this._icons = icons;
        this._icon = new St.Icon({style_class: 'popup-menu-icon', y_align: Clutter.ActorAlign.START});
        this._text = makeLabel('gdrive-sync-small', Pango.EllipsizeMode.MIDDLE, {x_expand: true});
        this._time = makeLabel('gdrive-sync-time', Pango.EllipsizeMode.NONE,
            {opacity: 160, y_align: Clutter.ActorAlign.START});
        this.add_child(this._icon);
        this.add_child(this._text);
        this.add_child(this._time);
        expandOnHover(this, this._text);
        if (clickable)
            this.connect('activate', () => onOpen(this._path));
        this.connect('destroy', () => {
            if (this._glowId)
                GLib.Source.remove(this._glowId);
        });
        this.syncSensitive();
    }

    syncSensitive() {
        if (this._activatable)
            return super.syncSensitive();
        this.reactive = true;
        this.can_focus = false;
        return true;
    }

    update(entry) {
        this._path = entry.path;
        this._icon.gicon = this._icons.activity[entry.kind] ?? this._icons.activity.info;
        this._text.text = entry.text;
        this._time.text = ago(entry.time);
    }

    // Grows in at the top and glows for a moment, then the glow fades out
    reveal() {
        this.opacity = 0;
        this.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        easeHeight(this, 0, naturalHeight(this, -1), 250);
        this.add_style_class_name('gdrive-sync-new');
        // Runs twice: swap the glow for the fading style, then drop that once the fade is over
        this._glowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            if (this.has_style_class_name('gdrive-sync-new')) {
                this.remove_style_class_name('gdrive-sync-new');
                this.add_style_class_name('gdrive-sync-fade');
                return GLib.SOURCE_CONTINUE;
            }
            this.remove_style_class_name('gdrive-sync-fade');
            this._glowId = 0;
            return GLib.SOURCE_REMOVE;
        });
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
        this._name = makeLabel(null);
        this._detail = makeLabel('gdrive-sync-small', Pango.EllipsizeMode.END, {opacity: 190});
        column.add_child(this._name);
        column.add_child(this._detail);
        this.add_child(column);
        expandOnHover(this, this._name);
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

// A Quick Settings toggle whose menu holds the full status, plus a small icon among the system indicators
// while the service runs
const GDriveIndicator = GObject.registerClass(
class GDriveIndicator extends QuickSettings.SystemIndicator {
    _init(extensionPath) {
        super._init();
        this._cancellable = new Gio.Cancellable();
        this._status = null;
        this._reading = false;
        this._transferRows = new Map();
        this._activityRows = new Map();
        this._activityShown = false;
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

        this._icon = this._addIndicator();
        this._icon.set({gicon: cloud, pivot_point: new Graphene.Point({x: 0.5, y: 0.5}), visible: false});
        this._spinning = false;

        // On and off also apply at the next login, like GNOME's own toggles
        this._quickToggle = new QuickSettings.QuickMenuToggle({title: 'Google Drive', gicon: cloud});
        this._quickToggle.connect('clicked', () => this._run(['systemctl', '--user', this._status ? 'disable' : 'enable',
            '--now', 'gdrive-sync.service']));
        this.quickSettingsItems.push(this._quickToggle);
        this.menu = this._quickToggle.menu;

        this._expanded = loadExpanded();
        this._buildMenu();
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) {
                this._renderMenu();
                this._refresh();
                return;
            }
            // Hover-opened sections don't outlive the menu
            for (const key of Object.keys(this._sections)) {
                this._clearSectionTimer(key);
                if (this._peek[key]) {
                    this._peek[key] = false;
                    this._show(key, false, false);
                }
            }
        });

        this._refresh();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        const quickSettings = Main.panel.statusArea.quickSettings.menu;
        const quickSettingsOpenId = quickSettings.connect('open-state-changed', (menu, open) => {
            if (open)
                this._fitToScreen();
        });
        this.connect('destroy', () => {
            quickSettings.disconnect(quickSettingsOpenId);
            GLib.Source.remove(this._timeoutId);
            for (const key of Object.keys(this._sections))
                this._clearSectionTimer(key);
            this._cancellable.cancel();
        });
    }

    _buildMenu() {
        this.menu.setHeader(this._icons.panel.idle, 'Google Drive');
        this._progressRow = new ProgressRow();
        this.menu.addMenuItem(this._progressRow);

        // Quick Settings itself can't scroll, so the lists scroll inside it: capped at 24em by the stylesheet,
        // and lower still by _fitToScreen when the screen has less room
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
        this._scroll = scroll;
        this._lists = new PopupMenu.PopupMenuSection();
        this._lists.actor.add_style_class_name('gdrive-sync-lists');
        this._lists.actor.add_child(scroll);
        this.menu.addMenuItem(this._lists);

        this._transferSection = new PopupMenu.PopupMenuSection();
        scrolled.addMenuItem(this._transferSection);
        this._activitySeparator = new PopupMenu.PopupSeparatorMenuItem();
        scrolled.addMenuItem(this._activitySeparator);
        this._activityHeader = new SectionHeader(() => this._toggle('activity'));
        this._activityHeader.label.text = 'Activity';
        scrolled.addMenuItem(this._activityHeader);
        this._activitySection = new PopupMenu.PopupMenuSection();
        scrolled.addMenuItem(this._activitySection);
        this._foldersSeparator = new PopupMenu.PopupSeparatorMenuItem();
        scrolled.addMenuItem(this._foldersSeparator);
        this._foldersHeader = new SectionHeader(() => this._toggle('folders'));
        scrolled.addMenuItem(this._foldersHeader);
        this._foldersSection = new PopupMenu.PopupMenuSection();
        scrolled.addMenuItem(this._foldersSection);
        this._sections = {
            activity: {header: this._activityHeader, section: this._activitySection},
            folders: {header: this._foldersHeader, section: this._foldersSection},
        };
        this._peek = {activity: false, folders: false};
        this._sectionTimers = {activity: 0, folders: 0};
        for (const [key, {header, section}] of Object.entries(this._sections)) {
            header.setExpanded(this._expanded[key], false);
            section.actor.visible = this._expanded[key];
            // Reactive with hover tracking so the pointer over its rows (or the gaps between them) counts
            section.actor.set({reactive: true, track_hover: true});
            for (const actor of [header, section.actor])
                actor.connect('notify::hover', () => this._onSectionHover(key));
        }

        this._actionsSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._actionsSeparator);
        this._syncItem = new ActionItem('Sync now', 'view-refresh-symbolic', () => this._run([CLI, 'now']));
        this.menu.addMenuItem(this._syncItem);
        this._openFolder = new PopupMenu.PopupImageMenuItem('Open Google Drive folder', 'folder-symbolic');
        this._openFolder.connect('activate', () => {
            Main.panel.closeQuickSettings();
            openPath(this._status.folder);
        });
        this.menu.addMenuItem(this._openFolder);
    }

    // A click keeps a section open (remembered across menu openings); on one that hover opened, it pins it
    _toggle(key) {
        this._clearSectionTimer(key);
        const open = !this._expanded[key];
        this._expanded[key] = open;
        saveExpanded(this._expanded);
        const wasOpen = this._peek[key] || !open;
        this._peek[key] = false;
        if (wasOpen !== open)
            this._show(key, open);
    }

    // Hovering a closed section's header opens it until the pointer leaves the header and its rows
    _onSectionHover(key) {
        const {header, section} = this._sections[key];
        const inside = header.hover || section.actor.hover;
        this._clearSectionTimer(key);
        const peek = inside
            ? !this._expanded[key] && !this._peek[key] && header.expandable
            : this._peek[key];
        if (!peek)
            return;
        this._sectionTimers[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, inside ? HOVER_DELAY : LEAVE_DELAY, () => {
            this._sectionTimers[key] = 0;
            this._peek[key] = inside;
            this._show(key, inside);
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearSectionTimer(key) {
        if (this._sectionTimers[key])
            GLib.Source.remove(this._sectionTimers[key]);
        this._sectionTimers[key] = 0;
    }

    // Sections slide open and shut by easing their height, like GNOME's own submenus
    _show(key, open, animate = true) {
        const {header, section} = this._sections[key];
        header.setExpanded(open, animate);
        const actor = section.actor;
        if (!animate) {
            naturalHeight(actor, -1);
            actor.set({clip_to_allocation: false, visible: open});
            return;
        }
        const from = actor.visible ? actor.height : 0;
        const width = laidOutWidth(actor.get_parent());
        actor.visible = true;
        const natural = naturalHeight(actor, width);
        easeHeight(actor, from, open ? natural : 0, 250, () => (actor.visible = open));
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
        const icon = this._icons.panel[s?.state] ?? this._icons.panel.idle;
        let subtitle = s?.message ?? 'Off';
        if (s?.state === 'syncing') {
            const percent = s.progress?.percent;
            subtitle = percent === null || percent === undefined ? 'Syncing…' : `Syncing ${percent}%`;
        } else if (s?.state === 'offline') {
            subtitle = 'Offline';
        }
        this._icon.set({gicon: icon, visible: s !== null, opacity: s?.state === 'offline' ? 128 : 255});
        this._setSpinning(s?.state === 'syncing');
        this._quickToggle.set({checked: s !== null, gicon: s ? icon : this._icons.panel.idle, subtitle});
        if (this.menu.isOpen)
            this._renderMenu();
    }

    // _render runs every second, so only (re)start the endless turn when the state flips
    _setSpinning(spinning) {
        if (spinning === this._spinning)
            return;
        this._spinning = spinning;
        this._icon.remove_all_transitions();
        this._icon.rotation_angle_z = 0;
        if (spinning) {
            this._icon.ease({
                rotation_angle_z: 360,
                duration: 1500,
                mode: Clutter.AnimationMode.LINEAR,
                repeatCount: -1,
            });
        }
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
        this._actionsSeparator.visible = running;
        this._syncItem.visible = running;
        this._openFolder.visible = running;
        this._lists.actor.visible = running;

        if (!running) {
            this.menu.setHeader(this._icons.panel.idle, 'Google Drive is off',
                'Turn it on to keep your starred folders in sync');
            this._progressRow.visible = false;
            return;
        }

        const [title, subtitle] = this._headerText(s);
        this.menu.setHeader(this._icons.panel[s.state] ?? this._icons.panel.idle, title, subtitle);

        const percent = s.progress?.percent;
        this._progressRow.visible = s.state === 'syncing' && percent !== null && percent !== undefined;
        if (this._progressRow.visible)
            this._progressRow.update(percent);

        this._renderTransfers(s.transfers.slice(0, MAX_TRANSFERS));

        const activity = s.activity.slice(0, MAX_ACTIVITY);
        this._activitySeparator.visible = activity.length > 0;
        this._activityHeader.visible = activity.length > 0;
        this._renderActivity(activity, s.pid);

        this._renderFolders(s.folders);
        this._fitToScreen();
    }

    // Gives the lists only the height left between the top of Quick Settings and the bottom of the screen.
    // The rest of the panel is measured as if this toggle's menu were fully open, so the result is the same
    // whether the menu is closed, opening, or open.
    _fitToScreen() {
        const panel = Main.panel.statusArea.quickSettings.menu.box;
        const monitor = Main.layoutManager.findMonitorForActor(panel) ?? Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const width = laidOutWidth(panel);
        const [, panelHeight] = panel.get_preferred_height(width);
        const container = this.menu.actor;
        const [, shownHeight] = container.visible ? container.get_preferred_height(width) : [0, 0];
        const [, menuHeight] = this.menu.box.get_preferred_height(width);
        // The lists' container, as the menu counts it (it carries the 24em cap; hidden while the service is off)
        const lists = this._lists.actor;
        const [, listsHeight] = lists.visible ? lists.get_preferred_height(laidOutWidth(lists)) : [0, 0];
        const rest = panelHeight - shownHeight + menuHeight - listsHeight;
        const top = Math.max(panel.get_transformed_position()[1], workArea.y);
        const room = workArea.y + workArea.height - top - rest - SCREEN_MARGIN;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._scroll.style = `max-height: ${Math.floor(Math.max(room, MIN_LISTS_HEIGHT) / scale)}px;`;
    }

    // Rows follow entry ids, so a summary line that keeps counting stays put and only new entries animate in
    _renderActivity(activity, pid) {
        const seen = new Set();
        activity.forEach((entry, i) => {
            const key = `${pid}:${entry.id}`;
            seen.add(key);
            let row = this._activityRows.get(key);
            const added = !row;
            if (added) {
                row = new ActivityRow(this._icons, Boolean(entry.path), path => {
                    Main.panel.closeQuickSettings();
                    openNearest(path);
                });
                this._activityRows.set(key, row);
                this._activitySection.addMenuItem(row, i);
            }
            row.update(entry);
            if (added && this._activityShown)
                row.reveal();
        });
        for (const [key, row] of this._activityRows) {
            if (!seen.has(key)) {
                row.destroy();
                this._activityRows.delete(key);
            }
        }
        this._activityShown = true;
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
                    Main.panel.closeQuickSettings();
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
        for (const folder of folders)
            this._folderRows.get(folder.id).update(folder);
    }

});

export default class GDriveSyncExtension extends Extension {
    enable() {
        this._indicator = new GDriveIndicator(this.path);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator.quickSettingsItems.forEach(item => item.destroy());
        this._indicator.destroy();
        this._indicator = null;
    }
}
