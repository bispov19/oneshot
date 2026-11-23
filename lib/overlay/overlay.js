// Overlay de captura/gravação.
//
// Fluxo: congela a tela -> o usuário seleciona região/janela/tela ->
// edita com as ferramentas (captura) ou confirma a área (gravação).
// Todas as coordenadas internas são lógicas do palco (stage).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FrozenImage} from '../capture/image.js';
import {Canvas} from '../editor/canvas.js';
import {TOOLS, toolById, toolByKey} from '../editor/tools.js';
import {
    ActionBar, StylePopover, ToolBar, Tooltips, fadeIn, iconButton,
} from '../ui/widgets.js';

const HANDLE_SIZE = 10;
const MAG_SIZE = 132;
const MAG_ZOOM = 8;
const MIN_SIZE = 4;

const HANDLE_CURSORS = {
    nw: Clutter.CursorType.NW_RESIZE, n: Clutter.CursorType.N_RESIZE,
    ne: Clutter.CursorType.NE_RESIZE, e: Clutter.CursorType.E_RESIZE,
    se: Clutter.CursorType.SE_RESIZE, s: Clutter.CursorType.S_RESIZE,
    sw: Clutter.CursorType.SW_RESIZE, w: Clutter.CursorType.W_RESIZE,
};

/** Converte "#rrggbb" + alfa em "rgba(...)" para CSS inline. */
function rgba(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${v >> 16 & 255}, ${v >> 8 & 255}, ${v & 255}, ${a})`;
}

function inside(r, x, y) {
    return r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Monitor que contém o ponto (ou o principal). */
function monitorAt(x, y) {
    return Main.layoutManager.monitors.find(m => inside({x: m.x, y: m.y, w: m.width, h: m.height}, x, y)) ??
        Main.layoutManager.primaryMonitor;
}

export class CaptureOverlay {
    /**
     * @param {object} p
     * @param {Gio.Settings} p.settings
     * @param {'region'|'window'|'screen'} p.mode
     * @param {'capture'|'record'} p.purpose
     * @param {object} p.handlers - callbacks da extensão:
     *   capture(action, overlay), record(rect, overlay), delay(mode, purpose), closed()
     */
    constructor({settings, mode = 'region', purpose = 'capture', handlers}) {
        this._settings = settings;
        this._mode = mode;
        this._purpose = purpose;
        this._handlers = handlers;
        this._state = 'select';
        this._sel = null;
        this._drag = null;
        this._grab = null;
        this._closed = false;
        this.image = null;
    }

    /* ============================== abertura ============================== */

    async open() {
        const s = this._settings;
        this._accent = s.get_string('accent-color');
        this._iconSize = s.get_int('icon-size');
        this._dimOpacity = s.get_double('dim-opacity');

        // Congela a tela antes de mostrar qualquer coisa.
        this.image = await FrozenImage.grab();
        if (this._closed)
            return;
        this.image.prepare(s.get_boolean('include-cursor')).then(() => {
            this._updateMagnifier();
        }).catch(e => logError(e, '[OneShot] falha ao preparar a imagem'));

        this._buildActors();
        Main.uiGroup.add_child(this.root);
        Main.uiGroup.set_child_above_sibling(this.root, null);

        this._grab = Main.pushModal(this.root, {actionMode: Shell.ActionMode.POPUP});
        global.stage.set_key_focus(this.root);
        this.root.set_cursor_type(Clutter.CursorType.CROSSHAIR);

        this._applyPurpose();
        this._layout();
        const [px, py] = global.get_pointer();
        this._onHover(px, py);
        fadeIn(this._modeBar);
    }

    _buildActors() {
        const {width: W, height: H} = global.stage;

        this.root = new St.Widget({
            style_class: 'oneshot-overlay',
            reactive: true,
            x: 0, y: 0, width: W, height: H,
        });

        // Imagem congelada (GPU).
        this._frozen = new Clutter.Actor({content: this.image.content, width: W, height: H});
        this.root.add_child(this._frozen);

        // Escurecimento: 4 retângulos ao redor da seleção.
        this._dims = [0, 1, 2, 3].map(() => {
            const d = new St.Widget({style: `background-color: rgba(4, 12, 28, ${this._dimOpacity});`});
            this.root.add_child(d);
            return d;
        });

        this._hover = new St.Widget({style_class: 'oneshot-hover', visible: false,
            style: `border-color: ${this._accent}; background-color: ${rgba(this._accent, 0.12)};`});
        this.root.add_child(this._hover);

        // Canvas de anotações (só na captura).
        this.canvas = new Canvas({image: this.image, accent: this._accent});
        this.canvas.visible = false;
        this.root.add_child(this.canvas);
        this.canvas.connect('history-changed', () => this._syncToolbar());
        this.canvas.connect('color-picked', (_c, hex) => this._setStyle({color: hex}));
        this.canvas.connect('text-editing', (_c, editing) => {
            if (!editing && !this._closed)
                global.stage.set_key_focus(this.root);
        });

        this._frame = new St.Widget({style_class: 'oneshot-selection', visible: false,
            style: `border-color: ${this._accent};`});
        this.root.add_child(this._frame);

        this._handles = {};
        for (const id of Object.keys(HANDLE_CURSORS)) {
            const h = new St.Widget({style_class: 'oneshot-handle', visible: false,
                width: HANDLE_SIZE, height: HANDLE_SIZE,
                style: `background-color: ${this._accent};`});
            this._handles[id] = h;
            this.root.add_child(h);
        }

        this._sizeLabel = new St.Label({style_class: 'oneshot-size-label', visible: false});
        this.root.add_child(this._sizeLabel);

        this._buildMagnifier();
        this._buildModeBar();
        this._buildEditBars();
        // Tooltips por último, para ficarem por cima de tudo.
        this._tooltips = new Tooltips(this.root);
        this._rebindTooltips();

        this.root.connect('button-press-event', (_a, e) => this._onPress(e));
        this.root.connect('motion-event', (_a, e) => this._onMotion(e));
        this.root.connect('button-release-event', (_a, e) => this._onRelease(e));
        this.root.connect('key-press-event', (_a, e) => this._onKey(e));
        this.root.connect('scroll-event', (_a, e) => this._onScroll(e));
    }

    /** Os tooltips precisam estar por cima: recria o vínculo após montar tudo. */
    _rebindTooltips() {
        for (const [widget, tip] of this._pendingTips ?? [])
            this._tooltips.attach(widget, tip);
        this._pendingTips = null;
    }

    /** Proxy usado durante a construção (antes do Tooltips final existir). */
    get _tipProxy() {
        this._pendingTips ??= [];
        return {attach: (w, t) => this._pendingTips.push([w, t])};
    }

    _buildMagnifier() {
        this._mag = new St.Widget({style_class: 'oneshot-magnifier', visible: false,
            width: MAG_SIZE, height: MAG_SIZE, clip_to_allocation: true,
            style: `border-color: ${this._accent};`});
        const {width: W, height: H} = global.stage;
        this._magZoom = new Clutter.Actor({content: this.image.content, width: W * MAG_ZOOM, height: H * MAG_ZOOM});
        this._magZoom.set_content_scaling_filters(Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST);
        this._mag.add_child(this._magZoom);
        const px = Math.max(2, MAG_ZOOM / this.image.scale);
        this._magCross = new St.Widget({style_class: 'oneshot-magnifier-cross',
            width: px + 2, height: px + 2,
            x: MAG_SIZE / 2 - 1, y: MAG_SIZE / 2 - 1});
        this._mag.add_child(this._magCross);
        this.root.add_child(this._mag);

        this._magInfo = new St.BoxLayout({style_class: 'oneshot-magnifier-info', visible: false});
        this._magSwatch = new St.Widget({style_class: 'oneshot-mag-swatch'});
        this._magLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._magInfo.add_child(this._magSwatch);
        this._magInfo.add_child(this._magLabel);
        this.root.add_child(this._magInfo);
    }

    _buildModeBar() {
        const tips = this._tipProxy;
        const size = this._iconSize;
        this._modeBar = new St.BoxLayout({style_class: 'oneshot-modebar', reactive: true});
        this._modeButtons = {};
        const modes = [
            ['region', 'mode-region', 'Região  (arrastar)'],
            ['window', 'mode-window', 'Janela  (clique na janela)'],
            ['screen', 'mode-screen', 'Tela/monitor  (clique no monitor)'],
        ];
        for (const [id, ic, tip] of modes) {
            const b = iconButton({icon: ic, tip, tooltips: tips, iconSize: size, toggle: true,
                onClick: () => this._setMode(id)});
            this._modeButtons[id] = b;
            this._modeBar.add_child(b);
        }
        this._modeBar.add_child(new St.Widget({style_class: 'oneshot-separator'}));
        const delay = this._settings.get_int('default-delay');
        this._modeBar.add_child(iconButton({icon: 'mode-timer', tip: `Capturar com atraso de ${delay} s`,
            tooltips: tips, iconSize: size,
            onClick: () => {
                const {mode, purpose} = this;
                this.close();
                this._handlers.delay(mode, purpose);
            }}));
        this._modeBar.add_child(new St.Widget({style_class: 'oneshot-separator'}));
        this._purposeButtons = {
            capture: iconButton({icon: 'mode-camera', tip: 'Captura de tela', tooltips: tips, iconSize: size,
                toggle: true, onClick: () => this._setPurpose('capture')}),
            record: iconButton({icon: 'mode-video', tip: 'Gravação de vídeo', tooltips: tips, iconSize: size,
                toggle: true, onClick: () => this._setPurpose('record')}),
        };
        this._modeBar.add_child(this._purposeButtons.capture);
        this._modeBar.add_child(this._purposeButtons.record);
        this._modeBar.add_child(new St.Widget({style_class: 'oneshot-separator'}));
        this._modeBar.add_child(iconButton({icon: 'act-cancel', tip: 'Cancelar  (Esc)', tooltips: tips,
            iconSize: size, onClick: () => this.close()}));
        this.root.add_child(this._modeBar);

        this._hint = new St.Label({style_class: 'oneshot-hint'});
        this.root.add_child(this._hint);
    }

    _buildEditBars() {
        const s = this._settings;
        const tips = this._tipProxy;
        const size = this._iconSize;

        // Estado inicial do estilo.
        this._style = {
            color: s.get_string('tool-color'),
            width: s.get_int('tool-width'),
            fontSize: s.get_int('font-size'),
        };
        this.canvas.font = s.get_string('font-family');
        let tool = s.get_boolean('remember-last-tool') ? s.get_string('last-tool') : 'arrow';
        if (!toolById(tool))
            tool = 'arrow';
        this._tool = tool;

        this._toolbar = new ToolBar({
            tools: TOOLS, tooltips: tips, iconSize: size, accent: this._accent,
            callbacks: {
                tool: id => this._setTool(id),
                color: btn => this._togglePopover(btn),
                undo: () => this.canvas.undo(),
                redo: () => this.canvas.redo(),
            },
        });
        this._toolbar.actor.hide();
        this.root.add_child(this._toolbar.actor);

        this._actionsCapture = new ActionBar({
            tooltips: tips, iconSize: size, accent: this._accent,
            actions: [
                {id: 'save', icon: 'act-save', tip: 'Salvar  (Ctrl+S / Enter)', onClick: () => this._action('save')},
                {id: 'copy', icon: 'act-copy', tip: 'Copiar  (Ctrl+C)', onClick: () => this._action('copy')},
                {id: 'saveas', icon: 'act-saveas', tip: 'Salvar como…  (Ctrl+Shift+S)', onClick: () => this._action('saveas')},
                {id: 'pin', icon: 'act-pin', tip: 'Fixar na tela  (Ctrl+P)', onClick: () => this._action('pin')},
                {id: 'openwith', icon: 'act-openwith', tip: 'Abrir com…  (Ctrl+O)', onClick: b => this._showOpenWith(b)},
                {separator: true},
                {id: 'cancel', icon: 'act-cancel', tip: 'Cancelar  (Esc)', styleClass: 'oneshot-danger', onClick: () => this.close()},
            ],
        });
        this._actionsCapture.actor.hide();
        this.root.add_child(this._actionsCapture.actor);

        this._actionsRecord = new ActionBar({
            tooltips: tips, iconSize: size, accent: this._accent,
            actions: [
                {id: 'record', icon: 'act-record', tip: 'Iniciar gravação  (Enter)', onClick: () => this._startRecording()},
                {separator: true},
                {id: 'cursor', icon: 'opt-cursor', tip: 'Mostrar o cursor', toggle: true,
                    active: s.get_boolean('record-cursor'),
                    onClick: b => s.set_boolean('record-cursor', b.checked)},
                {id: 'mic', icon: 'opt-mic', tip: 'Gravar microfone', toggle: true,
                    active: s.get_boolean('record-audio-mic'),
                    onClick: b => s.set_boolean('record-audio-mic', b.checked)},
                {id: 'system', icon: 'opt-speaker', tip: 'Gravar áudio do sistema', toggle: true,
                    active: s.get_boolean('record-audio-system'),
                    onClick: b => s.set_boolean('record-audio-system', b.checked)},
                {separator: true},
                {id: 'cancel', icon: 'act-cancel', tip: 'Cancelar  (Esc)', styleClass: 'oneshot-danger', onClick: () => this.close()},
            ],
        });
        this._actionsRecord.actor.hide();
        this.root.add_child(this._actionsRecord.actor);

        this._popover = new StylePopover({
            palette: s.get_strv('color-palette'), state: this._style, tooltips: tips,
            onChange: change => this._setStyle(change),
        });
        this.root.add_child(this._popover.actor);

        this._openWith = new St.BoxLayout({style_class: 'oneshot-popover', orientation: Clutter.Orientation.VERTICAL,
            reactive: true, visible: false});
        this.root.add_child(this._openWith);

        this.canvas.setStyle(this._style);
        this.canvas.setTool(this._tool);
        this._toolbar.setTool(this._tool);
        this._syncToolbar();
    }

    /* =============================== estado =============================== */

    get mode() {
        return this._mode;
    }

    get purpose() {
        return this._purpose;
    }

    get selection() {
        return this._sel ? {...this._sel} : null;
    }

    get shapes() {
        return this.canvas?.shapes ?? [];
    }

    _setMode(mode) {
        this._mode = mode;
        for (const [id, b] of Object.entries(this._modeButtons)) {
            b.checked = id === mode;
            b.style = id === mode ? `background-color: ${this._accent};` : null;
        }
        this._updateHint();
        const [x, y] = global.get_pointer();
        this._onHover(x, y);
    }

    _setPurpose(purpose) {
        this._purpose = purpose;
        this._applyPurpose();
        if (this._state === 'edit')
            this._enterEdit();
    }

    _applyPurpose() {
        const rec = this._purpose === 'record';
        for (const [id, b] of Object.entries(this._purposeButtons)) {
            b.checked = id === this._purpose;
            b.style = b.checked ? `background-color: ${this._accent};` : null;
        }
        // Na gravação a tela fica "ao vivo": esconde a imagem congelada.
        this._frozen.visible = !rec;
        this.canvas.visible = !rec && this._state === 'edit';
        this._setMode(this._mode);
    }

    _updateHint() {
        const what = {
            region: 'Arraste para selecionar uma região · clique para escolher uma janela',
            window: 'Clique na janela desejada',
            screen: 'Clique no monitor desejado',
        }[this._mode];
        this._hint.text = `${what} · Enter: tela inteira do monitor · Esc: cancelar`;
    }

    _setTool(id) {
        const t = toolById(id);
        if (!t)
            return;
        this._tool = id;
        this.canvas.setTool(id);
        this._toolbar.setTool(id);
        if (t.needsImage && (id === 'pixelate' || id === 'blur')) {
            // Carrega a surface Cairo só quando realmente necessária.
            this.image.prepare(false).then(() => {
                this.image.loadSurface();
                this.canvas.refresh();
            }).catch(logError);
        }
        if (this._settings.get_boolean('remember-last-tool'))
            this._settings.set_string('last-tool', id);
        const [x, y] = global.get_pointer();
        this._onHover(x, y);
    }

    _setStyle(change) {
        Object.assign(this._style, change);
        this.canvas.setStyle(change);
        this._popover.update(this._style);
        this._syncToolbar();
        if (this._settings.get_boolean('remember-last-tool')) {
            if (change.color)
                this._settings.set_string('tool-color', change.color);
            if (change.width)
                this._settings.set_int('tool-width', change.width);
            if (change.fontSize)
                this._settings.set_int('font-size', change.fontSize);
        }
    }

    _syncToolbar() {
        if (!this._toolbar)
            return;
        this._toolbar.setStyle(this._style.color, this._style.width);
        this._toolbar.setHistory(this.canvas.canUndo, this.canvas.canRedo);
    }

    _togglePopover(anchor) {
        this._openWith.hide();
        if (this._popover.visible)
            this._popover.hide();
        else
            this._popover.popup(anchor ?? this._toolbar.actor);
    }

    /* ============================== seleção ============================== */

    _setSelection(r) {
        const {width: W, height: H} = global.stage;
        let {x, y, w, h} = r;
        x = Math.max(0, Math.min(W - 1, x));
        y = Math.max(0, Math.min(H - 1, y));
        w = Math.max(1, Math.min(W - x, w));
        h = Math.max(1, Math.min(H - y, h));
        this._sel = {x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h)};
        this._layout();
    }

    /** Janela visível mais acima sob o ponto. */
    _windowAt(x, y) {
        const ws = global.workspace_manager.get_active_workspace();
        const actors = global.get_window_actors().slice().reverse();
        for (const a of actors) {
            const w = a.meta_window;
            if (!w || w.minimized || !w.showing_on_its_workspace())
                continue;
            if (!w.is_on_all_workspaces() && w.get_workspace() !== ws)
                continue;
            const type = w.get_window_type();
            if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK)
                continue;
            const f = w.get_frame_rect();
            if (inside({x: f.x, y: f.y, w: f.width, h: f.height}, x, y))
                return {x: f.x, y: f.y, w: f.width, h: f.height};
        }
        return null;
    }

    _monitorRect(x, y) {
        const m = monitorAt(x, y);
        return {x: m.x, y: m.y, w: m.width, h: m.height};
    }

    /** Retângulo sugerido para um clique, conforme o modo. */
    _pickRect(x, y) {
        if (this._mode === 'screen')
            return this._monitorRect(x, y);
        return this._windowAt(x, y) ?? this._monitorRect(x, y);
    }

    _handleAt(x, y) {
        const r = this._sel;
        if (!r)
            return null;
        const t = HANDLE_SIZE;
        const nearL = Math.abs(x - r.x) <= t, nearR = Math.abs(x - (r.x + r.w)) <= t;
        const nearT = Math.abs(y - r.y) <= t, nearB = Math.abs(y - (r.y + r.h)) <= t;
        const inX = x > r.x - t && x < r.x + r.w + t, inY = y > r.y - t && y < r.y + r.h + t;
        if (nearT && nearL)
            return 'nw';
        if (nearT && nearR)
            return 'ne';
        if (nearB && nearL)
            return 'sw';
        if (nearB && nearR)
            return 'se';
        if (nearT && inX)
            return 'n';
        if (nearB && inX)
            return 's';
        if (nearL && inY)
            return 'w';
        if (nearR && inY)
            return 'e';
        return null;
    }

    _resizeFrom(orig, handle, dx, dy) {
        let l = orig.x, t = orig.y, r = orig.x + orig.w, b = orig.y + orig.h;
        if (handle.includes('w'))
            l += dx;
        if (handle.includes('e'))
            r += dx;
        if (handle.includes('n'))
            t += dy;
        if (handle.includes('s'))
            b += dy;
        return {x: Math.min(l, r), y: Math.min(t, b), w: Math.abs(r - l), h: Math.abs(b - t)};
    }

    /* ============================== layout ============================== */

    _layout() {
        const {width: W, height: H} = global.stage;
        const r = this._sel;
        const [d0, d1, d2, d3] = this._dims;

        if (!r) {
            d0.set_position(0, 0);
            d0.set_size(W, H);
            for (const d of [d1, d2, d3])
                d.set_size(0, 0);
            this._frame.hide();
            this._sizeLabel.hide();
            Object.values(this._handles).forEach(h => h.hide());
        } else {
            d0.set_position(0, 0);
            d0.set_size(W, r.y);
            d1.set_position(0, r.y + r.h);
            d1.set_size(W, H - r.y - r.h);
            d2.set_position(0, r.y);
            d2.set_size(r.x, r.h);
            d3.set_position(r.x + r.w, r.y);
            d3.set_size(W - r.x - r.w, r.h);

            this._frame.set_position(r.x - 1, r.y - 1);
            this._frame.set_size(r.w + 2, r.h + 2);
            this._frame.show();

            const hs = HANDLE_SIZE / 2;
            const pos = {
                nw: [r.x, r.y], n: [r.x + r.w / 2, r.y], ne: [r.x + r.w, r.y],
                e: [r.x + r.w, r.y + r.h / 2], se: [r.x + r.w, r.y + r.h],
                s: [r.x + r.w / 2, r.y + r.h], sw: [r.x, r.y + r.h], w: [r.x, r.y + r.h / 2],
            };
            const small = r.w < 40 || r.h < 40;
            for (const [id, [hx, hy]] of Object.entries(pos)) {
                const h = this._handles[id];
                h.set_position(Math.round(hx - hs), Math.round(hy - hs));
                h.visible = !small || id.length === 2;
            }

            const S = this.image.scale;
            this._sizeLabel.text = `${Math.round(r.w * S)} × ${Math.round(r.h * S)}`;
            this._sizeLabel.show();
            const [, , lw, lh] = this._sizeLabel.get_preferred_size();
            let ly = r.y - lh - 8;
            if (ly < 4)
                ly = r.y + 8;
            this._sizeLabel.set_position(Math.round(Math.min(r.x, W - lw - 4)), Math.round(ly));

            if (this._state === 'edit') {
                this.canvas.setRegion(r.x, r.y, r.w, r.h);
                this._placeBars();
            }
        }

        // Barra de modos: topo do monitor principal.
        if (this._modeBar.visible) {
            const m = Main.layoutManager.primaryMonitor;
            const [, , bw] = this._modeBar.get_preferred_size();
            this._modeBar.set_position(Math.round(m.x + (m.width - bw) / 2), m.y + 24);
            const [, , hw] = this._hint.get_preferred_size();
            this._hint.set_position(Math.round(m.x + (m.width - hw) / 2), m.y + 24 + 56);
        }
    }

    /** Posiciona a barra de ferramentas e a de ações ao lado da seleção. */
    _placeBars() {
        const r = this._sel;
        const m = monitorAt(r.x + r.w / 2, r.y + r.h / 2);
        const gap = 10;
        const mx1 = m.x + 8, my1 = m.y + 8, mx2 = m.x + m.width - 8, my2 = m.y + m.height - 8;

        const tb = this._purpose === 'capture' ? this._toolbar.actor : null;
        if (tb) {
            const [, , tw, th] = tb.get_preferred_size();
            let ty = r.y + r.h + gap;
            if (ty + th > my2)
                ty = r.y - th - gap;
            if (ty < my1)
                ty = r.y + r.h - th - gap;
            const tx = Math.max(mx1, Math.min(mx2 - tw, r.x + r.w / 2 - tw / 2));
            tb.set_position(Math.round(tx), Math.round(Math.max(my1, ty)));
        }

        const ab = this._purpose === 'capture' ? this._actionsCapture.actor : this._actionsRecord.actor;
        const [, , aw, ah] = ab.get_preferred_size();
        let ax = r.x + r.w + gap;
        if (ax + aw > mx2)
            ax = r.x - aw - gap;
        if (ax < mx1)
            ax = r.x + r.w - aw - gap;
        const ay = Math.max(my1, Math.min(my2 - ah, r.y));
        ab.set_position(Math.round(Math.max(mx1, ax)), Math.round(ay));
    }

    _enterEdit() {
        this._state = 'edit';
        this._modeBar.hide();
        this._hint.hide();
        this._hover.hide();
        this._hideMagnifier();
        this._tooltips.hide();
        this._settings.set_string('last-capture-mode', 'region');
        this._settings.set_value('last-capture-area', new GLib.Variant('ai',
            [this._sel.x, this._sel.y, this._sel.w, this._sel.h]));

        const capture = this._purpose === 'capture';
        this.canvas.visible = capture;
        for (const [a, show] of [[this._toolbar.actor, capture],
            [this._actionsCapture.actor, capture], [this._actionsRecord.actor, !capture]]) {
            if (show && !a.visible) {
                a.show();
                fadeIn(a);
            } else if (!show) {
                a.hide();
            }
        }
        this._layout();
    }

    /* ============================== lupa ============================== */

    _updateMagnifier(x, y) {
        if (x === undefined)
            [x, y] = global.get_pointer();
        const show = this._settings.get_boolean('show-magnifier') && this._purpose === 'capture' &&
            (this._state === 'select' || this._drag?.kind === 'resize' || this._drag?.kind === 'new' ||
             (this._state === 'edit' && this._tool === 'eyedropper' && inside(this._sel, x, y)));
        if (!show) {
            this._hideMagnifier();
            return;
        }
        this._magZoom.set_position(Math.round(MAG_SIZE / 2 - x * MAG_ZOOM), Math.round(MAG_SIZE / 2 - y * MAG_ZOOM));

        const hex = this.image.pickColor(x, y);
        this._magSwatch.style = hex ? `background-color: ${hex};` : null;
        const S = this.image.scale;
        this._magLabel.text = `${hex ?? '…'}   ${Math.round(x * S)}, ${Math.round(y * S)}`;

        const {width: W, height: H} = global.stage;
        const off = 24;
        const [, , iw, ih] = this._magInfo.get_preferred_size();
        let mx = x + off, my = y + off;
        if (mx + MAG_SIZE > W - 4)
            mx = x - off - MAG_SIZE;
        if (my + MAG_SIZE + ih + 6 > H - 4)
            my = y - off - MAG_SIZE - ih - 6;
        this._mag.set_position(Math.round(mx), Math.round(my));
        this._magInfo.set_position(Math.round(mx + (MAG_SIZE - iw) / 2), Math.round(my + MAG_SIZE + 6));
        this.root.set_child_above_sibling(this._mag, null);
        this.root.set_child_above_sibling(this._magInfo, null);
        this._mag.show();
        this._magInfo.show();
    }

    _hideMagnifier() {
        this._mag?.hide();
        this._magInfo?.hide();
    }

    /* ============================== eventos ============================== */

    /** O ator sob o ponteiro pertence a uma barra/popover? */
    _isUi(x, y) {
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        if (!actor || actor === this.root)
            return false;
        return [this._toolbar.actor, this._actionsCapture.actor, this._actionsRecord.actor,
            this._modeBar, this._popover.actor, this._openWith]
            .some(c => c.visible && (c === actor || c.contains(actor)));
    }

    _onPress(event) {
        const [x, y] = event.get_coords();
        if (this._isUi(x, y))
            return Clutter.EVENT_PROPAGATE;
        const button = event.get_button();
        const mods = event.get_state();

        if (this._popover.visible || this._openWith.visible) {
            this._popover.hide();
            this._openWith.hide();
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_SECONDARY && this._state === 'edit' && this._purpose === 'capture') {
            this._togglePopover(this._toolbar._colorBtn);
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;

        this._tooltips.hide();

        if (this._state === 'edit') {
            if (this.canvas.isEditingText) {
                this.canvas.finishText();
                return Clutter.EVENT_STOP;
            }
            const handle = this._handleAt(x, y);
            if (handle) {
                this._drag = {kind: 'resize', handle, orig: {...this._sel}, start: [x, y]};
                return Clutter.EVENT_STOP;
            }
            if (inside(this._sel, x, y)) {
                if (this._purpose === 'capture' && this.canvas.press(x, y, mods)) {
                    this._drag = {kind: 'canvas'};
                    return Clutter.EVENT_STOP;
                }
                if (this._purpose === 'record' || this._tool === 'select') {
                    this._drag = {kind: 'move', orig: {...this._sel}, start: [x, y]};
                    this.root.set_cursor_type(Clutter.CursorType.GRABBING);
                }
                return Clutter.EVENT_STOP;
            }
        }
        this._drag = {kind: 'new', start: [x, y], moved: false};
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const [x, y] = event.get_coords();
        const d = this._drag;
        if (!d) {
            this._onHover(x, y);
            return Clutter.EVENT_PROPAGATE;
        }
        const mods = event.get_state();
        switch (d.kind) {
        case 'new': {
            const [sx, sy] = d.start;
            if (!d.moved && Math.hypot(x - sx, y - sy) < 4)
                break;
            d.moved = true;
            this._hover.hide();
            this._modeBar.hide();
            this._hint.hide();
            this._setSelection({x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy)});
            break;
        }
        case 'resize':
            this._setSelection(this._resizeFrom(d.orig, d.handle, x - d.start[0], y - d.start[1]));
            break;
        case 'move': {
            const {width: W, height: H} = global.stage;
            const nx = Math.max(0, Math.min(W - d.orig.w, d.orig.x + x - d.start[0]));
            const ny = Math.max(0, Math.min(H - d.orig.h, d.orig.y + y - d.start[1]));
            this._setSelection({...d.orig, x: nx, y: ny});
            break;
        }
        case 'canvas':
            this.canvas.motion(x, y, mods);
            break;
        }
        this._updateMagnifier(x, y);
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        const d = this._drag;
        if (!d)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._drag = null;

        if (d.kind === 'canvas') {
            this.canvas.release(x, y, event.get_state());
        } else if (d.kind === 'new') {
            if (!d.moved) {
                this._setSelection(this._pickRect(x, y));
            } else if (!this._sel || this._sel.w < MIN_SIZE || this._sel.h < MIN_SIZE) {
                // Seleção pequena demais: volta ao estado inicial.
                this._sel = null;
                this._state = 'select';
                this._layout();
                this._onHover(x, y);
                return Clutter.EVENT_STOP;
            }
            this._enterEdit();
        } else {
            this._layout();
        }
        this._onHover(x, y);
        return Clutter.EVENT_STOP;
    }

    _onHover(x, y) {
        if (this._closed)
            return;
        if (this._state === 'select') {
            const r = this._mode === 'region' ? null : this._pickRect(x, y);
            if (r) {
                this._hover.set_position(r.x, r.y);
                this._hover.set_size(r.w, r.h);
                this._hover.show();
            } else {
                this._hover.hide();
            }
            this.root.set_cursor_type(this._mode === 'region'
                ? Clutter.CursorType.CROSSHAIR : Clutter.CursorType.DEFAULT);
        } else {
            const handle = this._handleAt(x, y);
            let cursor = Clutter.CursorType.CROSSHAIR;
            if (handle)
                cursor = HANDLE_CURSORS[handle];
            else if (inside(this._sel, x, y)) {
                if (this._purpose === 'record')
                    cursor = Clutter.CursorType.MOVE;
                else if (this._tool === 'select')
                    cursor = this.canvas.shapeAt(x, y) >= 0 ? Clutter.CursorType.MOVE : Clutter.CursorType.GRABBING;
                else if (this._tool === 'text')
                    cursor = Clutter.CursorType.TEXT;
                else if (this._tool === 'eraser' || this._tool === 'eyedropper')
                    cursor = Clutter.CursorType.DEFAULT;
            } else {
                cursor = Clutter.CursorType.DEFAULT;
            }
            this.root.set_cursor_type(cursor);
        }
        this._updateMagnifier(x, y);
    }

    _onScroll(event) {
        if (this._state !== 'edit' || this._purpose !== 'capture')
            return Clutter.EVENT_PROPAGATE;
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
        this._bumpSize(delta);
        return Clutter.EVENT_STOP;
    }

    _bumpSize(delta) {
        if (this._tool === 'text' || this._tool === 'counter')
            this._setStyle({fontSize: Math.max(8, Math.min(96, this._style.fontSize + delta * 2))});
        else
            this._setStyle({width: Math.max(1, Math.min(40, this._style.width + delta))});
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        const mods = event.get_state();
        const ctrl = !!(mods & Clutter.ModifierType.CONTROL_MASK);
        const shift = !!(mods & Clutter.ModifierType.SHIFT_MASK);

        // Edição de texto: só Esc é nosso (confirma o texto).
        if (this.canvas.isEditingText) {
            if (sym === Clutter.KEY_Escape) {
                this.canvas.finishText();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }
        // Campo hexadecimal do popover em foco.
        if (global.stage.key_focus && global.stage.key_focus !== this.root) {
            if (sym === Clutter.KEY_Escape) {
                this._popover.hide();
                global.stage.set_key_focus(this.root);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (sym === Clutter.KEY_Escape) {
            if (this._popover.visible || this._openWith.visible) {
                this._popover.hide();
                this._openWith.hide();
            } else if (this.canvas.hasSelection) {
                this.canvas.setTool(this._tool); // desmarca a forma
            } else {
                this.close();
            }
            return Clutter.EVENT_STOP;
        }

        if (this._state === 'select') {
            if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                const [x, y] = global.get_pointer();
                this._setSelection(this._monitorRect(x, y));
                this._enterEdit();
            }
            return Clutter.EVENT_STOP;
        }

        // ---- estado de edição ----
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
            if (this._purpose === 'record')
                this._startRecording();
            else
                this._action('save');
            return Clutter.EVENT_STOP;
        }

        // Setas: movem a forma selecionada ou a seleção (Ctrl redimensiona).
        const arrows = {
            [Clutter.KEY_Left]: [-1, 0], [Clutter.KEY_Right]: [1, 0],
            [Clutter.KEY_Up]: [0, -1], [Clutter.KEY_Down]: [0, 1],
        };
        if (arrows[sym]) {
            const step = shift ? 10 : 1;
            const [dx, dy] = arrows[sym].map(v => v * step);
            if (!this.canvas.nudgeSelected(dx, dy)) {
                const r = this._sel;
                this._setSelection(ctrl
                    ? {...r, w: Math.max(MIN_SIZE, r.w + dx), h: Math.max(MIN_SIZE, r.h + dy)}
                    : {...r, x: r.x + dx, y: r.y + dy});
            }
            return Clutter.EVENT_STOP;
        }

        if (this._purpose === 'record')
            return Clutter.EVENT_STOP;

        const key = String.fromCodePoint(Clutter.keysym_to_unicode(sym) || 32).toLowerCase();
        if (ctrl) {
            if (key === 'z' && shift)
                this.canvas.redo();
            else if (key === 'z')
                this.canvas.undo();
            else if (key === 'y')
                this.canvas.redo();
            else if (key === 'c')
                this._action('copy');
            else if (key === 's' && shift)
                this._action('saveas');
            else if (key === 's')
                this._action('save');
            else if (key === 'p')
                this._action('pin');
            else if (key === 'o')
                this._showOpenWith(this._actionsCapture.buttons.get('openwith'));
            return Clutter.EVENT_STOP;
        }

        if (sym === Clutter.KEY_Delete || sym === Clutter.KEY_BackSpace) {
            this.canvas.deleteSelected();
            return Clutter.EVENT_STOP;
        }
        if (key === '+' || key === '=' || sym === Clutter.KEY_KP_Add) {
            this._bumpSize(1);
            return Clutter.EVENT_STOP;
        }
        if (key === '-' || sym === Clutter.KEY_KP_Subtract) {
            this._bumpSize(-1);
            return Clutter.EVENT_STOP;
        }
        if (key === 'c') {
            this._togglePopover(this._toolbar._colorBtn);
            return Clutter.EVENT_STOP;
        }
        const tool = toolByKey(key);
        if (tool)
            this._setTool(tool.id);
        return Clutter.EVENT_STOP;
    }

    /* ============================== ações ============================== */

    _action(action) {
        if (this._state !== 'edit' || this._busy)
            return;
        this.canvas.finishText();
        this._busy = true;
        this._handlers.capture(action, this);
    }

    _startRecording() {
        if (this._state !== 'edit' || this._busy)
            return;
        this._busy = true;
        const rect = this.selection;
        // Fecha na hora, para o overlay não aparecer no vídeo.
        this.close();
        this._handlers.record(rect);
    }

    /** Lista de aplicativos que abrem imagens. */
    _showOpenWith(anchor) {
        if (this._state !== 'edit')
            return;
        this._popover.hide();
        this._openWith.destroy_all_children();
        const seen = new Set();
        const apps = [
            ...Gio.AppInfo.get_recommended_for_type('image/png'),
            ...Gio.AppInfo.get_all_for_type('image/png'),
        ].filter(a => {
            if (seen.has(a.get_id()) || !a.should_show())
                return false;
            seen.add(a.get_id());
            return true;
        }).slice(0, 10);

        this._openWith.add_child(new St.Label({text: 'Abrir com', style_class: 'oneshot-popover-title'}));
        if (!apps.length)
            this._openWith.add_child(new St.Label({text: 'Nenhum aplicativo encontrado', style_class: 'oneshot-popover-label'}));
        for (const app of apps) {
            const row = new St.Button({style_class: 'oneshot-app-row', can_focus: false, track_hover: true});
            const box = new St.BoxLayout({style_class: 'oneshot-app-row-box'});
            box.add_child(new St.Icon({gicon: app.get_icon(), icon_size: 20}));
            box.add_child(new St.Label({text: app.get_display_name(), y_align: Clutter.ActorAlign.CENTER}));
            row.set_child(box);
            row.connect('clicked', () => {
                this._openWithApp = app;
                this._action('openwith');
            });
            this._openWith.add_child(row);
        }
        this.root.set_child_above_sibling(this._openWith, null);
        this._openWith.show();
        const [ax, ay] = anchor.get_transformed_position();
        const [aw] = anchor.get_transformed_size();
        const [, , pw, ph] = this._openWith.get_preferred_size();
        let x = ax + aw + 8;
        if (x + pw > global.stage.width - 8)
            x = ax - pw - 8;
        const y = Math.max(8, Math.min(global.stage.height - ph - 8, ay));
        this._openWith.set_position(Math.round(x), Math.round(y));
        fadeIn(this._openWith);
    }

    get openWithApp() {
        return this._openWithApp ?? null;
    }

    /** Esconde o overlay (mantém a imagem para exportar). */
    hide() {
        this._releaseGrab();
        this.root?.hide();
    }

    _releaseGrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    close() {
        if (this._closed)
            return;
        this._closed = true;
        this._releaseGrab();
        this._tooltips?.destroy();
        this._tooltips = null;
        this.root?.destroy();
        this.root = null;
        this.canvas = null;
        this.image?.destroy();
        this.image = null;
        this._handlers.closed?.(this);
    }
}
