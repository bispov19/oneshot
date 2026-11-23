// Gravação de áudio (microfone e/ou áudio do sistema) via GStreamer,
// usando o servidor de som do PipeWire pela interface PulseAudio.
// Saída: Opus em Ogg, mesclado ao vídeo no final.
//
// Pausa: o pipeline vai para PAUSED; como as fontes são "ao vivo", o
// GStreamer desconta o tempo pausado e o áudio fica alinhado ao vídeo
// (cujos trechos também não incluem as pausas).

import GLib from 'gi://GLib';

import {getGst} from '../gst.js';

let _Gst = null;

export class AudioRecorder {
    /**
     * @param {object} p
     * @param {string} p.path - arquivo .ogg de saída
     * @param {boolean} p.mic
     * @param {boolean} p.system
     */
    constructor({path, mic, system}) {
        this._path = path;
        this._mic = mic;
        this._system = system;
        this._pipeline = null;
    }

    async start() {
        const Gst = _Gst = await getGst();
        for (const el of ['pulsesrc', 'opusenc', 'oggmux', 'audiomixer'])
            if (!Gst.ElementFactory.find(el))
                throw new Error(`elemento GStreamer ausente: ${el}`);

        const src = dev => `pulsesrc ${dev ? `device=${dev} ` : ''}client-name=OneShot do-timestamp=true ` +
            '! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2 ! queue ';
        const sink = `audioconvert ! opusenc bitrate=128000 ! oggmux ! filesink location="${this._path}"`;
        let desc;
        if (this._mic && this._system)
            desc = `audiomixer name=mix ! ${sink} ${src(null)}! mix. ${src('@DEFAULT_MONITOR@')}! mix.`;
        else
            desc = `${src(this._system ? '@DEFAULT_MONITOR@' : null)}! ${sink}`;

        this._pipeline = Gst.parse_launch(desc);
        const bus = this._pipeline.get_bus();
        bus.add_signal_watch();
        this._busId = bus.connect('message', (_b, msg) => {
            if (msg.type === Gst.MessageType.ERROR)
                console.warn(`[OneShot] erro no áudio: ${msg.parse_error()[0].message}`);
        });
        if (this._pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE)
            throw new Error('não foi possível abrir a fonte de áudio');
    }

    pause() {
        this._pipeline?.set_state(_Gst.State.PAUSED);
    }

    resume() {
        this._pipeline?.set_state(_Gst.State.PLAYING);
    }

    /**
     * Finaliza o arquivo (envia EOS e espera).
     *
     * @returns {Promise<string|null>} caminho do arquivo
     */
    stop() {
        const Gst = _Gst;
        const pipeline = this._pipeline;
        if (!pipeline)
            return Promise.resolve(null);
        this._pipeline = null;
        return new Promise(resolve => {
            const bus = pipeline.get_bus();
            bus.disconnect(this._busId);
            let timeoutId = 0;
            const done = ok => {
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                timeoutId = 0;
                bus.disconnect(id);
                bus.remove_signal_watch();
                pipeline.set_state(Gst.State.NULL);
                resolve(ok ? this._path : null);
            };
            const id = bus.connect('message', (_b, msg) => {
                if (msg.type === Gst.MessageType.EOS)
                    done(true);
                else if (msg.type === Gst.MessageType.ERROR)
                    done(false);
            });
            // Segurança: se o EOS não chegar em 5 s, segue sem áudio.
            timeoutId = GLib.timeout_add(0, 5000, () => {
                timeoutId = 0;
                done(false);
                return false;
            });
            pipeline.set_state(Gst.State.PLAYING);
            pipeline.send_event(Gst.Event.new_eos());
        });
    }

    abort() {
        if (!this._pipeline)
            return;
        const bus = this._pipeline.get_bus();
        bus.disconnect(this._busId);
        bus.remove_signal_watch();
        this._pipeline.set_state(_Gst.State.NULL);
        this._pipeline = null;
    }
}
