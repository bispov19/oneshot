// Modelo e renderização das formas de anotação.
//
// Cada forma é um objeto simples (serializável), sempre em coordenadas
// lógicas do palco (stage). O mesmo código desenha na tela (St.DrawingArea)
// e na imagem final exportada (Cairo.ImageSurface), garantindo que o
// resultado salvo seja idêntico ao que o usuário vê.
//
// Formato:
//   {type, color: '#rrggbb', width, p: [[x, y], ...], ...extras}
//   - pencil/marker: p = todos os pontos do traço
//   - line/arrow/rect/rectfill/ellipse/pixelate/blur: p = [início, fim]
//   - text: p = [canto superior esquerdo], text, fontSize, font
//   - counter: p = [centro], n, fontSize

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

/** Copia profunda de uma forma (são dados puros). */
export function cloneShape(s) {
    return JSON.parse(JSON.stringify(s));
}

/** Converte "#rrggbb" em [r, g, b] de 0 a 1. */
export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    const v = m ? parseInt(m[1], 16) : 0xff0000;
    return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

/** Retorna branco ou preto, o que tiver mais contraste com a cor dada. */
export function contrastColor(hex) {
    const [r, g, b] = hexToRgb(hex);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 0.6 ? [0.07, 0.09, 0.15] : [1, 1, 1];
}

/** Retângulo normalizado a partir de dois pontos. */
export function normRect(a, b) {
    const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
    return {x, y, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1])};
}

/** Descrição de fonte com tamanho absoluto em pixels. */
export function fontDescription(font, size) {
    const desc = Pango.FontDescription.from_string(font || 'Sans');
    desc.set_absolute_size(Math.max(6, size) * Pango.SCALE);
    return desc;
}

function counterRadius(s) {
    return Math.max(10, (s.fontSize ?? 20) * 0.78);
}

/** Tamanho do texto, calculado com um contexto Cairo descartável. */
let _measureSurface = null;
function measureText(s) {
    _measureSurface ??= new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
    const cr = new Cairo.Context(_measureSurface);
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(fontDescription(s.font, s.fontSize));
    layout.set_text(s.text || ' ', -1);
    const [w, h] = layout.get_pixel_size();
    cr.$dispose();
    return [w, h];
}

