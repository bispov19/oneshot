// OneShot — captura de tela e gravação de vídeo para o GNOME Shell.
// Ponto de entrada da extensão: cria/destrói todos os componentes e
// coordena overlay, editor, ações, gravação e anotação ao vivo.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {resolveDir, ensureDir, formatFilename, IMAGE_EXT, uniqueFile} from './lib/config.js';
import {KeybindingManager} from './lib/keybindings.js';
import {Notifier, openFile, copyImage} from './lib/notify.js';
import {OneShotIndicator} from './lib/indicator.js';
import {captureFullscreen, captureArea} from './lib/capture/quick.js';
import {savePixbuf, playCaptureSound, encodePixbuf} from './lib/capture/saver.js';
import {CaptureOverlay} from './lib/overlay/overlay.js';
import {PinnedImage} from './lib/actions/pin.js';
import {chooseSavePath, launchWith, shareDir} from './lib/actions/external.js';
import {Countdown} from './lib/ui/countdown.js';
import {setIconDir} from './lib/ui/widgets.js';
import {Recorder, RecState} from './lib/recorder/recorder.js';
import {RecordingFrame, RecordingIndicator} from './lib/recorder/indicator.js';
import {LiveAnnotator} from './lib/live/annotator.js';

/** Atalhos funcionam também com popups/overlays abertos. */
const KB_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;

export default class OneShotExtension extends Extension {
    enable() {
        setIconDir(`${this.path}/icons`);
        this._settings = this.getSettings();
        this._timeouts = new Set();
        this._pins = new Set();
        this._busy = false;
        this._overlay = null;
        this._countdown = null;
        this._recorder = null;
        this._annotator = null;
        this._notifier = new Notifier(this.path);

        // Todas as ações ficam num objeto único, usado pelos atalhos e pelo menu.
        this.actions = {
            region: () => this._openOverlay('region', 'capture'),
            window: () => this._openOverlay('window', 'capture'),
            fullscreen: () => this._captureFullscreen(),
            monitor: index => this._captureMonitor(index),
            delayed: secs => this._delayed('region', 'capture', secs),
            repeatLast: () => this._repeatLast(),
            recordToggle: () => this._recordToggle(),
            recordPause: () => this._recorder?.togglePause(),
            annotateToggle: () => this._annotateToggle(),
            annotateClear: () => this._annotateClear(),
            openFolder: () => this._openFolder(),
        };

        this._keybindings = new KeybindingManager(this._settings);
        const kb = (key, fn) => this._keybindings.add(key, fn, KB_MODES);
        kb('shortcut-region', this.actions.region);
        kb('shortcut-fullscreen', this.actions.fullscreen);
        kb('shortcut-window', this.actions.window);
        kb('shortcut-repeat-last', this.actions.repeatLast);
        kb('shortcut-record-toggle', this.actions.recordToggle);
        kb('shortcut-record-pause', this.actions.recordPause);
        kb('shortcut-annotate-toggle', this.actions.annotateToggle);
        kb('shortcut-annotate-clear', this.actions.annotateClear);

        this._syncIndicator();
        this._settingsChangedId = this._settings.connect('changed::show-panel-button',
            () => this._syncIndicator());
    }

    disable() {
        // Ordem inversa da criação; tudo zerado para não vazar memória.
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        this._timeouts = null;

        this._countdown?.destroy();
        this._countdown = null;
        if (this._overlay instanceof CaptureOverlay)
            this._overlay.close();
        this._overlay = null;
        this._annotator?.destroy();
        this._annotator = null;
        this._stopRecordingUi();
        this._recorder?.destroy();
        this._recorder = null;
        for (const pin of [...this._pins])
            pin.destroy();
        this._pins.clear();
        this._pins = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._keybindings?.destroy();
        this._keybindings = null;

        this._notifier?.destroy();
        this._notifier = null;

        this.actions = null;
        this._settings = null;
    }

    /* ------------------------------ utilidades ------------------------------ */

