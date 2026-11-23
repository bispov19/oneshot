// Canvas de anotação: guarda as formas, o histórico (desfazer/refazer
// ilimitados) e traduz eventos do ponteiro em formas conforme a ferramenta.
//
// Desempenho (GPU integrada): usamos DUAS camadas Cairo.
//   - _base: todas as formas confirmadas; só é redesenhada quando algo muda.
//   - _active: só a forma sendo desenhada, numa área do tamanho da caixa
//     dessa forma — redesenhar a cada movimento do mouse fica barato.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
    cloneShape, fontDescription, hitTest, renderSelectionBox, renderShape,
    shapeBounds, translateShape, hexToRgb,
} from './shapes.js';
import {FREEHAND, TWO_POINT} from './tools.js';

export const Canvas = GObject.registerClass({
    Signals: {
        'history-changed': {},
        'color-picked': {param_types: [GObject.TYPE_STRING]},
        'text-editing': {param_types: [GObject.TYPE_BOOLEAN]},
        'selection-changed': {},
    },
}, class Canvas extends St.Widget {
    /**
     * @param {object} params
     * @param {object|null} params.image - provedor da imagem congelada
     *   ({surface, scale, pickColor(x, y)}) ou null (anotação ao vivo)
     * @param {string} params.accent - cor de destaque
     */
    _init({image = null, accent = '#2f8cff'} = {}) {
        super._init({reactive: false, clip_to_allocation: true});
        this._image = image;
        this._accent = accent;
        this._region = {x: 0, y: 0, w: 1, h: 1};

        this._base = new St.DrawingArea({x: 0, y: 0});
        this._base.connect('repaint', area => this._paintBase(area));
        this.add_child(this._base);

        this._active = new St.DrawingArea({x: 0, y: 0, width: 1, height: 1, visible: false});
        this._active.connect('repaint', area => this._paintActive(area));
        this.add_child(this._active);
        this._activeBox = {x: 0, y: 0, w: 1, h: 1};

        this._states = [[]];
        this._pos = 0;

        this.tool = 'arrow';
        this.color = '#ff3b47';
        this.strokeWidth = 4; // (não usar "width": é a largura do ator)
        this.fontSize = 20;
        this.font = 'Sans';

        this._draft = null; // forma sendo desenhada
        this._drag = null; // estado do arraste atual
        this._selected = -1; // índice da forma selecionada (ferramenta Selecionar)
        this._hidden = -1; // índice oculto na camada base (sendo movido/editado)
        this._text = null; // edição de texto {actor, index, x, y}
    }

    /* ------------------------------ estado ------------------------------ */

    get shapes() {
        return this._states[this._pos];
    }

    get canUndo() {
        return this._pos > 0;
    }

    get canRedo() {
        return this._pos < this._states.length - 1;
    }

    get isEditingText() {
        return !!this._text;
    }

    get isBusy() {
        return !!this._drag || !!this._text;
    }

    get hasSelection() {
        return this._selected >= 0;
    }

    /** Registra um novo estado no histórico. */
    _commit(shapes) {
        this._states.splice(this._pos + 1);
        this._states.push(shapes);
        this._pos++;
        this._afterChange();
    }

    _afterChange() {
        if (this._selected >= this.shapes.length)
            this._selected = -1;
        this._base.queue_repaint();
        this._updateActive();
        this.emit('history-changed');
    }

    undo() {
        this.finishText();
        if (!this.canUndo)
            return;
        this._pos--;
        this._selected = -1;
        this._afterChange();
    }

    redo() {
        this.finishText();
        if (!this.canRedo)
            return;
        this._pos++;
        this._selected = -1;
        this._afterChange();
    }

    clear() {
        this.finishText();
        if (this.shapes.length)
            this._commit([]);
        this._selected = -1;
    }

    deleteSelected() {
        if (this._selected < 0)
            return false;
        const next = this.shapes.filter((_, i) => i !== this._selected);
        this._selected = -1;
        this._commit(next);
        this.emit('selection-changed');
        return true;
    }

    /** Recarrega a camada base (ex.: quando a imagem congelada fica pronta). */
    refresh() {
        this._base.queue_repaint();
    }

    setAccent(accent) {
        this._accent = accent;
        this._updateActive();
    }

    /** Área visível do canvas, em coordenadas do palco. */
    setRegion(x, y, w, h) {
        this._region = {x, y, w: Math.max(1, w), h: Math.max(1, h)};
        this.set_position(x, y);
        this.set_size(this._region.w, this._region.h);
        this._base.set_size(this._region.w, this._region.h);
        this._base.queue_repaint();
        this._updateActive();
    }

    setTool(id) {
        this.finishText();
        this.tool = id;
        if (id !== 'select' && this._selected >= 0) {
            this._selected = -1;
            this._updateActive();
            this.emit('selection-changed');
        }
    }

    /** Muda cor/espessura/fonte; se houver forma selecionada, aplica a ela. */
    setStyle({color, width, fontSize}) {
        if (color)
            this.color = color;
        if (width)
            this.strokeWidth = width;
        if (fontSize)
            this.fontSize = fontSize;

        if (this._text) {
            this._styleTextActor();
            return;
        }
        if (this._selected >= 0) {
            const next = this.shapes.slice();
            const s = cloneShape(next[this._selected]);
            if (color)
                s.color = color;
            if (width)
                s.width = width;
            if (fontSize && (s.type === 'text' || s.type === 'counter'))
                s.fontSize = fontSize;
            next[this._selected] = s;
            this._commit(next);
        }
    }

    /* ------------------------------ ponteiro ------------------------------ */

    /** Índice da forma mais acima no ponto (x, y), ou -1. */
    shapeAt(x, y) {
        const shapes = this.shapes;
        for (let i = shapes.length - 1; i >= 0; i--) {
            if (hitTest(shapes[i], x, y))
                return i;
        }
        return -1;
    }

    /**
     * Botão pressionado (coordenadas do palco).
     *
     * @returns {boolean} true se o canvas tratou o evento
     */
    press(x, y, mods = 0) {
        const tool = this.tool;

        if (this._text) {
            this.finishText();
            return true;
        }

        if (tool === 'select') {
            const idx = this.shapeAt(x, y);
            this._selected = idx;
            this.emit('selection-changed');
            if (idx < 0) {
                this._updateActive();
                return false;
            }
            this._hidden = idx;
            this._drag = {kind: 'move', last: [x, y], shape: cloneShape(this.shapes[idx]), moved: false};
            this._base.queue_repaint();
            this._updateActive();
            return true;
        }

        if (tool === 'eyedropper') {
            const hex = this._image?.pickColor(x, y);
            if (hex)
                this.emit('color-picked', hex);
            return true;
        }

        if (tool === 'counter') {
            const n = this.shapes.filter(s => s.type === 'counter')
                .reduce((m, s) => Math.max(m, s.n), 0) + 1;
            this._commit([...this.shapes, {
                type: 'counter', color: this.color, width: this.strokeWidth,
                fontSize: this.fontSize, n, p: [[x, y]],
            }]);
            return true;
        }

        if (tool === 'text') {
            const idx = this.shapeAt(x, y);
            if (idx >= 0 && this.shapes[idx].type === 'text')
                this._startText(this.shapes[idx].p[0][0], this.shapes[idx].p[0][1], idx);
            else
                this._startText(x, y, -1);
            return true;
        }

        if (tool === 'eraser') {
            this._drag = {kind: 'erase', shapes: this.shapes.slice(), changed: false};
            this._eraseAt(x, y);
            return true;
        }

        if (TWO_POINT.has(tool) || FREEHAND.has(tool)) {
            if (TWO_POINT.has(tool) && !this._image && (tool === 'pixelate' || tool === 'blur'))
                return true;
            this._draft = {
                type: tool, color: this.color, width: this.strokeWidth,
                p: TWO_POINT.has(tool) ? [[x, y], [x, y]] : [[x, y]],
            };
            this._drag = {kind: 'draw', mods};
            this._updateActive();
            return true;
        }
        return false;
    }

    motion(x, y, mods = 0) {
        if (!this._drag)
            return false;

        switch (this._drag.kind) {
        case 'move': {
            const [lx, ly] = this._drag.last;
            translateShape(this._drag.shape, x - lx, y - ly);
            this._drag.last = [x, y];
            this._drag.moved = true;
            break;
        }
        case 'erase':
            this._eraseAt(x, y);
            break;
        case 'draw': {
            const d = this._draft;
            if (FREEHAND.has(d.type)) {
                const [px, py] = d.p[d.p.length - 1];
                if (Math.hypot(x - px, y - py) >= 1.5)
                    d.p.push([x, y]);
            } else {
                d.p[1] = constrain(d.type, d.p[0], [x, y], mods);
            }
            break;
        }
        }
        this._updateActive();
        return true;
    }

    release(x, y, mods = 0) {
        const drag = this._drag;
        if (!drag)
            return false;
        this._drag = null;

        if (drag.kind === 'move') {
            const idx = this._hidden;
            this._hidden = -1;
            if (drag.moved) {
                const next = this.shapes.slice();
                next[idx] = drag.shape;
                this._commit(next);
            } else {
                this._base.queue_repaint();
                this._updateActive();
            }
        } else if (drag.kind === 'erase') {
            if (drag.changed)
                this._commit(drag.shapes);
        } else if (drag.kind === 'draw') {
            this.motion(x, y, mods);
            const d = this._draft;
            this._draft = null;
            if (isMeaningful(d))
                this._commit([...this.shapes, d]);
            else
                this._updateActive();
        }
        return true;
    }

    _eraseAt(x, y) {
        const shapes = this._drag.shapes;
        for (let i = shapes.length - 1; i >= 0; i--) {
            if (hitTest(shapes[i], x, y)) {
                shapes.splice(i, 1);
                this._drag.changed = true;
                this._base.queue_repaint();
                return;
            }
        }
    }

    /** Move a forma selecionada pelo teclado. */
    nudgeSelected(dx, dy) {
        if (this._selected < 0)
            return false;
        const next = this.shapes.slice();
        const s = cloneShape(next[this._selected]);
        translateShape(s, dx, dy);
        next[this._selected] = s;
        this._commit(next);
        return true;
    }

    /* -------------------------------- texto -------------------------------- */

    _startText(x, y, index) {
        const existing = index >= 0 ? this.shapes[index] : null;
        if (existing) {
            this.color = existing.color;
            this.fontSize = existing.fontSize;
            this.font = existing.font ?? this.font;
        }
        const actor = new Clutter.Text({
            editable: true,
            reactive: true,
            single_line_mode: false,
            activatable: false,
            cursor_visible: true,
            cursor_size: 2,
            text: existing?.text ?? '',
            x: x - this._region.x,
            y: y - this._region.y,
        });
        this._text = {actor, index, x, y};
        this._styleTextActor();
        this.add_child(actor);
        actor.connect('notify::size', () => this._updateActive());
        actor.connect('text-changed', () => this._updateActive());
        global.stage.set_key_focus(actor);
        if (index >= 0) {
            this._hidden = index;
            this._base.queue_repaint();
        }
        this._updateActive();
        this.emit('text-editing', true);
    }

    _styleTextActor() {
        const actor = this._text?.actor;
        if (!actor)
            return;
        actor.font_description = fontDescription(this.font, this.fontSize);
        const [, color] = Cogl.Color.from_string(this.color);
        actor.color = color;
        const [, accent] = Cogl.Color.from_string(this._accent);
        actor.cursor_color = accent;
    }

    /** Confirma o texto em edição (se houver). */
    finishText() {
        const t = this._text;
        if (!t)
            return;
        this._text = null;
        const text = t.actor.get_text();
        t.actor.destroy();
        this._hidden = -1;

        const next = this.shapes.slice();
        if (text.trim()) {
            const shape = {
                type: 'text', color: this.color, width: 1, text,
                fontSize: this.fontSize, font: this.font, p: [[t.x, t.y]],
            };
            if (t.index >= 0)
                next[t.index] = shape;
            else
                next.push(shape);
            this._commit(next);
        } else if (t.index >= 0) {
            next.splice(t.index, 1);
            this._commit(next);
        } else {
            this._base.queue_repaint();
            this._updateActive();
        }
        this.emit('text-editing', false);
    }

    /* ------------------------------- pintura ------------------------------- */

    _env(preview = false) {
        return {
            source: this._image?.surface ?? null,
            scale: this._image?.scale ?? 1,
            preview,
        };
    }

    _paintBase(area) {
        const cr = area.get_context();
        try {
            cr.translate(-this._region.x, -this._region.y);
            const env = this._env();
            const shapes = this._drag?.kind === 'erase' ? this._drag.shapes : this.shapes;
            shapes.forEach((s, i) => {
                if (i !== this._hidden)
                    renderShape(cr, s, env);
            });
        } catch (e) {
            logError(e, '[OneShot] falha ao desenhar');
        } finally {
            cr.$dispose();
        }
    }

    /** O que vai na camada ativa: rascunho, forma em movimento, seleção, texto. */
    _activeItems() {
        const items = [];
        if (this._draft)
            items.push({shape: this._draft});
        if (this._drag?.kind === 'move')
            items.push({shape: this._drag.shape, box: true});
        else if (this._selected >= 0 && this.shapes[this._selected])
            items.push({shape: this.shapes[this._selected], box: true, only: true});
        if (this._text) {
            const [w, h] = this._text.actor.get_size();
            items.push({textBox: {x: this._text.x, y: this._text.y, w: Math.max(w, 8), h: Math.max(h, this.fontSize)}});
        }
        return items;
    }

    _updateActive() {
        const items = this._activeItems();
        if (!items.length) {
            this._active.hide();
            return;
        }
        // Caixa que envolve tudo, com margem, recortada à região.
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const it of items) {
            const b = it.textBox ?? shapeBounds(it.shape);
            x1 = Math.min(x1, b.x);
            y1 = Math.min(y1, b.y);
            x2 = Math.max(x2, b.x + b.w);
            y2 = Math.max(y2, b.y + b.h);
        }
        const pad = 8;
        const r = this._region;
        x1 = Math.max(r.x, Math.floor(x1 - pad));
        y1 = Math.max(r.y, Math.floor(y1 - pad));
        x2 = Math.min(r.x + r.w, Math.ceil(x2 + pad));
        y2 = Math.min(r.y + r.h, Math.ceil(y2 + pad));
        if (x2 <= x1 || y2 <= y1) {
            this._active.hide();
            return;
        }
        this._activeBox = {x: x1, y: y1, w: x2 - x1, h: y2 - y1};
        this._activeItemsCache = items;
        this._active.set_position(x1 - r.x, y1 - r.y);
        this._active.set_size(x2 - x1, y2 - y1);
        this._active.show();
        this._active.queue_repaint();
    }

    _paintActive(area) {
        const cr = area.get_context();
        try {
            cr.translate(-this._activeBox.x, -this._activeBox.y);
            const env = this._env(true);
            for (const it of this._activeItemsCache ?? []) {
                if (it.textBox) {
                    const b = it.textBox;
                    const [r, g, bl] = hexToRgb(this._accent);
                    cr.setSourceRGBA(r, g, bl, 0.9);
                    cr.setLineWidth(1);
                    cr.setDash([4, 3], 0);
                    cr.rectangle(b.x - 4, b.y - 3, b.w + 8, b.h + 6);
                    cr.stroke();
                    cr.setDash([], 0);
                    continue;
                }
                if (!it.only)
                    renderShape(cr, it.shape, env);
                if (it.box)
                    renderSelectionBox(cr, it.shape, this._accent);
            }
        } catch (e) {
            logError(e, '[OneShot] falha ao desenhar (camada ativa)');
        } finally {
            cr.$dispose();
        }
    }

    destroy() {
        this._text = null;
        this._image = null;
        super.destroy();
    }
});

/** Shift: linhas a cada 45°, retângulos/elipses quadrados. */
function constrain(type, a, b, mods) {
    if (!(mods & Clutter.ModifierType.SHIFT_MASK))
        return b;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (type === 'line' || type === 'arrow') {
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
    }
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    return [a[0] + Math.sign(dx || 1) * m, a[1] + Math.sign(dy || 1) * m];
}

/** Descarta cliques acidentais (formas minúsculas). */
function isMeaningful(s) {
    if (!s)
        return false;
    if (FREEHAND.has(s.type))
        return true;
    const [a, b] = s.p;
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    if (s.type === 'line' || s.type === 'arrow')
        return Math.hypot(dx, dy) >= 4;
    return dx >= 3 && dy >= 3;
}
