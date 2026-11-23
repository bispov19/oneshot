// Gravação de tela usando o serviço do GNOME Shell (org.gnome.Shell.Screencast).
//
// Pausa: o serviço não sabe pausar, então cada trecho vira um segmento
// separado; ao parar, os segmentos são concatenados SEM recodificar
// (GStreamer: matroskademux -> concat -> webmmux). O áudio (opcional) é
// gravado à parte e mesclado nesse mesmo passo.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {ensureDir, formatFilename, resolveDir, uniqueFile} from '../config.js';
import {AudioRecorder} from './audio.js';
import {getGst} from '../gst.js';

const ScreencastIface = loadInterfaceXML('org.gnome.Shell.Screencast');
const ScreencastProxy = Gio.DBusProxy.makeProxyWrapper(ScreencastIface);

/** max-quantizer do vp8enc por nível de qualidade (menor = melhor). */
const QUANTIZER = {low: 40, medium: 24, high: 14, lossless: 4};

/** Pipeline de codificação entregue ao serviço (sufixo após a captura). */
function encoderPipeline(settings) {
    const q = QUANTIZER[settings.get_string('video-quality')] ?? 24;
    const fps = settings.get_int('video-fps');
    const minQ = q <= 4 ? 'min-quantizer=0 ' : '';
    return 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=%T ! queue ! ' +
        `vp8enc cpu-used=16 ${minQ}max-quantizer=${q} deadline=1 keyframe-mode=auto ` +
        `keyframe-max-dist=${fps * 5} threads=%T static-threshold=1000 buffer-size=20000 ! ` +
        'queue ! webmmux';
}

export const RecState = {IDLE: 'idle', STARTING: 'starting', RECORDING: 'recording', PAUSED: 'paused', SAVING: 'saving'};

export class Recorder {
    /**
     * @param {object} p
     * @param {Gio.Settings} p.settings
     * @param {Function} p.onStateChanged - (state) => void
     * @param {Function} p.onError - (message) => void
     * @param {Function} p.onSaved - (Gio.File) => void
     */
    constructor({settings, onStateChanged, onError, onSaved}) {
        this._settings = settings;
        this._onStateChanged = onStateChanged;
        this._onError = onError;
        this._onSaved = onSaved;
        this.state = RecState.IDLE;
        this.rect = null;
        this._segments = [];
        this._elapsedBefore = 0; // µs gravados antes do trecho atual
        this._segmentStart = 0;
        this._proxy = null;
        this._audio = null;
    }

    get active() {
        return this.state !== RecState.IDLE;
    }

    /** Tempo gravado (segundos), sem contar pausas. */
    get elapsed() {
        let us = this._elapsedBefore;
        if (this.state === RecState.RECORDING)
            us += GLib.get_monotonic_time() - this._segmentStart;
        return Math.floor(us / 1e6);
    }

    _setState(state) {
        this.state = state;
        this._onStateChanged?.(state);
    }

    async _getProxy() {
        if (this._proxy)
            return this._proxy;
        this._proxy = await new Promise((resolve, reject) => {
            const proxy = new ScreencastProxy(Gio.DBus.session,
                'org.gnome.Shell.Screencast', '/org/gnome/Shell/Screencast',
                (p, error) => (error ? reject(error) : resolve(p)));
            return proxy;
        });
        this._errorId = this._proxy.connectSignal('Error', (_p, _s, [name, message]) => {
            console.warn(`[OneShot] erro do screencast: ${name}: ${message}`);
            this._fail(`Erro na gravação: ${message}`);
        });
        return this._proxy;
    }