    _syncIndicator() {
        const show = this._settings.get_boolean('show-panel-button');
        if (show && !this._indicator) {
            this._indicator = new OneShotIndicator(this);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    /** Espera `ms` milissegundos (timer rastreado para limpeza no disable). */
    _wait(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timeouts?.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        });
    }

    /** Executa `fn` depois que o menu do painel terminar de fechar. */
    afterMenu(fn) {
        this._wait(220).then(() => {
            if (this._settings)
                fn();
        });
    }

    _openFolder() {
        const dir = resolveDir(this._settings, 'image');
        ensureDir(dir);
        openFile(Gio.File.new_for_path(dir));
    }

    _notifySaved(file, pixbuf, result) {
        if (this._settings.get_boolean('notify-capture')) {
            this._notifier.fileSaved({
                file, kind: 'image', getPngBytes: result.getPngBytes, pixbuf, copied: result.copied,
            });
        }
    }

    /* ------------------------------ overlay ------------------------------ */

    async _openOverlay(mode, purpose) {
        if (this._overlay || this._countdown || this._busy)
            return;
        if (purpose === 'record' && this._recorder?.active)
            return;
        // O overlay não pode competir com a anotação ao vivo ativa.
        if (this._annotator?.active)
            this._annotator.setActive(false);
        this._overlay = 'opening'; // reserva, evita aberturas duplicadas
        // Congela a tela só depois que a visão geral terminar de fechar.
        if (Main.overview.visible) {
            await Promise.race([
                new Promise(resolve => {
                    const id = Main.overview.connect('hidden', () => {
                        Main.overview.disconnect(id);
                        resolve();
                    });
                    Main.overview.hide();
                }),
                this._wait(1000),
            ]);
        }
        if (!this._settings) // desativada enquanto esperava
            return;

        const overlay = new CaptureOverlay({
            settings: this._settings, mode, purpose,
            handlers: {
                capture: (action, ov) => this._onCaptureAction(action, ov),
                record: rect => this._startRecording(rect),
                delay: (m, p) => this._delayed(m, p, this._settings.get_int('default-delay')),
                closed: ov => {
                    if (this._overlay === ov)
                        this._overlay = null;
                },
            },
        });
        this._overlay = overlay;
        try {
            await overlay.open();
        } catch (e) {
            logError(e, '[OneShot] falha ao abrir o overlay');
            overlay.close();
            this._notifier?.info('OneShot: falha ao abrir a captura', e.message);
        }
    }

    async _delayed(mode, purpose, secs) {
        if (this._overlay || this._countdown)
            return;
        this._countdown = new Countdown(secs, this._settings.get_string('accent-color'));
        const ok = await this._countdown.run();
        this._countdown = null;
        if (!ok || !this._settings)
            return;
        // Um quadro para o contador sumir da tela antes de congelar.
        await this._wait(60);
        if (this._settings)
            this._openOverlay(mode, purpose);
    }

    /** Executa uma ação do editor (salvar, copiar, …). */
    async _onCaptureAction(action, ov) {
        const sel = ov.selection;
        const shapes = ov.shapes;
        const scale = ov.image.scale;
        const app = ov.openWithApp;
        ov.hide();
        try {
            const pixbuf = await ov.image.render(sel, shapes);
            ov.close();
            if (!this._settings)
                return;
            if (this._settings.get_boolean('capture-sound') && action !== 'pin')
                playCaptureSound();

            switch (action) {
            case 'save': {
                const result = await savePixbuf(this._settings, pixbuf, {mode: 'regiao'});
                this._notifySaved(result.file, pixbuf, result);
                break;
            }
            case 'copy':
                copyImage(encodePixbuf(pixbuf, 'png', 100));
                if (this._settings.get_boolean('notify-capture'))
                    this._notifier.info('Captura copiada', 'A imagem está na área de transferência.');
                break;
            case 'saveas':
                await this._saveAs(pixbuf);
                break;
            case 'pin':
                this._pin(pixbuf, sel.x, sel.y, scale);
                break;
            case 'openwith': {
                const ext = IMAGE_EXT[this._settings.get_string('image-format')] ?? 'png';
                const base = formatFilename(this._settings.get_string('filename-pattern'), 'regiao');
                const file = uniqueFile(shareDir(), base, ext);
                await savePixbuf(this._settings, pixbuf, {file, copy: false});
                if (app)
                    launchWith(app, file);
                break;
            }
            }
        } catch (e) {
            logError(e, `[OneShot] falha na ação ${action}`);
            ov.close();
            this._notifier?.info('OneShot: falha na captura', e.message);
        }
    }

