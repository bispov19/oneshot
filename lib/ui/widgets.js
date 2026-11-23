// Componentes visuais reutilizáveis: botões com ícone, tooltips,
// barra de ferramentas, barra de ações e popover de estilo.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

let _iconDir = null;

/** Define a pasta dos ícones (chamado no enable). */
export function setIconDir(path) {
    _iconDir = path;
}

export function icon(name, size = 18) {
    return new St.Icon({
        gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${_iconDir}/${name}.svg`)),
        icon_size: size,
    });
}

/* --------------------------------- Tooltip --------------------------------- */

/**
 * Tooltips do OneShot. Um único rótulo, reposicionado para o botão
 * sob o ponteiro, com pequeno atraso para não piscar.
 */
export class Tooltips {
    constructor(layer) {
        this._layer = layer;
        this._label = new St.Label({style_class: 'oneshot-tooltip', visible: false, opacity: 0});
        layer.add_child(this._label);
        this._timeout = 0;
    }

    /**
     * @param {St.Widget} widget
     * @param {string} text
     */
    attach(widget, text) {
        widget._oneshotTip = text;
        widget.connect('notify::hover', () => {
            if (widget.hover)
                this._schedule(widget);
            else
                this.hide();
        });
        widget.connect('destroy', () => {
            if (this._current === widget)
                this.hide();
        });
    }

    _schedule(widget) {
        this.hide();
        this._current = widget;
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
            this._timeout = 0;
            this._show(widget);
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(widget) {
        if (!widget.get_stage() || !this._label)
            return;
        this._label.text = widget._oneshotTip;
        this._layer.set_child_above_sibling(this._label, null);
        this._label.show();
        const [bx, by] = widget.get_transformed_position();
        const [bw, bh] = widget.get_transformed_size();
        const [, , lw, lh] = [0, 0, ...this._label.get_preferred_size().slice(2)];
        let x = bx + bw / 2 - lw / 2;
        let y = by + bh + 8;
        if (y + lh > global.stage.height - 4)
            y = by - lh - 8;
        x = Math.max(4, Math.min(global.stage.width - lw - 4, x));
        this._label.set_position(Math.round(x), Math.round(y));
        this._label.ease({opacity: 255, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    hide() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        this._current = null;
        if (this._label) {
            this._label.remove_all_transitions();
            this._label.opacity = 0;
            this._label.hide();
        }
    }

    destroy() {
        this.hide();
        this._label?.destroy();
        this._label = null;
    }
}

/* --------------------------------- Botões ---------------------------------- */

/**
 * Cria um botão com ícone.
 *
 * @param {object} p
 * @param {string} p.icon
 * @param {string} p.tip - texto do tooltip (o atalho entra entre parênteses)
 * @param {Function} p.onClick
 * @param {Tooltips} p.tooltips
 * @param {number} p.iconSize
 * @param {boolean} [p.toggle]
 */
export function iconButton({icon: name, tip, onClick, tooltips, iconSize, toggle = false, styleClass = ''}) {
    const btn = new St.Button({
        style_class: `oneshot-button ${styleClass}`.trim(),
        child: icon(name, iconSize),
        can_focus: false,
        toggle_mode: toggle,
        reactive: true,
        track_hover: true,
    });
    btn.connect('clicked', () => onClick?.(btn));
    if (tip)
        tooltips.attach(btn, tip);
    return btn;
}

function separator(vertical = false) {
    return new St.Widget({style_class: vertical ? 'oneshot-separator-h' : 'oneshot-separator'});
}

/** Estilo inline do botão ativo (cor de destaque configurável). */
function setActive(btn, active, accent) {
    btn.checked = active;
    btn.style = active ? `background-color: ${accent};` : null;
}

/* ---------------------------- Barra de ferramentas ---------------------------- */

export class ToolBar {
    /**
     * @param {object} p
     * @param {Array} p.tools - ferramentas exibidas
     * @param {Tooltips} p.tooltips
     * @param {number} p.iconSize
     * @param {string} p.accent
     * @param {object} p.callbacks - {tool(id), color(), undo(), redo()}
     * @param {Array} [p.extra] - botões extras [{icon, tip, onClick}]
     */
    constructor({tools, tooltips, iconSize, accent, callbacks, extra = []}) {
        this._accent = accent;
        this.actor = new St.BoxLayout({
            style_class: 'oneshot-toolbar',
            reactive: true,
            opacity: 0,
        });
        this._toolButtons = new Map();

        for (const t of tools) {
            const btn = iconButton({
                icon: t.icon, tip: `${t.name}  (${t.key.toUpperCase()})`,
                tooltips, iconSize, toggle: true,
                onClick: () => callbacks.tool(t.id),
            });
            this._toolButtons.set(t.id, btn);
            this.actor.add_child(btn);
        }

        this.actor.add_child(separator());

        // Botão de cor: uma bolinha com a cor atual.
        this._swatch = new St.Widget({style_class: 'oneshot-swatch'});
        this._colorBtn = new St.Button({
            style_class: 'oneshot-button', child: this._swatch, can_focus: false, track_hover: true,
        });
        this._colorBtn.connect('clicked', () => callbacks.color(this._colorBtn));
        tooltips.attach(this._colorBtn, 'Cor e espessura  (C)');
        this.actor.add_child(this._colorBtn);

        this._widthLabel = new St.Label({style_class: 'oneshot-width-label', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._widthLabel);

        this.actor.add_child(separator());
        this._undo = iconButton({icon: 'act-undo', tip: 'Desfazer  (Ctrl+Z)', tooltips, iconSize, onClick: () => callbacks.undo()});
        this._redo = iconButton({icon: 'act-redo', tip: 'Refazer  (Ctrl+Shift+Z)', tooltips, iconSize, onClick: () => callbacks.redo()});
        this.actor.add_child(this._undo);
        this.actor.add_child(this._redo);

        if (extra.length) {
            this.actor.add_child(separator());
            for (const e of extra)
                this.actor.add_child(iconButton({...e, tooltips, iconSize}));
        }
    }

    setTool(id) {
        for (const [tid, btn] of this._toolButtons)
            setActive(btn, tid === id, this._accent);
    }

    setStyle(color, width) {
        this._swatch.style = `background-color: ${color};`;
        this._widthLabel.text = `${width}px`;
    }

    setHistory(canUndo, canRedo) {
        this._undo.reactive = canUndo;
        this._undo.opacity = canUndo ? 255 : 90;
        this._redo.reactive = canRedo;
        this._redo.opacity = canRedo ? 255 : 90;
    }

    setAccent(accent, currentTool) {
        this._accent = accent;
        this.setTool(currentTool);
    }

    destroy() {
        this.actor.destroy();
    }
}

/* ------------------------------ Barra de ações ------------------------------ */

export class ActionBar {
    /**
     * @param {Array} actions - [{id, icon, tip, onClick, toggle?, active?}]
     */
    constructor({actions, tooltips, iconSize, vertical = true, accent = '#2f8cff'}) {
        this.actor = new St.BoxLayout({
            style_class: 'oneshot-actionbar',
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
            reactive: true,
            opacity: 0,
        });
        this._accent = accent;
        this.buttons = new Map();
        for (const a of actions) {
            if (a.separator) {
                this.actor.add_child(separator(vertical));
                continue;
            }
            const btn = iconButton({
                icon: a.icon, tip: a.tip, tooltips, iconSize, toggle: !!a.toggle,
                styleClass: a.styleClass ?? '',
                onClick: b => {
                    a.onClick(b);
                    if (a.toggle)
                        setActive(b, b.checked, this._accent);
                },
            });
            if (a.toggle)
                setActive(btn, !!a.active, accent);
            this.buttons.set(a.id, btn);
            this.actor.add_child(btn);
        }
    }

    destroy() {
        this.actor.destroy();
    }
}

/* ---------------------------- Popover de estilo ---------------------------- */

export class StylePopover {
    /**
     * @param {object} p
     * @param {string[]} p.palette
     * @param {object} p.state - {color, width, fontSize}
     * @param {Function} p.onChange - recebe {color?, width?, fontSize?}
     */
    constructor({palette, state, onChange, tooltips}) {
        this._state = {...state};
        this._onChange = onChange;

        this.actor = new St.BoxLayout({
            style_class: 'oneshot-popover',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
            opacity: 0,
        });

        // Paleta de cores
        const grid = new St.BoxLayout({style_class: 'oneshot-palette'});
        for (const hex of palette) {
            const sw = new St.Button({
                style_class: 'oneshot-palette-swatch',
                style: `background-color: ${hex};`,
                can_focus: false, track_hover: true,
            });
            sw.connect('clicked', () => this._set({color: hex}));
            tooltips.attach(sw, hex);
            grid.add_child(sw);
        }
        this.actor.add_child(grid);

        // Entrada hexadecimal
        const hexRow = new St.BoxLayout({style_class: 'oneshot-popover-row'});
        hexRow.add_child(new St.Label({text: 'Hex', style_class: 'oneshot-popover-label', y_align: Clutter.ActorAlign.CENTER}));
        this._hex = new St.Entry({style_class: 'oneshot-hex-entry', can_focus: true, x_expand: true});
        this._hex.clutter_text.connect('activate', () => {
            let v = this._hex.text.trim();
            if (!v.startsWith('#'))
                v = `#${v}`;
            if (/^#[0-9a-f]{6}$/i.test(v))
                this._set({color: v.toLowerCase()});
        });
        hexRow.add_child(this._hex);
        this.actor.add_child(hexRow);

        this._widthRow = this._stepper('Espessura', 'width', 1, 40, 'px');
        this._fontRow = this._stepper('Fonte', 'fontSize', 8, 96, 'px', 2);
        this.actor.add_child(this._widthRow.box);
        this.actor.add_child(this._fontRow.box);
        this._sync();
    }

    _stepper(title, key, min, max, unit, step = 1) {
        const box = new St.BoxLayout({style_class: 'oneshot-popover-row'});
        box.add_child(new St.Label({text: title, style_class: 'oneshot-popover-label', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        const minus = new St.Button({style_class: 'oneshot-button oneshot-small', child: icon('act-minus', 14), can_focus: false});
        const value = new St.Label({style_class: 'oneshot-popover-value', y_align: Clutter.ActorAlign.CENTER});
        const plus = new St.Button({style_class: 'oneshot-button oneshot-small', child: icon('act-plus', 14), can_focus: false});
        minus.connect('clicked', () => this._set({[key]: Math.max(min, this._state[key] - step)}));
        plus.connect('clicked', () => this._set({[key]: Math.min(max, this._state[key] + step)}));
        box.add_child(minus);
        box.add_child(value);
        box.add_child(plus);
        return {box, value, unit};
    }

    _set(change) {
        Object.assign(this._state, change);
        this._sync();
        this._onChange(change);
    }

    /** Atualiza o estado mostrado (sem disparar onChange). */
    update(state) {
        Object.assign(this._state, state);
        this._sync();
    }

    _sync() {
        this._hex.text = this._state.color;
        this._widthRow.value.text = `${this._state.width}${this._widthRow.unit}`;
        this._fontRow.value.text = `${this._state.fontSize}${this._fontRow.unit}`;
    }

    get visible() {
        return this.actor.visible;
    }

    /** Mostra junto ao botão âncora. */
    popup(anchor) {
        const parent = this.actor.get_parent();
        parent.set_child_above_sibling(this.actor, null);
        this.actor.show();
        const [ax, ay] = anchor.get_transformed_position();
        const [aw, ah] = anchor.get_transformed_size();
        const [, , pw, ph] = [0, 0, ...this.actor.get_preferred_size().slice(2)];
        let x = ax + aw / 2 - pw / 2;
        let y = ay + ah + 10;
        if (y + ph > global.stage.height - 8)
            y = ay - ph - 10;
        x = Math.max(8, Math.min(global.stage.width - pw - 8, x));
        this.actor.set_position(Math.round(x), Math.round(y));
        this.actor.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    hide() {
        this.actor.remove_all_transitions();
        this.actor.opacity = 0;
        this.actor.hide();
        if (global.stage.key_focus === this._hex.clutter_text)
            global.stage.set_key_focus(null);
    }

    destroy() {
        this.actor.destroy();
    }
}

/** Animação suave de entrada. */
export function fadeIn(actor) {
    actor.remove_all_transitions();
    actor.opacity = 0;
    actor.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
}
