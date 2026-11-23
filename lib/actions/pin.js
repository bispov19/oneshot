// "Fixar na tela": imagem flutuante sempre visível, arrastável.
//   - arrastar: move
//   - rolagem: zoom · Ctrl+rolagem: opacidade
//   - botões ao passar o mouse: copiar, salvar, fechar
//   - duplo clique: fecha

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {icon} from '../ui/widgets.js';

export class PinnedImage {
    /**
     * @param {object} p
     * @param {import('gi://GdkPixbuf').default.Pixbuf} p.pixbuf
     * @param {number} p.x - posição lógica
     * @param {number} p.y
     * @param {number} p.scale - pixels físicos por unidade lógica
     * @param {object} p.handlers - {copy(pixbuf), save(pixbuf), closed(pin)}
     */
    constructor({pixbuf, x, y, scale, handlers}) {
        this._pixbuf = pixbuf;
        this._handlers = handlers;
        this._baseW = pixbuf.width / scale;
        this._baseH = pixbuf.height / scale;
        this._zoom = 1;

        this.actor = new St.Widget({
            style_class: 'oneshot-pin',
            reactive: true,
            track_hover: true,
            x, y,
        });

        const ctx = global.stage.context.get_backend().get_cogl_context();
        const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
        content.set_bytes(ctx, pixbuf.read_pixel_bytes(),
            pixbuf.hasAlpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
            pixbuf.width, pixbuf.height, pixbuf.rowstride);
        this._image = new St.Widget({style_class: 'oneshot-pin-image', content});
        this.actor.add_child(this._image);

        this._bar = new St.BoxLayout({style_class: 'oneshot-pin-bar', opacity: 0, reactive: true});
        for (const [ic, cb] of [
            ['act-copy', () => this._handlers.copy(this._pixbuf)],
            ['act-save', () => this._handlers.save(this._pixbuf)],
            ['act-cancel', () => this.destroy()],
        ]) {
            const b = new St.Button({style_class: 'oneshot-button oneshot-small', child: icon(ic, 14), can_focus: false});
            b.connect('clicked', cb);
            this._bar.add_child(b);
        }
        this.actor.add_child(this._bar);

        this.actor.connect('notify::hover', () => {
            this._bar.ease({opacity: this.actor.hover ? 255 : 0, duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
        this.actor.connect('button-press-event', (_a, e) => this._onPress(e));
        this.actor.connect('motion-event', (_a, e) => this._onMotion(e));
        this.actor.connect('button-release-event', (_a, e) => this._onRelease(e));
        this.actor.connect('scroll-event', (_a, e) => this._onScroll(e));

        Main.layoutManager.addTopChrome(this.actor);
        this._resize();

        // Entrada suave.
        this.actor.set_pivot_point(0.5, 0.5);
        this.actor.scale_x = this.actor.scale_y = 0.92;
        this.actor.opacity = 0;
        this.actor.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 180,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _resize() {
        const w = Math.round(this._baseW * this._zoom);
        const h = Math.round(this._baseH * this._zoom);
        this._image.set_size(w, h);
        this.actor.set_size(w, h);
        const [, , bw] = this._bar.get_preferred_size();
        this._bar.set_position(Math.max(4, w - bw - 6), 6);
    }

    _onPress(event) {
        const [x, y] = event.get_coords();
        if (this._bar.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y)))
            return Clutter.EVENT_PROPAGATE;
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const now = Date.now();
        if (this._lastClick && now - this._lastClick < 350) {
            this.destroy();
            return Clutter.EVENT_STOP;
        }
        this._lastClick = now;

        this._dragStart = [x - this.actor.x, y - this.actor.y];
        this._grab = global.stage.grab(this.actor);
        this.actor.set_cursor_type(Clutter.CursorType.GRABBING);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._dragStart)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this.actor.set_position(Math.round(x - this._dragStart[0]), Math.round(y - this._dragStart[1]));
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        if (!this._dragStart)
            return Clutter.EVENT_PROPAGATE;
        this._dragStart = null;
        this._grab?.dismiss();
        this._grab = null;
        this.actor.set_cursor_type(Clutter.CursorType.DEFAULT);
        return Clutter.EVENT_STOP;
    }

    _onScroll(event) {
        const dir = event.get_scroll_direction();
        let delta = 0;
        if (dir === Clutter.ScrollDirection.UP)
            delta = 1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            delta = -1;
        else if (dir === Clutter.ScrollDirection.SMOOTH)
            delta = -Math.sign(event.get_scroll_delta()[1]);
        if (!delta)
            return Clutter.EVENT_STOP;

        if (event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            this._image.opacity = Math.max(50, Math.min(255, this._image.opacity + delta * 20));
        } else {
            this._zoom = Math.max(0.2, Math.min(4, this._zoom * (delta > 0 ? 1.1 : 1 / 1.1)));
            this._resize();
        }
        return Clutter.EVENT_STOP;
    }

    destroy() {
        if (!this.actor)
            return;
        this._grab?.dismiss();
        this._grab = null;
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
        this.actor = null;
        this._pixbuf = null;
        this._handlers.closed?.(this);
    }
}
