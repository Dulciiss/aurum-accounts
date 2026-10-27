const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, nativeImage, Notification, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createUpdater } = require('./updater');

// ---------- Carpeta de datos fija ----------
// La carpeta de datos (cuentas, ajustes y la clave con la que se cifran las contraseñas) no debe depender
// del nombre del programa: así renombrarlo no hace "desaparecer" las cuentas. Se reutiliza la carpeta que
// ya exista (la más reciente si hay varias) y, en instalaciones nuevas, se crea 'league-accounts'.
function pickDataFolder() {
    const base = app.getPath('appData');
    const candidates = ['league-accounts', 'League Accounts'];
    let best = null;
    for (const name of candidates) {
        const dir = path.join(base, name);
        let stamp = -1;
        try {
            stamp = fs.statSync(path.join(dir, 'accounts.json')).mtimeMs;
        } catch (e) {
            try { fs.statSync(path.join(dir, 'Local State')); stamp = 0; } catch (e2) { /* no existe */ }
        }
        if (stamp >= 0 && (!best || stamp > best.stamp)) best = { dir, stamp };
    }
    return best ? best.dir : path.join(base, candidates[0]);
}
app.setPath('userData', pickDataFolder());

// Identificador propio: Windows agrupa y muestra el icono de la app en la barra de tareas
// (sin esto, en desarrollo aparece agrupada con el icono de Electron)
app.setAppUserModelId('com.leagueaccounts.app');

// ---------- Cifrado de contraseñas (DPAPI de Windows vía safeStorage) ----------
// Solo el mismo usuario de Windows en el mismo equipo puede descifrarlas.
ipcMain.on('secure:encrypt', (event, plain) => {
    try {
        event.returnValue = safeStorage.isEncryptionAvailable()
            ? safeStorage.encryptString(String(plain)).toString('base64')
            : null;
    } catch (e) {
        event.returnValue = null;
    }
});

ipcMain.on('secure:decrypt', (event, b64) => {
    try {
        event.returnValue = safeStorage.decryptString(Buffer.from(String(b64), 'base64'));
    } catch (e) {
        event.returnValue = null;
    }
});

// Inicializar el módulo remote para permitir ventanas secundarias/fantasma
require('@electron/remote/main').initialize();

// Argumentos que añade el ajuste "Iniciar con Windows" (ver applySystemSettings en index.html)
const launchedAtStartup = process.argv.includes('--startup');
const startMinimized = launchedAtStartup && process.argv.includes('--minimized');

// ---------- Bandeja del sistema ----------
// Icono junto al reloj con un menú de cuentas (inicio de sesión rápido), atajo global para mostrar/ocultar la
// ventana y, si el usuario lo activa, "cerrar" = seguir en la bandeja. Las contraseñas NUNCA pasan por aquí:
// la interfaz solo envía id + etiqueta de cada cuenta, y el inicio de sesión lo hace el mismo código de siempre.
const TRAY_DEFAULTS = { trayIcon: true, closeToTray: false, trayShortcutOn: true, trayShortcut: 'Control+Alt+A' };
const MAX_TRAY_ACCOUNTS = 25;

// Ajustes que necesita el proceso principal antes de que cargue la interfaz (p. ej. arrancar solo en la bandeja)
function readTraySettings() {
    try {
        const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
        return sanitizeTrayConfig(saved, TRAY_DEFAULTS);
    } catch (e) {
        return Object.assign({}, TRAY_DEFAULTS);
    }
}

function sanitizeTrayConfig(input, base) {
    const c = Object.assign({}, base);
    if (!input || typeof input !== 'object') return c;
    if (typeof input.trayIcon === 'boolean') c.trayIcon = input.trayIcon;
    if (typeof input.closeToTray === 'boolean') c.closeToTray = input.closeToTray;
    if (typeof input.trayShortcutOn === 'boolean') c.trayShortcutOn = input.trayShortcutOn;
    if (typeof input.trayShortcut === 'string' && (input.trayShortcut === '' || /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/.test(input.trayShortcut)) && input.trayShortcut.length <= 40) {
        c.trayShortcut = input.trayShortcut;
    }
    return c;
}

