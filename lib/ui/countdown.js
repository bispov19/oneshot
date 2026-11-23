// Contagem regressiva do timer (captura com atraso). Clique cancela.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Countdown {
    /**
     * @param {number} seconds
     * @param {string} accent
     */
    constructor(seconds, accent) {
        this._left = seconds;
        this._accent = accent;
        this._id = 0;
    }

    /** @returns {Promise<boolean>} true se completou, false se cancelada */
    run() {
        return new Promise(resolve => {
            this._resolve = resolve;
            if (this._left <= 0) {
                this._finish(true);
                return;
            }
            const m = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
            this._label = new St.Button({
                style_class: 'oneshot-countdown',
                style: `border-color: ${this._accent};`,
                label: String(this._left),
                reactive: true,
                can_focus: false,
            });
            this._label.connect('clicked', () => this._finish(false));
            Main.layoutManager.addTopChrome(this._label);
            const [, , w, h] = this._label.get_preferred_size();
            this._label.set_position(Math.round(m.x + (m.width - w) / 2), Math.round(m.y + (m.height - h) / 2));
            this._label.set_pivot_point(0.5, 0.5);
            this._pulse();

            this._id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._left--;
                if (this._left <= 0) {
                    this._id = 0;
                    this._finish(true);
                    return GLib.SOURCE_REMOVE;
                }
                this._label.label = String(this._left);
                this._pulse();
                return GLib.SOURCE_CONTINUE;
            });
        });
    }

    _pulse() {
        this._label.scale_x = this._label.scale_y = 1.25;
        this._label.opacity = 120;
        this._label.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 300,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _finish(ok) {
        if (this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
        if (this._label) {
            Main.layoutManager.removeChrome(this._label);
            this._label.destroy();
            this._label = null;
        }
        const r = this._resolve;
        this._resolve = null;
        r?.(ok);
    }

    /** Cancela (usado no disable). */
    destroy() {
        this._finish(false);
    }
}
