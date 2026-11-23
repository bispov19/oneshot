// Gerenciador de atalhos globais. Registra cada atalho no Mutter e garante
// que todos sejam removidos em destroy() (exigência da revisão do EGO).

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class KeybindingManager {
    /**
     * @param {import('gi://Gio').default.Settings} settings
     */
    constructor(settings) {
        this._settings = settings;
        this._names = new Set();
    }

    /**
     * Registra um atalho lido da chave `name` do GSettings.
     * O Mutter acompanha mudanças na chave sozinho, então a troca de atalho
     * nas preferências vale imediatamente.
     *
     * @param {string} name - nome da chave (tipo `as`)
     * @param {Function} handler
     * @param {number} [modes] - modos do Shell em que o atalho funciona
     */
    add(name, handler, modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW) {
        if (this._names.has(name))
            this.remove(name);

        const action = Main.wm.addKeybinding(
            name,
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            modes,
            () => {
                try {
                    handler();
                } catch (e) {
                    logError(e, `[OneShot] erro no atalho ${name}`);
                }
            });

        if (action === Meta.KeyBindingAction.NONE)
            console.warn(`[OneShot] não foi possível registrar o atalho ${name} (conflito?)`);
        else
            this._names.add(name);
    }

    /** @param {string} name */
    remove(name) {
        if (!this._names.has(name))
            return;
        Main.wm.removeKeybinding(name);
        this._names.delete(name);
    }

    destroy() {
        for (const name of this._names)
            Main.wm.removeKeybinding(name);
        this._names.clear();
        this._settings = null;
    }
}
