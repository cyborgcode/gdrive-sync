import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const IFACE = `<node><interface name="local.TestHelper">
  <method name="OpenMenu"/><method name="CloseMenu"/>
  <method name="Click"><arg type="s" direction="in" name="label"/></method>
  <method name="ToggleSection"><arg type="s" direction="in" name="section"/></method>
</interface></node>`;

export default class TestHelper extends Extension {
    enable() {
        this._obj = Gio.DBusExportedObject.wrapJSObject(IFACE, this);
        this._obj.export(Gio.DBus.session, '/local/TestHelper');
        this._name = Gio.bus_own_name_on_connection(Gio.DBus.session, 'local.TestHelper', 0, null, null);
    }

    _indicator() {
        return Main.panel.statusArea['gdrive-sync@local'];
    }

    OpenMenu() {
        Main.overview.hide();
        this._indicator().menu.open();
    }

    CloseMenu() {
        this._indicator().menu.close();
    }

    Click(label) {
        const item = this._indicator().menu._getMenuItems().find(i => i.label?.text === label);
        item.activate(null);
    }

    ToggleSection(section) {
        const indicator = this._indicator();
        (section === 'activity' ? indicator._activityHeader : indicator._foldersHeader).activate(null);
    }

    disable() {
        this._obj.unexport();
        Gio.bus_unown_name(this._name);
    }
}
