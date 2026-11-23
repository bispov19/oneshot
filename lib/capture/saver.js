// Salva a imagem final no formato/qualidade configurados, copia para a área
// de transferência, toca o som e mostra a notificação.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    IMAGE_EXT, PIXBUF_TYPE, ensureDir, formatFilename, resolveDir, uniqueFile,
} from '../config.js';
import {copyImage} from '../notify.js';
import {encodeWebp} from './webp.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

/** Toca o som padrão de captura do GNOME. */
export function playCaptureSound() {
    try {
        global.display.get_sound_player().play_from_file(
            Gio.File.new_for_path(`${global.datadir}/sounds/screen-capture.oga`),
            'Captura de tela', null);
    } catch (e) {
        logError(e, '[OneShot] falha ao tocar som');
    }
}

/**
 * Codifica um Pixbuf em bytes no formato pedido.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf
 * @param {'png'|'jpg'|'webp'} format
 * @param {number} quality - 1 a 100
 * @returns {GLib.Bytes}
 */
export function encodePixbuf(pixbuf, format, quality) {
    const type = PIXBUF_TYPE[format] ?? 'png';
    let keys = [], values = [];
    if (type === 'jpeg' || type === 'webp') {
        keys = ['quality'];
        values = [String(quality)];
    } else {
        // Compressão PNG moderada: arquivo menor sem custo alto de CPU.
        keys = ['compression'];
        values = ['6'];
    }
    // JPG não tem canal alfa.
    let src = pixbuf;
    if (type === 'jpeg' && pixbuf.hasAlpha) {
        src = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, pixbuf.width, pixbuf.height);
        pixbuf.composite_color(src, 0, 0, pixbuf.width, pixbuf.height, 0, 0, 1, 1,
            GdkPixbuf.InterpType.NEAREST, 255, 0, 0, 16, 0xffffff, 0xffffff);
    }
    const [ok, buffer] = src.save_to_bufferv(type, keys, values);
    if (!ok)
        throw new Error(`Falha ao codificar ${type}`);
    return new GLib.Bytes(buffer);
}

/**
 * Versão assíncrona: usa o GStreamer para WebP com perdas (o GdkPixbuf
 * do sistema só gera WebP sem perdas) e cai no GdkPixbuf se falhar.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf
 * @param {'png'|'jpg'|'webp'} format
 * @param {number} quality
 * @returns {Promise<GLib.Bytes>}
 */
export async function encodeImage(pixbuf, format, quality) {
    if (format === 'webp') {
        try {
            return await encodeWebp(pixbuf, quality);
        } catch (e) {
            console.warn(`[OneShot] WebP via GStreamer falhou, usando GdkPixbuf: ${e.message}`);
        }
    }
    return encodePixbuf(pixbuf, format, quality);
}

/**
 * Salva um Pixbuf seguindo as configurações do usuário.
 *
 * @param {Gio.Settings} settings
 * @param {GdkPixbuf.Pixbuf} pixbuf
 * @param {object} [opts]
 * @param {string} [opts.mode] - marcador {mode} do nome do arquivo
 * @param {Gio.File} [opts.file] - destino explícito ("Salvar como")
 * @param {boolean} [opts.copy] - força copiar/não copiar
 * @returns {Promise<{file: Gio.File, getPngBytes: () => GLib.Bytes, copied: boolean}>}
 */
export async function savePixbuf(settings, pixbuf, opts = {}) {
    let format = settings.get_string('image-format');
    let file = opts.file ?? null;

    // Se o usuário escolheu a extensão no "Salvar como", respeitamos.
    if (file) {
        const ext = file.get_basename().split('.').pop().toLowerCase();
        if (ext === 'jpeg' || ext === 'jpg')
            format = 'jpg';
        else if (ext === 'webp' || ext === 'png')
            format = ext;
    } else {
        const dir = resolveDir(settings, 'image');
        ensureDir(dir);
        const base = formatFilename(settings.get_string('filename-pattern'), opts.mode ?? 'captura');
        file = uniqueFile(dir, base, IMAGE_EXT[format] ?? 'png');
    }

    const quality = settings.get_int('image-quality');
    const bytes = await encodeImage(pixbuf, format, quality);
    await file.replace_contents_bytes_async(bytes, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    // A área de transferência sempre recebe PNG (compatível com todos os apps).
    // Gerado só quando necessário, para não gastar CPU à toa.
    let png = format === 'png' ? bytes : null;
    const getPngBytes = () => {
        png ??= encodePixbuf(pixbuf, 'png', 100);
        return png;
    };

    const copy = opts.copy ?? settings.get_boolean('auto-copy');
    if (copy)
        copyImage(getPngBytes());

    return {file, getPngBytes, copied: copy};
}
