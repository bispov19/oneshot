// Ações que envolvem outros processos: "Salvar como" e "Abrir com".

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

/**
 * Mostra o seletor de arquivos (processo GTK auxiliar).
 *
 * @param {string} extPath - caminho da extensão
 * @param {string} folder - pasta inicial
 * @param {string} name - nome sugerido
 * @returns {Promise<Gio.File|null>}
 */
export async function chooseSavePath(extPath, folder, name) {
    const gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
    const proc = Gio.Subprocess.new(
        [gjs, '-m', `${extPath}/helpers/save-dialog.js`, folder, name],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await proc.communicate_utf8_async(null, null);
    const path = stdout?.trim();
    if (!proc.get_successful() || !path)
        return null;
    return Gio.File.new_for_path(path);
}

/** Pasta para arquivos entregues a outros apps ("Abrir com"). */
export function shareDir() {
    const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'oneshot']);
    GLib.mkdir_with_parents(dir, 0o700);
    // Limpeza: apaga arquivos com mais de 1 dia.
    try {
        const d = Gio.File.new_for_path(dir);
        const en = d.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const limit = GLib.get_real_time() / 1e6 - 86400;
        let info;
        while ((info = en.next_file(null))) {
            if (info.get_attribute_uint64('time::modified') < limit)
                d.get_child(info.get_name()).delete(null);
        }
        en.close(null);
    } catch (e) {
        console.warn(`[OneShot] limpeza do cache: ${e.message}`);
    }
    return dir;
}

/**
 * Abre o arquivo com o aplicativo escolhido.
 *
 * @param {Gio.AppInfo} app
 * @param {Gio.File} file
 */
export function launchWith(app, file) {
    app.launch([file], global.create_app_launch_context(0, -1));
}
