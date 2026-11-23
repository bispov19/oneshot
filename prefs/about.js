// Aba "Sobre" das preferências do OneShot.
//
// Aqui fica só a montagem da tela; os dados (nome, versão, autor…) chegam
// prontos do prefs.js. Roda no processo das preferências (GTK 4 +
// libadwaita), por isso o estilo vem de prefs/prefs.css, não do stylesheet.css.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/**
 * Carrega prefs/prefs.css para o processo das preferências e o remove quando
 * a janela fecha (o app Extensões continua aberto e somaria cópias do CSS).
 *
 * @param {Gio.File} dir - pasta da extensão
 * @param {Gtk.Window} window
 */
export function loadPrefsCss(dir, window) {
    const display = Gdk.Display.get_default();
    const provider = new Gtk.CssProvider();
    provider.load_from_file(dir.get_child('prefs').get_child('prefs.css'));
    Gtk.StyleContext.add_provider_for_display(display, provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    window.connect('close-request', () => {
        Gtk.StyleContext.remove_provider_for_display(display, provider);
        return false;
    });
}

/** Linha informativa (não clicável) com ícone à esquerda. */
function infoRow(iconName, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, subtitle_lines: 0, use_markup: false});
    row.add_prefix(new Gtk.Image({icon_name: iconName}));
    return row;
}

/** Linha que abre um endereço no navegador. */
function linkRow(iconName, title, url) {
    const row = new Adw.ActionRow({
        title, subtitle: url.replace(/^https?:\/\//, ''), activatable: true, use_markup: false,
    });
    row.add_prefix(new Gtk.Image({icon_name: iconName}));
    row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
    row.connect('activated', () => {
        new Gtk.UriLauncher({uri: url}).launch(row.get_root(), null, null);
    });
    return row;
}

/**
 * Monta a aba "Sobre".
 *
 * @param {object} info
 * @param {Gio.File} info.logo
 * @param {string} info.name
 * @param {string} info.description
 * @param {string} info.version
 * @param {string} info.license
 * @param {string} info.url - repositório
 * @param {string} info.profile - perfil do autor no GitHub
 * @param {string} info.author
 * @param {string} info.authorRole
 * @param {string} info.aboutMe - texto "Sobre mim"
 * @param {string} info.features
 * @param {string} info.notice
 * @returns {Adw.PreferencesPage}
 */
export function buildAboutPage(info) {
    const page = new Adw.PreferencesPage({title: 'Sobre', icon_name: 'help-about-symbolic'});

    // Card principal
    const heroGroup = new Adw.PreferencesGroup();
    const hero = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL, spacing: 12, css_classes: ['about-hero'],
    });
    hero.append(new Gtk.Image({
        gicon: new Gio.FileIcon({file: info.logo}), pixel_size: 140, margin_bottom: 6,
    }));
    hero.append(new Gtk.Label({label: info.name, css_classes: ['title-1']}));
    hero.append(new Gtk.Label({
        label: info.description, css_classes: ['dim-label'], wrap: true,
        justify: Gtk.Justification.CENTER, max_width_chars: 48,
    }));
    hero.append(new Gtk.Label({
        label: `Versão ${info.version}  •  ${info.license}`,
        css_classes: ['caption', 'dim-label'],
    }));
    heroGroup.add(hero);
    page.add(heroGroup);

    // Sobre mim
    const me = new Adw.PreferencesGroup({title: 'Sobre mim'});
    me.add(infoRow('avatar-default-symbolic', info.author, info.authorRole));
    me.add(infoRow('user-info-symbolic', 'Quem sou', info.aboutMe));
    me.add(linkRow('system-users-symbolic', 'Perfil no GitHub', info.profile));
    page.add(me);

    // Links
    const links = new Adw.PreferencesGroup({title: 'Links'});
    links.add(linkRow('web-browser-symbolic', 'Repositório no GitHub', info.url));
    links.add(linkRow('dialog-warning-symbolic', 'Relatar um problema', `${info.url}/issues`));
    page.add(links);

    // Créditos
    const credits = new Adw.PreferencesGroup({title: 'Créditos'});
    credits.add(infoRow('starred-symbolic', 'Recursos', info.features));
    credits.add(infoRow('dialog-information-symbolic', 'Aviso', info.notice));
    page.add(credits);

    return page;
}
