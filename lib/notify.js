// Notificações do OneShot com os botões "Abrir", "Abrir pasta" e "Copiar".

import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export class Notifier {
    /**
     * @param {string} extensionPath - caminho da extensão (para o ícone)
     */
    constructor(extensionPath) {
        this._icon = Gio.FileIcon.new(Gio.File.new_for_path(
            `${extensionPath}/icons/oneshot-symbolic.svg`));
        this._source = null;
    }

    /** Cria (ou reaproveita) a fonte de notificações. */
    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: 'OneShot',
                icon: this._icon,
            });
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    /**
     * Notificação simples, sem ações.
     *
     * @param {string} title
     * @param {string} [body]
     */
    info(title, body = '') {
        const source = this._getSource();
        const n = new MessageTray.Notification({
            source, title, body, isTransient: true,
        });
        source.addNotification(n);
    }

    /**
     * Notificação de arquivo salvo, com miniatura e ações.
     *
     * @param {object} params
     * @param {Gio.File} params.file - arquivo salvo
     * @param {'image'|'video'} params.kind
     * @param {() => GLib.Bytes} [params.getPngBytes] - gera o PNG para o botão "Copiar"
     * @param {import('gi://GdkPixbuf').default.Pixbuf} [params.pixbuf] - miniatura
     * @param {boolean} [params.copied] - já foi copiado automaticamente
     */
    fileSaved({file, kind, getPngBytes = null, pixbuf = null, copied = false}) {
        const source = this._getSource();
        const isImage = kind === 'image';
        const title = isImage ? 'Captura salva' : 'Gravação salva';
        let body = file.get_basename();
        if (copied)
            body += '\nCopiada para a área de transferência';

        const n = new MessageTray.Notification({
            source,
            title,
            body,
            gicon: pixbuf ? this._thumbnail(pixbuf) : this._icon,
            isTransient: false,
        });

        n.addAction('Abrir', () => openFile(file));
        n.addAction('Abrir pasta', () => showInFolder(file));
        n.addAction('Copiar', () => {
            if (isImage && getPngBytes)
                copyImage(getPngBytes());
            else
                copyFileUri(file);
        });

        source.addNotification(n);
    }

    /**
     * Converte um Pixbuf em St.ImageContent (mantém a proporção na notificação).
     *
     * @param {import('gi://GdkPixbuf').default.Pixbuf} pixbuf
     */
    _thumbnail(pixbuf) {
        try {
            const ctx = global.stage.context.get_backend().get_cogl_context();
            const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
            content.set_bytes(ctx, pixbuf.read_pixel_bytes(),
                pixbuf.hasAlpha ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888,
                pixbuf.width, pixbuf.height, pixbuf.rowstride);
            return content;
        } catch (e) {
            logError(e, '[OneShot] falha ao criar miniatura');
            return this._icon;
        }
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
        this._icon = null;
    }
}

/* ---------------- Ações auxiliares (também usadas fora das notificações) --------------- */

/** @param {Gio.File} file */
export function openFile(file) {
    try {
        Gio.AppInfo.launch_default_for_uri(file.get_uri(), global.create_app_launch_context(0, -1));
    } catch (e) {
        logError(e, '[OneShot] não foi possível abrir o arquivo');
    }
}

/**
 * Abre o gerenciador de arquivos com o arquivo selecionado
 * (org.freedesktop.FileManager1), com fallback para abrir só a pasta.
 *
 * @param {Gio.File} file
 */
export function showInFolder(file) {
    Gio.DBus.session.call(
        'org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1',
        'ShowItems',
        new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null, Gio.DBusCallFlags.NONE, -1, null,
        (conn, res) => {
            try {
                conn.call_finish(res);
            } catch {
                openFile(file.get_parent());
            }
        });
}

/** @param {GLib.Bytes} pngBytes */
export function copyImage(pngBytes) {
    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', pngBytes);
}

/** @param {Gio.File} file */
export function copyFileUri(file) {
    const data = new TextEncoder().encode(`${file.get_uri()}\r\n`);
    St.Clipboard.get_default().set_content(
        St.ClipboardType.CLIPBOARD, 'text/uri-list', new GLib.Bytes(data));
}
