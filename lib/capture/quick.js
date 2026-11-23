// Capturas diretas, sem overlay (tela inteira e monitor).
// Usa Shell.Screenshot, que funciona em Wayland sem portal.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area', 'screenshot_area_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async', 'new_from_stream_finish');

/**
 * Lê um MemoryOutputStream com PNG e devolve o Pixbuf.
 *
 * @param {Gio.MemoryOutputStream} stream
 * @returns {Promise<GdkPixbuf.Pixbuf>}
 */
async function streamToPixbuf(stream) {
    stream.close(null);
    const bytes = stream.steal_as_bytes();
    const input = Gio.MemoryInputStream.new_from_bytes(bytes);
    return GdkPixbuf.Pixbuf.new_from_stream_async(input, null);
}

/**
 * Captura todos os monitores.
 *
 * @param {boolean} includeCursor
 * @returns {Promise<GdkPixbuf.Pixbuf>}
 */
export async function captureFullscreen(includeCursor) {
    const shooter = new Shell.Screenshot();
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot(includeCursor, stream);
    return streamToPixbuf(stream);
}

/**
 * Captura uma área em coordenadas lógicas do palco.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {Promise<GdkPixbuf.Pixbuf>}
 */
export async function captureArea(x, y, w, h) {
    const shooter = new Shell.Screenshot();
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot_area(x, y, w, h, stream);
    return streamToPixbuf(stream);
}
