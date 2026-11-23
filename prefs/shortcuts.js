// Página de atalhos: edição, limpeza, restauração e detecção de conflitos
// (entre os atalhos do OneShot e com os atalhos do sistema).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {SHORTCUTS} from '../lib/config.js';

/** Esquemas do sistema onde procuramos atalhos já em uso. */
const SYSTEM_SCHEMAS = [
    ['org.gnome.desktop.wm.keybindings', 'Janelas'],
    ['org.gnome.shell.keybindings', 'GNOME Shell'],
    ['org.gnome.mutter.keybindings', 'Mutter'],
    ['org.gnome.mutter.wayland.keybindings', 'Mutter'],
    ['org.gnome.settings-daemon.plugins.media-keys', 'Teclas de mídia'],
];

/**
 * Normaliza um acelerador para comparação ("<Ctrl>a" == "<Control>A").
 *
 * @param {string} accel
 * @returns {string|null}
 */
function normalize(accel) {
    if (!accel)
        return null;
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    if (!ok || key === 0)
        return null;
    return `${Gdk.keyval_to_lower(key)}:${mods}`;
}

/**
 * Lê todos os atalhos do sistema: Map<normalizado, descrição>.
 *
 * @returns {Map<string, string>}
 */
function collectSystemShortcuts() {
    const map = new Map();
    const source = Gio.SettingsSchemaSource.get_default();

    const addFromSettings = (settings, schema, group, labelFor) => {
        for (const key of schema.list_keys()) {
            const value = settings.get_value(key);
            const type = value.get_type_string();
            let accels = [];
            if (type === 'as')
                accels = value.deepUnpack();
            else if (type === 's' && key === 'binding')
                accels = [value.deepUnpack()];
            else
                continue;
            for (const a of accels) {
                const n = normalize(a);
                if (n && !map.has(n))
                    map.set(n, `${group}: ${labelFor(key)}`);
            }
        }
    };

    for (const [id, group] of SYSTEM_SCHEMAS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const settings = new Gio.Settings({settings_schema: schema});
        addFromSettings(settings, schema, group,
            key => schema.get_key(key).get_summary() || key);
    }

    // Atalhos personalizados criados em Configurações > Teclado.
    const customSchema = source.lookup('org.gnome.settings-daemon.plugins.media-keys.custom-keybinding', true);
    const mediaSchema = source.lookup('org.gnome.settings-daemon.plugins.media-keys', true);
    if (customSchema && mediaSchema) {
        const media = new Gio.Settings({settings_schema: mediaSchema});
        for (const path of media.get_strv('custom-keybindings')) {
            const s = new Gio.Settings({settings_schema: customSchema, path});
            const n = normalize(s.get_string('binding'));
            if (n && !map.has(n))
                map.set(n, `Atalho personalizado: ${s.get_string('name')}`);
        }
    }
    return map;
}

/**
 * Diálogo que captura uma combinação de teclas.
 * Esc cancela, Backspace remove o atalho.
 */
const CaptureDialog = GObject.registerClass(
class CaptureDialog extends Adw.Dialog {
    /**
     * @param {string} title
     * @param {(accel: string|null) => void} onDone - null = remover
     */
    constructor(title, onDone) {
        super({title: 'Definir atalho', content_width: 420});
        this._onDone = onDone;

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 24, margin_bottom: 24, margin_start: 24, margin_end: 24,
        });
        box.append(new Gtk.Image({icon_name: 'input-keyboard-symbolic', pixel_size: 64, css_classes: ['dim-label']}));
        box.append(new Gtk.Label({label: `<b>${GLib_markup(title)}</b>`, use_markup: true}));
        box.append(new Gtk.Label({
            label: 'Pressione a nova combinação de teclas.\nEsc cancela · Backspace remove o atalho.',
            justify: Gtk.Justification.CENTER, css_classes: ['dim-label'],
        }));

        const view = new Adw.ToolbarView({content: box});
        view.add_top_bar(new Adw.HeaderBar());
        this.set_child(view);

        const ctl = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        ctl.connect('key-pressed', (_c, keyval, keycode, state) => this._onKey(keyval, keycode, state));
        this.add_controller(ctl);

        // Inibe os atalhos do sistema enquanto captura, senão o Shell
        // "engole" combinações que já estão em uso (inclusive as nossas).
        this.connect('map', () => {
            const surface = this.get_root()?.get_surface?.();
            if (surface instanceof Gdk.Toplevel) {
                this._surface = surface;
                surface.inhibit_system_shortcuts(null);
            }
        });
        this.connect('closed', () => {
            this._surface?.restore_system_shortcuts();
            this._surface = null;
        });
    }

    _onKey(keyval, keycode, state) {
        let mods = state & Gtk.accelerator_get_default_mod_mask();
        mods &= ~Gdk.ModifierType.LOCK_MASK;
        const key = Gdk.keyval_to_lower(keyval);

        if (mods === 0 && key === Gdk.KEY_Escape) {
            this.close();
            return Gdk.EVENT_STOP;
        }
        if (mods === 0 && key === Gdk.KEY_BackSpace) {
            this._onDone(null);
            this.close();
            return Gdk.EVENT_STOP;
        }
        // Ignora teclas modificadoras sozinhas (esperando a combinação).
        if (Gtk.accelerator_valid(key, mods) || isStandaloneKey(key)) {
            this._onDone(Gtk.accelerator_name_with_keycode(null, key, keycode, mods));
            this.close();
        }
        return Gdk.EVENT_STOP;
    }
});