    async _saveAs(pixbuf) {
        const ext = IMAGE_EXT[this._settings.get_string('image-format')] ?? 'png';
        const name = `${formatFilename(this._settings.get_string('filename-pattern'), 'regiao')}.${ext}`;
        const dir = resolveDir(this._settings, 'image');
        ensureDir(dir);
        const file = await chooseSavePath(this.path, dir, name);
        if (!file || !this._settings)
            return;
        const result = await savePixbuf(this._settings, pixbuf, {file});
        this._notifySaved(result.file, pixbuf, result);
    }

    _pin(pixbuf, x, y, scale) {
        const pin = new PinnedImage({
            pixbuf, x, y, scale,
            handlers: {
                copy: pb => copyImage(encodePixbuf(pb, 'png', 100)),
                save: async pb => {
                    const result = await savePixbuf(this._settings, pb, {mode: 'fixada', copy: false});
                    this._notifySaved(result.file, pb, result);
                },
                closed: p => this._pins?.delete(p),
            },
        });
        this._pins.add(pin);
    }

    /* --------------------------- capturas diretas --------------------------- */

    /**
     * Fluxo comum: captura -> salva -> som -> notificação.
     *
     * @param {Function} grab - função assíncrona que devolve um Pixbuf
     * @param {string} mode - nome do modo (para o nome do arquivo)
     */
    async _runCapture(grab, mode) {
        if (this._busy || this._overlay)
            return;
        this._busy = true;
        try {
            // Pequena pausa para menus/popups terminarem de fechar.
            await this._wait(180);
            if (!this._settings)
                return;
            const pixbuf = await grab();
            if (!this._settings)
                return;
            if (this._settings.get_boolean('capture-sound'))
                playCaptureSound();
            const result = await savePixbuf(this._settings, pixbuf, {mode});
            this._notifySaved(result.file, pixbuf, result);
        } catch (e) {
            logError(e, '[OneShot] falha na captura');
            this._notifier?.info('OneShot: falha na captura', e.message);
        } finally {
            this._busy = false;
        }
    }

    _captureFullscreen() {
        this._settings.set_string('last-capture-mode', 'fullscreen');
        return this._runCapture(
            () => captureFullscreen(this._settings.get_boolean('include-cursor')),
            'tela');
    }

    _captureMonitor(index) {
        const n = global.display.get_n_monitors();
        if (index < 0 || index >= n)
            return null;
        const g = global.display.get_monitor_geometry(index);
        this._settings.set_string('last-capture-mode', 'monitor');
        this._settings.set_value('last-capture-area',
            new GLib.Variant('ai', [g.x, g.y, g.width, g.height]));
        return this._runCapture(() => captureArea(g.x, g.y, g.width, g.height), `monitor${index + 1}`);
    }

    _repeatLast() {
        const mode = this._settings.get_string('last-capture-mode');
        const area = this._settings.get_value('last-capture-area').deepUnpack();
        if (mode === 'fullscreen')
            return this._captureFullscreen();
        if ((mode === 'monitor' || mode === 'region') && area.length === 4) {
            const [x, y, w, h] = area;
            return this._runCapture(() => captureArea(x, y, w, h), mode === 'region' ? 'regiao' : 'monitor');
        }
        this._notifier.info('OneShot', 'Nenhuma captura anterior para repetir.');
        return null;
    }

    /* ------------------------------ gravação ------------------------------ */

