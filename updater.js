// Actualizaciones automáticas.
//   · Instalador (NSIS): la app comprueba, descarga e instala la nueva versión desde las releases de GitHub.
//   · Portable y modo desarrollo: no pueden actualizarse solos; la interfaz avisa y abre la página de la release.
//
// Está separado de main.js para poder probarlo sin Electron: recibe todo lo que necesita por parámetro.
//   ipcMain     → canal de comunicación con la interfaz
//   send        → función que envía un estado a la interfaz ({ state, ... })
//   autoUpdater → el de 'electron-updater', o null si no procede (Portable, desarrollo...)
function createUpdater({ ipcMain, send, autoUpdater }) {
    const enabled = !!autoUpdater;

    // La interfaz pregunta una vez al arrancar si puede delegar la actualización en la app
    ipcMain.handle('update:capabilities', () => ({ selfUpdate: enabled }));
    if (!enabled) return { enabled };

    autoUpdater.autoDownload = false;         // solo se descarga cuando el usuario lo pide
    autoUpdater.autoInstallOnAppQuit = true;  // si la dejó descargada, se instala al cerrar la app

    let busy = false;                          // comprobando o descargando

    autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
    autoUpdater.on('update-available', (info) => { busy = false; send({ state: 'available', version: info.version }); });
    autoUpdater.on('update-not-available', () => { busy = false; send({ state: 'latest' }); });
    autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round((p && p.percent) || 0) }));
    autoUpdater.on('update-downloaded', (info) => { busy = false; send({ state: 'ready', version: info.version }); });
    autoUpdater.on('error', (err) => { busy = false; send({ state: 'error', message: String((err && err.message) || err) }); });

    ipcMain.on('update:check', () => {
        if (busy) return;
        busy = true;
        // Si falla, ya lo comunica el evento 'error'; el catch solo evita un rechazo sin tratar
        autoUpdater.checkForUpdates().catch(() => { busy = false; });
    });

    ipcMain.on('update:download', () => {
        if (busy) return;
        busy = true;
        autoUpdater.downloadUpdate().catch(() => { busy = false; });
    });

    // (silencioso, reabrir la app al terminar)
    ipcMain.on('update:install', () => autoUpdater.quitAndInstall(true, true));

    return { enabled };
}

module.exports = { createUpdater };
