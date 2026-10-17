const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
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
            contextIsolation: false
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

    win.once('ready-to-show', () => {
        if (startMinimized) {
            win.showInactive();
            win.minimize();
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
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
    app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});