function createTrayController({ app, Tray, Menu, nativeImage, Notification, globalShortcut, getWindow, iconPath, initial }) {
    let cfg = Object.assign({}, TRAY_DEFAULTS, initial);
    let tray = null;
    let quitting = false;
    let registered = null;      // atajo registrado ahora mismo
    let model = { accounts: [], more: 0, streamer: false, strings: {} };
    const liveNotifications = new Set();   // si no, se pueden recoger antes de que el usuario haga clic

    const win = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : null; };
    const send = (channel, ...args) => { const w = win(); if (w) w.webContents.send(channel, ...args); };

    function show() {
        const w = win(); if (!w) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
    }
    // Sin icono en la bandeja, ocultar dejaría la ventana inalcanzable: se minimiza a la barra de tareas
    function hideOrMinimize() {
        const w = win(); if (!w) return;
        if (tray) w.hide(); else w.minimize();
    }
    function toggle() {
        const w = win(); if (!w) return;
        if (w.isVisible() && !w.isMinimized() && w.isFocused()) hideOrMinimize(); else show();
    }

    const esc = (text) => String(text).replace(/&/g, '&&');   // en los menús de Windows "&" marca una letra

    function buildMenu() {
        const s = model.strings;
        const items = [
            { label: esc(s.open || 'Aurum Accounts'), click: show },
            { type: 'separator' },
            { label: esc(s.loginWith || ''), enabled: false }
        ];
        if (model.accounts.length) {
            model.accounts.forEach(a => items.push({ label: esc(a.label), click: () => send('tray:login', a.id) }));
            if (model.more > 0) items.push({ label: esc((s.more || '').replace('{n}', model.more)), click: show });
        } else {
            items.push({ label: esc(s.noAccounts || ''), enabled: false });
        }
        items.push(
            { type: 'separator' },
            { label: esc(s.streamer || ''), type: 'checkbox', checked: !!model.streamer, click: () => send('tray:toggle-streamer') },
            { type: 'separator' },
            { label: esc(s.quit || 'Quit'), click: () => { quitting = true; app.quit(); } }
        );
        return Menu.buildFromTemplate(items);
    }
    function refreshMenu() { if (tray) tray.setContextMenu(buildMenu()); }

    function ensureTray() {
        if (cfg.trayIcon && !tray) {
            const image = nativeImage.createFromPath(iconPath);
            if (image.isEmpty()) { console.error('No se pudo cargar el icono de la bandeja:', iconPath); return; }
            tray = new Tray(image);
            tray.setToolTip('Aurum Accounts');
            tray.on('click', toggle);          // clic izquierdo; el derecho abre el menú
            tray.on('double-click', show);
            refreshMenu();
        } else if (!cfg.trayIcon && tray) {
            tray.destroy();
            tray = null;
        }
    }

    function applyShortcut() {
        if (registered) {
            try { globalShortcut.unregister(registered); } catch (e) { /* ya no estaba */ }
            registered = null;
        }
        if (!cfg.trayShortcutOn || !cfg.trayShortcut) return true;
        let ok = false;
        try { ok = !!globalShortcut.register(cfg.trayShortcut, toggle); } catch (e) { ok = false; }
        if (ok) registered = cfg.trayShortcut;
        return ok;
    }

    return {
        start() { ensureTray(); applyShortcut(); },
        // La interfaz manda su configuración al arrancar y al guardar ajustes
        applyConfig(input) {
            cfg = sanitizeTrayConfig(input, cfg);
            ensureTray();
            return { shortcutOk: applyShortcut(), trayActive: !!tray };
        },
        // Lista de cuentas (solo id y etiqueta, sin credenciales) y textos ya traducidos
        setModel(input) {
            const strings = {};
            if (input && input.strings && typeof input.strings === 'object') {
                for (const [k, v] of Object.entries(input.strings)) if (typeof v === 'string') strings[k] = v.slice(0, 120);
            }
            const list = input && Array.isArray(input.accounts) ? input.accounts : [];
            const accounts = list
                .filter(a => a && typeof a.id === 'string' && typeof a.label === 'string')
                .map(a => ({ id: a.id, label: a.label.slice(0, 80) }));
            model = {
                accounts: accounts.slice(0, MAX_TRAY_ACCOUNTS),
                more: Math.max(0, accounts.length - MAX_TRAY_ACCOUNTS),
                streamer: !!(input && input.streamer),
                strings
            };
            refreshMenu();
        },
        notify({ title, body } = {}) {
            if (!Notification.isSupported() || typeof body !== 'string') return;
            const n = new Notification({ title: String(title || 'Aurum Accounts').slice(0, 60), body: body.slice(0, 200), icon: iconPath });
            liveNotifications.add(n);
            const done = () => liveNotifications.delete(n);
            n.on('click', () => { show(); done(); });
            n.on('close', done);
            n.show();
        },
        show, toggle,
        diagnostics: () => ({ trayAvailable: !!tray }),
        shouldHideOnClose: () => !quitting && cfg.trayIcon && !!tray && cfg.closeToTray,
        startsInTray: () => cfg.trayIcon && !!tray,
        markQuitting() { quitting = true; },
        dispose() { try { globalShortcut.unregisterAll(); } catch (e) { /* nada */ } if (tray) { tray.destroy(); tray = null; } }
    };
}

const trayCtl = createTrayController({
    app, Tray, Menu, nativeImage, Notification, globalShortcut,
    getWindow: () => BrowserWindow.getAllWindows()[0],
    iconPath: path.join(__dirname, 'icon.ico'),
    initial: readTraySettings()
});