/** Escapa texto para Pango markup. */
function GLib_markup(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Teclas que podem ser atalho sem modificador (Print, F1–F12…). */
function isStandaloneKey(key) {
    return key === Gdk.KEY_Print ||
        (key >= Gdk.KEY_F1 && key <= Gdk.KEY_F35);
}

/**
 * Cria a página de atalhos.
 *
 * @param {Gio.Settings} settings
 * @returns {Adw.PreferencesPage}
 */
export function buildShortcutsPage(settings) {
    const page = new Adw.PreferencesPage({
        title: 'Atalhos',
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
    });

    const group = new Adw.PreferencesGroup({
        title: 'Atalhos de teclado',
        description: 'Clique em um atalho para alterá-lo. Conflitos são destacados em amarelo.',
    });
    page.add(group);

    const systemShortcuts = collectSystemShortcuts();
    const rows = [];

    for (const {key, title} of SHORTCUTS) {
        const row = new Adw.ActionRow({title});

        const warn = new Gtk.Image({
            icon_name: 'dialog-warning-symbolic',
            css_classes: ['warning'],
            visible: false,
            valign: Gtk.Align.CENTER,
        });
        const label = new Gtk.ShortcutLabel({disabled_text: 'Desativado', valign: Gtk.Align.CENTER});
        const editBtn = new Gtk.Button({child: label, valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: 'Alterar atalho'});
        const resetBtn = new Gtk.Button({
            icon_name: 'edit-undo-symbolic', valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'], tooltip_text: 'Restaurar atalho padrão',
        });

        row.add_suffix(warn);
        row.add_suffix(editBtn);
        row.add_suffix(resetBtn);
        row.activatable_widget = editBtn;

        editBtn.connect('clicked', () => {
            const dlg = new CaptureDialog(title, accel => {
                settings.set_strv(key, accel ? [accel] : []);
            });
            dlg.present(page);
        });
        resetBtn.connect('clicked', () => settings.reset(key));

        group.add(row);
        rows.push({key, title, row, label, warn});
    }

    const refresh = () => {
        // Mapa dos nossos atalhos para detectar duplicados internos.
        const ours = new Map();
        for (const r of rows) {
            const accel = settings.get_strv(r.key)[0] ?? '';
            r.accel = accel;
            r.norm = normalize(accel);
            r.label.accelerator = accel;
            if (r.norm)
                ours.set(r.norm, [...ours.get(r.norm) ?? [], r.title]);
        }
        for (const r of rows) {
            const problems = [];
            if (r.norm) {
                const others = (ours.get(r.norm) ?? []).filter(t => t !== r.title);
                if (others.length)
                    problems.push(`Também usado em: ${others.join(', ')}`);
                const sys = systemShortcuts.get(r.norm);
                if (sys)
                    problems.push(`Conflita com ${sys}`);
            }
            r.warn.visible = problems.length > 0;
            r.warn.tooltip_text = problems.join('\n');
            r.row.subtitle = GLib_markup(problems.join(' · '));
        }
    };

    const ids = rows.map(r => settings.connect(`changed::${r.key}`, refresh));
    page.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));
    refresh();

    // Restaurar só os atalhos.
    const resetGroup = new Adw.PreferencesGroup();
    const resetAll = new Gtk.Button({
        label: 'Restaurar todos os atalhos', halign: Gtk.Align.CENTER,
        css_classes: ['pill'],
    });
    resetAll.connect('clicked', () => SHORTCUTS.forEach(s => settings.reset(s.key)));
    resetGroup.add(resetAll);
    page.add(resetGroup);

    return page;
}
