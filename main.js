const { app, BrowserWindow } = require('electron');

// Inicializar el módulo remote para permitir ventanas secundarias/fantasma
require('@electron/remote/main').initialize();

function createWindow () {
    const win = new BrowserWindow({
        width: 1000,
        height: 650,
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
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});