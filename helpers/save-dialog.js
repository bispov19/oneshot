// Auxiliar do "Salvar como": o GNOME Shell não pode abrir diálogos GTK,
// então a extensão executa este pequeno programa (gjs -m), que mostra o
// seletor de arquivos e imprime o caminho escolhido na saída padrão.
//
// Uso: gjs -m save-dialog.js <pasta inicial> <nome sugerido>
// Saída: caminho escolhido (código 0) ou nada (código 1 = cancelado).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const [folder, name] = ARGV;
Gtk.init();

const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
for (const [title, mime, pattern] of [
    ['Imagem PNG', 'image/png', '*.png'],
    ['Imagem JPEG', 'image/jpeg', '*.jpg'],
    ['Imagem WebP', 'image/webp', '*.webp'],
]) {
    const f = new Gtk.FileFilter({name: title});
    f.add_mime_type(mime);
    f.add_pattern(pattern);
    filters.append(f);
}

const dialog = new Gtk.FileDialog({
    title: 'Salvar captura como',
    modal: true,
    initial_name: name ?? 'OneShot.png',
    filters,
});
if (folder)
    dialog.initial_folder = Gio.File.new_for_path(folder);

const loop = new GLib.MainLoop(null, false);
let code = 1;
dialog.save(null, null, (d, res) => {
    try {
        const file = d.save_finish(res);
        if (file?.get_path()) {
            print(file.get_path());
            code = 0;
        }
    } catch {
        code = 1;
    }
    loop.quit();
});
loop.run();
System.exit(code);
