// Codificação WebP com qualidade ajustável via GStreamer (webpenc).
// Motivo: no Fedora atual o GdkPixbuf delega ao glycin, que grava WebP
// sempre sem perdas e ignora a opção "quality".
// O GStreamer roda em threads próprias, então não trava o Shell.

import GLib from 'gi://GLib';

import {getGst} from '../gst.js';

let Gst = null;

/**
 * Carrega o GStreamer só quando necessário (nada é feito ao importar o módulo).
 *
 * @returns {Promise<boolean>} se o codificador WebP com perdas está disponível
 */
export async function webpEncoderAvailable() {
    if (!Gst) {
        try {
            Gst = await getGst();
        } catch {
            return false;
        }
    }
    return ['webpenc', 'appsrc', 'appsink', 'videoconvert']
        .every(name => !!Gst.ElementFactory.find(name));
}

/**
 * Codifica um Pixbuf em WebP.
 *
 * @param {import('gi://GdkPixbuf').default.Pixbuf} pixbuf
 * @param {number} quality - 1 a 100 (100 = sem perdas)
 * @returns {Promise<GLib.Bytes>}
 */
export async function encodeWebp(pixbuf, quality) {
    if (!await webpEncoderAvailable())
        throw new Error('GStreamer webpenc indisponível');

    // RGBA garante stride = largura * 4, sem preenchimento entre linhas.
    const rgba = pixbuf.hasAlpha ? pixbuf : pixbuf.add_alpha(false, 0, 0, 0);
    const {width, height} = rgba;
    const lossless = quality >= 100;

    const pipeline = Gst.parse_launch(
        `appsrc name=src format=time caps=video/x-raw,format=RGBA,width=${width},height=${height},framerate=0/1 ` +
        `! videoconvert ! webpenc lossless=${lossless} quality=${Math.max(1, Math.min(100, quality))} speed=3 ` +
        '! appsink name=sink sync=false wait-on-eos=false');
    const src = pipeline.get_by_name('src');
    const sink = pipeline.get_by_name('sink');

    return new Promise((resolve, reject) => {
        const bus = pipeline.get_bus();
        bus.add_signal_watch();
        let done = false;
        const finish = (err, bytes) => {
            if (done)
                return;
            done = true;
            bus.disconnect(busId);
            bus.remove_signal_watch();
            pipeline.set_state(Gst.State.NULL);
            if (err)
                reject(err);
            else
                resolve(bytes);
        };
        const busId = bus.connect('message', (_b, msg) => {
            if (msg.type === Gst.MessageType.EOS) {
                const sample = sink.emit('pull-sample');
                const buffer = sample?.get_buffer();
                if (!buffer) {
                    finish(new Error('WebP: nenhum dado gerado'));
                    return;
                }
                finish(null, new GLib.Bytes(buffer.extract_dup(0, buffer.get_size())));
            } else if (msg.type === Gst.MessageType.ERROR) {
                const [error] = msg.parse_error();
                finish(error);
            }
        });

        pipeline.set_state(Gst.State.PLAYING);
        const buf = Gst.Buffer.new_wrapped_bytes(rgba.read_pixel_bytes());
        buf.pts = 0;
        buf.duration = Gst.SECOND;
        src.emit('push-buffer', buf);
        src.emit('end-of-stream');
    });
}
