// Indicador de gravação no painel superior + moldura da área gravada.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {icon} from '../ui/widgets.js';

function fmt(secs) {
    const h = Math.floor(secs / 3600), m = Math.floor(secs / 60) % 60, s = secs % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const RecordingIndicator = GObject.registerClass(
class RecordingIndicator extends PanelMenu.Button {
    /**
     * @param {object} p
     * @param {Function} p.elapsed - () => segundos
     * @param {object} p.handlers - {pause(), stop(), annotate()}
     * @param {object} p.shortcuts - textos dos atalhos para os tooltips
     */
    _init({elapsed, handlers, shortcuts}) {
        super._init(0.5, 'OneShot: gravação', true);
        this._elapsed = elapsed;
        this.add_style_class_name('oneshot-rec-indicator');

        const box = new St.BoxLayout({style_class: 'oneshot-rec-box'});
        this._dot = new St.Widget({style_class: 'oneshot-rec-dot', y_align: Clutter.ActorAlign.CENTER});
        this._time = new St.Label({text: '00:00', style_class: 'oneshot-rec-time', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._dot);
        box.add_child(this._time);

        const mk = (ic, tip, cb) => {
            const b = new St.Button({style_class: 'oneshot-rec-button', child: icon(ic, 14),
                can_focus: true, accessible_name: tip, y_align: Clutter.ActorAlign.CENTER});
            b.connect('clicked', cb);
            box.add_child(b);
            return b;
        };
        this._annotate = mk('act-annotate', `Anotar (${shortcuts.annotate})`, () => handlers.annotate());
        this._pause = mk('act-pause', `Pausar (${shortcuts.pause})`, () => handlers.pause());
        mk('act-stop', `Parar (${shortcuts.stop})`, () => handlers.stop());
        this.add_child(box);

        this._tick();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _tick() {
        this._time.text = fmt(this._elapsed());
        if (!this._paused)
            this._dot.opacity = this._dot.opacity === 255 ? 110 : 255;
    }

    setPaused(paused) {
        this._paused = paused;
        this._dot.opacity = 255;
        this._dot.style_class = paused ? 'oneshot-rec-dot paused' : 'oneshot-rec-dot';
        this._pause.child = icon(paused ? 'act-play' : 'act-pause', 14);
        this._tick();
    }

    setSaving() {
        this._time.text = 'Salvando…';
        this._pause.reactive = false;
        this._annotate.reactive = false;
    }

    destroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        super.destroy();
    }
});

/**
 * Moldura em volta da área gravada, desenhada POR FORA da área
 * (assim não aparece no vídeo).
 */
export class RecordingFrame {
    constructor(rect, color = '#ff4a57') {
        this._bars = [];
        const t = 3, g = 2;
        const {x, y, w, h} = rect;
        const specs = [
            [x - g - t, y - g - t, w + 2 * (g + t), t],
            [x - g - t, y + h + g, w + 2 * (g + t), t],
            [x - g - t, y - g, t, h + 2 * g],
            [x + w + g, y - g, t, h + 2 * g],
        ];
        for (const [bx, by, bw, bh] of specs) {
            const bar = new St.Widget({
                style: `background-color: ${color};`, opacity: 200,
                x: bx, y: by, width: bw, height: bh, reactive: false,
            });
            Main.uiGroup.add_child(bar);
            this._bars.push(bar);
        }
    }

    destroy() {
        this._bars.forEach(b => b.destroy());
        this._bars = [];
    }
}
