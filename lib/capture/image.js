// Imagem congelada da tela, usada pelo overlay e pelo editor.
//
// 1) screenshot_stage_to_content(): textura na GPU, instantânea — é o que
//    o usuário vê no overlay (e a lupa amplia).
// 2) composite_to_stream(): gera, em uma thread, o PNG da tela inteira e um
//    Pixbuf — usado para a cor do pixel e para a exportação.
// 3) Surface Cairo: carregada só quando necessária (pixelar/desfocar/exportar).

import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {renderShape} from '../editor/shapes.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

/** Pasta temporária em memória (tmpfs) para arquivos intermediários. */
export function runtimeDir() {
    const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'oneshot']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

let _counter = 0;
export function tempPath(ext) {
    return GLib.build_filenamev([runtimeDir(), `tmp-${GLib.get_monotonic_time()}-${_counter++}.${ext}`]);
}

export class FrozenImage {
    /** Captura o palco inteiro. */
    static async grab() {
        const shooter = new Shell.Screenshot();
        const [content, scale, cursorContent, cursorPoint, cursorScale] =
            await shooter.screenshot_stage_to_content();
        return new FrozenImage({content, scale, cursorContent, cursorPoint, cursorScale});
    }

    constructor({content, scale, cursorContent, cursorPoint, cursorScale}) {
        this.content = content;
        this.scale = scale;
        this._cursor = {content: cursorContent, point: cursorPoint, scale: cursorScale};
        this.pixbuf = null;
        this.surface = null;
        this._pngPath = null;
        this._ready = null;
    }

    /**
     * Inicia a composição em segundo plano (thread do Shell).
     *
     * @param {boolean} includeCursor
     * @returns {Promise<void>}
     */
    prepare(includeCursor) {
        this._ready ??= (async () => {
            const stream = Gio.MemoryOutputStream.new_resizable();
            const texture = this.content.get_texture();
            const cur = includeCursor && this._cursor.content ? this._cursor : null;
            const pixbuf = await Shell.Screenshot.composite_to_stream(
                texture, 0, 0, -1, -1, this.scale,
                cur?.content.get_texture() ?? null,
                cur ? cur.point.x * this.scale : 0,
                cur ? cur.point.y * this.scale : 0,
                cur?.scale ?? 1,
                stream);
            stream.close(null);
            if (!this.content) // destruída enquanto compunha
                return;
            this.pixbuf = pixbuf;
            this._pngPath = tempPath('png');
            GLib.file_set_contents(this._pngPath, stream.steal_as_bytes().toArray());
        })();
        return this._ready;
    }

    get isReady() {
        return !!this.pixbuf;
    }

    /** Carrega a surface Cairo (síncrono; chamar só depois de prepare()). */
    loadSurface() {
        if (!this.surface && this._pngPath)
            this.surface = Cairo.ImageSurface.createFromPNG(this._pngPath);
        return this.surface;
    }

    /**
     * Cor do pixel em coordenadas lógicas do palco.
     *
     * @returns {string|null} "#rrggbb"
     */
    pickColor(x, y) {
        const p = this.pixbuf;
        if (!p)
            return null;
        const px = Math.max(0, Math.min(p.width - 1, Math.floor(x * this.scale)));
        const py = Math.max(0, Math.min(p.height - 1, Math.floor(y * this.scale)));
        const data = p.new_subpixbuf(px, py, 1, 1).get_pixels();
        const h = v => v.toString(16).padStart(2, '0');
        return `#${h(data[0])}${h(data[1])}${h(data[2])}`;
    }

    /**
     * Gera a imagem final: recorte da seleção + anotações.
     *
     * @param {{x: number, y: number, w: number, h: number}} sel - lógico
     * @param {Array} shapes
     * @returns {Promise<GdkPixbuf.Pixbuf>}
     */
    async render(sel, shapes) {
        await this.prepare(false);
        const S = this.scale;
        const p = this.pixbuf;
        const px = Math.max(0, Math.round(sel.x * S));
        const py = Math.max(0, Math.round(sel.y * S));
        const pw = Math.max(1, Math.min(p.width - px, Math.round(sel.w * S)));
        const ph = Math.max(1, Math.min(p.height - py, Math.round(sel.h * S)));

        // Sem anotações: recorte direto do Pixbuf, sem passar pelo Cairo.
        if (!shapes.length)
            return p.new_subpixbuf(px, py, pw, ph).copy();

        const src = this.loadSurface();
        const out = new Cairo.ImageSurface(Cairo.Format.ARGB32, pw, ph);
        const cr = new Cairo.Context(out);
        cr.setSourceSurface(src, -px, -py);
        cr.paint();
        cr.translate(-px, -py);
        cr.scale(S, S);
        const env = {source: src, scale: S};
        for (const s of shapes)
            renderShape(cr, s, env);
        cr.$dispose();

        const path = tempPath('png');
        try {
            out.writeToPNG(path);
            return GdkPixbuf.Pixbuf.new_from_file(path);
        } finally {
            GLib.unlink(path);
        }
    }

    destroy() {
        if (this._pngPath)
            GLib.unlink(this._pngPath);
        this._pngPath = null;
        this.surface = null;
        this.pixbuf = null;
        this.content = null;
        this._cursor = null;
    }
}
