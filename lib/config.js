// Funções e constantes compartilhadas entre a extensão (Shell) e o prefs.js (GTK).
// IMPORTANTE: este módulo só pode importar bibliotecas disponíveis nos dois
// processos (GLib/Gio). Nada de St, Clutter, Meta, Gtk ou Adw aqui.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gettext from 'gettext';

/**
 * Lista dos atalhos configuráveis. A ordem é a mesma exibida nas preferências.
 * `key` é o nome da chave no GSettings; `title` é o rótulo (pt-BR).
 */
export const SHORTCUTS = [
    {key: 'shortcut-region', title: 'Capturar região'},
    {key: 'shortcut-fullscreen', title: 'Capturar tela inteira'},
    {key: 'shortcut-window', title: 'Capturar janela'},
    {key: 'shortcut-repeat-last', title: 'Repetir última captura'},
    {key: 'shortcut-record-toggle', title: 'Iniciar/parar gravação'},
    {key: 'shortcut-record-pause', title: 'Pausar/retomar gravação'},
    {key: 'shortcut-annotate-toggle', title: 'Alternar anotação ao vivo'},
    {key: 'shortcut-annotate-clear', title: 'Limpar anotações ao vivo'},
];

/** Extensões de arquivo por formato de imagem. */
export const IMAGE_EXT = {png: 'png', jpg: 'jpg', webp: 'webp'};

/** Tipo usado pelo GdkPixbuf para salvar cada formato. */
export const PIXBUF_TYPE = {png: 'png', jpg: 'jpeg', webp: 'webp'};

/**
 * Traduz uma string usando o domínio de tradução do GNOME Shell.
 * Assim "Screenshots" vira "Capturas de tela" em pt-BR, exatamente
 * a mesma pasta que o GNOME usa.
 *
 * @param {string} msg
 * @returns {string}
 */
function shellGettext(msg) {
    try {
        return Gettext.dgettext('gnome-shell', msg);
    } catch {
        return msg;
    }
}

/**
 * Pasta padrão das capturas: XDG Pictures/<"Screenshots" traduzido>.
 *
 * @returns {string}
 */
export function defaultScreenshotDir() {
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ??
        GLib.get_home_dir();
    return GLib.build_filenamev([pictures, shellGettext('Screenshots')]);
}

/**
 * Pasta padrão dos vídeos: XDG Videos/<"Screencasts" traduzido>.
 *
 * @returns {string}
 */
export function defaultVideoDir() {
    const videos = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ??
        GLib.get_home_dir();
    return GLib.build_filenamev([videos, shellGettext('Screencasts')]);
}

/**
 * Resolve a pasta efetiva (configurada ou padrão) para o tipo informado.
 *
 * @param {Gio.Settings} settings
 * @param {'image'|'video'} kind
 * @returns {string}
 */
export function resolveDir(settings, kind) {
    const custom = settings.get_string(kind === 'video' ? 'video-dir' : 'screenshot-dir');
    if (custom)
        return custom.startsWith('~') ? GLib.get_home_dir() + custom.slice(1) : custom;
    return kind === 'video' ? defaultVideoDir() : defaultScreenshotDir();
}

/**
 * Gera o nome do arquivo (sem extensão) a partir do padrão.
 * Aceita códigos strftime (%Y, %m, %d, %H, %M, %S…) e o marcador {mode}.
 *
 * @param {string} pattern
 * @param {string} mode - ex.: 'regiao', 'tela', 'janela'
 * @param {GLib.DateTime} [date]
 * @returns {string}
 */
export function formatFilename(pattern, mode = 'regiao', date = null) {
    const now = date ?? GLib.DateTime.new_now_local();
    let name = now.format(pattern || 'OneShot_%Y-%m-%d_%H-%M-%S') ?? 'OneShot';
    name = name.replaceAll('{mode}', mode);
    // Remove caracteres inválidos para nomes de arquivo.
    name = name.replace(/[/\\\0]/g, '-').trim();
    return name || 'OneShot';
}

/**
 * Monta um caminho único (acrescenta " (2)", " (3)"… se já existir).
 *
 * @param {string} dir
 * @param {string} base
 * @param {string} ext
 * @returns {Gio.File}
 */
export function uniqueFile(dir, base, ext) {
    let file = Gio.File.new_for_path(GLib.build_filenamev([dir, `${base}.${ext}`]));
    for (let i = 2; file.query_exists(null); i++)
        file = Gio.File.new_for_path(GLib.build_filenamev([dir, `${base} (${i}).${ext}`]));
    return file;
}

/**
 * Garante que a pasta exista.
 *
 * @param {string} dir
 */
export function ensureDir(dir) {
    GLib.mkdir_with_parents(dir, 0o755);
}