    /**
     * Inicia a gravação.
     *
     * @param {{x: number, y: number, w: number, h: number}|null} rect - null = tela inteira
     */
    async start(rect) {
        if (this.active)
            return;
        this.rect = rect;
        this._setState(RecState.STARTING);
        this._tmpDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'oneshot',
            `rec-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`]);
        ensureDir(this._tmpDir);
        this._segments = [];
        this._elapsedBefore = 0;
        try {
            await this._startSegment();
            const mic = this._settings.get_boolean('record-audio-mic');
            const sys = this._settings.get_boolean('record-audio-system');
            if (mic || sys) {
                this._audio = new AudioRecorder({
                    path: GLib.build_filenamev([this._tmpDir, 'audio.ogg']), mic, system: sys,
                });
                try {
                    await this._audio.start();
                } catch (e) {
                    console.warn(`[OneShot] áudio indisponível: ${e.message}`);
                    this._audio = null;
                    this._onError?.(`Gravando sem áudio: ${e.message}`, true);
                }
            }
            this._setState(RecState.RECORDING);
        } catch (e) {
            this._fail(`Não foi possível iniciar a gravação: ${e.message}`);
        }
    }

    async _startSegment() {
        const proxy = await this._getProxy();
        const n = this._segments.length;
        const template = GLib.build_filenamev([this._tmpDir, `seg${n}`]);
        const options = {
            'draw-cursor': new GLib.Variant('b', this._settings.get_boolean('record-cursor')),
            'framerate': new GLib.Variant('i', this._settings.get_int('video-fps')),
            'pipeline': new GLib.Variant('s', encoderPipeline(this._settings)),
        };
        let success, filename;
        if (this.rect) {
            const {x, y, w, h} = this.rect;
            // Dimensões pares evitam problemas em alguns codificadores/players.
            [success, filename] = await proxy.ScreencastAreaAsync(
                Math.round(x), Math.round(y), Math.max(2, Math.round(w) & ~1), Math.max(2, Math.round(h) & ~1),
                template, options);
        } else {
            [success, filename] = await proxy.ScreencastAsync(template, options);
        }
        if (!success)
            throw new Error('o serviço de screencast recusou o pedido');
        this._segments.push(filename);
        this._segmentStart = GLib.get_monotonic_time();
    }

    async _stopSegment() {
        this._elapsedBefore += GLib.get_monotonic_time() - this._segmentStart;
        const proxy = await this._getProxy();
        await proxy.StopScreencastAsync();
    }

    async togglePause() {
        if (this.state === RecState.RECORDING) {
            this._setState(RecState.PAUSED);
            try {
                await this._stopSegment();
                this._audio?.pause();
            } catch (e) {
                this._fail(`Falha ao pausar: ${e.message}`);
            }
        } else if (this.state === RecState.PAUSED) {
            try {
                await this._startSegment();
                this._audio?.resume();
                this._setState(RecState.RECORDING);
            } catch (e) {
                this._fail(`Falha ao retomar: ${e.message}`);
            }
        }
    }

    /** Para e salva. */
    async stop() {
        if (this.state !== RecState.RECORDING && this.state !== RecState.PAUSED)
            return;
        const wasRecording = this.state === RecState.RECORDING;
        this._setState(RecState.SAVING);
        try {
            if (wasRecording)
                await this._stopSegment();
            const audioPath = this._audio ? await this._audio.stop() : null;
            this._audio = null;
            const file = await this._finalize(audioPath);
            this._cleanupTmp();
            this._setState(RecState.IDLE);
            this._onSaved?.(file);
        } catch (e) {
            logError(e, '[OneShot] falha ao salvar a gravação');
            this._onError?.(`Falha ao salvar a gravação: ${e.message}. Os trechos ficaram em ${this._tmpDir}`);
            this._setState(RecState.IDLE);
        }
    }

    /** Junta segmentos e áudio no arquivo final. */
    async _finalize(audioPath) {
        const dir = resolveDir(this._settings, 'video');
        ensureDir(dir);
        const base = formatFilename(this._settings.get_string('filename-pattern'), 'gravacao');
        const out = uniqueFile(dir, base, 'webm');
        const segs = this._segments.filter(p => GLib.file_test(p, GLib.FileTest.EXISTS));
        if (!segs.length)
            throw new Error('nenhum trecho gravado');

        if (segs.length === 1 && !audioPath) {
            Gio.File.new_for_path(segs[0]).move(out, Gio.FileCopyFlags.NONE, null, null);
            return out;
        }

        const q = s => `"${s.replace(/(["\\])/g, '\\$1')}"`;
        let desc = `webmmux name=mux ! filesink location=${q(out.get_path())} `;
        if (segs.length === 1) {
            desc += `filesrc location=${q(segs[0])} ! matroskademux ! queue ! mux. `;
        } else {
            desc += 'concat name=c ! queue ! mux. ';
            for (const s of segs)
                desc += `filesrc location=${q(s)} ! matroskademux ! queue ! c. `;
        }
        if (audioPath)
            desc += `filesrc location=${q(audioPath)} ! oggdemux ! opusparse ! queue ! mux. `;

        await runPipeline(desc);
        return out;
    }

    _cleanupTmp() {
        try {
            const d = Gio.File.new_for_path(this._tmpDir);
            const en = d.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null)))
                d.get_child(info.get_name()).delete(null);
            en.close(null);
            d.delete(null);
        } catch (e) {
            console.warn(`[OneShot] limpeza: ${e.message}`);
        }
    }

    _fail(message) {
        const wasActive = this.active;
        try {
            this._audio?.abort();
        } catch {}
        this._audio = null;
        if (this.state === RecState.RECORDING)
            this._proxy?.StopScreencastAsync().catch(() => {});
        this._setState(RecState.IDLE);
        if (wasActive)
            this._onError?.(message);
    }

    /** Usado no disable(): interrompe sem perder o que já foi gravado. */
    destroy() {
        if (this.state === RecState.RECORDING || this.state === RecState.PAUSED) {
            // Encerra o segmento atual; os arquivos ficam na pasta temporária.
            this._proxy?.StopScreencastAsync().catch(() => {});
            this._audio?.abort();
            console.warn(`[OneShot] gravação interrompida; trechos em ${this._tmpDir}`);
        }
        if (this._proxy && this._errorId)
            this._proxy.disconnectSignal(this._errorId);
        this._proxy = null;
        this._audio = null;
        this._onStateChanged = this._onError = this._onSaved = null;
        this.state = RecState.IDLE;
    }
}

/**
 * Executa um pipeline GStreamer até o fim (EOS), sem bloquear o Shell.
 *
 * @param {string} desc
 * @returns {Promise<void>}
 */
export async function runPipeline(desc) {
    const Gst = await getGst();
    const pipeline = Gst.parse_launch(desc);
    return new Promise((resolve, reject) => {
        const bus = pipeline.get_bus();
        bus.add_signal_watch();
        const id = bus.connect('message', (_b, msg) => {
            if (msg.type !== Gst.MessageType.EOS && msg.type !== Gst.MessageType.ERROR)
                return;
            bus.disconnect(id);
            bus.remove_signal_watch();
            pipeline.set_state(Gst.State.NULL);
            if (msg.type === Gst.MessageType.EOS)
                resolve();
            else
                reject(msg.parse_error()[0]);
        });
        pipeline.set_state(Gst.State.PLAYING);
    });
}