ipcMain.handle('tray:config', (event, config) => trayCtl.applyConfig(config));
ipcMain.on('tray:accounts', (event, model) => trayCtl.setModel(model));
ipcMain.on('tray:notify', (event, notification) => trayCtl.notify(notification));
ipcMain.on('tray:show', () => trayCtl.show());
ipcMain.handle('diagnostics:collect', (event) => {
    if (!BrowserWindow.fromWebContents(event.sender)) {
        throw new Error('Diagnostics can only be collected from an application window.');
    }

    return {
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        platform: os.platform(),
        osVersion: os.release(),
        osArchitecture: os.arch(),
        processArchitecture: process.arch,
        electronVersion: process.versions.electron,
        chromiumVersion: process.versions.chrome,
        nodeVersion: process.versions.node,
        secureStorageAvailable: safeStorage.isEncryptionAvailable(),
        trayAvailable: trayCtl.diagnostics().trayAvailable,
        notificationsAvailable: Notification.isSupported()
    };
});

function createWindow () {
    const win = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 1000,   // por debajo de esto la interfaz deja de verse bien
        minHeight: 660,
        frame: false,   // sin marco de Windows: la barra de título la dibuja index.html
        icon: path.join(__dirname, 'icon.ico'),   // icono de la barra de tareas
        show: false, // se muestra en 'ready-to-show' para evitar parpadeos
        backgroundColor: '#0b0c10',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            // Con la ventana oculta en la bandeja, Chromium frenaría los temporizadores: el inicio de sesión
            // desde la bandeja y la actualización automática de rangos dependen de ellos
            backgroundThrottling: false
        }
    });

    // Habilitar la ventana para el uso de remote
    require('@electron/remote/main').enable(win.webContents);

    win.setMenuBarVisibility(false);
    win.loadFile('index.html');

    // Avisar a la barra de título de los cambios de estado (icono maximizar/restaurar, ocultarla en pantalla completa)
    const sendState = () => {
        if (!win.isDestroyed()) {
            win.webContents.send('win:state', { maximized: win.isMaximized(), fullscreen: win.isFullScreen() });
        }
    };
    ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(ev => win.on(ev, sendState));

    // F11 alterna pantalla completa esté donde esté el foco
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F11') {
            event.preventDefault();
            win.setFullScreen(!win.isFullScreen());
        }
    });

    // "Cerrar" oculta la ventana en la bandeja si el usuario lo activó (y siempre que no se esté saliendo)
    win.on('close', (event) => {
        if (trayCtl.shouldHideOnClose()) {
            event.preventDefault();
            win.hide();
            win.webContents.send('tray:hidden');
        }
    });
    // Si Windows se apaga o cierra sesión, no hay que impedirlo
    win.on('session-end', () => trayCtl.markQuitting());

    win.once('ready-to-show', () => {
        if (startMinimized) {
            // Con icono en la bandeja arranca solo ahí; sin él, minimizada en la barra de tareas como antes
            if (!trayCtl.startsInTray()) {
                win.showInactive();
                win.minimize();
            }
        } else {
            win.show();
        }
    });
}

// ---------- Controles de ventana (botones de la barra de título) ----------
const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);

ipcMain.on('win:minimize', (event) => {
    const win = senderWindow(event);
    if (win) win.minimize();
});

ipcMain.on('win:toggle-maximize', (event) => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
});

ipcMain.on('win:close', (event) => {
    const win = senderWindow(event);
    if (win) win.close();
});

ipcMain.on('win:get-state', (event) => {
    const win = senderWindow(event);
    event.returnValue = win ? { maximized: win.isMaximized(), fullscreen: win.isFullScreen() } : null;
});

// ---------- Actualizaciones automáticas (ver updater.js) ----------
// Solo el instalador se actualiza solo; el Portable y el modo desarrollo avisan desde la interfaz.
let autoUpdater = null;
if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR) {
    try {
        autoUpdater = require('electron-updater').autoUpdater;
    } catch (e) {
        console.error('electron-updater no está disponible:', e);
    }
}
createUpdater({
    ipcMain,
    autoUpdater,
    send: (payload) => BrowserWindow.getAllWindows().forEach(w => {
        if (!w.isDestroyed()) w.webContents.send('update:state', payload);
    })
});

// ---------- Una sola instancia ----------
// Si se abre la app otra vez (p. ej. a mano después de arrancar con Windows), se enfoca la
// ventana que ya existe: dos instancias a la vez podrían pisarse accounts.json.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    // Abrir la app otra vez la trae al frente, aunque estuviera oculta en la bandeja
    app.on('second-instance', () => trayCtl.show());
    app.whenReady().then(() => {
        createWindow();
        trayCtl.start();
    });
}

app.on('before-quit', () => trayCtl.markQuitting());
app.on('will-quit', () => trayCtl.dispose());

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});