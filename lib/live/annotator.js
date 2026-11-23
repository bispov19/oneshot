// Anotação ao vivo: desenha por cima da tela (inclusive durante a gravação,
// que captura o palco do Shell — as anotações aparecem no vídeo).
//
// - Ativa: captura o mouse/teclado para desenhar (barra de ferramentas visível).
// - Inativa: o desenho continua visível, mas os cliques voltam aos aplicativos.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Canvas} from '../editor/canvas.js';
import {TOOLS, toolById, toolByKey} from '../editor/tools.js';
import {StylePopover, ToolBar, Tooltips, fadeIn} from '../ui/widgets.js';

const LIVE_TOOLS = TOOLS.filter(t => !t.needsImage);

export class LiveAnnotator {
    /**
     * @param {object} p
     * @param {Gio.Settings} p.settings
     * @param {{x, y, w, h}|null} p.rect - área (gravação) ou null = tela toda
     * @param {Function} p.onChanged - (active) => void
     */
    constructor({settings, rect, onChanged}) {
        this._settings = settings;
        this._onChanged = onChanged;
        this.active = false;
        const {width: W, height: H} = global.stage;
        this._rect = rect ?? {x: 0, y: 0, w: W, h: H};
        this._accent = settings.get_string('accent-color');

        this.root = new St.Widget({reactive: false, x: 0, y: 0, width: W, height: H});
        Main.uiGroup.add_child(this.root);
        Main.uiGroup.set_child_above_sibling(this.root, null);

        this.canvas = new Canvas({image: null, accent: this._accent});
        this.canvas.setRegion(this._rect.x, this._rect.y, this._rect.w, this._rect.h);
        this.canvas.font = settings.get_string('font-family');
        this.root.add_child(this.canvas);

        this._style = {
            color: settings.get_string('tool-color'),
            width: settings.get_int('tool-width'),
            fontSize: settings.get_int('font-size'),
        };
        let tool = settings.get_boolean('remember-last-tool') ? settings.get_string('last-tool') : 'arrow';
        if (!LIVE_TOOLS.some(t => t.id === tool))
            tool = 'arrow';
        this._tool = tool;

        const pending = [];
        const tips = {attach: (w, t) => pending.push([w, t])};
        const size = settings.get_int('icon-size');
        this._toolbar = new ToolBar({
            tools: LIVE_TOOLS, tooltips: tips, iconSize: size, accent: this._accent,
            callbacks: {
                tool: id => this._setTool(id),
                color: btn => this._togglePopover(btn),
                undo: () => this.canvas.undo(),
                redo: () => this.canvas.redo(),
            },
            extra: [
                {icon: 'act-clear', tip: 'Limpar tudo', onClick: () => this.clear()},
                {icon: 'act-check', tip: 'Concluir  (Esc)', onClick: () => this.setActive(false)},
            ],
        });
        this._toolbar.actor.hide();
        this.root.add_child(this._toolbar.actor);

        this._popover = new StylePopover({
            palette: settings.get_strv('color-palette'), state: this._style, tooltips: tips,
            onChange: c => this._setStyle(c),
        });
        this.root.add_child(this._popover.actor);

        this._tooltips = new Tooltips(this.root);
        pending.forEach(([w, t]) => this._tooltips.attach(w, t));

        this.canvas.setStyle(this._style);
        this.canvas.setTool(tool);
        this._toolbar.setTool(tool);
        this._sync();
        this.canvas.connect('history-changed', () => this._sync());
        this.canvas.connect('text-editing', (_c, editing) => {
            if (!editing && this.active)
                global.stage.set_key_focus(this.root);
        });

        this.root.connect('button-press-event', (_a, e) => this._onPress(e));
        this.root.connect('motion-event', (_a, e) => this._onMotion(e));
        this.root.connect('button-release-event', (_a, e) => this._onRelease(e));
        this.root.connect('key-press-event', (_a, e) => this._onKey(e));
        this.root.connect('scroll-event', (_a, e) => this._onScroll(e));
    }

    _sync() {
        this._toolbar.setStyle(this._style.color, this._style.width);
        this._toolbar.setHistory(this.canvas.canUndo, this.canvas.canRedo);
    }

    _setTool(id) {
        if (!toolById(id) || toolById(id).needsImage)
            return;
        this._tool = id;
        this.canvas.setTool(id);
        this._toolbar.setTool(id);
    }

    _setStyle(change) {
        Object.assign(this._style, change);
        this.canvas.setStyle(change);
        this._popover.update(this._style);
        this._sync();
    }

    _togglePopover(anchor) {
        if (this._popover.visible)
            this._popover.hide();
        else
            this._popover.popup(anchor);
    }

    toggle() {
        this.setActive(!this.active);
    }

