// Janela de preferências do OneShot (GTK4 + libadwaita).

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    IMAGE_EXT, defaultScreenshotDir, defaultVideoDir, formatFilename,
} from './lib/config.js';
import {buildShortcutsPage} from './prefs/shortcuts.js';
import {
    colorRow, comboRow, folderRow, fontFamilyRow, spinRow, switchRow,
} from './prefs/widgets.js';

export default class OneShotPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Mantém a referência viva enquanto a janela existir.
        window._settings = settings;
        window.set_default_size(720, 780);
        window.search_enabled = true;

        window.add(this._capturePage(settings, window));
        window.add(this._recordingPage(settings));
        window.add(this._toolsPage(settings));
        window.add(buildShortcutsPage(settings));
        window.add(this._appearancePage(settings, window));
    }

    /* ------------------------------- Captura ------------------------------- */
    _capturePage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Captura', icon_name: 'camera-photo-symbolic'});

        // Arquivos
        const files = new Adw.PreferencesGroup({title: 'Arquivos'});
        files.add(folderRow(settings, 'screenshot-dir', 'Pasta das capturas', defaultScreenshotDir));
        files.add(comboRow(settings, 'image-format', 'Formato da imagem',
            [['png', 'PNG (sem perdas)'], ['jpg', 'JPG'], ['webp', 'WebP']]));
        const quality = spinRow(settings, 'image-quality', 'Qualidade',
            {min: 1, max: 100, subtitle: 'Usada para JPG e WebP'});
        files.add(quality);
        const syncQuality = () => {
            quality.sensitive = settings.get_string('image-format') !== 'png';
        };
        syncQuality();

        const pattern = new Adw.EntryRow({title: 'Padrão do nome do arquivo', show_apply_button: true});
        pattern.text = settings.get_string('filename-pattern');
        pattern.connect('apply', () => settings.set_string('filename-pattern', pattern.text));
        files.add(pattern);

        const preview = new Adw.ActionRow({
            title: 'Prévia',
            subtitle_selectable: true,
            css_classes: ['property'],
        });
        const help = new Gtk.MenuButton({
            icon_name: 'help-about-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: 'Códigos disponíveis',
            popover: new Gtk.Popover({
                child: new Gtk.Label({
                    use_markup: true,
                    margin_top: 10, margin_bottom: 10, margin_start: 10, margin_end: 10,
                    label: '<b>Códigos de data/hora</b>\n' +
                        '<tt>%Y</tt> ano · <tt>%m</tt> mês · <tt>%d</tt> dia\n' +
                        '<tt>%H</tt> hora · <tt>%M</tt> minuto · <tt>%S</tt> segundo\n' +
                        '<tt>%A</tt> dia da semana · <tt>%B</tt> nome do mês\n' +
                        '<tt>{mode}</tt> modo (regiao, tela, janela…)',
                }),
            }),
        });
        preview.add_suffix(help);
        files.add(preview);
        const syncPreview = () => {
            const ext = IMAGE_EXT[settings.get_string('image-format')] ?? 'png';
            const name = formatFilename(pattern.text, 'regiao');
            preview.subtitle = GLib.markup_escape_text(`${name}.${ext}`, -1);
        };
        pattern.connect('changed', syncPreview);
        syncPreview();
        page.add(files);

        // Comportamento
        const behavior = new Adw.PreferencesGroup({title: 'Comportamento'});
        behavior.add(switchRow(settings, 'auto-copy', 'Copiar automaticamente',
            'Copia a imagem para a área de transferência após capturar'));
        behavior.add(spinRow(settings, 'default-delay', 'Atraso padrão do timer',
            {min: 0, max: 60, subtitle: 'Segundos antes da captura com atraso'}));
        behavior.add(switchRow(settings, 'include-cursor', 'Incluir o cursor'));
        behavior.add(switchRow(settings, 'capture-sound', 'Som ao capturar'));
        behavior.add(switchRow(settings, 'show-magnifier', 'Lupa de precisão',
            'Mostra a lupa com a cor do pixel ao selecionar'));
        behavior.add(switchRow(settings, 'show-panel-button', 'Botão no painel superior'));
        page.add(behavior);

        // Notificações
        const notif = new Adw.PreferencesGroup({
            title: 'Notificações',
            description: 'Com os botões “Abrir”, “Abrir pasta” e “Copiar”',
        });
        notif.add(switchRow(settings, 'notify-capture', 'Notificar capturas'));
        notif.add(switchRow(settings, 'notify-recording', 'Notificar gravações'));
        page.add(notif);

        const ids = [
            settings.connect('changed::image-format', () => {
                syncQuality();
                syncPreview();
            }),
            settings.connect('changed::filename-pattern', () => {
                if (pattern.text !== settings.get_string('filename-pattern'))
                    pattern.text = settings.get_string('filename-pattern');
            }),
        ];
        page.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));

        page.add(this._resetGroup(settings, window));
        return page;
    }

    /* ------------------------------- Gravação ------------------------------ */
    _recordingPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Gravação', icon_name: 'media-record-symbolic'});

        const video = new Adw.PreferencesGroup({
            title: 'Vídeo',
            description: 'Usa o serviço de screencast do GNOME Shell; formato WebM.',
        });
        video.add(folderRow(settings, 'video-dir', 'Pasta dos vídeos', defaultVideoDir));
        video.add(spinRow(settings, 'video-fps', 'Quadros por segundo', {min: 5, max: 60}));
        video.add(comboRow(settings, 'video-quality', 'Qualidade', [
            ['low', 'Baixa (arquivo menor)'],
            ['medium', 'Média'],
            ['high', 'Alta'],
            ['lossless', 'Máxima (arquivo grande)'],
        ]));
        video.add(switchRow(settings, 'record-cursor', 'Mostrar o cursor'));
        page.add(video);

        const audio = new Adw.PreferencesGroup({
            title: 'Áudio',
            description: 'Gravado via PipeWire/GStreamer e mesclado ao vídeo no final.',
        });
        audio.add(switchRow(settings, 'record-audio-mic', 'Microfone'));
        audio.add(switchRow(settings, 'record-audio-system', 'Áudio do sistema'));
        page.add(audio);
        return page;
    }

    /* ------------------------------ Ferramentas ---------------------------- */
    _toolsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Ferramentas', icon_name: 'applications-graphics-symbolic'});
        const g = new Adw.PreferencesGroup({
            title: 'Padrões das ferramentas',
            description: 'Valores iniciais do editor e da anotação ao vivo',
        });
        g.add(colorRow(settings, 'tool-color', 'Cor'));
        g.add(spinRow(settings, 'tool-width', 'Espessura', {min: 1, max: 40}));
        g.add(spinRow(settings, 'font-size', 'Tamanho da fonte', {min: 8, max: 96}));
        g.add(fontFamilyRow(settings, 'font-family', 'Fonte do texto'));
        g.add(switchRow(settings, 'remember-last-tool', 'Lembrar a última ferramenta',
            'Ao abrir o editor, seleciona a ferramenta usada por último'));
        page.add(g);
        return page;
    }

    /* ------------------------------- Aparência ----------------------------- */
    _appearancePage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Aparência', icon_name: 'preferences-desktop-appearance-symbolic'});
        const g = new Adw.PreferencesGroup({title: 'Overlay e barra de ferramentas'});
        g.add(colorRow(settings, 'accent-color', 'Cor de destaque', 'Seleção, botões ativos e indicadores'));
        g.add(spinRow(settings, 'dim-opacity', 'Escurecimento fora da seleção',
            {min: 0, max: 0.95, step: 0.05, digits: 2}));
        g.add(spinRow(settings, 'icon-size', 'Tamanho dos ícones', {min: 14, max: 32, subtitle: 'Em pixels'}));
        page.add(g);
        page.add(this._resetGroup(settings, window));
        return page;
    }

    /** Grupo com o botão "Restaurar padrões" (pede confirmação). */
    _resetGroup(settings, window) {
        const group = new Adw.PreferencesGroup();
        const btn = new Gtk.Button({
            label: 'Restaurar padrões', halign: Gtk.Align.CENTER,
            css_classes: ['pill', 'destructive-action'],
        });
        btn.connect('clicked', () => {
            const dlg = new Adw.AlertDialog({
                heading: 'Restaurar padrões?',
                body: 'Todas as configurações do OneShot, incluindo os atalhos, voltarão aos valores originais.',
            });
            dlg.add_response('cancel', 'Cancelar');
            dlg.add_response('reset', 'Restaurar');
            dlg.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dlg.connect('response', (_d, resp) => {
                if (resp !== 'reset')
                    return;
                for (const key of settings.settings_schema.list_keys())
                    settings.reset(key);
                window.add_toast(new Adw.Toast({title: 'Configurações restauradas'}));
            });
            dlg.present(window);
        });
        group.add(btn);
        return group;
    }
}
