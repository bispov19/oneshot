// Botão do OneShot no painel superior, com menu de ações rápidas.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

export const OneShotIndicator = GObject.registerClass(
class OneShotIndicator extends PanelMenu.Button {
    /**
     * @param {object} ext - instância da extensão (fornece path e as ações)
     */
    _init(ext) {
        super._init(0.5, 'OneShot', false);
        this._ext = ext;

        this.add_style_class_name('oneshot-panel-button');
        this.add_child(new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${ext.path}/icons/oneshot-symbolic.svg`)),
            style_class: 'system-status-icon',
        }));

        this._buildMenu();
    }

    _icon(name) {
        return Gio.FileIcon.new(Gio.File.new_for_path(`${this._ext.path}/icons/${name}.svg`));
    }

    _item(label, callback, iconName = null) {
        const item = new PopupMenu.PopupImageMenuItem(label, iconName ? this._icon(iconName) : null);
        item.connect('activate', () => {
            // Fecha o menu e espera a animação, para ele não sair na imagem.
            this.menu.close();
            this._ext.afterMenu(callback);
        });
        this.menu.addMenuItem(item);
        return item;
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('oneshot-menu');
        const a = this._ext.actions;

        this._item('Capturar região', () => a.region(), 'oneshot-symbolic');
        this._item('Capturar janela', () => a.window());
        this._item('Capturar tela inteira', () => a.fullscreen());
        this._item('Repetir última captura', () => a.repeatLast());

        // Submenu de monitores (reconstruído ao abrir, para refletir hot-plug).
        this._monitorMenu = new PopupMenu.PopupSubMenuMenuItem('Capturar monitor');
        this.menu.addMenuItem(this._monitorMenu);

        // Submenu de atraso.
        const delayMenu = new PopupMenu.PopupSubMenuMenuItem('Captura com atraso');
        for (const secs of [3, 5, 10]) {
            const it = new PopupMenu.PopupMenuItem(`Região em ${secs} s`);
            it.connect('activate', () => {
                this.menu.close();
                this._ext.afterMenu(() => a.delayed(secs));
            });
            delayMenu.menu.addMenuItem(it);
        }
        this.menu.addMenuItem(delayMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._recordItem = this._item('Gravar tela', () => a.recordToggle(), 'record-symbolic');
        this._item('Anotar na tela', () => a.annotateToggle());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._item('Abrir pasta de capturas', () => a.openFolder());
        this._item('Preferências', () => this._ext.openPreferences());

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._rebuildMonitors();
                const rec = this._ext._recorder?.active;
                this._recordItem.label.text = rec ? 'Parar gravação' : 'Gravar tela';
            }
        });
    }

    _rebuildMonitors() {
        this._monitorMenu.menu.removeAll();
        const monitors = global.display.get_n_monitors();
        for (let i = 0; i < monitors; i++) {
            const geo = global.display.get_monitor_geometry(i);
            const it = new PopupMenu.PopupMenuItem(`Monitor ${i + 1} (${geo.width}×${geo.height})`);
            it.connect('activate', () => {
                this.menu.close();
                this._ext.afterMenu(() => this._ext.actions.monitor(i));
            });
            this._monitorMenu.menu.addMenuItem(it);
        }
    }

    destroy() {
        this._ext = null;
        super.destroy();
    }
});
