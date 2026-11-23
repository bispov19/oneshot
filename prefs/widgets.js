// Linhas reutilizáveis para as páginas de preferências.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

/** Liga `prop` do widget à chave e desconecta tudo quando o widget é destruído. */
function bind(settings, key, widget, prop) {
    settings.bind(key, widget, prop, Gio.SettingsBindFlags.DEFAULT);
}

export function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    bind(settings, key, row, 'active');
    return row;
}

export function spinRow(settings, key, title, {min, max, step = 1, digits = 0, subtitle = ''}) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step, page_increment: step * 5}),
    });
    bind(settings, key, row, 'value');
    return row;
}

/**
 * Lista suspensa ligada a uma chave enum/string.
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {string} title
 * @param {Array<[string, string]>} options - [valor, rótulo]
 */
export function comboRow(settings, key, title, options, subtitle = '') {
    const model = Gtk.StringList.new(options.map(o => o[1]));
    const row = new Adw.ComboRow({title, subtitle, model});
    const sync = () => {
        const idx = options.findIndex(o => o[0] === settings.get_string(key));
        if (idx >= 0 && row.selected !== idx)
            row.selected = idx;
    };
    sync();
    row.connect('notify::selected', () => {
        const value = options[row.selected]?.[0];
        if (value && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    return row;
}

/**
 * Seletor de pasta. Vazio = pasta padrão (mostrada como subtítulo).
 *
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {string} title
 * @param {() => string} defaultDir
 */
export function folderRow(settings, key, title, defaultDir) {
    const row = new Adw.ActionRow({title});
    const pick = new Gtk.Button({
        icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: 'Escolher pasta',
    });
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
        css_classes: ['flat'], tooltip_text: 'Usar a pasta padrão',
    });
    row.add_suffix(pick);
    row.add_suffix(reset);
    row.activatable_widget = pick;

    const sync = () => {
        const v = settings.get_string(key);
        row.subtitle = GLib.markup_escape_text(v || `${defaultDir()} (padrão)`, -1);
        reset.sensitive = !!v;
    };
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));

    pick.connect('clicked', async () => {
        const dlg = new Gtk.FileDialog({title, modal: true});
        const current = settings.get_string(key) || defaultDir();
        dlg.initial_folder = Gio.File.new_for_path(current);
        try {
            const folder = await dlg.select_folder(row.get_root(), null);
            if (folder?.get_path())
                settings.set_string(key, folder.get_path());
        } catch (e) {
            if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                logError(e);
        }
    });
    reset.connect('clicked', () => settings.set_string(key, ''));
    return row;
}

/** Converte Gdk.RGBA em "#rrggbb". */
export function rgbaToHex(rgba) {
    const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(rgba.red)}${h(rgba.green)}${h(rgba.blue)}`;
}

export function colorRow(settings, key, title, subtitle = '') {
    const row = new Adw.ActionRow({title, subtitle});
    const btn = new Gtk.ColorDialogButton({
        valign: Gtk.Align.CENTER,
        dialog: new Gtk.ColorDialog({with_alpha: false, title}),
    });
    const sync = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)))
            btn.rgba = rgba;
    };
    sync();
    btn.connect('notify::rgba', () => {
        const hex = rgbaToHex(btn.rgba);
        if (hex !== settings.get_string(key))
            settings.set_string(key, hex);
    });
    const id = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}

export function fontFamilyRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    const btn = new Gtk.FontDialogButton({
        valign: Gtk.Align.CENTER,
        level: Gtk.FontLevel.FAMILY,
        dialog: new Gtk.FontDialog({title}),
    });
    btn.font_desc = Pango.FontDescription.from_string(settings.get_string(key));
    btn.connect('notify::font-desc', () => {
        const fam = btn.font_desc?.get_family();
        if (fam && fam !== settings.get_string(key))
            settings.set_string(key, fam);
    });
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}
