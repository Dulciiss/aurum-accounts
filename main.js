const { app, BrowserWindow } = require('electron');

// Inicializar el módulo remote para permitir ventanas secundarias/fantasma
require('@electron/remote/main').initialize();

// Argumentos que añade el ajuste "Iniciar con Windows" (ver applySystemSettings en index.html)
const launchedAtStartup = process.argv.includes('--startup');
const startMinimized = launchedAtStartup && process.argv.includes('--minimized');

function createWindow () {
    const win = new BrowserWindow({
        width: 1000,
        height: 650,
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

    win.once('ready-to-show', () => {
        if (startMinimized) {
            win.showInactive();
            win.minimize();
        } else {
            win.show();
        }
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});