    setActive(active) {
        if (active === this.active)
            return;
        this.active = active;
        if (active) {
            this.root.reactive = true;
            this._grab = Main.pushModal(this.root, {actionMode: Shell.ActionMode.POPUP});
            global.stage.set_key_focus(this.root);
            this.root.set_cursor_type(Clutter.CursorType.CROSSHAIR);
            this._placeToolbar();
            this._toolbar.actor.show();
            fadeIn(this._toolbar.actor);
        } else {
            this.canvas.finishText();
            this._popover.hide();
            this._tooltips.hide();
            this._toolbar.actor.hide();
            this.root.reactive = false;
            if (this._grab) {
                Main.popModal(this._grab);
                this._grab = null;
            }
        }
        this._onChanged?.(active);
    }

    clear() {
        this.canvas.clear();
    }

    /** Barra fora da área gravada, se houver espaço (para não sair no vídeo). */
    _placeToolbar() {
        const r = this._rect;
        const {width: W, height: H} = global.stage;
        const tb = this._toolbar.actor;
        const [, , tw, th] = tb.get_preferred_size();
        const x = Math.max(8, Math.min(W - tw - 8, r.x + r.w / 2 - tw / 2));
        let y;
        if (r.y + r.h + 12 + th < H)
            y = r.y + r.h + 12;
        else if (r.y - th - 12 > 0)
            y = r.y - th - 12;
        else
            y = r.y + 12;
        tb.set_position(Math.round(x), Math.round(y));
    }

    _isUi(x, y) {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        return [this._toolbar.actor, this._popover.actor]
            .some(c => c.visible && actor && (c === actor || c.contains(actor)));
    }

    _inside(x, y) {
        const r = this._rect;
        return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    }

    _onPress(e) {
        const [x, y] = e.get_coords();
        if (this._isUi(x, y))
            return Clutter.EVENT_PROPAGATE;
        if (this._popover.visible) {
            this._popover.hide();
            return Clutter.EVENT_STOP;
        }
        if (e.get_button() === Clutter.BUTTON_PRIMARY && this._inside(x, y))
            this._drawing = this.canvas.press(x, y, e.get_state());
        return Clutter.EVENT_STOP;
    }

    _onMotion(e) {
        if (!this._drawing)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        this.canvas.motion(x, y, e.get_state());
        return Clutter.EVENT_STOP;
    }

    _onRelease(e) {
        if (!this._drawing)
            return Clutter.EVENT_PROPAGATE;
        this._drawing = false;
        const [x, y] = e.get_coords();
        this.canvas.release(x, y, e.get_state());
        return Clutter.EVENT_STOP;
    }

    _onScroll(e) {
        const dir = e.get_scroll_direction();
        let d = 0;
        if (dir === Clutter.ScrollDirection.UP)
            d = 1;
        else if (dir === Clutter.ScrollDirection.DOWN)
            d = -1;
        else if (dir === Clutter.ScrollDirection.SMOOTH)
            d = -Math.sign(e.get_scroll_delta()[1]);
        if (d)
            this._setStyle({width: Math.max(1, Math.min(40, this._style.width + d))});
        return Clutter.EVENT_STOP;
    }

    _onKey(e) {
        const sym = e.get_key_symbol();
        const mods = e.get_state();
        if (this.canvas.isEditingText) {
            if (sym === Clutter.KEY_Escape) {
                this.canvas.finishText();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (global.stage.key_focus && global.stage.key_focus !== this.root) {
            if (sym === Clutter.KEY_Escape) {
                this._popover.hide();
                global.stage.set_key_focus(this.root);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        if (sym === Clutter.KEY_Escape) {
            if (this._popover.visible)
                this._popover.hide();
            else
                this.setActive(false);
            return Clutter.EVENT_STOP;
        }
        const ctrl = mods & Clutter.ModifierType.CONTROL_MASK;
        const shift = mods & Clutter.ModifierType.SHIFT_MASK;
        const key = String.fromCodePoint(Clutter.keysym_to_unicode(sym) || 32).toLowerCase();
        if (ctrl) {
            if (key === 'z' && shift)
                this.canvas.redo();
            else if (key === 'z')
                this.canvas.undo();
            else if (key === 'y')
                this.canvas.redo();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Delete || sym === Clutter.KEY_BackSpace) {
            this.canvas.deleteSelected();
            return Clutter.EVENT_STOP;
        }
        if (key === 'c') {
            this._togglePopover(this._toolbar._colorBtn);
            return Clutter.EVENT_STOP;
        }
        const tool = toolByKey(key);
        if (tool && !tool.needsImage)
            this._setTool(tool.id);
        return Clutter.EVENT_STOP;
    }

    destroy() {
        this.setActive(false);
        this._tooltips?.destroy();
        this.root?.destroy();
        this.root = null;
        this.canvas = null;
        this._onChanged = null;
    }
}