    _recordToggle() {
        if (this._recorder?.state === RecState.RECORDING || this._recorder?.state === RecState.PAUSED)
            this._recorder.stop();
        else if (!this._recorder?.active)
            this._openOverlay('region', 'record');
    }

    _shortcutLabel(key) {
        return this._settings.get_strv(key)[0]?.replace(/</g, '').replace(/>/g, '+') || '—';
    }

    async _startRecording(rect) {
        if (this._recorder?.active)
            return;
        // A área cobre a tela toda? Então grava sem recorte (mais eficiente).
        const {width: W, height: H} = global.stage;
        const full = rect.x <= 0 && rect.y <= 0 && rect.w >= W && rect.h >= H;

        this._recorder = new Recorder({
            settings: this._settings,
            onStateChanged: state => this._onRecState(state),
            onError: (msg, soft) => {
                this._notifier?.info(soft ? 'OneShot' : 'OneShot: erro na gravação', msg);
            },
            onSaved: file => {
                if (this._settings?.get_boolean('notify-recording'))
                    this._notifier.fileSaved({file, kind: 'video'});
            },
        });
        // Dá tempo para o overlay sumir da tela antes de começar.
        await this._wait(120);
        if (!this._recorder)
            return;
        this._recRect = full ? null : rect;
        await this._recorder.start(this._recRect);
    }

    _onRecState(state) {
        switch (state) {
        case RecState.RECORDING:
            if (!this._recIndicator) {
                this._recIndicator = new RecordingIndicator({
                    elapsed: () => this._recorder?.elapsed ?? 0,
                    handlers: {
                        pause: () => this._recorder?.togglePause(),
                        stop: () => this._recorder?.stop(),
                        annotate: () => this._annotateToggle(),
                    },
                    shortcuts: {
                        pause: this._shortcutLabel('shortcut-record-pause'),
                        stop: this._shortcutLabel('shortcut-record-toggle'),
                        annotate: this._shortcutLabel('shortcut-annotate-toggle'),
                    },
                });
                Main.panel.addToStatusArea(`${this.uuid}-rec`, this._recIndicator, 0, 'right');
            }
            if (this._recRect && !this._recFrame)
                this._recFrame = new RecordingFrame(this._recRect);
            this._recIndicator.setPaused(false);
            break;
        case RecState.PAUSED:
            this._recIndicator?.setPaused(true);
            break;
        case RecState.SAVING:
            this._recIndicator?.setSaving();
            this._recFrame?.destroy();
            this._recFrame = null;
            // As anotações ao vivo terminam junto com a gravação.
            this._annotator?.destroy();
            this._annotator = null;
            break;
        case RecState.IDLE:
            this._stopRecordingUi();
            this._annotator?.destroy();
            this._annotator = null;
            this._recorder = null;
            break;
        }
    }

    _stopRecordingUi() {
        this._recIndicator?.destroy();
        this._recIndicator = null;
        this._recFrame?.destroy();
        this._recFrame = null;
    }

    /* --------------------------- anotação ao vivo --------------------------- */

    _annotateToggle() {
        if (this._overlay)
            return;
        if (!this._annotator) {
            const recording = this._recorder?.state === RecState.RECORDING ||
                this._recorder?.state === RecState.PAUSED;
            this._annotator = new LiveAnnotator({
                settings: this._settings,
                rect: recording ? this._recRect : null,
                onChanged: active => {
                    // Fora da gravação, ao concluir sem nada desenhado, remove a camada.
                    if (!active && this._annotator && !this._recorder?.active &&
                        !this._annotator.canvas.shapes.length) {
                        const a = this._annotator;
                        this._annotator = null;
                        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                            this._timeouts?.delete(id);
                            a.destroy();
                            return GLib.SOURCE_REMOVE;
                        });
                        this._timeouts.add(id);
                    }
                },
            });
        }
        this._annotator.toggle();
    }

    _annotateClear() {
        if (!this._annotator)
            return;
        this._annotator.clear();
        if (!this._annotator.active && !this._recorder?.active) {
            this._annotator.destroy();
            this._annotator = null;
        }
    }
}