/**
 * Caixa delimitadora da forma (já incluindo a espessura).
 *
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function shapeBounds(s) {
    const pad = (s.type === 'marker' ? s.width * 3 : s.width) / 2 + 2;
    switch (s.type) {
    case 'text': {
        const [w, h] = measureText(s);
        return {x: s.p[0][0] - 2, y: s.p[0][1] - 2, w: w + 4, h: h + 4};
    }
    case 'counter': {
        const r = counterRadius(s) + 2;
        return {x: s.p[0][0] - r, y: s.p[0][1] - r, w: 2 * r, h: 2 * r};
    }
    case 'arrow': {
        const r = normRect(s.p[0], s.p[1]);
        const head = arrowHead(s);
        return {x: r.x - head, y: r.y - head, w: r.w + 2 * head, h: r.h + 2 * head};
    }
    default: {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const [x, y] of s.p) {
            x1 = Math.min(x1, x);
            y1 = Math.min(y1, y);
            x2 = Math.max(x2, x);
            y2 = Math.max(y2, y);
        }
        return {x: x1 - pad, y: y1 - pad, w: x2 - x1 + 2 * pad, h: y2 - y1 + 2 * pad};
    }
    }
}

function arrowHead(s) {
    return Math.max(10, s.width * 3.5);
}

/** Distância de um ponto a um segmento. */
function distToSegment(px, py, [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Verifica se o ponto (x, y) "acerta" a forma.
 *
 * @returns {boolean}
 */
export function hitTest(s, x, y) {
    const tol = Math.max(6, s.width / 2 + 4);
    switch (s.type) {
    case 'pencil':
    case 'marker':
    case 'line':
    case 'arrow': {
        const extra = s.type === 'marker' ? s.width * 1.5 : 0;
        if (s.p.length === 1)
            return Math.hypot(x - s.p[0][0], y - s.p[0][1]) <= tol + extra;
        for (let i = 1; i < s.p.length; i++) {
            if (distToSegment(x, y, s.p[i - 1], s.p[i]) <= tol + extra)
                return true;
        }
        return false;
    }
    case 'rect':
    case 'ellipse': {
        // Contornos: acerta perto da borda.
        const r = normRect(s.p[0], s.p[1]);
        if (s.type === 'ellipse') {
            const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
            const rx = Math.max(1, r.w / 2), ry = Math.max(1, r.h / 2);
            const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
            return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
        }
        const inside = x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol;
        const deep = x > r.x + tol && x < r.x + r.w - tol && y > r.y + tol && y < r.y + r.h - tol;
        return inside && !deep;
    }
    default: {
        const b = shapeBounds(s);
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    }
    }
}

/** Desloca a forma (modifica o objeto). */
export function translateShape(s, dx, dy) {
    for (const pt of s.p) {
        pt[0] += dx;
        pt[1] += dy;
    }
}

/* ------------------------------- Renderização ------------------------------- */

/**
 * Desenha uma forma.
 *
 * @param {Cairo.Context} cr - já transformado para coordenadas lógicas do palco
 * @param {object} s - forma
 * @param {object} env
 * @param {Cairo.ImageSurface|null} env.source - imagem congelada da tela (pixels físicos)
 * @param {number} env.scale - pixels físicos por unidade lógica
 * @param {boolean} [env.preview] - desenho provisório (pixelar/desfocar viram contorno)
 */
export function renderShape(cr, s, env) {
    const [r, g, b] = hexToRgb(s.color);
    cr.save();
    // O caminho NÃO faz parte do estado salvo por save()/restore():
    // limpa para que restos da forma anterior não sejam preenchidos.
    cr.newPath();
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineWidth(s.width);
    cr.setSourceRGBA(r, g, b, 1);

    switch (s.type) {
    case 'pencil':
        tracePath(cr, s.p);
        cr.stroke();
        break;

    case 'marker':
        // Marca-texto: traço largo e translúcido, um único caminho
        // (evita escurecer onde o traço se sobrepõe).
        cr.setLineCap(Cairo.LineCap.SQUARE);
        cr.setLineWidth(s.width * 3 + 6);
        cr.setSourceRGBA(r, g, b, 0.38);
        tracePath(cr, s.p);
        cr.stroke();
        break;

    case 'line':
        cr.moveTo(...s.p[0]);
        cr.lineTo(...s.p[1]);
        cr.stroke();
        break;

    case 'arrow':
        drawArrow(cr, s);
        break;

    case 'rect': {
        const rc = normRect(s.p[0], s.p[1]);
        roundedRect(cr, rc.x, rc.y, rc.w, rc.h, Math.min(4, s.width));
        cr.stroke();
        break;
    }

    case 'rectfill': {
        const rc = normRect(s.p[0], s.p[1]);
        roundedRect(cr, rc.x, rc.y, rc.w, rc.h, 3);
        cr.fill();
        break;
    }

    case 'ellipse': {
        const rc = normRect(s.p[0], s.p[1]);
        if (rc.w >= 1 && rc.h >= 1) {
            cr.save();
            cr.translate(rc.x + rc.w / 2, rc.y + rc.h / 2);
            cr.scale(rc.w / 2, rc.h / 2);
            cr.arc(0, 0, 1, 0, 2 * Math.PI);
            cr.restore();
            cr.stroke();
        }
        break;
    }

    case 'pixelate':
    case 'blur':
        drawObscure(cr, s, env);
        break;

    case 'text': {
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(fontDescription(s.font, s.fontSize));
        layout.set_text(s.text, -1);
        // Contorno sutil para legibilidade sobre qualquer fundo.
        const [cr2, cg2, cb2] = contrastColor(s.color);
        cr.moveTo(...s.p[0]);
        PangoCairo.layout_path(cr, layout);
        cr.setSourceRGBA(cr2, cg2, cb2, 0.55);
        cr.setLineWidth(Math.max(2, s.fontSize / 8));
        cr.stroke();
        cr.moveTo(...s.p[0]);
        cr.setSourceRGBA(r, g, b, 1);
        PangoCairo.show_layout(cr, layout);
        cr.newPath();
        break;
    }

    case 'counter': {
        const rad = counterRadius(s);
        const [cx, cy] = s.p[0];
        cr.arc(cx, cy, rad, 0, 2 * Math.PI);
        cr.fill();
        cr.arc(cx, cy, rad, 0, 2 * Math.PI);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.setLineWidth(Math.max(1.5, rad / 9));
        cr.stroke();
        const layout = PangoCairo.create_layout(cr);
        const desc = fontDescription('Sans Bold', rad * 1.15);
        layout.set_font_description(desc);
        layout.set_text(String(s.n), -1);
        const [tw, th] = layout.get_pixel_size();
        cr.setSourceRGBA(...contrastColor(s.color), 1);
        cr.moveTo(cx - tw / 2, cy - th / 2);
        PangoCairo.show_layout(cr, layout);
        cr.newPath();
        break;
    }
    }
    cr.restore();
    cr.newPath();
}

function tracePath(cr, pts) {
    if (!pts.length)
        return;
    cr.moveTo(...pts[0]);
    if (pts.length === 1) {
        cr.lineTo(pts[0][0] + 0.01, pts[0][1]);
        return;
    }
    // Suaviza com curvas quadráticas entre os pontos médios.
    for (let i = 1; i < pts.length - 1; i++) {
        const [x1, y1] = pts[i];
        const mx = (x1 + pts[i + 1][0]) / 2, my = (y1 + pts[i + 1][1]) / 2;
        const [x0, y0] = cr.getCurrentPoint();
        cr.curveTo(x0 + 2 / 3 * (x1 - x0), y0 + 2 / 3 * (y1 - y0),
            mx + 2 / 3 * (x1 - mx), my + 2 / 3 * (y1 - my), mx, my);
    }
    cr.lineTo(...pts[pts.length - 1]);
}

function drawArrow(cr, s) {
    const [x1, y1] = s.p[0];
    const [x2, y2] = s.p[1];
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const head = Math.min(arrowHead(s), len * 0.6 + s.width);
    const spread = Math.PI / 7;
    // Haste termina antes da ponta para não "vazar" na ponta.
    const bx = x2 - Math.cos(ang) * head * 0.7;
    const by = y2 - Math.sin(ang) * head * 0.7;
    cr.moveTo(x1, y1);
    cr.lineTo(bx, by);
    cr.stroke();
    cr.moveTo(x2, y2);
    cr.lineTo(x2 - head * Math.cos(ang - spread), y2 - head * Math.sin(ang - spread));
    cr.lineTo(x2 - head * Math.cos(ang + spread), y2 - head * Math.sin(ang + spread));
    cr.closePath();
    cr.setLineWidth(Math.max(1, s.width / 2));
    cr.fillPreserve();
    cr.stroke();
}

function roundedRect(cr, x, y, w, h, rad) {
    rad = Math.min(rad, w / 2, h / 2);
    if (rad <= 0) {
        cr.rectangle(x, y, w, h);
        return;
    }
    cr.newSubPath();
    cr.arc(x + w - rad, y + rad, rad, -Math.PI / 2, 0);
    cr.arc(x + w - rad, y + h - rad, rad, 0, Math.PI / 2);
    cr.arc(x + rad, y + h - rad, rad, Math.PI / 2, Math.PI);
    cr.arc(x + rad, y + rad, rad, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * Pixelar/desfocar: reduz a área da imagem original e amplia de volta.
 * Pixelar amplia com filtro "nearest" (blocos); desfocar com bilinear,
 * em duas passadas, o que é barato e suave o bastante.
 */
function drawObscure(cr, s, env) {
    const rc = normRect(s.p[0], s.p[1]);
    if (rc.w < 2 || rc.h < 2)
        return;

    if (!env.source || env.preview) {
        cr.setDash([6, 4], 0);
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(1, 1, 1, 0.9);
        cr.rectangle(rc.x, rc.y, rc.w, rc.h);
        cr.stroke();
        if (!env.source)
            return;
    }

    const S = env.scale;
    const pw = rc.w * S, ph = rc.h * S;
    const pixelate = s.type === 'pixelate';
    // Tamanho do bloco/intensidade cresce com a espessura escolhida.
    const factor = pixelate ? Math.max(4, s.width * 2.5) * S : Math.max(12, s.width * 5) * S;
    const sw = Math.max(1, Math.round(pw / factor));
    const sh = Math.max(1, Math.round(ph / factor));

    const small = new Cairo.ImageSurface(Cairo.Format.ARGB32, sw, sh);
    const sc = new Cairo.Context(small);
    sc.scale(sw / pw, sh / ph);
    sc.setSourceSurface(env.source, -rc.x * S, -rc.y * S);
    sc.getSource().setFilter(Cairo.Filter.GOOD);
    sc.paint();
    sc.$dispose();

    let src = small, srcW = sw, srcH = sh;
    if (!pixelate) {
        // Segunda passada: amplia um pouco e reduz de novo, suavizando.
        const mw = Math.min(Math.round(pw), sw * 4), mh = Math.min(Math.round(ph), sh * 4);
        const mid = new Cairo.ImageSurface(Cairo.Format.ARGB32, mw, mh);
        const mc = new Cairo.Context(mid);
        mc.scale(mw / sw, mh / sh);
        mc.setSourceSurface(small, 0, 0);
        mc.getSource().setFilter(Cairo.Filter.BILINEAR);
        mc.paint();
        mc.$dispose();
        src = mid;
        srcW = mw;
        srcH = mh;
    }

    cr.save();
    cr.rectangle(rc.x, rc.y, rc.w, rc.h);
    cr.clip();
    cr.translate(rc.x, rc.y);
    cr.scale(rc.w / srcW, rc.h / srcH);
    cr.setSourceSurface(src, 0, 0);
    const pat = cr.getSource();
    pat.setFilter(pixelate ? Cairo.Filter.NEAREST : Cairo.Filter.BILINEAR);
    pat.setExtend(Cairo.Extend.PAD);
    cr.paint();
    cr.restore();
}

/** Contorno tracejado de seleção (ferramenta Selecionar/Mover). */
export function renderSelectionBox(cr, s, accent) {
    const b = shapeBounds(s);
    const [r, g, bl] = hexToRgb(accent);
    cr.save();
    cr.setLineWidth(1.5);
    cr.setDash([5, 4], 0);
    cr.setSourceRGBA(r, g, bl, 1);
    cr.rectangle(b.x - 3, b.y - 3, b.w + 6, b.h + 6);
    cr.stroke();
    cr.restore();
}
