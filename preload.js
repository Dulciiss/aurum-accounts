const { contextBridge, ipcRenderer } = require('electron');

const gamerCardApi = Object.freeze({
    getAssets(championKey) {
        return ipcRenderer.invoke('gamer-card:get-assets', championKey);
    }
});

if (process.contextIsolated) {
    contextBridge.exposeInMainWorld('aurumGamerCardBridge', gamerCardApi);
} else {
    window.aurumGamerCardBridge = gamerCardApi;
}
