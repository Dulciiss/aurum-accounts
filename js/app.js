        const fs = require('fs');
        const path = require('path');
        const { exec, execFile, spawn } = require('child_process');
        const { ipcRenderer, clipboard } = require('electron');
        const https = require('https');
        const { BrowserWindow, shell, dialog, app: remoteApp } = require('@electron/remote');

        // ---------- Definición segura de la ruta en AppData ----------
        let userDataPath;
        try {
            const currentApp = remoteApp || require('@electron/remote').app || require('electron').app;
            userDataPath = currentApp.getPath('userData');
        } catch (e) {
            userDataPath = path.join(process.env.APPDATA || (process.platform == 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + "/.local/share"), 'league-accounts');
        }

        if (!fs.existsSync(userDataPath)) {
            fs.mkdirSync(userDataPath, { recursive: true });
        }

        const dataPath = path.join(userDataPath, 'accounts.json');
        const settingsPath = path.join(userDataPath, 'settings.json');

        // Todos los textos de la interfaz viven en js/translations.js (t() los lee según el idioma activo).

        function getSystemLanguage() {
            const sysLang = (navigator.language || navigator.userLanguage || 'en').split('-')[0];
            return translations[sysLang] ? sysLang : 'es';
        }

        const TACTICAL_TAGS = Object.freeze([
            { id: 'duo-god', labelKey: 'tacticalDuoGod' },
            { id: 'main-otp', labelKey: 'tacticalMainOtp' },
            { id: 'tilt-alert', labelKey: 'tacticalTiltAlert' },
            { id: 'smurf', labelKey: 'tacticalSmurf' }
        ]);

        function normalizeTacticalTags(tags) {
            const allowed = new Set(TACTICAL_TAGS.map(tag => tag.id));
            const values = Array.isArray(tags) ? tags : [];
            return [...new Set(values.filter(tag => allowed.has(tag)))].slice(0, 2);
        }

        const DEFAULT_SETTINGS = {
            language: getSystemLanguage(),
            launchAtStartup: false,
            startMinimized: false,
            christmasTheme: false,
            autoRefresh: true,
            refreshMinutes: 15,          // 900 s, como hasta ahora
            loginMode: 'riotClient',     // 'riotClient' | 'previousWindow'
            launchGame: false,
            autoCheckUpdates: true,
            streamerMode: false,         // modo streamer activado ahora mismo
            streamerIds: true,           // ...qué se oculta cuando está activado:
            streamerLogin: true,
            streamerDescs: false,
            streamerPass: true,
            trayIcon: true,                  // icono en la bandeja del sistema
            closeToTray: false,              // la X oculta la ventana en la bandeja en lugar de cerrar la app
            trayShortcutOn: true,            // atajo global para mostrar/ocultar la ventana
            trayShortcut: 'Control+Alt+A',
            trayHintShown: false,            // ya se avisó (una vez) de que la app sigue en la bandeja
            viewMode: 'grid',
            activeView: 'accounts',
            friendRivals: [],
            friendsDesktopNotifications: false,
            rankChangeNotifications: true,
            desktopRankNotifications: false
        };

        function loadSettings() {
            try {
                if (fs.existsSync(settingsPath)) {
                    const loaded = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
                    loaded.viewMode = loaded.viewMode === 'list' ? 'list' : 'grid';
                    loaded.activeView = loaded.activeView === 'friends' ? 'friends' : 'accounts';
                    loaded.friendRivals = Array.isArray(loaded.friendRivals) ? loaded.friendRivals
                        .filter(friend => friend && typeof friend.riotId === 'string' && friend.riotId.trim())
                        .map(friend => ({
                            id: typeof friend.id === 'string' && friend.id ? friend.id : newAccountId(),
                            riotId: friend.riotId.trim(),
                            region: typeof friend.region === 'string' ? friend.region.toLowerCase() : 'euw',
                            relation: friend.relation === 'rival' ? 'rival' : 'friend',
                            note: typeof friend.note === 'string' ? friend.note.slice(0, 120) : '',
                            tags: normalizeTags(friend.tags).map(tag => tag.slice(0, 40)).slice(0, 10),
                            tacticalTags: normalizeTacticalTags(friend.tacticalTags),
                            soloq: friend.soloq || null,
                            flex: friend.flex || null,
                            lpHistory: Array.isArray(friend.lpHistory) ? friend.lpHistory : [],
                            lpHistoryFlex: Array.isArray(friend.lpHistoryFlex) ? friend.lpHistoryFlex : [],
                            recentGames: Array.isArray(friend.recentGames) ? friend.recentGames.slice(0, 10) : null,
                            opggStatus: friend.opggStatus || null,
                            opggUpdatedAt: Number.isFinite(friend.opggUpdatedAt) ? friend.opggUpdatedAt : null
                        })) : [];
                    loaded.friendsDesktopNotifications = loaded.friendsDesktopNotifications === true;
                    loaded.christmasTheme = loaded.christmasTheme === true;
                    loaded.desktopRankNotifications = loaded.desktopRankNotifications === true;
                    return loaded;
                }
            } catch (e) {
                console.error('Error leyendo settings.json, se usan los valores por defecto', e);
            }
            return { ...DEFAULT_SETTINGS };
        }

        function saveSettings() {
            const tempPath = settingsPath + '.tmp';
            fs.writeFileSync(tempPath, JSON.stringify(settings, null, 4));
            fs.renameSync(tempPath, settingsPath);
        }

        let settings = loadSettings();
        let currentLang = translations[settings.language] ? settings.language : getSystemLanguage();
        const christmasSnow = document.getElementById('christmas-snow');
        const christmasAudio = document.getElementById('christmas-audio');
        christmasAudio.src = 'assets/audio/navidad.mp3';
        christmasAudio.loop = true;
        christmasAudio.preload = 'none';
        const CHRISTMAS_MUSIC_VOLUME_KEY = 'aurum-christmas-music-volume';
        let christmasMusicVolume = 3;
        try {
            const rawMusicVolume = localStorage.getItem(CHRISTMAS_MUSIC_VOLUME_KEY);
            if (rawMusicVolume !== null) {
                const savedMusicVolume = Number(rawMusicVolume);
                if (Number.isFinite(savedMusicVolume)) {
                    christmasMusicVolume = Math.max(0, Math.min(100, Math.round(savedMusicVolume)));
                }
            }
        } catch (error) {
            console.error('No se pudo leer el volumen de la música ambiental:', error);
        }
        christmasAudio.volume = christmasMusicVolume / 100;
        let christmasMusicPlaying = false;
        let christmasPlaybackAttempt = 0;
        let christmasFadeFrame = null;
        let christmasFadeId = 0;
        const CHRISTMAS_AUDIO_FADE_DURATION = 500;

        function fadeChristmasAudio(targetVolume, pauseAtEnd = false) {
            const fadeId = ++christmasFadeId;
            if (christmasFadeFrame !== null) cancelAnimationFrame(christmasFadeFrame);

            const initialVolume = christmasAudio.volume;
            const startedAt = performance.now();
            const updateVolume = (now) => {
                if (fadeId !== christmasFadeId) return;
                const progress = Math.min((now - startedAt) / CHRISTMAS_AUDIO_FADE_DURATION, 1);
                christmasAudio.volume = initialVolume + (targetVolume - initialVolume) * progress;

                if (progress < 1) {
                    christmasFadeFrame = requestAnimationFrame(updateVolume);
                    return;
                }

                christmasFadeFrame = null;
                if (pauseAtEnd) {
                    christmasAudio.pause();
                    christmasAudio.currentTime = 0;
                }
            };

            christmasFadeFrame = requestAnimationFrame(updateVolume);
        }

        function stopChristmasMusic() {
            christmasPlaybackAttempt += 1;
            christmasMusicPlaying = false;
            fadeChristmasAudio(0, true);
        }

        async function startChristmasMusic() {
            if (!settings.christmasTheme || window.aurumSoundboard.getState().muted) return;
            const playbackAttempt = ++christmasPlaybackAttempt;
            const shouldStartFromSilence = christmasAudio.paused;
            if (shouldStartFromSilence) christmasAudio.volume = 0;
            christmasAudio.muted = false;
            await christmasAudio.play();
            if (playbackAttempt !== christmasPlaybackAttempt || !settings.christmasTheme
                || window.aurumSoundboard.getState().muted) {
                return;
            }
            christmasMusicPlaying = true;
            fadeChristmasAudio(christmasMusicVolume / 100);
        }

        function syncChristmasMusicWithMasterAudio() {
            if (!settings.christmasTheme) return;
            if (window.aurumSoundboard.getState().muted) {
                stopChristmasMusic();
            } else if (!christmasMusicPlaying) {
                startChristmasMusic().catch(error => {
                    console.warn('La reproducción navideña requiere interacción del usuario:', error);
                });
            }
        }

        function resumeChristmasMusicAfterInteraction() {
            if (!settings.christmasTheme || window.aurumSoundboard.getState().muted
                || christmasMusicPlaying || !christmasAudio.paused) return;
            startChristmasMusic().catch(error => {
                console.warn('La reproducción navideña requiere interacción del usuario:', error);
            });
        }

        window.addEventListener('aurum-soundboard-state-change', syncChristmasMusicWithMasterAudio);
        document.addEventListener('pointerdown', resumeChristmasMusicAfterInteraction, true);
        document.addEventListener('keydown', resumeChristmasMusicAfterInteraction, true);

        ipcRenderer.on('christmas:stop-music', stopChristmasMusic);
        ipcRenderer.on('christmas:resume-music', () => {
            if (settings.christmasTheme && !window.aurumSoundboard.getState().muted) {
                startChristmasMusic().catch(error => {
                    console.warn('La reproducción navideña requiere interacción del usuario:', error);
                });
            }
        });
        function applyChristmasTheme() {
            document.body.classList.toggle('christmas-theme', settings.christmasTheme);
            christmasSnow.hidden = !settings.christmasTheme;
            if (settings.christmasTheme && christmasSnow.childElementCount === 0) {
                const snowflakeCount = 40;
                for (let index = 0; index < snowflakeCount; index += 1) {
                    const flake = document.createElement('span');
                    flake.className = 'christmas-snowflake';
                    flake.style.setProperty('--snow-x', `${Math.random() * 100}%`);
                    flake.style.setProperty('--snow-size', `${2 + Math.random() * 4}px`);
                    flake.style.setProperty('--snow-duration', `${5 + Math.random() * 7}s`);
                    flake.style.setProperty('--snow-delay', `${-Math.random() * 12}s`);
                    flake.style.setProperty('--snow-drift', `${-35 + Math.random() * 70}px`);
                    christmasSnow.appendChild(flake);
                }
            }
            if (!settings.christmasTheme) {
                stopChristmasMusic();
            } else if (!window.aurumSoundboard.getState().muted && !christmasMusicPlaying) {
                startChristmasMusic().catch(error => {
                    console.warn('La reproducción navideña requiere interacción del usuario:', error);
                });
            }
        }

        applyChristmasTheme();

        function t(key) {
            return translations[currentLang][key] || translations['en'][key] || key;
        }

        const rankThemeConfig = {
            'CHALLENGER': { primary: '#f4c430', neon: '#ffd700', glow: 'rgba(255, 215, 0, 0.4)', cardBorder: '#f4c430' },
            'GRANDMASTER': { primary: '#ef4444', neon: '#ff4646', glow: 'rgba(255, 70, 70, 0.4)', cardBorder: '#ef4444' },
            'MASTER': { primary: '#a855f7', neon: '#d043ff', glow: 'rgba(208, 67, 255, 0.4)', cardBorder: '#a855f7' },
            'DIAMOND': { primary: '#38bdf8', neon: '#00d2ff', glow: 'rgba(0, 210, 255, 0.4)', cardBorder: '#38bdf8' },
            'EMERALD': { primary: '#10b981', neon: '#00ff7f', glow: 'rgba(0, 255, 127, 0.4)', cardBorder: '#10b981' },
            'PLATINUM': { primary: '#0ea5e9', neon: '#38bdf8', glow: 'rgba(14, 165, 233, 0.4)', cardBorder: '#0ea5e9' },
            'GOLD': { primary: '#eab308', neon: '#ffd700', glow: 'rgba(234, 179, 8, 0.4)', cardBorder: '#eab308' },
            'SILVER': { primary: '#94a3b8', neon: '#cbd5e1', glow: 'rgba(148, 163, 184, 0.4)', cardBorder: '#94a3b8' },
            'BRONZE': { primary: '#b45309', neon: '#d97706', glow: 'rgba(180, 83, 9, 0.4)', cardBorder: '#b45309' },
            'IRON': { primary: '#475569', neon: '#64748b', glow: 'rgba(71, 85, 105, 0.4)', cardBorder: '#475569' },
            'UNRANKED': { primary: '#334155', neon: '#475569', glow: 'rgba(51, 65, 85, 0.2)', cardBorder: '#232430' }
        };

        function getRankTheme(tier) {
            if (!tier) return rankThemeConfig['UNRANKED'];
            const clean = tier.toUpperCase().split(' ')[0].trim();
            return rankThemeConfig[clean] || rankThemeConfig['UNRANKED'];
        }

        function applyLanguage() {
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                el.textContent = t(key);
            });
            document.querySelectorAll('[data-i18n-title]').forEach(el => {
                el.title = t(el.getAttribute('data-i18n-title'));
            });
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                const key = el.getAttribute('data-i18n-placeholder');
                el.placeholder = t(key);
            });
            document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
                el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
            });
            document.documentElement.lang = currentLang;
            refreshWindowLabels();
            refreshSoundboardButton();
            refreshHextechChestButton();
            renderDuoMatch();
            renderRankedFocusWidget(window.aurumFocusMode.getState());
            applyViewMode(settings.viewMode);
            applyMainView(settings.activeView);
            document.querySelectorAll('.lang-option').forEach(btn => {
                if (btn.getAttribute('data-lang') === currentLang) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
            loadAccounts();
        }

        const langBtn = document.getElementById('lang-btn');
        const langDropdown = document.getElementById('lang-dropdown');

        langBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            langDropdown.style.display = langDropdown.style.display === 'flex' ? 'none' : 'flex';
        });

        window.addEventListener('click', () => {
            langDropdown.style.display = 'none';
        });

        document.querySelectorAll('.lang-option').forEach(opt => {
            opt.addEventListener('click', () => {
                currentLang = opt.getAttribute('data-lang');
                settings.language = currentLang;
                saveSettings();
                applyLanguage();
                refreshUpdateUi();
                langDropdown.style.display = 'none';
            });
        });

        // ---------- Desplegables propios (región / ordenar) ----------
        // El <select> nativo sigue siendo la fuente de verdad (value + evento 'change'),
        // pero queda oculto: su panel nativo no se puede estilizar y se veía mal.
        const ddInstances = [];
        function closeAllDropdowns(except) {
            ddInstances.forEach(dd => { if (dd !== except) dd.close(); });
        }

        function enhanceSelect(select) {
            const pill = select.closest('.tb-pill');
            if (!pill) return;
            pill.classList.add('tb-dd');

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'tb-dd-btn';
            button.setAttribute('aria-haspopup', 'listbox');
            button.setAttribute('aria-expanded', 'false');
            const menu = document.createElement('div');
            menu.className = 'tb-dd-menu';
            menu.setAttribute('role', 'listbox');
            select.insertAdjacentElement('afterend', button);
            pill.appendChild(menu);

            function items() { return Array.from(menu.querySelectorAll('.tb-dd-opt')); }

            function rebuild() {
                const current = select.value;
                menu.textContent = '';
                const addOption = (opt) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'tb-dd-opt' + (opt.value === current ? ' active' : '');
                    b.setAttribute('role', 'option');
                    b.setAttribute('aria-selected', opt.value === current ? 'true' : 'false');
                    b.dataset.value = opt.value;
                    b.textContent = opt.textContent;
                    menu.appendChild(b);
                };
                Array.from(select.children).forEach(child => {
                    if (child.tagName === 'OPTGROUP') {
                        const h = document.createElement('div');
                        h.className = 'tb-dd-group';
                        h.textContent = child.label;
                        menu.appendChild(h);
                        Array.from(child.children).forEach(addOption);
                    } else if (child.tagName === 'OPTION') {
                        addOption(child);
                    }
                });
                const sel = select.selectedOptions[0];
                button.textContent = sel ? sel.textContent : '';
            }

            function open() {
                closeAllDropdowns(api);
                langDropdown.style.display = 'none';
                pill.classList.add('open');
                button.setAttribute('aria-expanded', 'true');
                const active = menu.querySelector('.tb-dd-opt.active');
                if (active) active.scrollIntoView({ block: 'nearest' });
            }
            function close() {
                pill.classList.remove('open');
                button.setAttribute('aria-expanded', 'false');
            }
            const api = { close, pill };
            ddInstances.push(api);

            // La etiqueta <label> intentaría activar el <select> oculto: el clic lo gestionamos nosotros
            pill.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const opt = e.target.closest('.tb-dd-opt');
                if (opt) {
                    close();
                    button.focus();
                    if (select.value !== opt.dataset.value) {
                        select.value = opt.dataset.value;
                        rebuild();
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    return;
                }
                if (e.target.closest('.tb-dd-group')) return;
                if (pill.classList.contains('open')) close(); else open();
            });

            // Teclado: flechas / Intro / Espacio / Esc
            pill.addEventListener('keydown', (e) => {
                const isOpen = pill.classList.contains('open');
                if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(); button.focus(); return; }
                if (e.key === 'Tab' && isOpen) { close(); return; }
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (!isOpen) { open(); }
                    const list = items();
                    if (!list.length) return;
                    const idx = list.indexOf(document.activeElement);
                    const next = idx < 0
                        ? list.findIndex(i => i.classList.contains('active'))
                        : (idx + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
                    list[Math.max(0, next)].focus();
                }
            });

            new MutationObserver(rebuild).observe(select, { childList: true, subtree: true, characterData: true });
            select.addEventListener('change', rebuild);
            rebuild();
        }

        enhanceSelect(document.getElementById('filter-region'));
        enhanceSelect(document.getElementById('sort-select'));
        enhanceSelect(document.getElementById('filter-category'));
        window.addEventListener('click', () => closeAllDropdowns());
        langBtn.addEventListener('click', () => closeAllDropdowns());

        const btnAdd = document.querySelector('.btn-add');
        const btnSettings = document.querySelector('.btn-menu');
        const btnImport = document.getElementById('btn-import');
        const btnExport = document.getElementById('btn-export');
        

        const settingsModal = document.getElementById('settings-modal');
        const btnCloseSettings = document.getElementById('close-settings');
        const btnOpenFolder = document.getElementById('btn-open-folder');
        const btnCopyDiagnostics = document.getElementById('btn-copy-diagnostics');
        const dataPathLabel = document.getElementById('data-path-label');
        const accountsCountLabel = document.getElementById('accounts-count-label');

        const confirmModal = document.getElementById('confirm-modal');
        const confirmText = document.getElementById('confirm-text');
        const confirmYes = document.getElementById('confirm-yes');
        const confirmNo = document.getElementById('confirm-no');
        let accountToDelete = null;

        const mainContent = document.querySelector('.main-content');
        const clientSyncBanner = document.getElementById('client-sync-banner');
        const clientSyncMessage = document.getElementById('client-sync-message');
        const clientSyncImport = document.getElementById('client-sync-import');
        const searchInput = document.getElementById('search-input');
        const filterRegion = document.getElementById('filter-region');
        const sortSelect = document.getElementById('sort-select');
        const filterCategory = document.getElementById('filter-category');
        const viewToggle = document.getElementById('toggle-view');
        let traySyncTimer = null;       // bandeja del sistema: envío de la lista de cuentas (con retardo para agrupar cambios)
        let trayAccountsCache = null;   // última lista de cuentas leída
        const rankStatsContainer = document.getElementById('rank-stats-container');
        const autoRefreshTimerLabel = document.getElementById('auto-refresh-timer');
        const mainViewTabs = document.querySelectorAll('[data-main-view]');
        let activeClientAccountId = null;
        let latestClientSnapshot = null;
        let clientSyncBusy = false;
        let latestGameClientLock = null;
        let gameflowPhase = '';
        let gameflowSyncBusy = false;
        let latestFocusQueueId = null;
        let latestFocusQueueName = '';
        let latestFocusStartedAt = null;
        let lastFocusSessionSyncAt = 0;

        function updateRankedFocusState(phase = gameflowPhase) {
            const activeAccount = readAccounts().find(account => account.id === activeClientAccountId);
            const hiddenAccount = settings.streamerMode && settings.streamerIds;
            return window.aurumFocusMode.updateGameState({
                phase,
                queueId: latestFocusQueueId,
                queueName: latestFocusQueueName,
                startedAt: latestFocusStartedAt,
                accountLabel: activeAccount
                    ? hiddenAccount ? t('focusAccountHidden') : activeAccount.riotId || activeAccount.loginUser
                    : ''
            });
        }

        async function syncRankedFocusSession(lock) {
            const response = await riotClientRequest('GET', '/lol-gameflow/v1/session', lock, 1000);
            if (!response.ok) return;
            const session = JSON.parse(response.body);
            const gameData = session && session.gameData || {};
            const queue = gameData.queue || session && session.queue || {};
            latestFocusQueueId = queue.id === undefined ? null : queue.id;
            latestFocusQueueName = queue.name || queue.shortName || queue.queueType || '';
            latestFocusStartedAt = gameData.gameStart || gameData.startTime || session.gameStart || null;
            updateRankedFocusState();
        }

        function setClientSyncState(state, messageKey, canImport = false) {
            clientSyncBanner.dataset.state = state;
            clientSyncMessage.textContent = t(messageKey);
            clientSyncImport.hidden = !canImport;
        }

        function applyViewMode(mode) {
            const isList = mode === 'list';
            mainContent.classList.toggle('compact-list', isList);
            viewToggle.classList.toggle('active', isList);
            viewToggle.setAttribute('aria-pressed', String(isList));
            const label = t(isList ? 'viewToGrid' : 'viewToList');
            viewToggle.title = label;
            viewToggle.setAttribute('aria-label', label);
        }

        function applyMainView(view) {
            const activeView = view === 'friends' ? 'friends' : 'accounts';
            document.body.classList.toggle('friends-view-active', activeView === 'friends');
            mainViewTabs.forEach(button => {
                const selected = button.dataset.mainView === activeView;
                button.classList.toggle('active', selected);
                button.setAttribute('aria-pressed', String(selected));
            });
            document.querySelectorAll('.accounts-only-control').forEach(control => {
                control.hidden = activeView === 'friends';
            });
            if (searchInput) {
                searchInput.placeholder = t(activeView === 'friends' ? 'friendsSearchPlaceholder' : 'searchPlaceholder');
            }
            if (activeView === 'accounts') applyViewMode(settings.viewMode);
            else mainContent.classList.remove('compact-list');
        }

        mainViewTabs.forEach(button => button.addEventListener('click', () => {
            const nextView = button.dataset.mainView === 'friends' ? 'friends' : 'accounts';
            if (settings.activeView === nextView) return;
            settings.activeView = nextView;
            saveSettings();
            applyMainView(nextView);
            loadAccounts();
        }));

        viewToggle.addEventListener('click', () => {
            settings.viewMode = settings.viewMode === 'list' ? 'grid' : 'list';
            saveSettings();
            applyViewMode(settings.viewMode);
        });

        // ---------- Barra de título propia (ventana sin marco) ----------
        function applyWindowState(state) {
            if (!state) return;
            document.body.classList.toggle('maximized', !!state.maximized);
            document.body.classList.toggle('fullscreen', !!state.fullscreen);
            refreshWindowLabels();
        }
        function refreshWindowLabels() {
            const maxBtn = document.getElementById('tb-max');
            const label = t(document.body.classList.contains('maximized') ? 'winRestore' : 'winMaximize');
            maxBtn.title = label;
            maxBtn.setAttribute('aria-label', label);
        }
        document.getElementById('tb-min').addEventListener('click', () => ipcRenderer.send('win:minimize'));
        document.getElementById('tb-max').addEventListener('click', () => ipcRenderer.send('win:toggle-maximize'));
        document.getElementById('tb-close').addEventListener('click', () => ipcRenderer.send('win:close'));
        ipcRenderer.on('win:state', (_e, state) => applyWindowState(state));
        try { applyWindowState(ipcRenderer.sendSync('win:get-state')); } catch (e) { /* sin estado inicial */ }

        // ---------- Utilidades de cuentas ----------
        // ---------- Regiones (lista única para toda la app) ----------
        // code = código de OP.GG; label = lo que se muestra; platform = identificador de Riot (para alias)
        const REGION_LIST = [
            { code: 'euw',  label: 'EUW',  platform: 'euw1' },
            { code: 'eune', label: 'EUNE', platform: 'eun1' },
            { code: 'na',   label: 'NA',   platform: 'na1' },
            { code: 'kr',   label: 'KR',   platform: 'kr' },
            { code: 'br',   label: 'BR',   platform: 'br1' },
            { code: 'lan',  label: 'LAN',  platform: 'la1' },
            { code: 'las',  label: 'LAS',  platform: 'la2' },
            { code: 'oce',  label: 'OCE',  platform: 'oc1' },
            { code: 'tr',   label: 'TR',   platform: 'tr1' },
            { code: 'ru',   label: 'RU',   platform: 'ru' },
            { code: 'me',   label: 'ME',   platform: 'me1' },
            { code: 'jp',   label: 'JP',   platform: 'jp1' },
            { code: 'sg',   label: 'SEA',  platform: 'sg2' },
            { code: 'tw',   label: 'TW',   platform: 'tw2' },
            { code: 'vn',   label: 'VN',   platform: 'vn2' }
        ];
        const REGIONS = REGION_LIST.map(r => r.code);

        // Acepta "EUW", "euw1", "SEA", "la2", "ph", "th"... y devuelve el código de OP.GG o null
        function normalizeRegion(str) {
            const v = String(str || '').trim().toLowerCase();
            if (!v) return null;
            if (['sea', 'ph', 'ph2', 'th', 'th2', 'sg2'].includes(v)) return 'sg'; // servidores fusionados en SEA (2025)
            const found = REGION_LIST.find(r => r.code === v || r.platform === v || r.label.toLowerCase() === v);
            return found ? found.code : null;
        }

        function regionLabel(code) {
            const r = REGION_LIST.find(x => x.code === code);
            return r ? r.label : String(code || '').toUpperCase();
        }

        function regionName(r) {
            const name = t('region_' + r.code);
            return name === 'region_' + r.code ? r.label : name;
        }

        // Rellena los selectores de región; el del filtro muestra cuántas cuentas hay en cada una
        function populateRegionSelects(accounts) {
            const counts = {};
            (accounts || []).forEach(a => { counts[a.region] = (counts[a.region] || 0) + 1; });

            const filter = document.getElementById('filter-region');
            const keep = filter.value || 'all';
            const withAccounts = REGION_LIST.filter(r => counts[r.code]);
            const without = REGION_LIST.filter(r => !counts[r.code]);
            filter.innerHTML =
                `<option value="all">${escapeHtml(t('selAll'))}</option>` +
                (withAccounts.length ? `<optgroup label="${escapeHtml(t('regionsWithAccounts'))}">${withAccounts.map(r =>
                    `<option value="${r.code}">${r.label} (${counts[r.code]})</option>`).join('')}</optgroup>` : '') +
                `<optgroup label="${escapeHtml(t('regionsOther'))}">${without.map(r =>
                    `<option value="${r.code}">${r.label}</option>`).join('')}</optgroup>`;
            filter.value = REGIONS.includes(keep) ? keep : 'all';

            ['acc-region', 'bulk-region'].forEach(id => {
                const sel = document.getElementById(id);
                const prev = sel.value;
                sel.innerHTML = REGION_LIST.map(r => `<option value="${r.code}">${r.label} — ${escapeHtml(regionName(r))}</option>`).join('');
                sel.value = REGIONS.includes(prev) ? prev : 'euw';
            });
        }

        function populateCategorySelect(accounts) {
            const selected = filterCategory.value || 'all';
            const groups = new Map();
            const tags = new Map();
            accounts.forEach(account => {
                const group = String(account.group || '').trim();
                if (group) groups.set(group.toLowerCase(), group);
                (Array.isArray(account.tags) ? account.tags : []).forEach(tag => {
                    const value = String(tag || '').trim();
                    if (value) tags.set(value.toLowerCase(), value);
                });
            });

            filterCategory.textContent = '';
            const all = document.createElement('option');
            all.value = 'all';
            all.textContent = t('allCategories');
            filterCategory.appendChild(all);

            const hideNames = settings.streamerMode && settings.streamerDescs;
            const addCategoryGroup = (type, values, labelKey, categoryKey) => {
                if (!values.size) return;
                const optgroup = document.createElement('optgroup');
                optgroup.label = t(labelKey);
                [...values.entries()].sort((a, b) => a[1].localeCompare(b[1], currentLang)).forEach(([key, name], index) => {
                    const option = document.createElement('option');
                    option.value = `${type}:${key}`;
                    option.textContent = t(categoryKey).replace('{name}', hideNames ? String(index + 1) : name);
                    optgroup.appendChild(option);
                });
                filterCategory.appendChild(optgroup);
            };
            addCategoryGroup('group', groups, 'groupsLabel', 'categoryGroup');
            addCategoryGroup('tag', tags, 'tagsLabel', 'categoryTag');
            filterCategory.value = Array.from(filterCategory.options).some(option => option.value === selected) ? selected : 'all';
        }

        const EMPTY_QUEUE = () => ({ tier: 'UNRANKED', lp: 0, minLp: 0, maxLp: 100 });

        function escapeHtml(str) {
            return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        function newAccountId() {
            return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        }

        function normalizeTags(input) {
            const values = Array.isArray(input) ? input : (typeof input === 'string' ? input.split(',') : []);
            return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
        }

        function nextAccountOrder(accounts) {
            return accounts.reduce((highest, account) => {
                const order = Number(account.order);
                return Math.max(highest, Number.isFinite(order) ? order : -1);
            }, -1) + 1;
        }

        // Cifra con safeStorage (main.js). Devuelve true si quedó cifrada.
        function setAccountPassword(acc, plain) {
            let enc = null;
            try { enc = ipcRenderer.sendSync('secure:encrypt', plain); } catch (e) { enc = null; }
            if (enc) {
                acc.passwordEnc = enc;
                delete acc.password;
                return true;
            }
            acc.password = plain; // sin cifrado disponible: se queda como estaba
            delete acc.passwordEnc;
            return false;
        }

        function getAccountPassword(acc) {
            if (acc.passwordEnc) {
                try {
                    const plain = ipcRenderer.sendSync('secure:decrypt', acc.passwordEnc);
                    if (plain !== null) return plain;
                } catch (e) { /* cae al texto plano si existe */ }
            }
            return acc.password || '';
        }

        // Escritura segura de accounts.json: se escribe en un archivo temporal y se renombra (reemplazo
        // atómico), y antes se guarda una copia de la última versión válida en accounts.json.bak.
        // Así un corte de luz o un cierre a mitad de escritura no puede dejarte sin cuentas.
        const backupPath = dataPath + '.bak';
        let accountsRecovered = false;

        function parseAccountsFile(filePath) {
            try {
                const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                return Array.isArray(parsed) ? parsed : null;
            } catch (e) {
                return null;
            }
        }

        function writeAccounts(accounts) {
            try {
                const current = fs.existsSync(dataPath) ? parseAccountsFile(dataPath) : null;
                // No se sustituye una copia buena por una lista vacía
                if (current && (current.length > 0 || !fs.existsSync(backupPath))) fs.copyFileSync(dataPath, backupPath);
            } catch (e) {
                console.error('No se pudo crear la copia de seguridad de accounts.json', e);
            }
            const tmpPath = dataPath + '.tmp';
            fs.writeFileSync(tmpPath, JSON.stringify(accounts, null, 4));
            fs.renameSync(tmpPath, dataPath);
        }

        // Aparta un accounts.json dañado (no se borra: así se puede intentar rescatar a mano)
        function setAsideCorruptAccounts() {
            try {
                fs.renameSync(dataPath, path.join(userDataPath, `accounts.corrupt-${Date.now()}.json`));
            } catch (e) { /* si no se puede apartar, se deja donde está */ }
        }

        // Si accounts.json está dañado, recupera la última copia buena; devuelve null si no hay
        function restoreAccountsBackup() {
            const backup = fs.existsSync(backupPath) ? parseAccountsFile(backupPath) : null;
            if (!backup) return null;
            setAsideCorruptAccounts();
            fs.copyFileSync(backupPath, dataPath);
            accountsRecovered = true;
            return backup;
        }

        // Lee accounts.json y migra el formato antiguo (sin id, notas, contraseñas en claro)
        function readAccounts() {
            if (!fs.existsSync(dataPath)) return [];
            let accounts;
            try {
                accounts = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
            } catch (e) {
                console.error('accounts.json no es un JSON válido', e);
                accounts = restoreAccountsBackup();
                if (!accounts) { setAsideCorruptAccounts(); return []; }
            }
            if (!Array.isArray(accounts)) return [];

            let changed = false;
            accounts.forEach((acc, index) => {
                if (!acc.id) { acc.id = newAccountId(); changed = true; }
                const normRegion = normalizeRegion(acc.region) || 'euw';
                if (acc.region !== normRegion) { acc.region = normRegion; changed = true; }
                const tags = normalizeTags(acc.tags);
                if (!Array.isArray(acc.tags) || JSON.stringify(acc.tags) !== JSON.stringify(tags)) { acc.tags = tags; changed = true; }
                const history = normalizeLpHistory(acc.lpHistory);
                if (!Array.isArray(acc.lpHistory) || JSON.stringify(acc.lpHistory) !== JSON.stringify(history)) { acc.lpHistory = history; changed = true; }
                const flexHistory = normalizeLpHistory(acc.lpHistoryFlex);
                if (!Array.isArray(acc.lpHistoryFlex) || JSON.stringify(acc.lpHistoryFlex) !== JSON.stringify(flexHistory)) { acc.lpHistoryFlex = flexHistory; changed = true; }
                const group = typeof acc.group === 'string' ? acc.group.trim() : '';
                if (acc.group !== group) { acc.group = group; changed = true; }
                if (typeof acc.order !== 'number' || !Number.isFinite(acc.order)) { acc.order = index; changed = true; }
                if (acc.note !== undefined) {
                    if (!acc.description && acc.note) acc.description = acc.note;
                    delete acc.note;
                    changed = true;
                }
                if (acc.password && !acc.passwordEnc && setAccountPassword(acc, acc.password)) changed = true;
            });
            if (changed) writeAccounts(accounts);
            return accounts;
        }

        function splitRiotId(riotId) {
            const raw = String(riotId || '');
            const i = raw.lastIndexOf('#');
            return i > 0 ? { name: raw.slice(0, i).trim(), tag: raw.slice(i + 1).trim() } : { name: raw.trim(), tag: '' };
        }

        function hasRiotId(acc) {
            const { name, tag } = splitRiotId(acc.riotId);
            return !!(name && tag);
        }

        function isValidRiotId(riotId) {
            const raw = String(riotId || '').trim();
            const separator = raw.indexOf('#');
            if (separator <= 0 || separator !== raw.lastIndexOf('#')) return false;
            const name = raw.slice(0, separator).trim();
            const tag = raw.slice(separator + 1).trim();
            return name.length >= 3 && name.length <= 16 && tag.length >= 3 && tag.length <= 5
                && /^[\p{L}\p{N} _.'-]+$/u.test(name)
                && /^[\p{L}\p{N}]+$/u.test(tag);
        }

        function displayName(acc) {
            return splitRiotId(acc.riotId).name || acc.loginUser || '?';
        }

        // "GOLD" -> "Oro" / "Gold" / "골드"... según el idioma; si falta, el nombre en inglés
        function tierName(base) {
            const up = String(base).toUpperCase();
            const name = t('tier_' + up);
            return name === 'tier_' + up ? up.charAt(0) + up.slice(1).toLowerCase() : name;
        }

        // "GOLD III" -> "Oro III"
        function prettyTier(tierStr) {
            if (!tierStr || tierStr.toUpperCase() === 'UNRANKED') return t('unranked');
            const [base, div] = tierStr.split(' ');
            return tierName(base) + (div ? ' ' + div : '');
        }

        // ---------- OP.GG (perfil y temporada pasada de SoloQ) ----------
        function opggUrl(acc) {
            const { name, tag } = splitRiotId(acc.riotId);
            const region = (acc.region || 'euw').toLowerCase();
            return `https://op.gg/lol/summoners/${region}/${encodeURIComponent(name)}-${encodeURIComponent(tag)}`;
        }

        // GET con Node (sin CORS), siguiendo redirecciones
        function httpGetText(url, redirects = 0) {
            return new Promise((resolve, reject) => {
                const req = https.get(url, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml',
                        'Accept-Language': 'en-US,en;q=0.9'
                    },
                    timeout: 15000
                }, res => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
                        res.resume();
                        return resolve(httpGetText(new URL(res.headers.location, url).toString(), redirects + 1));
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        const err = new Error(`HTTP ${res.statusCode}`);
                        err.statusCode = res.statusCode;
                        return reject(err);
                    }
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve(data));
                });
                req.on('timeout', () => req.destroy(new Error('timeout')));
                req.on('error', reject);
            });
        }

        const TIER_NAMES = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];
        const ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

        function formatLastSeason(tier, division, lp) {
            const T = String(tier || '').toUpperCase();
            if (!TIER_NAMES.includes(T.toLowerCase())) return null;
            const name = T.charAt(0) + T.slice(1).toLowerCase();
            if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(T)) {
                return (lp !== undefined && lp !== null && lp !== '') ? `${name} ${lp}LP` : name;
            }
            let div = division;
            if (typeof div === 'number' || /^\d$/.test(String(div))) div = ROMAN[Number(div)];
            return div ? `${name} ${String(div).toUpperCase()}` : name;
        }

        // ---------- Lectura de la página de perfil de OP.GG ----------
        // OP.GG no tiene API pública: se lee el texto de la página (pedida en inglés).
        // Si OP.GG cambia su web, todo lo que habría que ajustar está en esta función.
        const TIER_RE = '(Grandmaster|Challenger|Master|Diamond|Emerald|Platinum|Gold|Silver|Bronze|Iron)';

        function htmlToText(html) {
            return html
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
                .replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ');
        }

        function escapeRegex(str) {
            return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        // "Diamond", 2 -> "DIAMOND II" (mismo formato que se guardaba antes)
        function toStoredTier(tier, division) {
            const T = tier.toUpperCase();
            if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(T) || !division) return T;
            return `${T} ${ROMAN[Number(division)] || division}`;
        }

        function queueFromMatch(m) {
            if (!m || !m[1]) return EMPTY_QUEUE(); // "Unranked"
            const tier = toStoredTier(m[1], m[2]);
            const lp = parseInt(String(m[3]).replace(/,/g, ''), 10) || 0;
            const base = m[1].toUpperCase();
            if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(base)) {
                const minLp = base === 'MASTER' ? 0 : (base === 'GRANDMASTER' ? 400 : 700);
                return { tier, lp, minLp, maxLp: Math.max(lp + 300, minLp + 500) };
            }
            return { tier, lp, minLp: 0, maxLp: 100 };
        }

        // Devuelve { notFound } o { level, soloq, flex, flexRankAvailable, lastSeason } o null si no se pudo leer
        function parseOpggProfile(html, acc) {
            const text = htmlToText(html);
            const { name, tag } = splitRiotId(acc.riotId);
            const profileIconMatch = /(?:profileIcon(?:Id)?["'\s:=]+|profile_icons\/profileIcon|profileicon\/)(\d{1,5})(?:\.jpg|\.png)?/i.exec(html);
            const profileIconId = profileIconMatch ? Number(profileIconMatch[1]) : null;

            if (/summoner (?:is )?not (?:found|registered)|no search results|not registered on OP\.GG/i.test(text)) {
                return { notFound: true };
            }

            // Bloques "Ranked Solo/Duo Master 255 LP" / "Ranked Flex Emerald 3 35 LP" / "... Unranked"
            const queueRe = label => new RegExp(label + '\\s+(?:Unranked|' + TIER_RE + '(?:\\s+([1-4]))?\\s+([\\d,]+)\\s*LP)', 'i');
            const soloM = queueRe('Ranked Solo/Duo').exec(text);
            const flexM = queueRe('Ranked Flex').exec(text);

            let soloq = soloM ? queueFromMatch(soloM) : null;
            if (!soloq) {
                // Respaldo: descripción de la página "Nombre#TAG / Master 255 LP / 129Win 118Lose ..."
                const meta = /<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i.exec(html);
                if (meta) {
                    const mm = new RegExp('/\\s*' + TIER_RE + '(?:\\s+([1-4]))?\\s+([\\d,]+)\\s*LP', 'i').exec(meta[1]);
                    soloq = mm ? queueFromMatch(mm) : EMPTY_QUEUE();
                }
            }
            const flex = flexM ? queueFromMatch(flexM) : EMPTY_QUEUE();

            // Nivel: el número que aparece justo antes de "Nombre#TAG" en la cabecera del perfil
            let level = null;
            const levelM = new RegExp('(\\d{1,4})\\s*' + escapeRegex(name) + '\\s*#\\s*' + escapeRegex(tag), 'i').exec(text);
            if (levelM) level = levelM[1];

            // Temporada pasada: primera fila de la tabla de temporadas de SoloQ ("S2025 Diamond 2 1")
            let lastSeason = null;
            if (soloM) {
                const end = flexM && flexM.index > soloM.index ? flexM.index : soloM.index + 4000;
                const section = text.slice(soloM.index, end);
                const rowM = new RegExp('\\bS(20\\d{2})(?:\\s+S\\d)?\\s+' + TIER_RE + '(?:\\s+([1-4]))?\\s+([\\d,]+)', 'i').exec(section);
                // Solo cuenta si es la temporada anterior a la actual (no una de hace años)
                if (rowM && Number(rowM[1]) >= new Date().getFullYear() - 1) {
                    lastSeason = formatLastSeason(rowM[2], rowM[3] ? Number(rowM[3]) : null, rowM[4].replace(/,/g, ''));
                }
            }

            // Posición global: "Ladder Rank 14,888 (0.4783% of top)"
            let ladder = null;
            const ladderM = /Ladder Rank\s+([\d,]+)\s*\(\s*(?:top\s*)?([\d.]+)\s*%/i.exec(text);
            if (ladderM) ladder = { rank: parseInt(ladderM[1].replace(/,/g, ''), 10), percent: parseFloat(ladderM[2]) };

            // Campeones más jugados de la temporada, de la descripción de la página:
            // "... / Orianna - 30Win 30Lose Win rate 50%, Twisted Fate - 25Win 20Lose Win rate 56%, ..."
            const topChampions = [];
            const descM = /<meta[^>]+(?:name|property)="(?:og:)?description"[^>]+content="([^"]*)"/i.exec(html);
            if (descM) {
                const desc = htmlToText(descM[1]);
                const champRe = /([^,\/]+?)\s+-\s+(\d+)\s*Win\s+(\d+)\s*Lose/gi;
                let cm;
                while ((cm = champRe.exec(desc)) && topChampions.length < 5) {
                    const wins = parseInt(cm[2], 10), losses = parseInt(cm[3], 10);
                    topChampions.push({ name: cm[1].trim(), wins, losses, wr: Math.round((wins / Math.max(1, wins + losses)) * 100) });
                }
            }

            if (!soloq && !flexM && !level) return null; // no se reconoce la página
            return { level, profileIconId, soloq: soloq || EMPTY_QUEUE(), flex, flexRankAvailable: !!flexM, lastSeason, ladder, topChampions };
        }

        const tierIcons = {
            'CHALLENGER': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-challenger.png',
            'GRANDMASTER': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-grandmaster.png',
            'MASTER': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-master.png',
            'DIAMOND': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-diamond.png',
            'EMERALD': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-emerald.png',
            'PLATINUM': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-platinum.png',
            'GOLD': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-gold.png',
            'SILVER': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-silver.png',
            'BRONZE': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-bronze.png',
            'IRON': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-iron.png',
            'UNRANKED': 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-emblem/emblem-iron.png'
        };

        const rankWeights = { 'CHALLENGER': 10, 'GRANDMASTER': 9, 'MASTER': 8, 'DIAMOND': 7, 'EMERALD': 6, 'PLATINUM': 5, 'GOLD': 4, 'SILVER': 3, 'BRONZE': 2, 'IRON': 1, 'UNRANKED': 0 };

        const MAX_LP_HISTORY = 180;
        const CHART_LP_HISTORY = 30;

        function createRankSnapshot(queue, timestamp = Date.now()) {
            const tier = String(queue && queue.tier || 'UNRANKED').toUpperCase().trim();
            const [base, division] = tier.split(/\s+/);
            const tierWeight = rankWeights[base] || 0;
            const divisionOffset = { IV: 0, III: 1, II: 2, I: 3 }[division] || 0;
            const rankOrder = tierWeight * 4 + divisionOffset;
            const lp = Math.max(0, Number(queue && queue.lp) || 0);
            return { timestamp, tier, lp, rankOrder, score: rankOrder * 100 + lp };
        }

        function normalizeLpHistory(history) {
            if (!Array.isArray(history)) return [];
            return history.filter(point =>
                point && Number.isFinite(point.timestamp) &&
                typeof point.tier === 'string' &&
                Number.isFinite(point.lp) &&
                Number.isFinite(point.rankOrder) &&
                Number.isFinite(point.score)
            ).slice(-MAX_LP_HISTORY);
        }

        function rankChangeMessage(change, index) {
            const hiddenIds = settings.streamerMode && settings.streamerIds;
            const hiddenLogin = settings.streamerMode && settings.streamerLogin;
            const hiddenDesc = settings.streamerMode && settings.streamerDescs;
            const account = change.account;
            const name = (account.riotId && !hiddenIds ? account.riotId : '')
                || (account.loginUser && !hiddenLogin ? account.loginUser : '')
                || (account.description && !hiddenDesc ? account.description : '')
                || t('trayAccountN').replace('{n}', String(index + 1));
            const rankHidden = settings.streamerMode && settings.streamerIds;
            const previous = rankHidden ? '' : prettyTier(change.previous.tier);
            const current = rankHidden ? '' : prettyTier(change.current.tier);
            const promoted = change.current.rankOrder > change.previous.rankOrder;
            const direction = rankHidden
                ? (promoted ? 'rankPromotionPrivate' : 'rankDemotionPrivate')
                : (promoted ? 'rankPromotionNotice' : 'rankDemotionNotice');
            return t(direction)
                .replace('{name}', name)
                .replace('{previous}', previous)
                .replace('{current}', current);
        }

        function notifyRankChanges(changes) {
            if (!settings.rankChangeNotifications || !changes.length) return;
            const lines = changes.slice(0, 3).map(rankChangeMessage);
            if (changes.length > lines.length) lines.push(t('rankChangeMore').replace('{count}', String(changes.length - lines.length)));
            const message = lines.join(' · ');
            if (document.visibilityState === 'hidden') trayNotify(message);
            else showNeonNotification(message);
        }

        async function ensureDesktopNotificationPermission() {
            const NotificationApi = window.Notification;
            if (!NotificationApi) {
                showNeonNotification(t('desktopNotificationsUnsupported'));
                return false;
            }
            if (NotificationApi.permission === 'granted') return true;
            if (NotificationApi.permission === 'denied') {
                showNeonNotification(t('desktopNotificationsPermissionDenied'));
                return false;
            }

            try {
                const permission = await NotificationApi.requestPermission();
                if (permission === 'granted') return true;
                showNeonNotification(t('desktopNotificationsPermissionDenied'));
                return false;
            } catch (err) {
                console.error('No se pudo solicitar permiso para notificaciones de escritorio', err);
                showNeonNotification(t('desktopNotificationsPermissionDenied'));
                return false;
            }
        }

        function desktopRankChangeBody(change, index) {
            const hiddenIds = settings.streamerMode && settings.streamerIds;
            const hiddenLogin = settings.streamerMode && settings.streamerLogin;
            const hiddenDesc = settings.streamerMode && settings.streamerDescs;
            const account = change.account;
            const name = (account.riotId && !hiddenIds ? account.riotId : '')
                || (account.loginUser && !hiddenLogin ? account.loginUser : '')
                || (account.description && !hiddenDesc ? account.description : '')
                || t('trayAccountN').replace('{n}', String(change.accountIndex ?? index + 1));
            const rankChanged = change.previous.rankOrder !== change.current.rankOrder;
            const rankHidden = settings.streamerMode && settings.streamerIds;
            const details = [];

            if (!rankHidden) {
                const lpDelta = change.current.lp - change.previous.lp;
                if (lpDelta !== 0) details.push(`${lpDelta > 0 ? '+' : ''}${lpDelta} LP`);
            }
            if (rankChanged) {
                details.push(t(change.current.rankOrder > change.previous.rankOrder ? 'desktopRankUp' : 'desktopRankDown'));
            }
            if (!details.length) details.push(t('desktopLpChanged'));

            const queue = change.queue === 'flex' ? t('flex') : 'Solo/Duo';
            const rank = rankHidden ? '' : ` · ${prettyTier(change.current.tier)} (${change.current.lp} LP)`;
            return t('desktopRankChangeBody')
                .replace('{name}', name)
                .replace('{change}', details.join(' · '))
                .replace('{queue}', queue)
                .replace('{rank}', rank);
        }

        function notifyDesktopRankChanges(changes) {
            const enabledChanges = changes.filter(change => change.isFriend
                ? settings.friendsDesktopNotifications
                : settings.desktopRankNotifications);
            if (!enabledChanges.length) return;
            const NotificationApi = window.Notification;
            if (!NotificationApi || NotificationApi.permission !== 'granted') {
                console.warn('No se enviaron notificaciones de escritorio: el permiso no está concedido.');
                return;
            }

            enabledChanges.forEach((change, index) => {
                try {
                    new NotificationApi('Aurum Accounts', { body: desktopRankChangeBody(change, index) });
                } catch (err) {
                    console.error('No se pudo mostrar una notificación de escritorio', err);
                }
            });
        }

        function formatHistoryTimestamp(timestamp) {
            return new Date(timestamp).toLocaleString(currentLang, { dateStyle: 'short', timeStyle: 'short' });
        }

        function renderLpHistoryChart(history) {
            if (!history.length) return '<div class="lp-history-empty">—</div>';
            const width = 360, height = 112, inset = 12, plotLeft = 78;
            const rankColors = {
                IRON: '#a8a29e',
                BRONZE: '#d88752',
                SILVER: '#cbd5e1',
                GOLD: '#f4c95d',
                PLATINUM: '#58c5d8',
                EMERALD: '#42d392',
                DIAMOND: '#6ca8ff',
                MASTER: '#c084fc',
                GRANDMASTER: '#fb7185',
                CHALLENGER: '#f5dc8b',
                UNRANKED: '#94a3b8'
            };
            const rankClass = tier => {
                const base = String(tier || 'UNRANKED').toUpperCase().split(/\s+/)[0];
                return `rank-${rankColors[base] ? base.toLowerCase() : 'unranked'}`;
            };
            const last = history[history.length - 1];
            const tierBase = last.tier.split(/\s+/)[0];
            const rankStep = ['MASTER', 'GRANDMASTER', 'CHALLENGER', 'UNRANKED'].includes(tierBase) ? 4 : 1;
            const upperReference = tierBase === 'UNRANKED' ? rankWeights.IRON * 4 : last.rankOrder + rankStep;
            const lowerReference = tierBase === 'UNRANKED' ? -1 : last.rankOrder - rankStep;
            const referenceOrders = [
                ...(upperReference <= rankWeights.CHALLENGER * 4 ? [upperReference] : []),
                ...(lowerReference >= 0 ? [lowerReference] : [])
            ];
            const rankAtOrder = order => {
                const weight = Math.floor(order / 4);
                const base = Object.keys(rankWeights).find(tier => rankWeights[tier] === weight) || 'UNRANKED';
                const division = ['IV', 'III', 'II', 'I'][order % 4];
                return weight >= 8 || base === 'UNRANKED' ? base : `${base} ${division}`;
            };
            const references = referenceOrders.map(order => ({
                score: order * 100,
                tier: rankAtOrder(order),
                label: prettyTier(rankAtOrder(order))
            }));
            const values = history.map(point => point.score).concat(references.map(point => point.score));
            const min = Math.min(...values), max = Math.max(...values);
            const spread = Math.max(100, max - min);
            const yForScore = score => height - inset - ((score - min) / spread) * (height - inset * 2);
            const points = history.map((point, index) => {
                const x = history.length === 1 ? (plotLeft + width) / 2 : plotLeft + index * (width - plotLeft - inset) / (history.length - 1);
                const y = yForScore(point.score);
                return { x, y, point };
            });
            const trend = history.length > 1 ? history[history.length - 1].score - history[0].score : 0;
            const trendText = t('lpTrend').replace('{value}', `${trend > 0 ? '+' : ''}${trend}`);
            const trendClass = trend > 0 ? 'up' : trend < 0 ? 'down' : 'steady';
            const chartSegments = points.slice(1).map((point, index) => {
                const previous = points[index];
                return `<path class="lp-history-line ${rankClass(point.point.tier)}" d="M${previous.x.toFixed(1)},${previous.y.toFixed(1)} L${point.x.toFixed(1)},${point.y.toFixed(1)}"></path>`;
            }).join('');
            const chartPoints = points.map(({ x, y, point }) =>
                `<circle class="${rankClass(point.tier)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${escapeHtml(formatHistoryTimestamp(point.timestamp))} · ${escapeHtml(prettyTier(point.tier))} · ${point.lp} LP</title></circle>`
            ).join('');
            const referenceLines = references.map(reference => {
                const y = yForScore(reference.score);
                return `<line class="lp-history-reference ${rankClass(reference.tier)}" x1="${plotLeft}" x2="${width}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"><title>${escapeHtml(reference.label)}</title></line>
                    <text class="lp-history-reference-label ${rankClass(reference.tier)}" x="0" y="${Math.max(10, Math.min(height - 3, y - 3)).toFixed(1)}">${escapeHtml(reference.label)}</text>`;
            }).join('');
            const first = history[0];

            return `<div class="lp-history-chart-wrap">
                <div class="lp-history-summary">
                    <span class="lp-history-count">${history.length}</span>
                    <span class="lp-history-trend ${trendClass}">${escapeHtml(trendText)}</span>
                </div>
                <svg class="lp-history-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(t('lpHistoryChartLabel').replace('{count}', history.length))}">
                    <path class="lp-history-gridline" d="M${plotLeft} ${height / 2}H${width}"></path>
                    ${referenceLines}
                    ${chartSegments}
                    ${chartPoints}
                </svg>
                <div class="lp-history-dates"><span>${escapeHtml(formatHistoryTimestamp(first.timestamp))}</span><span>${escapeHtml(formatHistoryTimestamp(last.timestamp))}</span></div>
            </div>`;
        }

        function renderLpHistory(account) {
            const soloHistory = normalizeLpHistory(account.lpHistory).slice(-CHART_LP_HISTORY);
            const flexHistory = normalizeLpHistory(account.lpHistoryFlex).slice(-CHART_LP_HISTORY);
            if (!soloHistory.length && !flexHistory.length) return '';
            const initialQueue = soloHistory.length ? 'solo' : 'flex';

            return `<div class="lp-history card-section sens sens-id" aria-label="${escapeHtml(t('lpHistoryTitle'))}">
                <div class="lp-history-head">
                    <span class="sec-label">${escapeHtml(t('lpHistoryTitle'))}</span>
                    <div class="lp-history-tabs" role="group" aria-label="${escapeHtml(t('lpHistoryTitle'))}">
                        <button type="button" class="lp-history-tab ${initialQueue === 'solo' ? 'active' : ''}" aria-pressed="${initialQueue === 'solo'}" data-lp-queue="solo">Solo/Duo</button>
                        <button type="button" class="lp-history-tab ${initialQueue === 'flex' ? 'active' : ''}" aria-pressed="${initialQueue === 'flex'}" data-lp-queue="flex">${escapeHtml(t('flex'))}</button>
                    </div>
                </div>
                <div class="lp-history-panel" data-lp-history-panel="solo" ${initialQueue === 'flex' ? 'hidden' : ''}>${renderLpHistoryChart(soloHistory)}</div>
                <div class="lp-history-panel" data-lp-history-panel="flex" ${initialQueue === 'solo' ? 'hidden' : ''}>${renderLpHistoryChart(flexHistory)}</div>
            </div>`;
        }

        function showNeonNotification(message) {
            const existingToast = document.querySelector('.neon-toast');
            if (existingToast) existingToast.remove();

            const toast = document.createElement('div');
            toast.className = 'neon-toast';
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('width', '20');
            icon.setAttribute('height', '20');
            icon.setAttribute('viewBox', '0 0 24 24');
            icon.setAttribute('fill', 'none');
            icon.setAttribute('stroke', '#38bdf8');
            icon.setAttribute('stroke-width', '2.5');
            icon.setAttribute('stroke-linecap', 'round');
            icon.setAttribute('stroke-linejoin', 'round');
            icon.innerHTML = '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>';
            const text = document.createElement('span');
            text.textContent = message;
            toast.append(icon, text);
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('hiding');
                setTimeout(() => toast.remove(), 400);
            }, 4000);
        }

        const achievementsModal = document.getElementById('achievements-modal');
        const achievementsAccount = document.getElementById('achievements-account');
        const achievementsList = document.getElementById('achievements-list');

        function openAchievements(account, state) {
            achievementsAccount.textContent = account.riotId || account.loginUser || '';
            achievementsList.innerHTML = window.aurumAchievements.catalog
                .filter(achievement => !achievement.secret || state.unlocked[achievement.id])
                .map(achievement => {
                const unlockedAt = state.unlocked[achievement.id];
                const isUnlocked = !!unlockedAt;
                let dateLabel = '';
                if (isUnlocked) {
                    const date = new Date(unlockedAt);
                    if (Number.isFinite(date.getTime())) {
                        dateLabel = `${t('achievementUnlockedAt')} · ${date.toLocaleString(currentLang, { dateStyle: 'medium', timeStyle: 'short' })}`;
                    }
                }
                return `<article class="achievement-item ${isUnlocked ? 'unlocked' : 'locked'}">
                    <span class="achievement-icon" aria-hidden="true">🏆</span>
                    <div class="achievement-copy">
                        <h4>${escapeHtml(t(achievement.nameKey))}</h4>
                        <p>${escapeHtml(t(achievement.descriptionKey))}</p>
                        <span class="achievement-status">${escapeHtml(dateLabel || t(isUnlocked ? 'achievementUnlockedAt' : 'achievementLocked'))}</span>
                    </div>
                </article>`;
            }).join('');
            achievementsModal.style.display = 'flex';
            achievementsModal.setAttribute('aria-hidden', 'false');
            document.getElementById('achievements-close').focus();
        }

        const masteryModal = document.getElementById('mastery-modal');
        const masteryAccountLabel = document.getElementById('mastery-account');
        const masteryLevelLabel = document.getElementById('mastery-level');
        const masteryXpLabel = document.getElementById('mastery-xp');
        const masteryProgress = document.getElementById('mastery-progress');
        const masteryProgressFill = document.getElementById('mastery-progress-fill');
        const masteryNextLevel = document.getElementById('mastery-next-level');
        const masteryTitleSelect = document.getElementById('mastery-title-select');
        let masteryAccountId = null;

        function openMastery(account, state = window.aurumMastery.getState(account)) {
            masteryAccountId = account.id;
            masteryAccountLabel.textContent = account.riotId || account.loginUser || '';
            masteryLevelLabel.textContent = t(`masteryLevel${state.level}`);
            masteryXpLabel.textContent = t('masteryXpProgress').replace('{xp}', state.xp.toLocaleString(currentLang));
            masteryProgress.setAttribute('aria-valuenow', String(state.progressPercent));
            masteryProgress.setAttribute('aria-valuetext', `${state.progressPercent}%`);
            masteryProgressFill.style.width = `${state.progressPercent}%`;
            masteryNextLevel.textContent = state.nextLevel
                ? t('masteryNextLevel').replace('{xp}', (state.xpForNextLevel - state.xpIntoLevel).toLocaleString(currentLang))
                : t('masteryMaxLevel');
            masteryTitleSelect.innerHTML = state.unlockedTitles.map(title =>
                `<option value="${escapeHtml(title.id)}">${escapeHtml(t(title.nameKey))}</option>`
            ).join('');
            masteryTitleSelect.value = state.equippedTitleId;
            masteryModal.style.display = 'flex';
            masteryModal.setAttribute('aria-hidden', 'false');
            document.getElementById('mastery-close').focus();
        }

        function closeMastery() {
            masteryModal.style.display = 'none';
            masteryModal.setAttribute('aria-hidden', 'true');
            masteryAccountId = null;
        }

        document.getElementById('mastery-close').addEventListener('click', closeMastery);
        document.getElementById('mastery-save').addEventListener('click', () => {
            const account = readAccounts().find(item => item.id === masteryAccountId);
            if (!account) {
                closeMastery();
                return;
            }
            try {
                window.aurumMastery.equipTitle(account, masteryTitleSelect.value);
                closeMastery();
                loadAccounts();
            } catch (error) {
                console.error('No se pudo equipar el título de maestría:', error);
                showNeonNotification(t('masteryEquipFailed'));
            }
        });
        masteryModal.addEventListener('click', event => {
            if (event.target === masteryModal) closeMastery();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && masteryModal.style.display === 'flex') closeMastery();
        });

        const hextechChestButton = document.getElementById('hextech-chest-button');
        const hextechChestCount = document.getElementById('hextech-chest-count');
        const hextechChestModal = document.getElementById('hextech-chest-modal');
        const hextechChestCanvas = document.getElementById('hextech-chest-canvas');
        const hextechChestStatus = document.getElementById('hextech-chest-status');
        const hextechChestReward = document.getElementById('hextech-chest-reward');
        const hextechChestAccount = document.getElementById('hextech-chest-account');
        const hextechChestFragments = document.getElementById('hextech-chest-fragments-list');
        const hextechChestOpenButton = document.getElementById('hextech-chest-open');
        const hextechChestClaimButton = document.getElementById('hextech-chest-claim');
        let cancelHextechChestAnimation = null;

        function refreshHextechChestButton() {
            try {
                const state = window.aurumHextechChest.getState();
                hextechChestCount.textContent = String(state.available);
                hextechChestButton.setAttribute('aria-label', t('chestButtonLabel').replace('{count}', String(state.available)));
                hextechChestButton.title = t('chestButtonTitle').replace('{count}', String(state.available));
                hextechChestButton.classList.toggle('has-chest', state.available > 0);
                hextechChestButton.disabled = false;
            } catch (error) {
                console.error('No se pudo actualizar el indicador de cofres Hextech:', error);
                hextechChestButton.disabled = true;
                hextechChestButton.title = t('chestStorageError');
            }
        }

        function renderHextechChestFragments(fragments) {
            hextechChestFragments.innerHTML = fragments.length
                ? fragments.map(fragment => `<p>${escapeHtml(t(`chestFragment${fragment.id[0].toUpperCase()}${fragment.id.slice(1)}`))}</p>`).join('')
                : `<p class="hextech-chest-empty">${escapeHtml(t('chestNoFragments'))}</p>`;
        }

        function renderHextechChestReward(reward) {
            let title = '';
            let description = '';
            if (reward.type === 'masteryXp') {
                title = t('chestRewardMastery');
                description = t('chestRewardXpAmount').replace('{xp}', String(reward.xp));
            } else if (reward.type === 'emblem') {
                const emblem = window.aurumHextechChest.cosmetics.find(item => item.id === reward.emblemId);
                title = emblem ? t(emblem.nameKey) : t('chestRewardEmblem');
                description = reward.permanent ? t('chestDurationPermanent') : t('chestDuration24Hours');
            } else {
                title = t('chestRewardFragment');
                description = t(`chestFragment${reward.fragmentId[0].toUpperCase()}${reward.fragmentId.slice(1)}`);
            }
            hextechChestReward.innerHTML = `<span class="hextech-reward-kicker">${escapeHtml(t('chestRewardRevealed'))}</span>
                <strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p>`;
            hextechChestReward.hidden = false;
            hextechChestOpenButton.hidden = true;
            hextechChestClaimButton.hidden = false;
            hextechChestClaimButton.disabled = reward.type === 'masteryXp' && hextechChestAccount.options.length === 0;
            hextechChestStatus.textContent = t('chestReadyToClaim');
            hextechChestAccount.closest('.hextech-chest-account-field').hidden = reward.type !== 'masteryXp';
        }

        function refreshHextechChestModal() {
            const accounts = readAccounts();
            const selectedId = activeClientAccountId && accounts.some(account => account.id === activeClientAccountId)
                ? activeClientAccountId
                : accounts[0] && accounts[0].id;
            hextechChestAccount.innerHTML = accounts.map((account, index) => {
                const streamerLabel = settings.streamerMode && settings.streamerIds
                    ? t('chestAccountN').replace('{n}', String(index + 1))
                    : account.riotId || account.loginUser || account.id;
                return `<option value="${escapeHtml(account.id)}">${escapeHtml(streamerLabel)}</option>`;
            }).join('');
            hextechChestAccount.disabled = accounts.length === 0;
            if (selectedId) hextechChestAccount.value = selectedId;

            const state = window.aurumHextechChest.getState();
            renderHextechChestFragments(state.fragments);
            hextechChestReward.hidden = true;
            hextechChestClaimButton.hidden = true;
            hextechChestOpenButton.hidden = false;
            hextechChestOpenButton.disabled = state.available < 1;
            hextechChestStatus.textContent = state.pendingReward
                ? t('chestPendingReward')
                : state.available
                    ? t('chestDailyHint').replace('{count}', String(state.available))
                    : t('chestNoneAvailable');
            if (state.pendingReward) renderHextechChestReward(state.pendingReward);
        }

        function openHextechChestModal() {
            refreshHextechChestModal();
            hextechChestModal.style.display = 'flex';
            hextechChestModal.setAttribute('aria-hidden', 'false');
            (hextechChestModal.querySelector('#hextech-chest-claim:not([hidden])')
                || hextechChestModal.querySelector('#hextech-chest-open')).focus();
        }

        function closeHextechChestModal() {
            if (cancelHextechChestAnimation) {
                cancelHextechChestAnimation();
                cancelHextechChestAnimation = null;
            }
            hextechChestModal.style.display = 'none';
            hextechChestModal.setAttribute('aria-hidden', 'true');
        }

        hextechChestButton.addEventListener('click', openHextechChestModal);
        document.getElementById('hextech-chest-close').addEventListener('click', closeHextechChestModal);
        hextechChestModal.addEventListener('click', event => {
            if (event.target === hextechChestModal) closeHextechChestModal();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && hextechChestModal.style.display === 'flex') closeHextechChestModal();
        });
        hextechChestOpenButton.addEventListener('click', () => {
            try {
                const reward = window.aurumHextechChest.openChest({ allowMasteryXp: readAccounts().length > 0 });
                refreshHextechChestButton();
                hextechChestOpenButton.disabled = true;
                hextechChestStatus.textContent = t('chestOpening');
                cancelHextechChestAnimation = window.aurumHextechChest.animateOpening(hextechChestCanvas, () => {
                    cancelHextechChestAnimation = null;
                    renderHextechChestReward(reward);
                    refreshHextechChestButton();
                });
            } catch (error) {
                console.error('No se pudo abrir el cofre Hextech:', error);
                showNeonNotification(t('chestOpenError'));
                refreshHextechChestModal();
            }
        });
        hextechChestClaimButton.addEventListener('click', () => {
            try {
                const state = window.aurumHextechChest.getState();
                if (!state.pendingReward) {
                    refreshHextechChestModal();
                    return;
                }
                const account = state.pendingReward.type === 'masteryXp'
                    ? readAccounts().find(item => item.id === hextechChestAccount.value)
                    : null;
                const claimed = window.aurumHextechChest.claimPending(account);
                refreshHextechChestButton();
                if (claimed.type === 'masteryXp') loadAccounts();
                showNeonNotification(t('chestClaimed'));
                closeHextechChestModal();
            } catch (error) {
                console.error('No se pudo reclamar la recompensa del cofre Hextech:', error);
                showNeonNotification(t('chestClaimError'));
            }
        });
        window.addEventListener('aurum-hextech-chest-earned', event => {
            refreshHextechChestButton();
            const earned = Number(event.detail && event.detail.earned) || 0;
            if (earned) showNeonNotification(t('chestBonusEarned').replace('{count}', String(earned)));
        });
        refreshHextechChestButton();
        setInterval(refreshHextechChestButton, 60 * 1000);

        function closeAchievements() {
            achievementsModal.style.display = 'none';
            achievementsModal.setAttribute('aria-hidden', 'true');
        }

        document.getElementById('achievements-close').addEventListener('click', closeAchievements);
        achievementsModal.addEventListener('click', event => {
            if (event.target === achievementsModal) closeAchievements();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && achievementsModal.style.display === 'flex') closeAchievements();
        });

        const gamerCardModal = document.getElementById('gamer-card-modal');
        const gamerCardPreview = document.getElementById('gamer-card-preview');
        let currentGamerCardCanvas = null;

        function gamerCardLabels() {
            const activeEmblem = window.aurumHextechChest.getState().activeEmblem;
            return {
                region: t('gamerCardRegion'),
                rank: t('gamerCardRank'),
                winRate: t('gamerCardWinRate'),
                streak: t('gamerCardStreak'),
                trophies: t('gamerCardTrophies'),
                games: t('gamerCardGames'),
                game: t('gamerCardGame'),
                wins: t('gamerCardWins'),
                win: t('gamerCardWin'),
                losses: t('gamerCardLosses'),
                loss: t('gamerCardLoss'),
                none: t('gamerCardNone'),
                unranked: t('gamerCardUnranked'),
                noData: t('gamerCardNoData'),
                recentGames: t('gamerCardRecentGames'),
                unlocked: t('gamerCardUnlocked'),
                shareCard: t('gamerCardShareCard'),
                emblem: activeEmblem ? t(activeEmblem.nameKey) : '',
                emblemId: activeEmblem ? activeEmblem.id : ''
            };
        }

        async function openGamerCard(account, achievementState) {
            try {
                const topChampion = Array.isArray(account.topChampions)
                    ? account.topChampions.reduce((best, champion) => {
                        const games = Number(champion.wins || 0) + Number(champion.losses || 0);
                        const bestGames = best ? Number(best.wins || 0) + Number(best.losses || 0) : -1;
                        return games > bestGames ? champion : best;
                    }, null)
                    : null;
                const championKey = topChampion ? champId(topChampion.name) : null;
                const assets = await window.aurumGamerCardBridge.getAssets(championKey);
                currentGamerCardCanvas = await window.aurumGamerCard.createGamerCard(
                    account,
                    achievementState,
                    gamerCardLabels(),
                    assets
                );
                gamerCardPreview.replaceChildren(currentGamerCardCanvas);
                gamerCardModal.style.display = 'flex';
                gamerCardModal.setAttribute('aria-hidden', 'false');
                document.getElementById('gamer-card-download').focus();
            } catch (error) {
                console.error('No se pudo generar la Gamer Card:', error);
                showNeonNotification(t('gamerCardExportFailed'));
            }
        }

        function closeGamerCard() {
            gamerCardModal.style.display = 'none';
            gamerCardModal.setAttribute('aria-hidden', 'true');
            currentGamerCardCanvas = null;
            gamerCardPreview.replaceChildren();
        }

        document.getElementById('gamer-card-close').addEventListener('click', closeGamerCard);
        gamerCardModal.addEventListener('click', event => {
            if (event.target === gamerCardModal) closeGamerCard();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && gamerCardModal.style.display === 'flex') closeGamerCard();
        });
        function canvasToPngBlob(canvas) {
            return new Promise((resolve, reject) => {
                canvas.toBlob(blob => {
                    if (blob) resolve(blob);
                    else reject(new Error('El canvas no pudo generar un PNG.'));
                }, 'image/png');
            });
        }

        document.getElementById('gamer-card-download').addEventListener('click', async () => {
            if (!currentGamerCardCanvas) return;
            let objectUrl = null;
            try {
                const blob = await canvasToPngBlob(currentGamerCardCanvas);
                const link = document.createElement('a');
                link.download = 'aurum-gamer-card.png';
                objectUrl = URL.createObjectURL(blob);
                link.href = objectUrl;
                link.click();
                setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
                showNeonNotification(t('gamerCardDownloaded'));
            } catch (error) {
                console.error('No se pudo exportar la Gamer Card:', error);
                showNeonNotification(t('gamerCardExportFailed'));
                if (objectUrl) URL.revokeObjectURL(objectUrl);
            }
        });

        const poroGameModal = document.getElementById('poro-game-modal');
        const poroGameFab = document.getElementById('poro-game-fab');
        const poroGameCanvas = document.getElementById('poro-game-canvas');
        const poroGameScore = document.getElementById('poro-game-score');
        const poroGameHighScore = document.getElementById('poro-game-high-score');
        const poroGameStatus = document.getElementById('poro-game-status');
        const poroGameStart = document.getElementById('poro-game-start');
        let poroGame = null;

        function openPoroGame() {
            if (gameflowPhase === 'READYCHECK') return;
            if (!poroGame) {
                poroGame = window.aurumPoroDodge.createPoroDodge(
                    poroGameCanvas,
                    {
                        get ready() { return t('poroReady'); },
                        get instructions() { return t('poroInstructions'); },
                        get gameOver() { return t('poroGameOver'); },
                        get restartHint() { return t('poroRestartHint'); }
                    },
                    (score, highScore) => {
                        poroGameScore.textContent = String(score);
                        poroGameHighScore.textContent = String(highScore);
                    },
                    () => {
                        try {
                            const accounts = readAccounts();
                            const account = accounts.find(item => item.id === activeClientAccountId)
                                || accounts[0]
                                || { id: 'poro-dodge-player' };
                            const unlock = window.aurumAchievements.unlockAchievement(account, 'poro_dodger');
                            if (unlock.newlyUnlocked) {
                                showNeonNotification(t('poroAchievementToast'));
                                if (account.id !== 'poro-dodge-player') loadAccounts();
                            }
                        } catch (error) {
                            console.error('No se pudo desbloquear el logro de Poro Dodge:', error);
                        }
                    },
                    () => {
                        poroGameStatus.textContent = t('poroGameOver');
                        poroGameStart.textContent = t('poroRestart');
                    }
                );
                poroGameHighScore.textContent = String(poroGame.highScore);
            }
            poroGameStatus.textContent = t('poroInstructions');
            poroGameStart.textContent = t('poroStart');
            poroGameModal.style.display = 'flex';
            poroGameModal.setAttribute('aria-hidden', 'false');
            document.getElementById('poro-game-close').focus();
        }

        function closePoroGame() {
            if (poroGame) poroGame.pause();
            poroGameModal.style.display = 'none';
            poroGameModal.setAttribute('aria-hidden', 'true');
        }

        poroGameFab.addEventListener('click', openPoroGame);
        document.getElementById('poro-game-settings-open').addEventListener('click', openPoroGame);
        document.getElementById('poro-game-close').addEventListener('click', closePoroGame);
        poroGameModal.addEventListener('click', event => {
            if (event.target === poroGameModal) closePoroGame();
        });
        poroGameStart.addEventListener('click', () => {
            if (!poroGame) return;
            poroGameStart.textContent = t('poroStart');
            poroGameStatus.textContent = t('poroInstructions');
            poroGame.start();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && poroGameModal.style.display === 'flex') closePoroGame();
        });

        // Escapa un texto para SendKeys (+ ^ % ~ ( ) { } [ ] tienen significado especial)
        // y lo devuelve como cadena literal de PowerShell entre comillas simples.
        function sendKeysLiteral(str) {
            const escaped = String(str ?? '').replace(/[+^%~(){}\[\]]/g, c => `{${c}}`);
            return "'" + escaped.replace(/'/g, "''") + "'";
        }

        function getRiotClientPath() {
            try {
                const installs = JSON.parse(fs.readFileSync('C:\\ProgramData\\Riot Games\\RiotClientInstalls.json', 'utf-8'));
                const p = installs.rc_default || installs.rc_live;
                if (p && fs.existsSync(p)) return p;
            } catch (e) { /* sin archivo de instalaciones: probamos la ruta por defecto */ }
            const fallback = 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe';
            return fs.existsSync(fallback) ? fallback : null;
        }

        const LEAGUE_LAUNCH_ARGS = ['--launch-product=league_of_legends', '--launch-patchline=live'];

        // Devuelve true si se pudo lanzar
        function launchLeague() {
            const rcPath = getRiotClientPath();
            if (!rcPath) return false;
            const child = spawn(rcPath, LEAGUE_LAUNCH_ARGS, { detached: true, stdio: 'ignore' });
            child.on('error', () => { /* si no arranca, waitForLeagueClient acabará avisando */ });
            child.unref();
            return true;
        }

        // PIDs de los procesos con ese nombre de imagen (siempre resuelve, aunque tasklist falle)
        function listProcessPids(imageName) {
            return new Promise(resolve => {
                exec(`tasklist /fi "imagename eq ${imageName}" /fo csv /nh`, { windowsHide: true }, (err, stdout) => {
                    const pids = new Set();
                    String(stdout || '').split(/\r?\n/).forEach(line => {
                        const m = /^"[^"]*","(\d+)"/.exec(line.trim());
                        if (m) pids.add(Number(m[1]));
                    });
                    resolve(pids);
                });
            });
        }
        const LEAGUE_IMAGES = ['LeagueClient.exe', 'LeagueClientUx.exe', 'LeagueClientUX.exe'];
        function listLeaguePids() {
            return Promise.all(LEAGUE_IMAGES.map(listProcessPids)).then(sets => new Set(sets.flatMap(set => [...set])));
        }

        // ---------- API local del Riot Client ----------
        // El cliente publica su puerto y contraseña en un "lockfile"; con eso se le puede pedir
        // abrir el juego directamente, sin depender de la ventana ni de pulsar "Jugar".
        function readRiotLockfile() {
            const lockPath = path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'Riot Client', 'Config', 'lockfile');
            try {
                return parseClientLockfile(fs.readFileSync(lockPath, 'utf8'));
            } catch (e) {
                return null;
            }
        }

        function parseClientLockfile(contents) {
            const [, , rawPort, password] = String(contents).trim().split(':');
            const port = Number(rawPort);
            return Number.isInteger(port) && port > 0 && port <= 65535 && password ? { port, password } : null;
        }

        function readLeagueClientLockfile() {
            const installsPath = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Riot Games', 'RiotClientInstalls.json');
            const installDirs = [];
            try {
                const installs = JSON.parse(fs.readFileSync(installsPath, 'utf8'));
                const installPath = typeof installs.product_install_full_path === 'string' ? installs.product_install_full_path : '';
                const installRoot = typeof installs.product_install_root === 'string' ? installs.product_install_root : '';
                const clientPaths = [installs.rc_default, installs.rc_live]
                    .filter(value => typeof value === 'string' && value);
                const siblingGameDirs = clientPaths.map(clientPath =>
                    path.join(path.dirname(path.dirname(clientPath)), 'League of Legends')
                );
                const gamePath = typeof installs.league_of_legends === 'string' ? installs.league_of_legends : '';
                installDirs.push(...[
                    gamePath,
                    installPath && path.extname(installPath) ? path.dirname(installPath) : installPath,
                    installRoot,
                    installRoot && path.join(installRoot, 'League of Legends'),
                    ...siblingGameDirs
                ].filter(Boolean));
            } catch (e) { /* Se prueban las rutas de instalación habituales como respaldo. */ }
            for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Riot Games']) {
                if (base) installDirs.push(path.join(base, 'Riot Games', 'League of Legends'), path.join(base, 'League of Legends'));
            }
            for (const dir of [...new Set(installDirs)]) {
                try {
                    const lock = parseClientLockfile(fs.readFileSync(path.join(dir, 'lockfile'), 'utf8'));
                    if (lock) return lock;
                } catch (e) { /* El cliente aún no creó el lockfile de juego en esta ubicación. */ }
            }
            return null;
        }

        function readLeagueClientProcessLockfile() {
            return new Promise(resolve => {
                const command = `Get-CimInstance Win32_Process -Filter "name = 'LeagueClientUx.exe'" | ForEach-Object { $_.CommandLine }`;
                execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
                    windowsHide: true,
                    timeout: 3000,
                    maxBuffer: 64 * 1024
                }, (error, stdout) => {
                    if (error) {
                        resolve(null);
                        return;
                    }
                    const commandLine = String(stdout || '');
                    const port = Number(/--app-port(?:=|\s+)(\d+)/i.exec(commandLine)?.[1]);
                    const password = /--remoting-auth-token(?:=|\s+)["']?([^\s"']+)/i.exec(commandLine)?.[1];
                    resolve(Number.isInteger(port) && port > 0 && port <= 65535 && password
                        ? { port, password }
                        : null);
                });
            });
        }

        function clientResponseJson(response, endpoint) {
            if (!response.ok) return null;
            try {
                return JSON.parse(response.body);
            } catch (e) {
                console.warn(`Respuesta inesperada del cliente de League of Legends (${endpoint})`, e.message);
                return null;
            }
        }

        function clientRankQueue(queue) {
            if (!queue || typeof queue !== 'object') return null;
            let baseTier = String(queue.tier || '').toUpperCase().trim();
            if (!baseTier) return null;
            if (baseTier === 'NONE') baseTier = 'UNRANKED';
            const division = String(queue.division || '').toUpperCase().trim();
            const tier = ['MASTER', 'GRANDMASTER', 'CHALLENGER', 'UNRANKED'].includes(baseTier) || !division
                ? baseTier
                : `${baseTier} ${division}`;
            const lp = Number(queue.leaguePoints);
            return { tier, lp: Number.isFinite(lp) ? Math.max(0, lp) : 0 };
        }

        async function readGameClientProfile(lock) {
            const endpoints = [
                ['/lol-summoner/v1/current-summoner', 'summoner'],
                ['/lol-chat/v1/me', 'identity'],
                ['/lol-ranked/v1/current-ranked-stats', 'ranked']
            ];
            const responses = await Promise.all(endpoints.map(([endpoint]) =>
                riotClientRequest('GET', endpoint, lock)
            ));
            const [summoner, identity, ranked] = responses.map((response, index) =>
                clientResponseJson(response, endpoints[index][1])
            );
            if (!summoner && !identity) return null;

            const gameName = String(identity && identity.gameName || '').trim();
            const gameTag = String(identity && identity.gameTag || '').trim().replace(/^#/, '');
            const riotId = gameName && gameTag ? `${gameName}#${gameTag}` : '';
            const platform = String(
                (identity && (identity.platformId || identity.pid)) ||
                (summoner && (summoner.platformId || summoner.region)) || ''
            ).trim();
            const queueMap = ranked && ranked.queueMap && typeof ranked.queueMap === 'object' ? ranked.queueMap : {};
            const profileIconId = Number(summoner && summoner.profileIconId);
            const level = Number(summoner && summoner.summonerLevel);

            return {
                puuid: String((summoner && summoner.puuid) || (identity && identity.puuid) || '').trim(),
                riotId,
                region: normalizeRegion(platform),
                profileIconId: Number.isInteger(profileIconId) && profileIconId > 0 ? profileIconId : null,
                level: Number.isFinite(level) && level > 0 ? level : null,
                soloq: clientRankQueue(queueMap.RANKED_SOLO_5x5),
                flex: clientRankQueue(queueMap.RANKED_FLEX_SR)
            };
        }

        function matchesClientAccount(account, profile) {
            if (profile.puuid && account.puuid) {
                return profile.puuid.toLowerCase() === String(account.puuid).toLowerCase();
            }
            if (!profile.riotId || String(account.riotId || '').trim().toLowerCase() !== profile.riotId.toLowerCase()) return false;
            return !profile.region || normalizeRegion(account.region) === profile.region;
        }

        function applyClientQueue(account, key, incoming, rankChanges) {
            if (!incoming) return false;
            const current = account[key] || EMPTY_QUEUE();
            const changed = current.tier !== incoming.tier || Number(current.lp) !== incoming.lp;
            let historyChanged = false;

            if (changed) account[key] = { ...current, ...incoming };
            if (key === 'soloq') {
                const previousHistory = normalizeLpHistory(account.lpHistory);
                const nextSnapshot = createRankSnapshot(incoming);
                if (!previousHistory.length) {
                    previousHistory.push(nextSnapshot);
                    historyChanged = true;
                } else {
                    const previousPoint = previousHistory[previousHistory.length - 1];
                    if (previousPoint.tier !== nextSnapshot.tier || previousPoint.lp !== nextSnapshot.lp) {
                        if (previousPoint.rankOrder !== nextSnapshot.rankOrder) {
                            rankChanges.push({
                                account,
                                previous: createRankSnapshot(previousPoint),
                                current: nextSnapshot
                            });
                        }
                        previousHistory.push(nextSnapshot);
                        historyChanged = true;
                    }
                }
                if (historyChanged) account.lpHistory = previousHistory.slice(-MAX_LP_HISTORY);
            }
            return changed || historyChanged;
        }

        function setPoroGameflowPhase(phase) {
            const normalized = String(phase || '').trim().toUpperCase();
            if (!normalized) return;
            const previousPhase = gameflowPhase;
            gameflowPhase = normalized;
            if (normalized !== 'INPROGRESS') {
                latestFocusQueueId = null;
                latestFocusQueueName = '';
                latestFocusStartedAt = null;
            } else if (previousPhase !== normalized) {
                latestFocusQueueId = null;
                latestFocusQueueName = '';
                latestFocusStartedAt = null;
            }
            if (previousPhase !== normalized) updateRankedFocusState();

            if (normalized === 'READYCHECK') {
                if (previousPhase !== normalized) window.aurumSoundboard.play('readyCheck');
                poroGameFab.hidden = true;
                if (poroGameModal.style.display === 'flex') closePoroGame();
                return;
            }

            const queuePhase = normalized === 'LOBBY' || normalized === 'MATCHMAKING';
            poroGameFab.hidden = !queuePhase;
        }

        async function pollGameflowPhase() {
            if (gameflowSyncBusy) return;
            gameflowSyncBusy = true;
            try {
                const lock = readLeagueClientLockfile() || latestGameClientLock;
                if (!lock) {
                    setPoroGameflowPhase('NONE');
                    return;
                }
                const response = await riotClientRequest('GET', '/lol-gameflow/v1/gameflow-phase', lock, 1000);
                if (!response.ok) return;
                let phase;
                try { phase = JSON.parse(response.body); }
                catch (error) { phase = String(response.body || '').trim().replace(/^"|"$/g, ''); }
                if (typeof phase === 'string') {
                    setPoroGameflowPhase(phase);
                    if (phase.toUpperCase() === 'INPROGRESS' && Date.now() - lastFocusSessionSyncAt >= 5000) {
                        lastFocusSessionSyncAt = Date.now();
                        await syncRankedFocusSession(lock);
                    }
                }
            } catch (error) {
                console.warn('No se pudo consultar el estado de cola del cliente LCU:', error.message);
            } finally {
                gameflowSyncBusy = false;
            }
        }

        function syncClientProfile(profile) {
            const accounts = readAccounts();
            const matchedAccount = accounts.find(account => matchesClientAccount(account, profile));
            const previousActiveId = activeClientAccountId;
            const rankChanges = [];
            let changed = false;

            if (matchedAccount) {
                activeClientAccountId = matchedAccount.id;
                if (profile.puuid && matchedAccount.puuid !== profile.puuid) {
                    matchedAccount.puuid = profile.puuid;
                    changed = true;
                }
                if (profile.riotId && matchedAccount.riotId !== profile.riotId) {
                    matchedAccount.riotId = profile.riotId;
                    changed = true;
                }
                if (profile.region && matchedAccount.region !== profile.region) {
                    matchedAccount.region = profile.region;
                    changed = true;
                }
                if (profile.profileIconId && matchedAccount.profileIconId !== profile.profileIconId) {
                    matchedAccount.profileIconId = profile.profileIconId;
                    changed = true;
                }
                if (profile.level && matchedAccount.level !== profile.level) {
                    matchedAccount.level = profile.level;
                    changed = true;
                }
                changed = applyClientQueue(matchedAccount, 'soloq', profile.soloq, rankChanges) || changed;
                changed = applyClientQueue(matchedAccount, 'flex', profile.flex, rankChanges) || changed;
            } else {
                activeClientAccountId = null;
            }

            if (changed) writeAccounts(accounts);
            updateRankedFocusState();
            if (changed || previousActiveId !== activeClientAccountId) loadAccounts();
            if (rankChanges.length) notifyRankChanges(rankChanges);
            latestClientSnapshot = profile;
            setClientSyncState(
                matchedAccount ? 'active' : 'unknown',
                matchedAccount ? 'clientSyncActive' : 'clientSyncUnknown',
                !matchedAccount && !!profile.riotId
            );
        }

        function importDetectedClientAccount() {
            if (!latestClientSnapshot || !latestClientSnapshot.riotId) return;
            try {
                const accounts = readAccounts();
                const existing = accounts.find(account => matchesClientAccount(account, latestClientSnapshot));
                if (existing) {
                    syncClientProfile(latestClientSnapshot);
                    return;
                }

                const profile = latestClientSnapshot;
                const imported = {
                    id: newAccountId(),
                    puuid: profile.puuid || '',
                    riotId: profile.riotId,
                    region: profile.region || 'euw',
                    loginUser: '',
                    profileIconId: profile.profileIconId || undefined,
                    level: profile.level || undefined,
                    soloq: profile.soloq || EMPTY_QUEUE(),
                    flex: profile.flex || EMPTY_QUEUE(),
                    lpHistory: profile.soloq ? [createRankSnapshot(profile.soloq)] : [],
                    tags: [],
                    group: '',
                    order: nextAccountOrder(accounts),
                    clientImportedNeedsCredentials: true
                };
                accounts.push(imported);
                writeAccounts(accounts);
                activeClientAccountId = imported.id;
                loadAccounts();
                setClientSyncState('active', 'clientSyncActive');
                showNeonNotification(t('clientSyncImported'));
            } catch (e) {
                console.error('Error al importar la cuenta del cliente de League of Legends', e);
                showNeonNotification(t('clientSyncImportError'));
            }
        }

        async function syncWithGameClient() {
            if (clientSyncBusy) return;
            clientSyncBusy = true;
            try {
                const lock = readLeagueClientLockfile() || await readLeagueClientProcessLockfile();
                if (!lock) {
                    latestGameClientLock = null;
                    setPoroGameflowPhase('NONE');
                    const detectedPids = await listLeaguePids();
                    const hadActiveAccount = activeClientAccountId !== null;
                    activeClientAccountId = null;
                    latestClientSnapshot = null;
                    if (hadActiveAccount) loadAccounts();
                    setClientSyncState(detectedPids.size ? 'waiting' : 'offline', detectedPids.size ? 'clientSyncWaiting' : 'clientSyncOffline');
                    return;
                }
                latestGameClientLock = lock;

                const profile = await readGameClientProfile(lock);
                if (profile && (profile.puuid || profile.riotId)) {
                    syncClientProfile(profile);
                } else {
                    const hadActiveAccount = activeClientAccountId !== null;
                    activeClientAccountId = null;
                    latestClientSnapshot = null;
                    if (hadActiveAccount) loadAccounts();
                    setClientSyncState('waiting', 'clientSyncWaiting');
                }
            } catch (e) {
                console.error('Error al sincronizar con el cliente de League of Legends', e);
                setClientSyncState('error', 'clientSyncError');
            } finally {
                clientSyncBusy = false;
            }
        }

        // Siempre resuelve: { ok, status, note, body }
        function riotClientRequest(method, apiPath, lock = readRiotLockfile(), timeout = 5000, requestBody = null) {
            return new Promise(resolve => {
                if (!lock) { resolve({ ok: false, status: 0, note: 'sin lockfile' }); return; }
                let finished = false;
                const finish = result => { if (!finished) { finished = true; resolve(result); } };
                const body = requestBody === null ? null : JSON.stringify(requestBody);
                const req = https.request({
                    host: '127.0.0.1', port: lock.port, path: apiPath, method,
                    headers: {
                        Authorization: 'Basic ' + Buffer.from('riot:' + lock.password).toString('base64'),
                        ...(body === null ? {} : {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(body)
                        })
                    },
                    rejectUnauthorized: false, // certificado local autofirmado
                    timeout
                }, res => {
                    let body = '';
                    res.on('data', chunk => { if (body.length < 65536) body += chunk; });
                    res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
                });
                req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, note: 'timeout' }); });
                req.on('error', e => finish({ ok: false, status: 0, note: e.code || 'error' }));
                req.end(body === null ? undefined : body);
            });
        }

        function launchLeagueViaApi() {
            return riotClientRequest('POST', '/product-launcher/v1/products/league_of_legends/patchlines/live');
        }

        // ---------- Scripts de PowerShell que informan de cada paso ("STEP:clave") ----------
        const PS_PRELUDE = `
            Add-Type -AssemblyName System.Windows.Forms
            $wshell = New-Object -ComObject wscript.shell
            function Step($name) { [Console]::Out.WriteLine("STEP:$name"); [Console]::Out.Flush() }
        `;

        function psTypingBlock(loginUser, password) {
            return `
                Step 'typeCreds'
                [System.Windows.Forms.SendKeys]::SendWait(${sendKeysLiteral(loginUser)})
                Start-Sleep -Milliseconds 600
                [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
                Start-Sleep -Milliseconds 600
                [System.Windows.Forms.SendKeys]::SendWait(${sendKeysLiteral(password)})
                Start-Sleep -Milliseconds 600
                Step 'confirm'
                [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
                Start-Sleep -Seconds 2
            `;
        }

        // Códigos de salida: 0 ok, 2 el cliente no arrancó, 3 no apareció la ventana
        // Margen para arranques en frío: hasta 60 s para el proceso y 90 s para la ventana.
        function psRiotClientScript(loginUser, password) {
            return PS_PRELUDE + `
                Step 'waitClient'
                $ok = $false
                for ($i = 0; $i -lt 120; $i++) {
                    if (Get-Process -Name 'Riot Client', 'RiotClientUx' -ErrorAction SilentlyContinue) { $ok = $true; break }
                    Start-Sleep -Milliseconds 500
                }
                if (-not $ok) { exit 2 }
                $t0 = Get-Date

                Step 'findLogin'
                $found = $false
                for ($i = 0; $i -lt 180; $i++) {
                    if ($wshell.AppActivate('Riot Client')) { $found = $true; break }
                    Start-Sleep -Milliseconds 500
                }
                if (-not $found) { exit 3 }

                # Que exista la ventana no significa que el formulario ya esté pintado (sobre todo si
                # el launcher estaba cerrado). Se espera un margen proporcional a lo que tardó en abrirse
                # y, además, a que el cliente deje de estar ocupado cargando.
                Step 'waitReady'
                $elapsed = ((Get-Date) - $t0).TotalSeconds
                $minSettle = [math]::Min(15, [math]::Max(4, $elapsed * 0.5))
                function Get-RiotCpu {
                    $sum = 0.0
                    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Riot*Client*' } | ForEach-Object {
                        try { $sum += $_.TotalProcessorTime.TotalSeconds } catch { }
                    }
                    return $sum
                }
                $prev = Get-RiotCpu
                $calm = 0
                $waited = 0.0
                while ($waited -lt 45) {
                    Start-Sleep -Milliseconds 500
                    $waited += 0.5
                    $cur = Get-RiotCpu
                    $delta = $cur - $prev
                    $prev = $cur
                    if ($delta -ge 0.15) { $calm = 0 } elseif ($delta -ge 0) { $calm++ }
                    if ($waited -ge $minSettle -and $calm -ge 4) { break }
                }

                Step 'bringFront'
                $null = $wshell.AppActivate('Riot Client')
                Start-Sleep -Milliseconds 800
            ` + psTypingBlock(loginUser, password) + `
                exit 0
            `;
        }

        function psPreviousWindowScript(loginUser, password) {
            return PS_PRELUDE + `
                Step 'switchWindow'
                [System.Windows.Forms.SendKeys]::SendWait('%{TAB}')
                Start-Sleep -Milliseconds 800
            ` + psTypingBlock(loginUser, password) + `
                exit 0
            `;
        }

        // Ejecuta PowerShell leyendo su salida línea a línea
        function runPowerShellStream(script, onLine, onExit) {
            const encoded = Buffer.from(script, 'utf16le').toString('base64');
            const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
            let buffer = '';
            child.stdout.on('data', chunk => {
                buffer += chunk.toString();
                let nl;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (line) onLine(line);
                }
            });
            let finished = false;
            const done = code => { if (!finished) { finished = true; onExit(code); } };
            child.on('close', done);
            child.on('error', () => done(-1));
            return child;
        }

        // ---------- Pantalla de inicio de sesión ----------
        const STEP_I18N = {
            openClient: 'stepOpenClient', waitClient: 'stepWaitClient', findLogin: 'stepFindLogin',
            waitReady: 'stepWaitReady', bringFront: 'stepBringFront', switchWindow: 'stepSwitchWindow', typeCreds: 'stepTypeCreds',
            confirm: 'stepConfirm', launchGame: 'stepLaunchGame'
        };
        const CHECK_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#06200f" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
        const CROSS_ICON = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

        const loginOverlay = document.getElementById('login-overlay');
        const loginTitleEl = document.getElementById('login-title');
        const loginAccountEl = document.getElementById('login-account');
        const loginBarFill = document.getElementById('login-bar-fill');
        const loginStepsEl = document.getElementById('login-steps');
        const loginFooterEl = document.getElementById('login-footer-text');
        const loginBtnRetry = document.getElementById('login-btn-retry');
        const loginBtnCancel = document.getElementById('login-btn-cancel');
        const loginBtnClose = document.getElementById('login-btn-close');
        let loginSession = null;

        function buildLoginSteps() {
            const steps = settings.loginMode === 'previousWindow'
                ? ['switchWindow', 'typeCreds', 'confirm']
                : ['openClient', 'waitClient', 'findLogin', 'waitReady', 'bringFront', 'typeCreds', 'confirm'];
            if (settings.launchGame) steps.push('launchGame');
            return steps;
        }

        function renderLogin() {
            const session = loginSession;
            if (!session) return;
            loginOverlay.classList.toggle('success', session.state === 'success');
            loginOverlay.classList.toggle('error', session.state === 'error');
            loginTitleEl.textContent = t(session.state === 'success' ? 'loginSuccess' : session.state === 'error' ? 'loginFailed' : 'loginTitle');
            loginStepsEl.innerHTML = session.steps.map((key, i) => {
                const st = session.status[i];
                const icon = st === 'done' ? CHECK_ICON : st === 'failed' ? CROSS_ICON : '';
                return `<li class="login-step ${st}"><span class="step-icon">${icon}</span><span>${escapeHtml(t(STEP_I18N[key]))}</span></li>`;
            }).join('');
            const doneCount = session.status.filter(x => x === 'done').length;
            loginBarFill.style.width = `${(doneCount / session.steps.length) * 100}%`;
            loginFooterEl.textContent = (session.footer ? t(session.footer) : '') +
                (session.state === 'error' && session.debug && session.debug.length ? ` [${session.debug.join(' · ')}]` : '');
            loginFooterEl.classList.toggle('error', session.state === 'error');
            loginBtnCancel.classList.toggle('show', session.state === 'running');
            loginBtnRetry.classList.toggle('show', session.state === 'error');
            loginBtnClose.classList.toggle('show', session.state !== 'running');
            loginBtnRetry.textContent = t('loginRetry');
            loginBtnCancel.textContent = t('loginCancel');
            loginBtnClose.textContent = t('loginClose');
        }

        function advanceLoginTo(key) {
            const session = loginSession;
            const idx = session.steps.indexOf(key);
            if (idx < 0) return;
            for (let i = 0; i < idx; i++) session.status[i] = 'done';
            session.status[idx] = 'active';
            renderLogin();
        }

        function finishLogin(launchedGame) {
            const session = loginSession;
            session.state = 'success';
            session.status = session.steps.map(() => 'done');
            session.footer = launchedGame ? 'loginLaunching' : 'loginDoneNoGame';
            const currentAccount = readAccounts().find(account => account.id === session.account.id) || session.account;
            try {
                window.aurumMastery.addXp(currentAccount, 25);
            } catch (error) {
                console.error('No se pudo añadir XP por iniciar sesión:', error);
            }
            window.aurumSoundboard.play('login');
            loadAccounts();
            renderLogin();
            loginBtnClose.focus();
            if (session.fromTray) {
                trayNotify(t('trayLoginOk'));
                // Nadie está mirando la ventana: se recoge sola para no dejarla con la pantalla de "listo" abierta
                setTimeout(() => { if (loginSession === session) closeLoginOverlay(); }, 1500);
            }
        }

        function failLogin(messageKey) {
            const session = loginSession;
            session.state = 'error';
            let idx = session.status.indexOf('active');
            if (idx < 0) idx = session.status.indexOf('pending');
            if (idx >= 0) session.status[idx] = 'failed';
            session.footer = messageKey;
            renderLogin();
            loginBtnRetry.focus();
            if (session.fromTray) trayNotify(t('trayLoginFail'));   // el detalle queda en la ventana al abrirla
        }

        // Solo ejecuta fn si esta sesión sigue en curso (no se canceló)
        function loginLater(session, ms, fn) {
            const id = setTimeout(() => {
                if (loginSession === session && session.state === 'running') fn();
            }, ms);
            session.timers.push(id);
        }

        function startLogin(account, opts = {}) {
            if (loginSession && loginSession.state === 'running') return;
            const password = getAccountPassword(account);
            if (!password) {
                showNeonNotification(t('errNoPassword'));
                if (opts.fromTray) trayNotify(t('errNoPassword'));
                return;
            }

            const steps = buildLoginSteps();
            const session = {
                account, steps,
                status: steps.map(() => 'pending'),
                state: 'running', footer: '', child: null, timers: [],
                fromTray: !!opts.fromTray   // lanzado desde la bandeja con la ventana oculta: se avisa con una notificación
            };
            loginSession = session;

            // Procesos del juego que ya estaban abiertos: así solo damos por bueno uno nuevo
            session.leagueBaseline = new Set();
            if (settings.launchGame) listLeaguePids().then(pids => { session.leagueBaseline = pids; });

            const tierBase = account.soloq && account.soloq.tier ? account.soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
            const loginEmblemImg = document.getElementById('login-emblem-img');
            const rankIconUrl = tierIcons[tierBase] || tierIcons['UNRANKED'];
            loginEmblemImg.onerror = () => {
                loginEmblemImg.style.visibility = 'hidden';
            };
            loginEmblemImg.onload = () => { loginEmblemImg.style.visibility = 'visible'; };
            loginEmblemImg.src = rankIconUrl;
            loginAccountEl.textContent = account.riotId || account.loginUser;
            renderLogin();
            loginOverlay.classList.add('open');
            loginOverlay.setAttribute('aria-hidden', 'false');
            loginBtnCancel.focus();

            const onLine = line => {
                const m = /^STEP:(\w+)/.exec(line);
                if (m && loginSession === session && session.state === 'running') advanceLoginTo(m[1]);
            };
            const onExit = code => {
                session.child = null;
                if (loginSession !== session || session.state !== 'running') return;
                if (code === 0) afterCredentials(session);
                else failLogin({ 2: 'errClientNotStarted', 3: 'errLoginWindow' }[code] || 'errLoginGeneric');
            };

            if (settings.loginMode === 'previousWindow') {
                session.child = runPowerShellStream(psPreviousWindowScript(account.loginUser, password), onLine, onExit);
                return;
            }

            // Modo Riot Client: cerrar el cliente si estaba abierto y volver a lanzarlo
            advanceLoginTo('openClient');
            exec('taskkill /f /im RiotClientServices.exe /im "Riot Client.exe" /im RiotClientUx.exe', { windowsHide: true }, () => {
                loginLater(session, 1500, () => {
                    // Con "abrir el juego" activo, el cliente se arranca ya con el juego pedido:
                    // en cuanto inicia sesión lo lanza él mismo, sin depender de ningún temporizador.
                    const rcPath = settings.launchGame ? getRiotClientPath() : null;
                    if (rcPath) {
                        const child = spawn(rcPath, LEAGUE_LAUNCH_ARGS, { detached: true, stdio: 'ignore' });
                        child.on('error', () => exec('cmd /c start riotclient://', { windowsHide: true }));
                        child.unref();
                    } else {
                        exec('cmd /c start riotclient://', { windowsHide: true });
                    }
                    session.child = runPowerShellStream(psRiotClientScript(account.loginUser, password), onLine, onExit);
                });
            });
        }

        function afterCredentials(session) {
            if (!session.steps.includes('launchGame')) {
                finishLogin(false);
                return;
            }
            advanceLoginTo('launchGame');
            waitForLeagueClient(session);
        }

        // Intentos de abrir el juego una vez iniciada la sesión (ms desde que se escribieron las credenciales).
        // 'api' = se lo pedimos al Riot Client por su API local; 'args' = relanzamos RiotClientServices con el juego.
        const GAME_ATTEMPTS = [
            { at: 4000, how: 'api' }, { at: 14000, how: 'api' }, { at: 24000, how: 'args' },
            { at: 40000, how: 'api' }, { at: 56000, how: 'args' }
        ];
        const GAME_TIMEOUT_MS = 90000;  // máximo esperando a que aparezca el cliente del juego

        // Solo se da el inicio por bueno cuando el cliente del juego aparece de verdad
        function waitForLeagueClient(session) {
            session.debug = [];
            // El juego ya estaba abierto antes de empezar: no hay forma de distinguir uno nuevo
            if (session.leagueBaseline.size > 0) {
                launchLeague();
                loginLater(session, 1500, () => finishLogin(true));
                return;
            }
            const startedAt = Date.now();
            let next = 0;
            const alive = () => loginSession === session && session.state === 'running';
            const poll = () => {
                listLeaguePids().then(async pids => {
                    if (!alive()) return;
                    if ([...pids].some(pid => !session.leagueBaseline.has(pid))) { finishLogin(true); return; }
                    const waited = Date.now() - startedAt;
                    if (next < GAME_ATTEMPTS.length && waited >= GAME_ATTEMPTS[next].at) {
                        const attempt = GAME_ATTEMPTS[next++];
                        if (attempt.how === 'api') {
                            const r = await launchLeagueViaApi();
                            session.debug.push('API ' + (r.status || r.note));
                            console.info('[login] lanzar juego por API:', r.status, r.note || '', r.body || '');
                        } else {
                            if (!launchLeague()) { failLogin('riotClientNotFound'); return; }
                            session.debug.push('args');
                        }
                        if (!alive()) return;
                    }
                    if (waited >= GAME_TIMEOUT_MS) {
                        console.info('[login] el juego no se abrió. Intentos:', session.debug.join(', '));
                        failLogin('errGameNotStarted');
                        return;
                    }
                    loginLater(session, 2000, poll);
                });
            };
            poll();
        }

        function closeLoginOverlay() {
            const session = loginSession;
            if (session) {
                session.state = session.state === 'running' ? 'cancelled' : session.state;
                session.timers.forEach(clearTimeout);
                if (session.child) { try { session.child.kill(); } catch (e) { /* ya terminó */ } }
            }
            loginSession = null;
            loginOverlay.classList.remove('open', 'success', 'error');
            loginOverlay.setAttribute('aria-hidden', 'true');
        }

        loginBtnCancel.addEventListener('click', closeLoginOverlay);
        loginBtnClose.addEventListener('click', closeLoginOverlay);
        loginBtnRetry.addEventListener('click', () => {
            const id = loginSession && loginSession.account.id;
            closeLoginOverlay();
            const acc = readAccounts().find(a => a.id === id);
            if (acc) startLogin(acc);
        });
        document.addEventListener('keydown', (e) => {
            // Esc solo cierra cuando ya terminó (para no cancelar por accidente a mitad de proceso)
            if (e.key === 'Escape' && loginSession && loginSession.state !== 'running') closeLoginOverlay();
        });

        function deleteAccount(id) {
            writeAccounts(readAccounts().filter(acc => acc.id !== id));
            loadAccounts();
        }

        const rankDistPrev = {}; // para animar solo lo que cambia
        function updateRankDistribution(allAccounts) {
            const tiers = ['CHALLENGER', 'GRANDMASTER', 'MASTER', 'DIAMOND', 'EMERALD', 'PLATINUM', 'GOLD', 'SILVER', 'BRONZE', 'IRON', 'UNRANKED'];
            const counts = {};
            tiers.forEach(tr => counts[tr] = 0);
            allAccounts.forEach(acc => {
                const tier = acc.soloq && acc.soloq.tier ? acc.soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
                counts[counts[tier] !== undefined ? tier : 'UNRANKED']++;
            });

            const total = Math.max(1, allAccounts.length);
            const pending = [];
            rankStatsContainer.innerHTML = tiers.map(tier => {
                const count = counts[tier];
                if (tier === 'UNRANKED' && count === 0) return '';
                const theme = getRankTheme(tier);
                const pct = (count / total) * 100;
                pending.push([tier, pct]);
                const label = tier === 'UNRANKED' ? t('unranked') : tierName(tier);
                return `<div class="rd-row ${count ? '' : 'empty'}" style="--c: ${theme.primary}; --g: ${theme.glow};">
                    <span class="rd-icon"><img src="${tierIcons[tier] || tierIcons.UNRANKED}" alt=""></span>
                    <span class="rd-name">${escapeHtml(label)}</span>
                    <span class="rd-bar"><span class="rd-fill" data-tier="${tier}" style="display: block; width: ${rankDistPrev[tier] || 0}%;"></span></span>
                    <span class="rd-count">${count}</span>
                </div>`;
            }).join('');
            requestAnimationFrame(() => requestAnimationFrame(() => {
                pending.forEach(([tier, pct]) => {
                    const fill = rankStatsContainer.querySelector(`.rd-fill[data-tier="${tier}"]`);
                    if (fill) fill.style.width = `${pct}%`;
                    rankDistPrev[tier] = pct;
                });
            }));
        }

        const USER_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;

        const TROPHY_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>`;

        // Cuanto mejor el winrate, más vistoso. Con muy pocas partidas no se presume.
        function wrTier(wr, games) {
            if (games < 3) return 'wr-neutral';
            if (wr >= 70) return 'wr-legend';
            if (wr >= 60) return 'wr-great';
            if (wr >= 55) return 'wr-good';
            if (wr >= 50) return 'wr-ok';
            if (wr >= 45) return 'wr-meh';
            return 'wr-bad';
        }

        function renderRecentGames(recentGames) {
            if (!Array.isArray(recentGames) || !recentGames.length) return '';
            const games = recentGames.slice(0, 10);
            const wins = games.filter(game => game.result === 'WIN').length;
            const losses = games.filter(game => game.result === 'LOSE').length;
            const recentWr = Math.round((wins / Math.max(1, wins + losses)) * 100);
            return `<div class="card-section recent-games-section">
                <div class="sec-label">${escapeHtml(t('secRecent'))}
                    <span class="recent-summary ${wrTier(recentWr, wins + losses)}">${wins}${escapeHtml(t('winShort'))} ${losses}${escapeHtml(t('lossShort'))} · ${recentWr}%</span>
                </div>
                <div class="recent-row">
                    ${games.map(game => {
                        const image = champImg(game.champ);
                        const cls = game.result === 'WIN' ? 'win' : game.result === 'LOSE' ? 'loss' : 'remake';
                        const result = t(cls === 'win' ? 'gameWin' : cls === 'loss' ? 'gameLoss' : 'gameRemake');
                        const gameType = game.gameType || t('unknownGameType');
                        const label = `${champName(game.champ)} - ${t('matchResultLabel')}: ${result} - ${t('matchTypeLabel')}: ${gameType}`;
                        return `<div class="recent-game ${cls}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${image ? `<img src="${image}" alt="">` : `<span>${escapeHtml(champName(game.champ).slice(0, 2))}</span>`}</div>`;
                    }).join('')}
                </div>
            </div>`;
        }

        const LOGIN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/></svg>`;
        const CLIPBOARD_ICON = `<svg class="ic-main" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
        const KEY_ICON = `<svg class="ic-main" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>`;
        const OK_ICON = `<svg class="ic-ok" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
        const CLIPBOARD_CLEAR_MS = 30000;
        let clipboardClearTimer = null;

        // Copia el Riot ID (el que se busca en OP.GG) o la contraseña
        function copyFromAccount(account, what, btn) {
            let text = '';
            if (what === 'riot') text = account.riotId || '';
            else text = getAccountPassword(account);
            if (!text) {
                showNeonNotification(t(what === 'riot' ? 'copyNoRiotId' : 'errNoPassword'));
                return;
            }
            clipboard.writeText(text);
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1400);

            if (what === 'password') {
                // Por seguridad, la contraseña se borra del portapapeles a los 30 s (si sigue ahí)
                clearTimeout(clipboardClearTimer);
                clipboardClearTimer = setTimeout(() => {
                    if (clipboard.readText() === text) clipboard.clear();
                }, CLIPBOARD_CLEAR_MS);
                showNeonNotification(t('copiedPassword'));
            } else {
                showNeonNotification(`${t('copiedRiotId')}: ${text}`);
            }
        }

        function renderCard(account, visibleIndex, visibleCount, achievementState) {
            const newCard = document.createElement('div');
            newCard.className = 'account-card';
            newCard.dataset.accountId = account.id;
            newCard.classList.toggle('client-active', account.id === activeClientAccountId);
            const masteryState = window.aurumMastery.getState(account);
            const masteryBadgeLabel = `${t('masteryBadgeLabel')} · ${masteryState.badgeText} · ${t(masteryState.equippedTitle.nameKey)}`;
            newCard.classList.toggle('mastery-tier-5', masteryState.level >= 5 && masteryState.level < 7);
            newCard.classList.toggle('mastery-tier-7', masteryState.level >= 7);

            const soloq = account.soloq || EMPTY_QUEUE();
            const flex = account.flex || EMPTY_QUEUE();
            const region = regionLabel(account.region || 'euw');
            const mainTierBase = soloq.tier ? soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
            const iconUrl = tierIcons[mainTierBase] || tierIcons['UNRANKED'];

            let lpPercent = 0;
            const apexTiers = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
            if (apexTiers.includes(mainTierBase)) {
                const min = soloq.minLp !== undefined ? soloq.minLp : 0;
                const max = soloq.maxLp !== undefined && soloq.maxLp > min ? soloq.maxLp : (min + 500);
                lpPercent = Math.min(Math.max(((soloq.lp - min) / (max - min)) * 100, 0), 100);
            } else if (mainTierBase !== 'UNRANKED') {
                lpPercent = Math.min(Math.max(soloq.lp, 0), 100);
            }

            const rankTheme = getRankTheme(soloq.tier);
            newCard.style.borderColor = rankTheme.cardBorder;
            newCard.style.boxShadow = `0 8px 16px -4px rgba(0, 0, 0, 0.4), 0 0 16px ${rankTheme.glow}`;

            const { name, tag } = splitRiotId(account.riotId);
            const shownName = name || account.loginUser || '?';
            const profileIconUrl = Number.isInteger(Number(account.profileIconId)) && Number(account.profileIconId) > 0 && ddragon.version
                ? `https://ddragon.leagueoflegends.com/cdn/${ddragon.version}/img/profileicon/${Number(account.profileIconId)}.png`
                : '';
            const profileIconHtml = profileIconUrl
                ? `<img class="acc-profile-avatar sens sens-id" src="${profileIconUrl}" alt="" aria-hidden="true">`
                : '';
            const activeAccountHtml = account.id === activeClientAccountId
                ? `<span class="acc-badge client-active-badge">${escapeHtml(t('clientActive'))}</span>`
                : '';
            const missingCredentialsHtml = account.clientImportedNeedsCredentials
                ? `<span class="acc-badge client-credentials-badge" title="${escapeHtml(t('clientNeedsCredentialsHint'))}">${escapeHtml(t('clientNeedsCredentials'))}</span>`
                : '';
            const lastSeasonText = !hasRiotId(account) ? '—'
                : account.opggUpdatedAt ? (account.lastSeason || t('unranked')) : '…';
            const notFound = account.opggStatus === 'notFound';

            // Posición global
            let ladderHtml = '';
            if (account.ladder && account.ladder.rank) {
                const pct = account.ladder.percent;
                const cls = pct <= 1 ? 'lad-elite' : pct <= 5 ? 'lad-high' : pct <= 15 ? 'lad-good' : pct <= 40 ? 'lad-mid' : '';
                const pctText = pct < 0.01 ? '<' + (0.01).toLocaleString(currentLang)
                    : pct.toLocaleString(currentLang, { maximumFractionDigits: pct < 1 ? 2 : 1 });
                ladderHtml = `<span class="acc-badge ladder ${cls} sens sens-id" title="${escapeHtml(t('ladderTitle'))}">${TROPHY_ICON}#${account.ladder.rank.toLocaleString(currentLang)} · ${escapeHtml(t('topLabel'))} ${pctText}%</span>`;
            }

            // Campeones más jugados
            let champsHtml = '';
            if (!notFound && Array.isArray(account.topChampions) && account.topChampions.length) {
                champsHtml = `
                <div class="card-section" style="position: relative; z-index: 1;">
                    <div class="sec-label">${escapeHtml(t('secTopChamps'))}</div>
                    <div class="champ-row">
                        ${account.topChampions.slice(0, 5).map(c => {
                            const games = c.wins + c.losses;
                            const tier = wrTier(c.wr, games);
                            const img = champImg(c.name);
                            return `<div class="champ-tile" title="${escapeHtml(champName(c.name))} · ${c.wins}${escapeHtml(t('winShort'))} ${c.losses}${escapeHtml(t('lossShort'))}">
                                <div class="champ-icon ring-${tier}">${img ? `<img src="${img}" alt="">` : `<span>${escapeHtml(String(c.name).slice(0, 2))}</span>`}</div>
                                <div class="champ-wr ${tier}">${c.wr}%</div>
                                <div class="champ-games">${games} ${escapeHtml(t('gamesShort'))}</div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
            }

            const recentHtml = !notFound ? renderRecentGames(account.recentGames) : '';
            const flexText = (flex.tier || 'UNRANKED') === 'UNRANKED' ? t('unranked') : `${prettyTier(flex.tier)} · ${flex.lp} LP`;
            const showLevel = hasRiotId(account) && account.level;
            const taxonomyHtml = [
                account.group ? `<span class="account-taxonomy-item group sens sens-desc">${escapeHtml(account.group)}</span>` : '',
                ...(Array.isArray(account.tags) ? account.tags : []).map(tag => `<span class="account-taxonomy-item sens sens-desc">${escapeHtml(tag)}</span>`)
            ].filter(Boolean).join('');
            const taxonomy = taxonomyHtml ? `<div class="acc-taxonomy">${taxonomyHtml}</div>` : '';
            const reorderActions = sortSelect.value === 'manual' ? `
                <div class="account-order-actions">
                    <button type="button" class="card-icon-btn" data-move="up" aria-label="${escapeHtml(t('moveUp'))}" title="${escapeHtml(t('moveUp'))}" ${visibleIndex === 0 ? 'disabled' : ''}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>
                    </button>
                    <button type="button" class="card-icon-btn" data-move="down" aria-label="${escapeHtml(t('moveDown'))}" title="${escapeHtml(t('moveDown'))}" ${visibleIndex === visibleCount - 1 ? 'disabled' : ''}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                </div>` : '';

            newCard.innerHTML = `
                <div style="position: absolute; top: 30%; left: 50%; width: 220px; height: 220px; background: radial-gradient(circle, ${rankTheme.glow} 0%, transparent 70%); border-radius: 50%; pointer-events: none; animation: cardRadarWave 6s ease-in-out infinite; z-index: 0;"></div>

                <div style="position: relative; z-index: 1; display: flex; gap: 14px; align-items: center;">
                    <img src="${iconUrl}" alt="" style="width: 52px; height: 52px; min-width: 52px; object-fit: contain; transform: scale(3.5); transform-origin: center; filter: drop-shadow(0 0 8px ${rankTheme.glow});">
                    <div style="flex-grow: 1; min-width: 0;">
                        <div class="acc-name-line">
                            <span class="acc-name-identity sens sens-id" title="${escapeHtml(account.riotId || account.loginUser)}">
                                ${profileIconHtml}
                                <span class="acc-name">${escapeHtml(shownName)}</span>${tag ? `<span class="acc-tag">#${escapeHtml(tag)}</span>` : ''}
                            </span>
                        </div>
                        <div class="acc-badges">
                            <span class="acc-badge region">${escapeHtml(region)}</span>
                            <button type="button" class="acc-badge mastery-badge" aria-label="${escapeHtml(masteryBadgeLabel)}" title="${escapeHtml(masteryBadgeLabel)}">
                                ${escapeHtml(masteryState.badgeText)}<span aria-hidden="true">·</span>${escapeHtml(t(masteryState.equippedTitle.nameKey))}
                            </button>
                            ${showLevel ? `<span class="acc-badge">${escapeHtml(t('levelShort'))} ${escapeHtml(account.level)}</span>` : ''}
                            ${account.loginUser ? `<span class="acc-badge user sens sens-login" title="${escapeHtml(t('fieldLoginUser'))}">${USER_ICON}${escapeHtml(account.loginUser)}</span>` : ''}
                            ${activeAccountHtml}
                            ${missingCredentialsHtml}
                            ${ladderHtml}
                        </div>
                        ${taxonomy}
                    </div>
                </div>

                ${notFound ? `
                <div class="rank-box not-found" style="position: relative; z-index: 1; margin-top: 14px;">
                    <div class="nf-title">${escapeHtml(t('opggNotFound'))}</div>
                    <button type="button" class="nf-fix">${escapeHtml(t('opggFixRiotId'))}</button>
                </div>` : `
                <div class="rank-box" style="position: relative; z-index: 1; margin-top: 14px;">
                    <div class="rank-box-top">
                        <span class="rank-box-tier" style="color: ${rankTheme.primary};">${escapeHtml(prettyTier(soloq.tier))}</span>
                        <span class="rank-box-lp">${mainTierBase === 'UNRANKED' ? '' : `${soloq.lp} LP`}</span>
                    </div>
                    <div style="background: #1e2029; height: 5px; border-radius: 3px; overflow: hidden; box-shadow: inset 0 0 4px rgba(0,0,0,0.6);">
                        <div class="lp-fill-animated" style="width: ${lpPercent}%; height: 100%; background: linear-gradient(90deg, ${rankTheme.primary}, ${rankTheme.neon}, #ffffff, ${rankTheme.neon}, ${rankTheme.primary}); box-shadow: 0 0 10px ${rankTheme.glow};"></div>
                    </div>
                    <div class="rank-box-meta">
                        <span>${escapeHtml(t('lastSeason'))} <strong>${escapeHtml(lastSeasonText)}</strong></span>
                        <span>${escapeHtml(t('flex'))}: <strong>${escapeHtml(flexText)}</strong></span>
                    </div>
                </div>`}

                ${champsHtml}
                ${recentHtml}
                ${renderLpHistory(account)}

                ${account.description ? `<div class="acc-description sens sens-desc" style="position: relative; z-index: 1;" title="${escapeHtml(account.description)}">${escapeHtml(account.description)}</div>` : ''}

                <div class="card-actions" style="position: relative; z-index: 1; margin-top: 12px; border-top: 1px solid #1f2029; padding-top: 12px;">
                    <div class="account-quick-actions">
                    ${reorderActions}
                    <div class="account-quick-buttons">
                    <button type="button" class="card-icon-btn achievement-button" data-tip="${escapeHtml(t('achievementsButton'))}" aria-label="${escapeHtml(t('achievementsButton'))}">🏆</button>
                    <button type="button" class="card-icon-btn gamer-card-button" data-tip="${escapeHtml(t('gamerCardExportTooltip'))}" aria-label="${escapeHtml(t('gamerCardExportTooltip'))}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3"/></svg>
                    </button>
                    <button class="card-icon-btn" data-copy="riot" data-tip="${escapeHtml(t('copyRiotId'))}" aria-label="${escapeHtml(t('copyRiotId'))}" ${hasRiotId(account) ? '' : 'disabled'}>${CLIPBOARD_ICON}${OK_ICON}</button>
                    <button class="card-icon-btn" data-copy="password" data-tip="${escapeHtml(t('copyPassword'))}" aria-label="${escapeHtml(t('copyPassword'))}">${KEY_ICON}${OK_ICON}</button>
                    </div>
                    </div>
                    <button type="button" class="btn-login" aria-label="${escapeHtml(t('loginAction'))}">${LOGIN_ICON}<span>${escapeHtml(t('loginAction'))}</span></button>
                </div>
            `;

            newCard.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', (e) => {
                e.stopPropagation();
                moveAccount(account.id, btn.dataset.move === 'up' ? -1 : 1);
            }));
            newCard.querySelectorAll('.card-icon-btn').forEach(btn => btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (btn.dataset.copy) copyFromAccount(account, btn.dataset.copy, btn);
            }));
            newCard.querySelector('.achievement-button').addEventListener('click', event => {
                event.stopPropagation();
                openAchievements(account, achievementState);
            });
            newCard.querySelector('.mastery-badge').addEventListener('click', event => {
                event.stopPropagation();
                openMastery(account);
            });
            newCard.querySelector('.gamer-card-button').addEventListener('click', event => {
                event.stopPropagation();
                openGamerCard(account, achievementState);
            });

            newCard.querySelector('.btn-login').addEventListener('click', () => {
                startLogin(account);
            });

            const fixBtn = newCard.querySelector('.nf-fix');
            if (fixBtn) fixBtn.addEventListener('click', () => openDrawer('edit', account));

            newCard.querySelectorAll('.lp-history-tab').forEach(button => button.addEventListener('click', () => {
                const queue = button.dataset.lpQueue;
                newCard.querySelectorAll('.lp-history-tab').forEach(tab => {
                    const selected = tab.dataset.lpQueue === queue;
                    tab.classList.toggle('active', selected);
                    tab.setAttribute('aria-pressed', String(selected));
                });
                newCard.querySelectorAll('.lp-history-panel').forEach(panel => {
                    panel.hidden = panel.dataset.lpHistoryPanel !== queue;
                });
            }));

            newCard.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                openCardMenu(e.clientX, e.clientY, account);
            });

            mainContent.appendChild(newCard);
        }

        // ---------- Menú contextual (clic derecho en una tarjeta) ----------
        const cardMenu = document.getElementById('card-menu');
        let menuAccountId = null;
        let menuFriendId = null;

        function openCardMenu(x, y, account) {
            menuAccountId = account.id;
            menuFriendId = null;
            cardMenu.querySelector('[data-action="delete"]').hidden = false;
            cardMenu.querySelector('.ctx-sep').hidden = false;
            cardMenu.querySelector('[data-action="opgg"]').disabled = !hasRiotId(account);
            cardMenu.classList.add('open');
            const { width, height } = cardMenu.getBoundingClientRect();
            cardMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
            cardMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
            const firstEnabled = cardMenu.querySelector('.ctx-item:not(:disabled)');
            if (firstEnabled) firstEnabled.focus();
        }

        function openFriendMenu(x, y, friend) {
            menuAccountId = null;
            menuFriendId = friend.id;
            cardMenu.querySelector('[data-action="delete"]').hidden = true;
            cardMenu.querySelector('.ctx-sep').hidden = true;
            cardMenu.querySelector('[data-action="opgg"]').disabled = !hasRiotId(friend);
            cardMenu.classList.add('open');
            const { width, height } = cardMenu.getBoundingClientRect();
            cardMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
            cardMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
            const firstEnabled = cardMenu.querySelector('.ctx-item:not(:disabled):not([hidden])');
            if (firstEnabled) firstEnabled.focus();
        }

        function closeCardMenu() {
            cardMenu.classList.remove('open');
            menuAccountId = null;
            menuFriendId = null;
        }

        function askDelete(acc) {
            accountToDelete = acc.id;
            // El nombre va en su propio <span> para poder difuminarlo en modo streamer
            const [confirmBefore, confirmAfter] = t('deleteConfirm').split('{name}');
            const confirmName = document.createElement('span');
            confirmName.className = 'sens sens-id';
            confirmName.textContent = acc.riotId || acc.loginUser;
            confirmText.textContent = '';
            confirmText.append(confirmBefore || '', confirmName, confirmAfter || '');
            confirmModal.style.display = 'flex';
        }

        function runMenuAction(action) {
            if (menuFriendId) {
                const friend = (settings.friendRivals || []).find(entry => entry.id === menuFriendId);
                closeCardMenu();
                if (!friend) return;
                if (action === 'opgg' && hasRiotId(friend)) shell.openExternal(opggUrl(friend));
                else if (action === 'edit') {
                    const card = mainContent.querySelector(`[data-friend-id="${CSS.escape(friend.id)}"]`);
                    const form = card && card.querySelector('.friend-edit-form');
                    if (form) {
                        form.hidden = false;
                        const noteInput = form.querySelector('[data-friend-note]');
                        if (noteInput) noteInput.focus();
                    }
                }
                return;
            }
            const acc = readAccounts().find(a => a.id === menuAccountId);
            closeCardMenu();
            if (!acc) return;
            if (action === 'opgg' && hasRiotId(acc)) shell.openExternal(opggUrl(acc));
            else if (action === 'edit') openDrawer('edit', acc);
            else if (action === 'delete') askDelete(acc);
        }

        cardMenu.addEventListener('click', (e) => {
            const item = e.target.closest('.ctx-item');
            if (item && !item.disabled) runMenuAction(item.dataset.action);
        });
        document.addEventListener('mousedown', (e) => {
            if (cardMenu.classList.contains('open') && !cardMenu.contains(e.target)) closeCardMenu();
        });
        document.addEventListener('keydown', (e) => {
            if (!cardMenu.classList.contains('open')) return;
            if (e.key === 'Escape') { e.preventDefault(); closeCardMenu(); }
            else if (e.key === 'Delete') { e.preventDefault(); runMenuAction('delete'); }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const items = [...cardMenu.querySelectorAll('.ctx-item:not(:disabled):not([hidden])')];
                const i = items.indexOf(document.activeElement);
                const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
                items[next].focus();
            }
        });
        window.addEventListener('blur', closeCardMenu);
        window.addEventListener('resize', closeCardMenu);
        mainContent.addEventListener('scroll', closeCardMenu);

        confirmYes.addEventListener('click', () => {
            if (accountToDelete) {
                deleteAccount(accountToDelete);
                accountToDelete = null;
            }
            confirmModal.style.display = 'none';
        });

        confirmNo.addEventListener('click', () => {
            accountToDelete = null;
            confirmModal.style.display = 'none';
        });

        // ---------- Estados vacíos ----------
        const EMPTY_EMBLEM = `
            <svg width="64" height="72" viewBox="0 0 64 72" aria-hidden="true">
                <defs>
                    <linearGradient id="hexOuter" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a3abbd"/><stop offset="1" stop-color="#4b5263"/></linearGradient>
                    <linearGradient id="hexInner" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d4456"/><stop offset="1" stop-color="#1b1f28"/></linearGradient>
                </defs>
                <polygon points="32,2 61,19 61,53 32,70 3,53 3,19" fill="url(#hexOuter)"/>
                <polygon points="32,9 55,22.5 55,49.5 32,63 9,49.5 9,22.5" fill="url(#hexInner)"/>
                <text x="32" y="43" text-anchor="middle" font-size="20" font-weight="700" fill="#737b8e" font-family="Segoe UI, sans-serif">?</text>
            </svg>`;

        function renderEmptyState() {
            const el = document.createElement('div');
            el.className = 'empty-state';
            el.innerHTML = `
                <div class="empty-emblem">${EMPTY_EMBLEM}</div>
                <h2>${escapeHtml(t('emptyTitle'))}</h2>
                <p>${escapeHtml(t('emptyText'))}</p>
                <button type="button" class="btn-gold">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>
                    ${escapeHtml(t('addAccountBtn'))}
                </button>`;
            el.querySelector('button').addEventListener('click', () => openDrawer('add'));
            mainContent.appendChild(el);
        }

        function renderNoResults() {
            const el = document.createElement('div');
            el.className = 'empty-state no-results';
            el.innerHTML = `<h2>${escapeHtml(t('noResultsTitle'))}</h2><p>${escapeHtml(t('noResultsText'))}</p>`;
            mainContent.appendChild(el);
        }

        // Orden de las cuentas (rango, nombre u orden manual): lo usan la ventana y el menú de la bandeja.
        function accountComparator(sortBy) {
            return (a, b) => {
                if (sortBy === 'manual') return a.order - b.order;
                if (sortBy === 'rank') {
                    const tierA = a.soloq && a.soloq.tier ? a.soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
                    const tierB = b.soloq && b.soloq.tier ? b.soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
                    const weightA = rankWeights[tierA] !== undefined ? rankWeights[tierA] : 0;
                    const weightB = rankWeights[tierB] !== undefined ? rankWeights[tierB] : 0;
                    if (weightA !== weightB) return weightB - weightA;
                    return (b.soloq ? b.soloq.lp : 0) - (a.soloq ? a.soloq.lp : 0);
                }
                return displayName(a).localeCompare(displayName(b));
            };
        }

        function getFilteredAccounts(allAccounts) {
            const searchTerm = searchInput.value.toLowerCase();
            const selectedRegion = filterRegion.value;
            const selectedCategory = filterCategory.value;
            return allAccounts.filter(acc => {
                const haystack = [acc.riotId, acc.loginUser, acc.description, acc.group, ...(acc.tags || [])].filter(Boolean).join(' ').toLowerCase();
                const matchesRegion = selectedRegion === 'all' || (acc.region || 'euw').toLowerCase() === selectedRegion;
                const matchesCategory = selectedCategory === 'all' ||
                    (selectedCategory.startsWith('group:') && String(acc.group || '').trim().toLowerCase() === selectedCategory.slice(6)) ||
                    (selectedCategory.startsWith('tag:') && (acc.tags || []).some(tag => String(tag).trim().toLowerCase() === selectedCategory.slice(4)));
                return haystack.includes(searchTerm) && matchesRegion && matchesCategory;
            });
        }

        function moveAccount(id, direction) {
            const accounts = readAccounts();
            const visible = getFilteredAccounts(accounts).sort(accountComparator('manual'));
            const visibleIndex = visible.findIndex(account => account.id === id);
            const target = visible[visibleIndex + direction];
            if (!target) return;

            const ordered = accounts.slice().sort(accountComparator('manual'));
            const from = ordered.findIndex(account => account.id === id);
            ordered.splice(from, 1);
            const targetIndex = ordered.findIndex(account => account.id === target.id);
            ordered.splice(targetIndex + (direction > 0 ? 1 : 0), 0, accounts.find(account => account.id === id));
            ordered.forEach((account, index) => { account.order = index; });
            writeAccounts(ordered);
            loadAccounts();
        }

        function friendRecentStatus(recentGames) {
            if (!Array.isArray(recentGames) || !recentGames.length) return '';
            const results = recentGames.slice(0, 10).map(game => {
                const result = String(game && game.result || '').toUpperCase();
                if (result === 'WIN' || result === 'VICTORY') return 'WIN';
                if (result === 'LOSE' || result === 'LOSS' || result === 'DEFEAT') return 'LOSE';
                return '';
            });
            const decisive = results.filter(Boolean);
            if (!decisive.length) return '';
            const wins = decisive.filter(result => result === 'WIN').length;
            const winRate = Math.round(wins / decisive.length * 100);
            let winStreak = 0;
            if (results[0] === 'WIN') {
                for (const result of results) {
                    if (result !== 'WIN') break;
                    winStreak += 1;
                }
            }
            return `<div class="friend-recent-status">
                ${winStreak >= 4 ? `<span class="friend-status-badge on-streak">${escapeHtml(t('friendOnStreak'))} · ${winStreak}</span>` : ''}
                <span class="friend-status-badge recent-win-rate">${winRate}% ${escapeHtml(t('friendRecentWinRate'))}</span>
            </div>`;
        }

        function renderFriendCard(friend) {
            const card = document.createElement('article');
            card.className = 'account-card friend-card';
            card.dataset.friendId = friend.id;
            const solo = friend.soloq;
            const flex = friend.flex;
            const friendRegion = REGION_LIST.find(region => region.code === friend.region)
                || { code: friend.region, label: regionLabel(friend.region) };
            const soloHistory = normalizeLpHistory(friend.lpHistory).slice(-CHART_LP_HISTORY);
            const flexHistory = normalizeLpHistory(friend.lpHistoryFlex).slice(-CHART_LP_HISTORY);
            const initialQueue = soloHistory.length || !flexHistory.length ? 'solo' : 'flex';
            const recentGamesHtml = renderRecentGames(friend.recentGames);
            const friendTags = normalizeTags(friend.tags);
            const tagsHtml = friendTags.length
                ? `<div class="friend-tags">${friendTags.map(tag => `<span class="friend-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
                : '';
            const tacticalTags = normalizeTacticalTags(friend.tacticalTags);
            const tacticalTagsHtml = tacticalTags.length
                ? `<div class="friend-tactical-badges">${tacticalTags.map(id => {
                    const tag = TACTICAL_TAGS.find(item => item.id === id);
                    return tag ? `<span class="rival-tactical-badge ${tag.id}">${escapeHtml(t(tag.labelKey))}</span>` : '';
                }).join('')}</div>`
                : '';
            const recentStatusHtml = friendRecentStatus(friend.recentGames);
            const tacticalTagInputs = TACTICAL_TAGS.map(tag => `
                <label class="tactical-tag-option ${tag.id}">
                    <input type="checkbox" data-tactical-tag value="${tag.id}" ${tacticalTags.includes(tag.id) ? 'checked' : ''}>
                    <span>${escapeHtml(t(tag.labelKey))}</span>
                </label>`).join('');
            const rankSummary = (queue, label) => {
                if (!queue || !queue.tier) return `<div class="friend-rank-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(t('unranked'))}</strong></div>`;
                return `<div class="friend-rank-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(prettyTier(queue.tier))} · ${Number(queue.lp) || 0} LP</strong></div>`;
            };
            const historyMarkup = soloHistory.length || flexHistory.length ? `
                <section class="lp-history card-section" aria-label="${escapeHtml(t('lpHistoryTitle'))}">
                    <div class="lp-history-head">
                        <span class="sec-label">${escapeHtml(t('lpHistoryTitle'))}</span>
                        <div class="lp-history-tabs" role="group" aria-label="${escapeHtml(t('lpHistoryTitle'))}">
                            <button type="button" class="lp-history-tab ${initialQueue === 'solo' ? 'active' : ''}" aria-pressed="${initialQueue === 'solo'}" data-lp-queue="solo">Solo/Duo</button>
                            <button type="button" class="lp-history-tab ${initialQueue === 'flex' ? 'active' : ''}" aria-pressed="${initialQueue === 'flex'}" data-lp-queue="flex">${escapeHtml(t('flex'))}</button>
                        </div>
                    </div>
                    <div class="lp-history-panel" data-lp-history-panel="solo" ${initialQueue === 'flex' ? 'hidden' : ''}>${renderLpHistoryChart(soloHistory)}</div>
                    <div class="lp-history-panel" data-lp-history-panel="flex" ${initialQueue === 'solo' ? 'hidden' : ''}>${renderLpHistoryChart(flexHistory)}</div>
                </section>` : '';

            card.innerHTML = `
                <header class="friend-card-head">
                    <div>
                        <div class="friend-card-identity">
                            <div class="friend-card-name">${escapeHtml(friend.riotId)}</div>
                            ${tacticalTagsHtml}
                        </div>
                        <div class="friend-card-meta">${escapeHtml(regionName(friendRegion))} · ${escapeHtml(t(friend.relation === 'rival' ? 'friendTypeRival' : 'friendTypeFriend'))}</div>
                    </div>
                    <button type="button" class="friend-remove" data-remove-friend="${escapeHtml(friend.id)}" aria-label="${escapeHtml(t('friendRemove'))}" title="${escapeHtml(t('friendRemove'))}">×</button>
                </header>
                ${recentStatusHtml}
                <div class="friend-ranks">
                    ${rankSummary(solo, 'Solo/Duo')}
                    ${rankSummary(flex, t('flex'))}
                </div>
                ${recentGamesHtml}
                ${historyMarkup}
                ${friend.note ? `<p class="friend-note">${escapeHtml(friend.note)}</p>` : ''}
                ${tagsHtml}
                <form class="friend-edit-form" hidden>
                    <label class="friend-note-label" for="friend-note-${escapeHtml(friend.id)}">${escapeHtml(t('friendNote'))}</label>
                    <input class="friend-note-input" id="friend-note-${escapeHtml(friend.id)}" type="text" maxlength="120" data-friend-note value="${escapeHtml(friend.note || '')}" placeholder="${escapeHtml(t('friendNotePlaceholder'))}">
                    <label class="friend-note-label" for="friend-tags-${escapeHtml(friend.id)}">${escapeHtml(t('friendTags'))}</label>
                    <input class="friend-note-input" id="friend-tags-${escapeHtml(friend.id)}" type="text" data-friend-tags value="${escapeHtml(friendTags.join(', '))}" placeholder="${escapeHtml(t('friendTagsPlaceholder'))}">
                    <fieldset class="tactical-tag-picker">
                        <legend>${escapeHtml(t('friendTacticalTags'))}</legend>
                        <span class="tactical-tag-hint">${escapeHtml(t('friendTacticalTagsHint'))}</span>
                        <div class="tactical-tag-options">${tacticalTagInputs}</div>
                    </fieldset>
                    <div class="friend-edit-actions">
                        <button class="btn-gold friend-add-button" type="submit">${escapeHtml(t('friendSave'))}</button>
                        <button class="friend-edit-cancel" type="button">${escapeHtml(t('friendCancel'))}</button>
                    </div>
                </form>
                ${friend.opggStatus === 'notFound' ? `<div class="friend-profile-status">${escapeHtml(t('friendsProfileNotFound'))}</div>` : ''}
                ${friend.opggStatus === 'noData' ? `<div class="friend-profile-status">${escapeHtml(t('friendsNoData'))}</div>` : ''}
            `;

            card.querySelectorAll('.lp-history-tab').forEach(button => button.addEventListener('click', () => {
                const queue = button.dataset.lpQueue;
                card.querySelectorAll('.lp-history-tab').forEach(tab => {
                    const selected = tab.dataset.lpQueue === queue;
                    tab.classList.toggle('active', selected);
                    tab.setAttribute('aria-pressed', String(selected));
                });
                card.querySelectorAll('.lp-history-panel').forEach(panel => {
                    panel.hidden = panel.dataset.lpHistoryPanel !== queue;
                });
            }));
            card.querySelector('[data-remove-friend]').addEventListener('click', () => {
                settings.friendRivals = settings.friendRivals.filter(entry => entry.id !== friend.id);
                saveSettings();
                loadAccounts();
            });
            const editForm = card.querySelector('.friend-edit-form');
            const tacticalInputs = [...editForm.querySelectorAll('[data-tactical-tag]')];
            const updateTacticalTagLimit = () => {
                const selectedCount = tacticalInputs.filter(input => input.checked).length;
                tacticalInputs.forEach(input => { input.disabled = !input.checked && selectedCount >= 2; });
            };
            tacticalInputs.forEach(input => input.addEventListener('change', updateTacticalTagLimit));
            updateTacticalTagLimit();
            editForm.addEventListener('submit', event => {
                event.preventDefault();
                friend.note = card.querySelector('[data-friend-note]').value.trim().slice(0, 120);
                friend.tags = normalizeTags(card.querySelector('[data-friend-tags]').value)
                    .map(tag => tag.slice(0, 40)).slice(0, 10);
                friend.tacticalTags = normalizeTacticalTags(tacticalInputs.filter(input => input.checked).map(input => input.value));
                saveSettings();
                loadAccounts();
            });
            card.querySelector('.friend-edit-cancel').addEventListener('click', () => { editForm.hidden = true; });
            card.addEventListener('contextmenu', event => {
                event.preventDefault();
                openFriendMenu(event.clientX, event.clientY, friend);
            });
            return card;
        }

        function renderFriendsView() {
            const friends = settings.friendRivals || [];
            const searchTerm = searchInput.value.trim().toLowerCase();
            const filteredFriends = friends.filter(friend =>
                [friend.riotId, friend.note, ...(friend.tags || []), friend.region, friend.relation]
                    .filter(Boolean).join(' ').toLowerCase().includes(searchTerm)
            );
            const regionOptions = REGION_LIST.map(region =>
                `<option value="${escapeHtml(region.code)}">${escapeHtml(region.label)} — ${escapeHtml(regionName(region))}</option>`
            ).join('');

            mainContent.innerHTML = `
                <section class="friends-view">
                    <header class="friends-view-header">
                        <div>
                            <h1>${escapeHtml(t('friendsTitle'))}</h1>
                            <p>${escapeHtml(t('friendsSubtitle'))}</p>
                        </div>
                    </header>
                    <form class="friend-add-form" id="friend-add-form">
                        <label><span>${escapeHtml(t('friendRiotId'))}</span><input id="friend-riot-id" type="text" maxlength="100" required placeholder="${escapeHtml(t('friendRiotIdPlaceholder'))}"></label>
                        <label><span>${escapeHtml(t('friendRegion'))}</span><select id="friend-region">${regionOptions}</select></label>
                        <label><span>${escapeHtml(t('friendRelationship'))}</span><select id="friend-relation">
                            <option value="friend">${escapeHtml(t('friendTypeFriend'))}</option>
                            <option value="rival">${escapeHtml(t('friendTypeRival'))}</option>
                        </select></label>
                        <label><span>${escapeHtml(t('friendNote'))}</span><input id="friend-note" type="text" maxlength="120" placeholder="${escapeHtml(t('friendNotePlaceholder'))}"></label>
                        <button class="btn-gold friend-add-button" type="submit">${escapeHtml(t('friendAdd'))}</button>
                    </form>
                    <label class="friends-notifications-toggle">
                        <input type="checkbox" id="friends-desktop-notifications" ${settings.friendsDesktopNotifications ? 'checked' : ''}>
                        <span>${escapeHtml(t('friendsDesktopNotifications'))}</span>
                    </label>
                    <div class="friend-card-grid" id="friend-card-grid"></div>
                </section>`;

            const grid = mainContent.querySelector('#friend-card-grid');
            if (!filteredFriends.length) {
                const empty = document.createElement('p');
                empty.className = 'friends-empty';
                empty.textContent = friends.length ? t('noResultsText') : t('friendsEmpty');
                grid.appendChild(empty);
            } else {
                filteredFriends.forEach(friend => grid.appendChild(renderFriendCard(friend)));
            }

            mainContent.querySelector('#friend-add-form').addEventListener('submit', event => {
                event.preventDefault();
                const riotId = mainContent.querySelector('#friend-riot-id').value.trim();
                const region = mainContent.querySelector('#friend-region').value;
                if (!isValidRiotId(riotId)) {
                    showNeonNotification(t('friendInvalidRiotId'));
                    return;
                }
                if (settings.friendRivals.some(friend => friend.riotId.toLowerCase() === riotId.toLowerCase() && friend.region === region)) {
                    showNeonNotification(t('friendAlreadyAdded'));
                    return;
                }
                settings.friendRivals.push({
                    id: newAccountId(),
                    riotId,
                    region,
                    relation: mainContent.querySelector('#friend-relation').value === 'rival' ? 'rival' : 'friend',
                    note: mainContent.querySelector('#friend-note').value.trim().slice(0, 120),
                    tags: [],
                    soloq: null,
                    flex: null,
                    lpHistory: [],
                    lpHistoryFlex: [],
                    recentGames: null,
                    opggStatus: null,
                    opggUpdatedAt: null
                });
                saveSettings();
                loadAccounts();
                showNeonNotification(t('friendAdded'));
            });
            mainContent.querySelector('#friends-desktop-notifications').addEventListener('change', async event => {
                if (event.target.checked && !await ensureDesktopNotificationPermission()) {
                    event.target.checked = false;
                    return;
                }
                settings.friendsDesktopNotifications = event.target.checked;
                saveSettings();
            });
        }

        function loadAccounts() {
            const allAccounts = readAccounts();
            renderDuoFeed();
            const achievementStates = new Map();
            const newlyUnlocked = [];
            allAccounts.forEach(account => {
                const state = window.aurumAchievements.evaluateAchievements(account, allAccounts);
                achievementStates.set(account.id, state);
                state.newlyUnlocked.forEach(achievement => {
                    newlyUnlocked.push(`${displayName(account)} · ${t(achievement.nameKey)}`);
                });
            });
            if (newlyUnlocked.length) {
                showNeonNotification(`${t('achievementUnlockedToast')}: ${newlyUnlocked.join(' · ')}`);
            }
            syncTray(allAccounts);
            populateRegionSelects(allAccounts);
            populateCategorySelect(allAccounts);
            updateRankDistribution(allAccounts);
            mainContent.innerHTML = '';

            if (settings.activeView === 'friends') {
                renderFriendsView();
                return;
            }

            if (allAccounts.length === 0) {
                renderEmptyState();
                return;
            }

            const sortBy = sortSelect.value;
            const filteredAccounts = getFilteredAccounts(allAccounts);

            filteredAccounts.sort(accountComparator(sortBy));

            if (filteredAccounts.length === 0) {
                renderNoResults();
                return;
            }
            filteredAccounts.forEach((acc, index) => renderCard(acc, index, filteredAccounts.length, achievementStates.get(acc.id)));
        }

        // ---------- Imágenes de campeones (Data Dragon, CDN de imágenes oficial de LoL) ----------
        let ddragon = { version: null, byKey: {}, byName: {} };
        const normChamp = str => String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');

        async function loadChampionData() {
            try {
                const versions = JSON.parse(await httpGetText('https://ddragon.leagueoflegends.com/api/versions.json'));
                const version = versions[0];
                const data = JSON.parse(await httpGetText(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`)).data;
                const byKey = {}, byName = {};
                Object.values(data).forEach(c => {
                    byKey[c.key] = c.id;                 // 61 -> "Orianna"
                    byName[normChamp(c.name)] = c.id;    // "twistedfate" -> "TwistedFate", "wukong" -> "MonkeyKing"
                    byName[normChamp(c.id)] = c.id;
                });
                ddragon = { version, byKey, byName, names: Object.fromEntries(Object.values(data).map(c => [c.id, c.name])) };
                loadAccounts(); // repintar con las imágenes
            } catch (e) {
                console.error('No se pudieron cargar las imágenes de campeones', e.message);
            }
        }

        function champId(ref) {
            if (ref === null || ref === undefined || ref === '') return null;
            const str = String(ref);
            if (/^\d+$/.test(str)) return ddragon.byKey[str] || null;
            return ddragon.byName[normChamp(str)] || null;
        }

        function champImg(ref) {
            const id = champId(ref);
            return id && ddragon.version ? `https://ddragon.leagueoflegends.com/cdn/${ddragon.version}/img/champion/${id}.png` : null;
        }

        function champName(ref) {
            const id = champId(ref);
            return (id && ddragon.names && ddragon.names[id]) || String(ref ?? '?');
        }

        // ---------- Servidor MCP oficial de OP.GG (historial de partidas) ----------
        // https://github.com/opgginc/opgg-mcp — los parámetros de cada herramienta se leen del propio servidor.
        const OPGG_MCP_URL = 'https://mcp-api.op.gg/mcp';
        const mcpState = { sessionId: null, tools: null, initPromise: null, nextId: 1 };

        function httpPostJson(url, bodyObj, extraHeaders = {}) {
            return new Promise((resolve, reject) => {
                const body = JSON.stringify(bodyObj);
                const u = new URL(url);
                const req = https.request({
                    hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream',
                        'Content-Length': Buffer.byteLength(body),
                        'User-Agent': 'AurumAccounts',
                        ...extraHeaders
                    },
                    timeout: 20000
                }, res => {
                    let data = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
                });
                req.on('timeout', () => req.destroy(new Error('timeout')));
                req.on('error', reject);
                req.write(body);
                req.end();
            });
        }

        // La respuesta puede venir como JSON o como flujo SSE ("data: {...}")
        function parseMcpReply(res, id) {
            if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
                const msgs = res.text.split(/\r?\n/)
                    .filter(l => l.startsWith('data:'))
                    .map(l => { try { return JSON.parse(l.slice(5).trim()); } catch (e) { return null; } })
                    .filter(Boolean);
                return msgs.find(m => m.id === id) || msgs[msgs.length - 1] || null;
            }
            try { return JSON.parse(res.text); } catch (e) { return null; }
        }

        async function mcpRequest(method, params, isNotification = false) {
            const msg = { jsonrpc: '2.0', method };
            if (params) msg.params = params;
            if (!isNotification) msg.id = mcpState.nextId++;
            const res = await httpPostJson(OPGG_MCP_URL, msg, mcpState.sessionId ? { 'Mcp-Session-Id': mcpState.sessionId } : {});
            if (res.headers['mcp-session-id']) mcpState.sessionId = res.headers['mcp-session-id'];
            if (isNotification) return null;
            if (res.status === 404 && mcpState.sessionId) {
                // Sesión caducada: se reinicia en la próxima llamada
                Object.assign(mcpState, { sessionId: null, tools: null, initPromise: null });
                throw new Error('MCP: sesión caducada');
            }
            if (res.status >= 400) throw new Error(`MCP HTTP ${res.status}: ${res.text.slice(0, 200)}`);
            const reply = parseMcpReply(res, msg.id);
            if (!reply) throw new Error('MCP: respuesta no válida');
            if (reply.error) throw new Error('MCP: ' + (reply.error.message || JSON.stringify(reply.error)));
            return reply.result;
        }

        function mcpInit() {
            if (mcpState.tools) return Promise.resolve();
            if (!mcpState.initPromise) {
                mcpState.initPromise = (async () => {
                    await mcpRequest('initialize', {
                        protocolVersion: '2025-03-26',
                        capabilities: {},
                        clientInfo: { name: 'aurum-accounts', version: remoteApp.getVersion() }
                    });
                    await mcpRequest('notifications/initialized', null, true);
                    const list = await mcpRequest('tools/list', {});
                    mcpState.tools = {};
                    (list.tools || []).forEach(tool => { mcpState.tools[tool.name] = tool; });
                })().catch(e => {
                    Object.assign(mcpState, { sessionId: null, tools: null, initPromise: null });
                    throw e;
                });
            }
            return mcpState.initPromise;
        }

        // Rellena los argumentos según el esquema que publica el servidor
        function buildToolArgs(tool, acc) {
            const schema = (tool && tool.inputSchema) || {};
            const props = schema.properties || {};
            const required = schema.required || [];
            const { name, tag } = splitRiotId(acc.riotId);
            const pickEnum = (prop, wanted) => {
                if (!prop.enum) return wanted;
                const w = String(wanted).toLowerCase();
                return prop.enum.find(v => String(v).toLowerCase() === w)
                    ?? prop.enum.find(v => String(v).toLowerCase().startsWith(w))
                    ?? wanted;
            };
            const args = {};
            for (const [key, prop] of Object.entries(props)) {
                const k = key.toLowerCase();
                if (/riot_?id/.test(k)) args[key] = `${name}#${tag}`;
                else if (/game_?name|summoner_?name|^name$/.test(k)) args[key] = name;
                else if (/tag/.test(k)) args[key] = tag;
                else if (/region|platform|server/.test(k)) args[key] = pickEnum(prop, (acc.region || 'euw').toUpperCase());
                else if (/^(lang|locale|language|hl)$/.test(k)) args[key] = pickEnum(prop, 'en_US');
                else if (/desired_output_fields/.test(k)) args[key] = ['data'];
                else if (/^(limit|count|size|game_count|games|page_size)$/.test(k)) args[key] = 10;
                else if (required.includes(key) && prop.enum) args[key] = prop.enum.find(v => /solo|total|all/i.test(String(v))) ?? prop.enum[0];
                else if (required.includes(key) && prop.default !== undefined) args[key] = prop.default;
            }
            return args;
        }

        // Busca el campeón y el resultado en un objeto de partida, sin depender de nombres exactos
        function findChampionRef(o, depth = 0) {
            if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3) return null;
            for (const [k, v] of Object.entries(o)) {
                if (/^champion(_?id|_?key|_?name)?$/i.test(k)) {
                    if (typeof v === 'number' || typeof v === 'string') return v;
                    if (v && typeof v === 'object') return v.key ?? v.id ?? v.name ?? v.champion_id ?? null;
                }
            }
            for (const v of Object.values(o)) {
                const found = findChampionRef(v, depth + 1);
                if (found !== null) return found;
            }
            return null;
        }

        function findResult(o, depth = 0) {
            if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3) return null;
            for (const [k, v] of Object.entries(o)) {
                const key = k.toLowerCase();
                if (key === 'result' || key === 'game_result' || key === 'outcome') {
                    const r = String(v).toUpperCase();
                    if (/WIN|VICTORY/.test(r)) return 'WIN';
                    if (/LOSE|LOSS|DEFEAT/.test(r)) return 'LOSE';
                    if (/REMAKE|EARLY/.test(r)) return 'REMAKE';
                }
                if ((key === 'win' || key === 'is_win' || key === 'iswin') && typeof v === 'boolean') return v ? 'WIN' : 'LOSE';
            }
            for (const v of Object.values(o)) {
                const found = findResult(v, depth + 1);
                if (found) return found;
            }
            return null;
        }

        function findGameType(o, depth = 0) {
            if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3) return null;
            for (const [key, value] of Object.entries(o)) {
                if (/^(game_?type|queue_?type|queue_?id|game_?mode)$/i.test(key) &&
                    (typeof value === 'string' || typeof value === 'number')) return value;
            }
            for (const value of Object.values(o)) {
                const found = findGameType(value, depth + 1);
                if (found !== null) return found;
            }
            return null;
        }

        function formatGameType(value) {
            if (value === null || value === undefined || value === '') return '';
            const queueNames = {
                400: 'Normal / Draft Pick',
                420: 'Ranked Solo/Duo',
                430: 'Normal / Blind Pick',
                440: 'Ranked Flex',
                450: 'ARAM',
                480: 'Swiftplay',
                490: 'Quickplay'
            };
            const normalized = String(value).trim();
            return queueNames[normalized] || normalized.replace(/[_-]+/g, ' ');
        }

        // Formato compacto de OP.GG MCP:
        //   class GameHistory: id,created_at,...      <- nombres de campos
        //   LolListSummonerMatches(Data([GameHistory("...", "...", ...)]))   <- valores en ese orden
        function parseOpggCompact(text) {
            const classes = {};
            const lines = String(text).split(/\r?\n/);
            let i = 0;
            for (; i < lines.length; i++) {
                const m = /^class\s+(\w+)\s*:\s*(.*)$/.exec(lines[i]);
                if (m) classes[m[1]] = m[2].split(',').map(f => f.trim()).filter(Boolean);
                else if (lines[i].trim()) break;
            }
            const src = lines.slice(i).join('\n');
            let pos = 0;
            const ws = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };
            const fail = () => { throw new Error(`Formato de OP.GG inesperado (posición ${pos})`); };

            function list(close) {
                const out = [];
                ws();
                if (src[pos] === close) { pos++; return out; }
                for (;;) {
                    out.push(value());
                    ws();
                    if (src[pos] === ',') { pos++; continue; }
                    if (src[pos] === close) { pos++; return out; }
                    fail();
                }
            }

            function value() {
                ws();
                const c = src[pos];
                if (c === '"') {
                    let j = pos + 1, esc = false;
                    for (; j < src.length; j++) {
                        if (esc) { esc = false; continue; }
                        if (src[j] === '\\') { esc = true; continue; }
                        if (src[j] === '"') break;
                    }
                    const str = JSON.parse(src.slice(pos, j + 1));
                    pos = j + 1;
                    return str;
                }
                if (c === '[') { pos++; return list(']'); }
                const ident = /^[A-Za-z_]\w*/.exec(src.slice(pos, pos + 80));
                if (ident) {
                    const name = ident[0];
                    pos += name.length;
                    ws();
                    if (src[pos] === '(') {
                        pos++;
                        const args = list(')');
                        const fields = classes[name];
                        if (!fields) return args;
                        const obj = {};
                        fields.forEach((f, k) => { obj[f] = args[k]; });
                        return obj;
                    }
                    if (name === 'true') return true;
                    if (name === 'false') return false;
                    if (name === 'null' || name === 'None') return null;
                    return name;
                }
                const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(pos, pos + 40));
                if (num) { pos += num[0].length; return Number(num[0]); }
                fail();
            }

            return value();
        }

        function extractRecentGames(payload, acc) {
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload); }
                catch (e) {
                    try { payload = parseOpggCompact(payload); }
                    catch (e2) { console.warn(e2.message); return null; }
                }
            }
            const nameLc = splitRiotId(acc.riotId).name.toLowerCase();
            const arrays = [];
            (function walk(o, depth) {
                if (!o || typeof o !== 'object' || depth > 7) return;
                if (Array.isArray(o)) {
                    if (o.length && o[0] && typeof o[0] === 'object') arrays.push(o);
                    o.forEach(x => walk(x, depth + 1));
                } else Object.values(o).forEach(v => walk(v, depth + 1));
            })(payload, 0);

            const isGame = g => g && typeof g === 'object' && Object.keys(g).some(k => /created|started|game_length|duration|played_at|match_id|game_id/i.test(k));
            let best = null;
            for (const arr of arrays) {
                if (!arr.some(isGame)) continue; // descarta listas de jugadores de una misma partida
                const games = arr.map(g => {
                    if (!isGame(g)) return null;
                    let me = g.myData || g.my_data || g.me || g.summoner_data || null;
                    if (!me && Array.isArray(g.participants)) {
                        me = g.participants.length === 1
                            ? g.participants[0]
                            : g.participants.find(p => JSON.stringify(p).toLowerCase().includes(`"${nameLc}"`)) || null;
                    }
                    const src = me || g;
                    const champ = findChampionRef(src);
                    let result = findResult(src) || findResult(g);
                    // Partidas de menos de 4 minutos = remake
                    const duration = Number(g.game_length_second || g.game_length_seconds || g.duration);
                    if (Number.isFinite(duration) && duration > 0 && duration < 240) result = 'REMAKE';
                    const gameType = formatGameType(findGameType(g));
                    const timestamp = g.created_at ?? g.createdAt ?? g.played_at ?? g.playedAt ?? g.timestamp ?? null;
                    const id = g.id ?? g.gameId ?? g.game_id ?? g.matchId ?? g.match_id ?? null;
                    return champ !== null && result ? { id, champ, result, gameType, timestamp } : null;
                }).filter(Boolean);
                if (!best || games.length > best.length) best = games;
            }
            return best && best.length ? best.slice(0, 10) : null;
        }

        const RECENT_GAMES_FIELDS = [
            'data.game_history[].{id,created_at,game_type,game_length_second}',
            'data.game_history[].participants[].{champion_id,champion_name}',
            'data.game_history[].participants[].stats.result'
        ];

        async function fetchRecentGames(acc) {
            await mcpInit();
            const tool = mcpState.tools['lol_list_summoner_matches']
                || Object.values(mcpState.tools).find(t => /^lol.*(match|game)/i.test(t.name) && !/detail/i.test(t.name));
            if (!tool) throw new Error('MCP: el servidor no ofrece historial de partidas');

            const base = buildToolArgs(tool, acc);
            const fieldsKey = Object.keys(base).find(k => /desired_output_fields/i.test(k));
            const variants = fieldsKey
                ? [{ ...base, [fieldsKey]: RECENT_GAMES_FIELDS }, base] // la segunda, por si OP.GG cambia los nombres
                : [base];

            let lastRaw = null;
            for (const args of variants) {
                try {
                    const result = await mcpRequest('tools/call', { name: tool.name, arguments: args });
                    lastRaw = result;
                    if (result.isError) continue;
                    const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
                    const games = extractRecentGames(result.structuredContent || text, acc);
                    if (games) return games;
                } catch (e) {
                    lastRaw = { error: e.message };
                }
            }
            // Para poder ver qué devuelve el servidor y ajustar la lectura
            try {
                fs.writeFileSync(path.join(path.dirname(dataPath), 'opgg-mcp-debug.json'),
                    JSON.stringify({ tool, argsTried: variants, response: lastRaw }, null, 2));
            } catch (e) { /* sin permiso */ }
            console.warn(`OP.GG MCP: no se pudieron leer las partidas de ${acc.riotId} (detalles en opgg-mcp-debug.json)`);
            return null;
        }

        // ---------- Actualización de rangos desde OP.GG ----------
        async function refreshRanksFromOpgg() {
            const accounts = readAccounts().filter(hasRiotId);
            const friends = (settings.friendRivals || []).filter(hasRiotId);
            const profiles = [
                ...accounts.map(profile => ({ profile, isFriend: false })),
                ...friends.map(profile => ({ profile, isFriend: true }))
            ];
            if (profiles.length === 0) return;

            const results = new Map();
            for (const { profile: acc, isFriend } of profiles) {
                const resultKey = `${isFriend ? 'friend' : 'account'}:${acc.id}`;
                try {
                    const html = await httpGetText(opggUrl(acc));
                    const data = parseOpggProfile(html, acc);
                    if (!data) {
                        // Se guarda la página para poder ver qué cambió en OP.GG
                        try { fs.writeFileSync(path.join(path.dirname(dataPath), 'opgg-debug.html'), html); } catch (e) { /* sin permiso */ }
                        console.warn(`OP.GG: no se pudieron leer los datos de ${acc.riotId} (página guardada en opgg-debug.html)`);
                        if (isFriend) results.set(resultKey, { riotId: acc.riotId, region: acc.region, opggStatus: 'noData' });
                    } else if (data.notFound) {
                        results.set(resultKey, { riotId: acc.riotId, region: acc.region, opggStatus: 'notFound' });
                    } else {
                        let recentGames = null;
                        try { recentGames = await fetchRecentGames(acc); }
                        catch (e) { console.warn(`OP.GG MCP: ${acc.riotId}:`, e.message); }
                        results.set(resultKey, { riotId: acc.riotId, region: acc.region, opggStatus: 'ok', opggUpdatedAt: Date.now(), ...data, recentGames });
                    }
                } catch (e) {
                    if (e.statusCode === 404) results.set(resultKey, { riotId: acc.riotId, region: acc.region, opggStatus: 'notFound' });
                    else console.error(`OP.GG: error consultando ${acc.riotId}:`, e.message);
                }
                await new Promise(r => setTimeout(r, 1200)); // no saturar OP.GG
            }

            if (!results.size) return;
            // Se guarda sobre lo que haya en disco; si la cuenta se borró o cambió de Riot ID mientras tanto, se ignora
            const disk = readAccounts();
            const rankChanges = [];
            const desktopRankChanges = [];
            disk.forEach((a, accountIndex) => {
                const r = results.get(`account:${a.id}`);
                if (!r || a.riotId !== r.riotId || a.region !== r.region) return;
                a.opggStatus = r.opggStatus;
                if (r.opggStatus === 'ok') {
                    const history = normalizeLpHistory(a.lpHistory);
                    const previous = history.length ? history[history.length - 1] : null;
                    const current = createRankSnapshot(r.soloq, r.opggUpdatedAt);
                    if (previous && previous.rankOrder !== current.rankOrder) {
                        rankChanges.push({ account: a, previous, current });
                    }
                    if (previous && (previous.rankOrder !== current.rankOrder || previous.lp !== current.lp)) {
                        desktopRankChanges.push({ account: a, accountIndex, queue: 'solo', previous, current });
                    }
                    if (!previous || previous.rankOrder !== current.rankOrder || previous.lp !== current.lp) {
                        history.push(current);
                        a.lpHistory = history.slice(-MAX_LP_HISTORY);
                    }
                    if (r.flexRankAvailable) {
                        const flexHistory = normalizeLpHistory(a.lpHistoryFlex);
                        const previousFlex = flexHistory.length ? flexHistory[flexHistory.length - 1] : null;
                        const currentFlex = createRankSnapshot(r.flex, r.opggUpdatedAt);
                        if (previousFlex && (previousFlex.rankOrder !== currentFlex.rankOrder || previousFlex.lp !== currentFlex.lp)) {
                            desktopRankChanges.push({ account: a, accountIndex, queue: 'flex', previous: previousFlex, current: currentFlex });
                        }
                        if (!previousFlex || previousFlex.rankOrder !== currentFlex.rankOrder || previousFlex.lp !== currentFlex.lp) {
                            flexHistory.push(currentFlex);
                            a.lpHistoryFlex = flexHistory.slice(-MAX_LP_HISTORY);
                        }
                    }
                    if (r.level) a.level = r.level;
                    a.soloq = r.soloq;
                    a.flex = r.flex;
                    if (Number.isInteger(r.profileIconId) && r.profileIconId > 0) a.profileIconId = r.profileIconId;
                    a.lastSeason = r.lastSeason;
                    a.opggUpdatedAt = r.opggUpdatedAt;
                    a.ladder = r.ladder;
                    a.topChampions = r.topChampions;
                    if (r.recentGames) {
                        try {
                            window.aurumMastery.addNewGames(a, r.recentGames);
                        } catch (error) {
                            console.error(`No se pudo añadir XP por partidas nuevas de ${a.riotId}:`, error);
                        }
                        a.recentGames = r.recentGames; // si falla, se conservan las anteriores
                    }
                }
            });
            let friendsChanged = false;
            settings.friendRivals.forEach((friend, friendIndex) => {
                const r = results.get(`friend:${friend.id}`);
                if (!r || friend.riotId !== r.riotId || friend.region !== r.region) return;
                friend.opggStatus = r.opggStatus;
                friendsChanged = true;
                if (r.opggStatus !== 'ok') return;

                const history = normalizeLpHistory(friend.lpHistory);
                const previous = history.length ? history[history.length - 1] : null;
                const current = createRankSnapshot(r.soloq, r.opggUpdatedAt);
                if (previous && (previous.rankOrder !== current.rankOrder || previous.lp !== current.lp)) {
                    desktopRankChanges.push({ account: friend, accountIndex: friendIndex, queue: 'solo', previous, current, isFriend: true });
                }
                if (!previous || previous.rankOrder !== current.rankOrder || previous.lp !== current.lp) {
                    history.push(current);
                    friend.lpHistory = history.slice(-MAX_LP_HISTORY);
                }
                if (r.flexRankAvailable) {
                    const flexHistory = normalizeLpHistory(friend.lpHistoryFlex);
                    const previousFlex = flexHistory.length ? flexHistory[flexHistory.length - 1] : null;
                    const currentFlex = createRankSnapshot(r.flex, r.opggUpdatedAt);
                    if (previousFlex && (previousFlex.rankOrder !== currentFlex.rankOrder || previousFlex.lp !== currentFlex.lp)) {
                        desktopRankChanges.push({ account: friend, accountIndex: friendIndex, queue: 'flex', previous: previousFlex, current: currentFlex, isFriend: true });
                    }
                    if (!previousFlex || previousFlex.rankOrder !== currentFlex.rankOrder || previousFlex.lp !== currentFlex.lp) {
                        flexHistory.push(currentFlex);
                        friend.lpHistoryFlex = flexHistory.slice(-MAX_LP_HISTORY);
                    }
                }
                friend.soloq = r.soloq;
                friend.flex = r.flex;
                friend.opggUpdatedAt = r.opggUpdatedAt;
                if (r.recentGames) friend.recentGames = r.recentGames;
            });
            if ([...results.keys()].some(key => key.startsWith('account:'))) writeAccounts(disk);
            if (friendsChanged) saveSettings();
            loadAccounts();
            showNeonNotification(t('syncMsg'));
            notifyRankChanges(rankChanges);
            notifyDesktopRankChanges(desktopRankChanges);
        }

        // ---------- Panel lateral: añadir / editar cuenta ----------
        const drawer = document.getElementById('account-drawer');
        const drawerOverlay = document.getElementById('drawer-overlay');
        const drawerTitle = document.getElementById('drawer-title');
        const drawerTabs = document.getElementById('drawer-tabs');
        const tabSingle = document.getElementById('tab-single');
        const tabBulk = document.getElementById('tab-bulk');
        const accLoginUser = document.getElementById('acc-login-user');
        const accRiotId = document.getElementById('acc-riot-id');
        const accRegion = document.getElementById('acc-region');
        const accPassword = document.getElementById('acc-password');
        const accDescription = document.getElementById('acc-description');
        const accTags = document.getElementById('acc-tags');
        const accGroup = document.getElementById('acc-group');
        const singleError = document.getElementById('single-error');
        const drawerSubmitLabel = document.getElementById('drawer-submit-label');
        const bulkText = document.getElementById('bulk-text');
        const bulkRegion = document.getElementById('bulk-region');
        const bulkError = document.getElementById('bulk-error');
        let drawerMode = 'add';
        let editingId = null;

        function setDrawerTab(tab) {
            drawerTabs.querySelectorAll('.drawer-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
            tabSingle.style.display = tab === 'single' ? 'block' : 'none';
            tabBulk.style.display = tab === 'bulk' ? 'block' : 'none';
        }

        function clearDrawerErrors() {
            singleError.textContent = '';
            bulkError.textContent = '';
            [accLoginUser, accRiotId, accPassword].forEach(i => i.classList.remove('invalid'));
        }

        function openDrawer(mode = 'add', acc = null) {
            drawerMode = mode;
            editingId = acc ? acc.id : null;
            const isEdit = mode === 'edit';

            // data-i18n se actualiza para que un cambio de idioma respete el modo
            drawerTitle.setAttribute('data-i18n', isEdit ? 'drawerEditTitle' : 'drawerAddTitle');
            drawerTitle.textContent = t(isEdit ? 'drawerEditTitle' : 'drawerAddTitle');
            drawerSubmitLabel.setAttribute('data-i18n', isEdit ? 'saveChangesBtn' : 'addAccountBtn');
            drawerSubmitLabel.textContent = t(isEdit ? 'saveChangesBtn' : 'addAccountBtn');
            drawerTabs.style.display = isEdit ? 'none' : 'flex';
            setDrawerTab('single');

            accLoginUser.value = acc ? (acc.loginUser || '') : '';
            accRiotId.value = acc ? (acc.riotId || '') : '';
            accRegion.value = acc && REGIONS.includes(acc.region) ? acc.region : 'euw';
            accPassword.value = '';
            accPassword.type = 'password';
            accPassword.placeholder = isEdit ? t('passwordKeepPh') : '';
            accDescription.value = acc ? (acc.description || '') : '';
            accTags.value = acc && Array.isArray(acc.tags) ? acc.tags.join(', ') : '';
            accGroup.value = acc ? (acc.group || '') : '';
            if (!isEdit) bulkText.value = '';
            clearDrawerErrors();

            drawer.classList.add('open');
            drawerOverlay.classList.add('open');
            drawer.setAttribute('aria-hidden', 'false');
            setTimeout(() => accLoginUser.focus(), 60);
        }

        function closeDrawer() {
            drawer.classList.remove('open');
            drawerOverlay.classList.remove('open');
            drawer.setAttribute('aria-hidden', 'true');
            accPassword.value = '';
        }

        function isDuplicateUser(accounts, loginUser, exceptId = null) {
            const u = loginUser.toLowerCase();
            return accounts.some(a => a.id !== exceptId && String(a.loginUser || '').toLowerCase() === u);
        }

        function showFieldError(input, key) {
            singleError.textContent = t(key);
            if (input) { input.classList.add('invalid'); input.focus(); }
        }

        function submitSingle() {
            clearDrawerErrors();
            const loginUser = accLoginUser.value.trim();
            const riotId = accRiotId.value.trim();
            const region = accRegion.value;
            const password = accPassword.value; // sin trim: los espacios pueden ser parte de la contraseña
            const description = accDescription.value.trim();
            const tags = normalizeTags(accTags.value);
            const group = accGroup.value.trim();
            const isEdit = drawerMode === 'edit';

            if (!loginUser) return showFieldError(accLoginUser, 'errLoginUser');
            if (riotId && !/^[^#]+#[^#]+$/.test(riotId)) return showFieldError(accRiotId, 'errRiotId');
            if (!isEdit && !password) return showFieldError(accPassword, 'errPassword');

            const accounts = readAccounts();
            if (isDuplicateUser(accounts, loginUser, editingId)) return showFieldError(accLoginUser, 'errDuplicate');

            let needsRefresh = false;
            if (isEdit) {
                const acc = accounts.find(a => a.id === editingId);
                if (!acc) { closeDrawer(); loadAccounts(); return; }
                const riotIdChanged = acc.riotId !== riotId;
                const riotChanged = riotIdChanged || acc.region !== region;
                Object.assign(acc, { loginUser, riotId, region, description, tags, group });
                if (password) setAccountPassword(acc, password);
                if (loginUser && (password || getAccountPassword(acc))) delete acc.clientImportedNeedsCredentials;
                if (riotChanged) {
                    // El rango guardado era de otro Riot ID/región
                    Object.assign(acc, { level: null, soloq: EMPTY_QUEUE(), flex: EMPTY_QUEUE(), lastSeason: null });
                    if (riotIdChanged) {
                        delete acc.puuid;
                        delete acc.profileIconId;
                    }
                    delete acc.opggUpdatedAt;
                    delete acc.opggStatus;
                    delete acc.lpHistory;
                    delete acc.ladder;
                    delete acc.topChampions;
                    delete acc.recentGames;
                    needsRefresh = !!riotId;
                }
            } else {
                const acc = {
                    id: newAccountId(), loginUser, riotId, region, description, tags, group,
                    order: nextAccountOrder(accounts),
                    level: null, soloq: EMPTY_QUEUE(), flex: EMPTY_QUEUE(), lastSeason: null
                };
                setAccountPassword(acc, password);
                accounts.push(acc);
                needsRefresh = !!riotId;
            }

            writeAccounts(accounts);
            loadAccounts();
            closeDrawer();
            showNeonNotification(t(isEdit ? 'accountSaved' : 'accountAdded'));
            if (needsRefresh) runRefresh();
        }

        // "usuario:contraseña[:región][:Nombre#TAG]" — la contraseña puede contener ':'
        function parseBulkLine(line, defaultRegion) {
            const parts = line.split(':');
            if (parts.length < 2) return null;
            const loginUser = parts.shift().trim();
            let riotId = '';
            let region = defaultRegion;
            if (parts.length > 1 && parts[parts.length - 1].includes('#')) riotId = parts.pop().trim();
            if (parts.length > 1 && normalizeRegion(parts[parts.length - 1])) region = normalizeRegion(parts.pop());
            const password = parts.join(':');
            if (!loginUser || !password) return null;
            if (riotId && !/^[^#]+#[^#]+$/.test(riotId)) return null;
            return { loginUser, password, region, riotId };
        }

        function submitBulk() {
            clearDrawerErrors();
            const lines = bulkText.value.split(/\r?\n/);
            const accounts = readAccounts();
            let added = 0, skipped = 0, anyLine = false;
            const invalid = [];

            lines.forEach((raw, idx) => {
                const line = raw.trim();
                if (!line) return;
                anyLine = true;
                const parsed = parseBulkLine(line, bulkRegion.value);
                if (!parsed) { invalid.push(idx + 1); return; }
                if (isDuplicateUser(accounts, parsed.loginUser)) { skipped++; return; }
                const acc = {
                    id: newAccountId(), loginUser: parsed.loginUser, riotId: parsed.riotId, region: parsed.region,
                    description: '', tags: [], group: '', order: nextAccountOrder(accounts),
                    level: null, soloq: EMPTY_QUEUE(), flex: EMPTY_QUEUE(), lastSeason: null
                };
                setAccountPassword(acc, parsed.password);
                accounts.push(acc);
                added++;
            });

            if (!anyLine) { bulkError.textContent = t('errBulkEmpty'); bulkText.focus(); return; }
            if (added === 0 && invalid.length) {
                bulkError.textContent = `${t('bulkInvalidLines')}: ${invalid.join(', ')}`;
                return;
            }

            if (added) writeAccounts(accounts);
            loadAccounts();
            closeDrawer();
            let msg = `${t('bulkAdded')}: ${added}`;
            if (skipped) msg += ` · ${skipped} ${t('bulkSkipped')}`;
            if (invalid.length) msg += ` · ${t('bulkInvalidLines')}: ${invalid.join(', ')}`;
            showNeonNotification(msg);
            if (added) runRefresh();
        }

        drawerTabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.drawer-tab');
            if (tab) { clearDrawerErrors(); setDrawerTab(tab.dataset.tab); }
        });
        document.getElementById('toggle-password').addEventListener('click', () => {
            if (settings.streamerMode && settings.streamerPass) return;   // el modo streamer no deja enseñar contraseñas
            accPassword.type = accPassword.type === 'password' ? 'text' : 'password';
        });
        document.getElementById('drawer-submit').addEventListener('click', submitSingle);
        document.getElementById('bulk-submit').addEventListener('click', submitBulk);
        tabSingle.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitSingle(); });
        document.getElementById('drawer-close').addEventListener('click', closeDrawer);
        drawerOverlay.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
        });
        btnAdd.addEventListener('click', () => openDrawer('add'));
        // ---------- Modal de ajustes ----------
        const setLanguageSel = document.getElementById('set-language');
        const setVisualTheme = document.getElementById('set-visual-theme');
        const setLaunchStartup = document.getElementById('set-launch-startup');
        const setStartMinimized = document.getElementById('set-start-minimized');
        const setChristmasTheme = document.getElementById('set-christmas-theme');
        const setRankedFocus = document.getElementById('set-ranked-focus');
        const setAutoRefresh = document.getElementById('set-auto-refresh');
        const soundboardVolume = document.getElementById('soundboard-volume');
        const soundboardVolumeValue = document.getElementById('soundboard-volume-value');
        const christmasMusicVolumeInput = document.getElementById('christmas-music-volume');
        const christmasMusicVolumeValue = document.getElementById('christmas-music-volume-value');
        const soundboardToggle = document.getElementById('soundboard-toggle');
        const rankedFocusWidget = document.getElementById('ranked-focus-widget');
        const rankedFocusTimer = document.getElementById('ranked-focus-timer');
        const rankedFocusQueue = document.getElementById('ranked-focus-queue');
        const rankedFocusAccount = document.getElementById('ranked-focus-account');
        const rankedFocusExit = document.getElementById('ranked-focus-exit');
        rankedFocusExit.addEventListener('click', () => {
            try {
                window.aurumFocusMode.setEnabled(false);
                setRankedFocus.checked = false;
                updateRankedFocusState();
            } catch (error) {
                console.error('No se pudo desactivar Ranked Focus:', error);
                showNeonNotification(t('focusSaveError'));
            }
        });
        const aurumMatchModal = document.getElementById('aurum-match-modal');
        const duoQueueFilter = document.getElementById('duo-queue-filter');
        const duoRoleFilter = document.getElementById('duo-role-filter');
        const duoFeed = document.getElementById('duo-feed');
        const duoFeedEmpty = document.getElementById('duo-feed-empty');
        const duoBoardStatus = document.getElementById('duo-board-status');
        const duoPublishModal = document.getElementById('duo-publish-modal');
        const duoPublishForm = document.getElementById('duo-publish-form');
        const duoPublishStatus = document.getElementById('duo-publish-status');
        const duoPublishButton = document.getElementById('duo-publish-submit');
        const duoPublicConsent = document.getElementById('duo-public-consent');
        const duoAccountSelect = document.getElementById('duo-account');
        const duoPrimaryRole = document.getElementById('duo-primary-role');
        const duoSecondaryRole = document.getElementById('duo-secondary-role');
        const duoQueueSelect = document.getElementById('duo-queue');
        const duoPlayStyle = document.getElementById('duo-play-style');
        const duoVoiceSelect = document.getElementById('duo-voice');
        const duoGoalInput = document.getElementById('duo-goal');
        let duoLcuFriends = [];
        const setRankNotifications = document.getElementById('set-rank-notifications');
        const setDesktopNotifications = document.getElementById('set-desktop-notifications');
        const setRefreshMinutes = document.getElementById('set-refresh-minutes');
        const setLaunchGame = document.getElementById('set-launch-game');
        const intervalBlock = document.getElementById('interval-block');
        const presetButtons = document.querySelectorAll('#preset-group .preset-btn');
        const btnSaveSettings = document.getElementById('save-settings');
        const btnXSettings = document.getElementById('settings-x');
        const setAutoUpdates = document.getElementById('set-auto-updates');
        const setStIds = document.getElementById('set-st-ids');
        const setStLogin = document.getElementById('set-st-login');
        const setStDescs = document.getElementById('set-st-descs');
        const setStPass = document.getElementById('set-st-pass');
        const setTrayIcon = document.getElementById('set-tray-icon');
        const setTrayClose = document.getElementById('set-tray-close');
        const setTrayShortcutOn = document.getElementById('set-tray-shortcut-on');
        const shortcutBtn = document.getElementById('set-shortcut-btn');
        const shortcutWarn = document.getElementById('shortcut-warn');
        const settingsTabs = Array.from(document.querySelectorAll('[data-settings-tab]'));
        const settingsSections = Array.from(document.querySelectorAll('[data-settings-category]'));
        const settingsContent = document.getElementById('settings-content');
        const SETTINGS_CATEGORY_STORAGE_KEY = 'aurum-settings-selected-category';
        let activeSettingsCategory = 'general';
        try {
            const savedCategory = localStorage.getItem(SETTINGS_CATEGORY_STORAGE_KEY);
            if (settingsTabs.some(tab => tab.dataset.settingsTab === savedCategory)) {
                activeSettingsCategory = savedCategory;
            }
        } catch (error) {
            console.error('No se pudo restaurar la categoría de Ajustes:', error);
        }

        function highlightPreset(minutes) {
            presetButtons.forEach(b => b.classList.toggle('active', parseInt(b.dataset.min, 10) === minutes));
        }

        function syncDependentControls() {
            intervalBlock.classList.toggle('interval-disabled', !setAutoRefresh.checked);
            setStartMinimized.disabled = !setLaunchStartup.checked;
        }

        function refreshSoundboardButton() {
            const state = window.aurumSoundboard.getState();
            soundboardToggle.classList.toggle('is-muted', state.muted);
            soundboardToggle.setAttribute('aria-pressed', String(!state.muted));
            const label = t(state.muted ? 'soundUnmute' : 'soundMute');
            soundboardToggle.title = label;
            soundboardToggle.setAttribute('aria-label', label);
        }

        function duoRoleOptions(selectedRole) {
            const roles = window.aurumDuoFinder.roles;
            const emptyOption = `<option value="">${escapeHtml(t('duoNoSecondaryRole'))}</option>`;
            return (selectedRole === '' ? emptyOption : '') + roles.map(role =>
                `<option value="${role}">${escapeHtml(t(`duoRole${role[0].toUpperCase()}${role.slice(1)}`))}</option>`
            ).join('');
        }

        function getDuoWinRate(account) {
            const value = getDuoWinRateValue(account);
            return value === null ? t('duoNoRecentGames') : `${value}%`;
        }

        function getDuoWinRateValue(account) {
            const games = account && Array.isArray(account.recentGames) ? account.recentGames.slice(0, 10) : [];
            const results = games.map(game => String(game && game.result || '').toUpperCase());
            const decisive = results.filter(result => ['WIN', 'VICTORY', 'LOSE', 'LOSS', 'DEFEAT'].includes(result));
            if (!decisive.length) return null;
            const wins = decisive.filter(result => result === 'WIN' || result === 'VICTORY').length;
            return Math.round(wins / decisive.length * 100);
        }

        function setDuoBoardStatus(messageKey, state = '') {
            duoBoardStatus.textContent = messageKey ? t(messageKey) : '';
            if (state) duoBoardStatus.dataset.state = state;
            else delete duoBoardStatus.dataset.state;
        }

        function duoRoleLabel(role) {
            return role ? t(`duoRole${role[0].toUpperCase()}${role.slice(1)}`) : '';
        }

        function duoAccountLabel(account, accountIndex) {
            const hiddenId = settings.streamerMode && settings.streamerIds;
            const hiddenLogin = settings.streamerMode && settings.streamerLogin;
            if (hiddenId) return t('duoAccountNumber').replace('{n}', String(accountIndex + 1));
            return account.riotId || (!hiddenLogin ? account.loginUser : '') || t('duoUnknownAccount');
        }

        function duoRankDetails(queue, hiddenRank) {
            if (hiddenRank) return { text: t('duoHidden'), tier: 'UNRANKED', lp: '' };
            const rawTier = String(queue && queue.tier || 'UNRANKED').toUpperCase();
            if (rawTier === 'UNRANKED') return { text: t('unranked'), tier: 'UNRANKED', lp: '' };
            const tier = rawTier.split(/\s+/)[0];
            const lp = Math.max(0, Number(queue && queue.lp) || 0);
            return { text: `${prettyTier(rawTier)} · ${lp} LP`, tier, lp: `${lp} LP` };
        }

        function duoCreateEntry(account, details, index, own) {
            const hiddenId = settings.streamerMode && settings.streamerIds;
            const hiddenLogin = settings.streamerMode && settings.streamerLogin;
            const hiddenRank = settings.streamerMode && settings.streamerIds;
            const sourceAccount = account || {};
            const rankQueue = details.rankTier
                ? { tier: details.rankTier, lp: details.rankLp }
                : details.rank_tier
                    ? { tier: details.rank_tier, lp: details.rank_lp }
                    : details.queue === 'flex' ? sourceAccount.flex : sourceAccount.soloq;
            const profileIconId = Number(sourceAccount.profileIconId);
            const profileIcon = Number.isInteger(profileIconId) && profileIconId > 0 && ddragon.version
                ? `https://ddragon.leagueoflegends.com/cdn/${ddragon.version}/img/profileicon/${profileIconId}.png`
                : '';
            const riotId = details.riotId || sourceAccount.riotId || '';
            const name = hiddenId
                ? own ? t('duoAccountNumber').replace('{n}', String(index + 1)) : t('duoAccountHidden')
                : riotId || (!hiddenLogin ? sourceAccount.loginUser : '') || t('duoUnknownAccount');
            const rank = duoRankDetails(rankQueue, hiddenRank);
            const winRateValue = details.winRate !== undefined ? details.winRate : details.win_rate;
            return {
                type: own ? 'own' : 'friend',
                id: details.id,
                ownerId: details.ownerId || details.owner_id || '',
                accountId: sourceAccount.id || details.accountId || details.account_key || '',
                riotId,
                summonerId: sourceAccount.summonerId || details.summonerId || '',
                displayName: name,
                region: details.region || sourceAccount.region || 'euw',
                profileIcon: sourceAccount.profileIcon || profileIcon,
                rank,
                winRate: hiddenRank ? t('duoHidden')
                    : winRateValue !== null && winRateValue !== undefined && winRateValue !== ''
                        && Number.isFinite(Number(winRateValue)) ? `${Number(winRateValue)}%`
                        : getDuoWinRate(sourceAccount),
                queue: details.queue || 'soloDuo',
                primaryRole: details.primaryRole || '',
                secondaryRole: details.secondaryRole || '',
                playStyle: details.playStyle || details.play_style || '',
                voice: details.voice || 'any',
                goal: details.goal || '',
                publishedAt: details.publishedAt || details.created_at && Date.parse(details.created_at) || Date.now(),
                tacticalTags: Array.isArray(sourceAccount.tacticalTags) ? sourceAccount.tacticalTags : []
            };
        }

        function duoFriendEntries() {
            const entries = [];
            const seen = new Set(readAccounts().map(account => String(account.riotId || '').toLocaleLowerCase()).filter(Boolean));
            const contacts = [
                ...(Array.isArray(settings.friendRivals) ? settings.friendRivals : []),
                ...duoLcuFriends
            ];
            contacts.forEach((friend, index) => {
                const riotId = String(friend && friend.riotId || '').trim();
                if (!riotId || seen.has(riotId.toLocaleLowerCase())) return;
                seen.add(riotId.toLocaleLowerCase());
                const current = {
                    ...friend,
                    id: friend.id || `lcu-friend-${index}`,
                    riotId,
                    region: friend.region || 'euw',
                    soloq: friend.soloq || { tier: 'UNRANKED', lp: 0 },
                    flex: friend.flex || { tier: 'UNRANKED', lp: 0 },
                    recentGames: Array.isArray(friend.recentGames) ? friend.recentGames : []
                };
                entries.push(duoCreateEntry(current, {
                    id: current.id,
                    queue: 'soloDuo',
                    primaryRole: '',
                    secondaryRole: '',
                    playStyle: current.note || '',
                    publishedAt: current.opggUpdatedAt || Date.now()
                }, index, false));
            });
            return entries;
        }

        let duoRenderedEntries = [];

        function renderDuoCard(entry, index) {
            const tierIcon = tierIcons[entry.rank.tier] || tierIcons.UNRANKED;
            const avatar = entry.profileIcon
                ? `<img src="${escapeHtml(entry.profileIcon)}" alt="" aria-hidden="true">`
                : `<span>${escapeHtml((entry.displayName || '?').slice(0, 1).toUpperCase())}</span>`;
            const roles = [entry.primaryRole, entry.secondaryRole].filter(Boolean);
            const roleChips = roles.length
                ? roles.map(role => `<span class="duo-role-chip">${escapeHtml(duoRoleLabel(role))}</span>`).join('')
                : `<span class="duo-role-chip is-muted">${escapeHtml(t('duoRoleFlexible'))}</span>`;
            const tags = entry.tacticalTags.map(id => TACTICAL_TAGS.find(tag => tag.id === id)).filter(Boolean);
            const tagMarkup = tags.map(tag => `<span class="rival-tactical-badge ${tag.id}">${escapeHtml(t(tag.labelKey))}</span>`).join('');
            const age = Math.max(0, Math.floor((Date.now() - entry.publishedAt) / 60000));
            const ageText = age < 1 ? t('duoJustNow') : age < 60
                ? t('duoMinutesAgo').replace('{n}', String(age))
                : t('duoHoursAgo').replace('{n}', String(Math.floor(age / 60)));
            const ownerActions = entry.type === 'own'
                ? `<button type="button" class="duo-card-action is-secondary" data-duo-action="renew" data-duo-index="${index}">${escapeHtml(t('duoRenew'))}</button>
                   <button type="button" class="duo-card-action is-danger" data-duo-action="delete" data-duo-index="${index}">${escapeHtml(t('duoDelete'))}</button>`
                : `<button type="button" class="duo-card-action is-primary" data-duo-action="invite" data-duo-index="${index}">${escapeHtml(t('duoInviteToLobby'))}</button>`;
            const voice = entry.voice === 'yes' ? t('duoVoiceYes') : entry.voice === 'no' ? t('duoVoiceNo') : t('duoVoiceAny');
            const queueName = t(entry.queue === 'flex' ? 'duoQueueFlex' : 'duoQueueSolo');
            const region = regionLabel(entry.region);
            return `<article class="duo-listing-card ${entry.type === 'own' ? 'is-own' : ''}" role="listitem">
                <div class="duo-listing-player">
                    <div class="duo-listing-avatar">${avatar}</div>
                    <div class="duo-listing-identity">
                        <div class="duo-listing-name-row">
                            <strong>${escapeHtml(entry.displayName)}</strong>
                            ${entry.type === 'own' ? `<span class="duo-owner-badge">${escapeHtml(t('duoYourListing'))}</span>` : ''}
                        </div>
                        <span class="duo-listing-region">${escapeHtml(region)} · ${escapeHtml(entry.type === 'own' ? queueName : t('duoFriendListing'))} · ${escapeHtml(ageText)}</span>
                    </div>
                </div>
                <div class="duo-listing-rank">
                    <img src="${escapeHtml(tierIcon)}" alt="" aria-hidden="true">
                    <div><strong>${escapeHtml(entry.rank.text)}</strong><span>${escapeHtml(t('duoWinRate'))}: ${escapeHtml(entry.winRate)}</span></div>
                </div>
                <div class="duo-listing-preferences">
                    <div class="duo-listing-roles">${roleChips}</div>
                    <div class="duo-listing-tactics">
                        ${entry.playStyle ? `<span>✦ ${escapeHtml(entry.playStyle)}</span>` : ''}
                        <span>${escapeHtml(t('duoVoice'))}: ${escapeHtml(voice)}</span>
                        ${entry.goal ? `<span>${escapeHtml(t('duoGoal'))}: ${escapeHtml(entry.goal)}</span>` : ''}
                        ${tagMarkup}
                    </div>
                </div>
                <div class="duo-listing-actions">${ownerActions}</div>
            </article>`;
        }

        function renderDuoFeed() {
            const accounts = readAccounts();
            const accountIndex = new Map(accounts.map((account, index) => [account.id, index]));
            const ownerId = window.aurumDuoFinder.getOwnerId();
            const globalEntries = window.aurumDuoFinder.getPosts()
                .map(post => {
                    const account = accounts.find(item => item.id === post.accountId);
                    const own = post.ownerId
                        ? post.ownerId === ownerId
                        : !window.aurumDuoFinder.isOnline();
                    return duoCreateEntry(account || post, post, account ? accountIndex.get(account.id) || 0 : 0, own);
                })
                .filter(Boolean);
            const globalIds = new Set(globalEntries.map(entry => entry.riotId.toLocaleLowerCase()).filter(Boolean));
            const friendEntries = duoFriendEntries().filter(entry => !globalIds.has(entry.riotId.toLocaleLowerCase()));
            const queueFilter = duoQueueFilter.value;
            const roleFilter = duoRoleFilter.value;
            const allEntries = [...globalEntries, ...friendEntries].filter(entry => {
                const matchesQueue = queueFilter === 'all' || entry.type === 'friend' || entry.queue === queueFilter;
                const matchesRole = roleFilter === 'all' || entry.type === 'friend'
                    || entry.primaryRole === roleFilter || entry.secondaryRole === roleFilter;
                return matchesQueue && matchesRole;
            });
            duoRenderedEntries = allEntries;
            duoFeed.innerHTML = allEntries.map(renderDuoCard).join('');
            duoFeed.hidden = allEntries.length === 0;
            duoFeedEmpty.hidden = allEntries.length > 0;
            duoFeedEmpty.classList.toggle('is-offline', !window.aurumDuoFinder.isOnline());
        }

        function renderDuoPublishForm() {
            const accounts = readAccounts();
            const profile = window.aurumDuoFinder.getProfile();
            const selectedId = accounts.some(account => account.id === profile.accountId)
                ? profile.accountId
                : accounts.some(account => account.id === activeClientAccountId)
                    ? activeClientAccountId
                    : accounts[0] && accounts[0].id || '';
            duoAccountSelect.innerHTML = accounts.length
                ? accounts.map((account, index) => `<option value="${escapeHtml(account.id)}">${escapeHtml(duoAccountLabel(account, index))}</option>`).join('')
                : `<option value="">${escapeHtml(t('duoNoAccounts'))}</option>`;
            duoAccountSelect.disabled = !accounts.length;
            duoAccountSelect.value = selectedId;
            duoPrimaryRole.innerHTML = duoRoleOptions(profile.primaryRole);
            duoPrimaryRole.value = profile.primaryRole;
            duoSecondaryRole.innerHTML = duoRoleOptions('');
            duoSecondaryRole.value = profile.secondaryRole;
            duoQueueSelect.value = profile.queue;
            duoPlayStyle.value = profile.playStyle;
            duoVoiceSelect.value = profile.voice;
            duoGoalInput.value = profile.goal;
            duoPublishButton.disabled = !accounts.length;
            duoPublicConsent.checked = false;
        }

        function setDuoPublishStatus(messageKey, state = '') {
            duoPublishStatus.textContent = messageKey ? t(messageKey) : '';
            if (state) duoPublishStatus.dataset.state = state;
            else delete duoPublishStatus.dataset.state;
        }

        function openDuoPublish() {
            renderDuoPublishForm();
            setDuoPublishStatus('');
            duoPublishModal.style.display = 'flex';
            duoPublishModal.setAttribute('aria-hidden', 'false');
            duoAccountSelect.focus();
        }

        function closeDuoPublish() {
            duoPublishModal.style.display = 'none';
            duoPublishModal.setAttribute('aria-hidden', 'true');
        }

        function renderDuoMatch() {
            renderDuoFeed();
            if (duoPublishModal.style.display === 'flex') renderDuoPublishForm();
        }

        function openAurumMatch() {
            renderDuoMatch();
            setDuoBoardStatus('');
            aurumMatchModal.style.display = 'flex';
            aurumMatchModal.setAttribute('aria-hidden', 'false');
            syncDuoLcuFriends();
        }

        function closeAurumMatch() {
            closeDuoPublish();
            aurumMatchModal.style.display = 'none';
            aurumMatchModal.setAttribute('aria-hidden', 'true');
        }

        async function publishDuoAnnouncement(event) {
            event.preventDefault();
            if (!duoAccountSelect.value) {
                setDuoPublishStatus('duoNoAccountForAnnouncement', 'error');
                return;
            }
            if (!duoPublicConsent.checked) {
                setDuoPublishStatus('duoPublicConsentRequired', 'error');
                return;
            }
            const account = readAccounts().find(item => item.id === duoAccountSelect.value);
            if (!account || !account.riotId) {
                setDuoPublishStatus('duoPublicIdentityMissing', 'error');
                return;
            }
            const queue = duoQueueSelect.value === 'flex' ? account.flex : account.soloq;
            const profile = window.aurumDuoFinder.getProfile();
            const profileToSave = {
                ...profile,
                accountId: account.id,
                primaryRole: duoPrimaryRole.value,
                secondaryRole: duoSecondaryRole.value,
                queue: duoQueueSelect.value,
                playStyle: duoPlayStyle.value,
                voice: duoVoiceSelect.value,
                goal: duoGoalInput.value
            };
            duoPublishButton.disabled = true;
            setDuoPublishStatus('duoPublishSending');
            try {
                const result = await window.aurumDuoFinder.publishPost({
                    ...profileToSave,
                    id: undefined,
                    riotId: account.riotId,
                    region: account.region,
                    rankTier: queue && queue.tier || 'UNRANKED',
                    rankLp: queue && queue.lp,
                    winRate: getDuoWinRateValue(account)
                });
                window.aurumDuoFinder.saveProfile(profileToSave);
                renderDuoFeed();
                if (result.ok) {
                    setDuoBoardStatus('duoPublished', 'success');
                } else {
                    setDuoBoardStatus('duoOfflinePublished', 'offline');
                }
                closeDuoPublish();
            } catch (error) {
                console.error('No se pudo publicar el anuncio de Aurum Match:', error);
                setDuoPublishStatus('duoPublishError', 'error');
            } finally {
                duoPublishButton.disabled = false;
            }
        }

        async function syncDuoLcuFriends() {
            const lock = readLeagueClientLockfile() || latestGameClientLock;
            if (!lock) {
                if (window.aurumDuoFinder.isOnline()) setDuoBoardStatus('duoLcuOffline');
                return;
            }
            try {
                const response = await riotClientRequest('GET', '/lol-chat/v1/friends', lock);
                if (!response.ok) {
                    setDuoBoardStatus('duoFriendListError', 'error');
                    return;
                }
                const friends = JSON.parse(response.body);
                duoLcuFriends = (Array.isArray(friends) ? friends : []).map(friend => {
                    const gameName = String(friend && (friend.gameName || friend.name || friend.displayName) || '').trim();
                    const gameTag = String(friend && (friend.gameTag || friend.tagLine || friend.tag) || '').trim().replace(/^#/, '');
                    const riotId = gameName && gameTag ? `${gameName}#${gameTag}` : '';
                    return {
                        ...friend,
                        riotId,
                        summonerId: friend && friend.summonerId,
                        profileIconId: friend && friend.profileIconId
                    };
                }).filter(friend => friend.riotId);
                if (window.aurumDuoFinder.isOnline()) setDuoBoardStatus('duoFriendListUpdated', 'success');
                renderDuoFeed();
            } catch (error) {
                console.error('No se pudo actualizar la lista de amigos del LCU:', error);
                setDuoBoardStatus('duoFriendListError', 'error');
            }
        }

        async function inviteDuoEntry(entry) {
            if (!entry || !entry.riotId) {
                setDuoBoardStatus('duoFriendNotFound', 'error');
                return;
            }
            const lock = readLeagueClientLockfile() || latestGameClientLock;
            if (!lock) {
                try {
                    clipboard.writeText(entry.riotId);
                    setDuoBoardStatus('duoInviteCopied', 'success');
                } catch (error) {
                    console.error('No se pudo copiar el Riot ID:', error);
                    setDuoBoardStatus('duoCopyError', 'error');
                }
                return;
            }

            setDuoBoardStatus('duoInviteSending');
            try {
                let summonerId = Number(entry.summonerId);
                if (!Number.isSafeInteger(summonerId) || summonerId <= 0) {
                    const friendsResponse = await riotClientRequest('GET', '/lol-chat/v1/friends', lock);
                    if (!friendsResponse.ok) {
                        setDuoBoardStatus('duoFriendListError', 'error');
                        return;
                    }
                    const separator = entry.riotId.lastIndexOf('#');
                    const targetName = entry.riotId.slice(0, separator).trim().toLocaleLowerCase();
                    const targetTag = entry.riotId.slice(separator + 1).trim().toLocaleLowerCase();
                    const friends = JSON.parse(friendsResponse.body);
                    const friend = (Array.isArray(friends) ? friends : []).find(item => {
                        const gameName = String(item && (item.gameName || item.name || item.displayName) || '').trim();
                        const gameTag = String(item && (item.gameTag || item.tagLine || item.tag) || '').trim().replace(/^#/, '');
                        return gameName.toLocaleLowerCase() === targetName && gameTag.toLocaleLowerCase() === targetTag;
                    });
                    summonerId = Number(friend && friend.summonerId);
                }
                if (!Number.isSafeInteger(summonerId) || summonerId <= 0) {
                    setDuoBoardStatus('duoFriendNotFound', 'error');
                    return;
                }
                const response = await riotClientRequest(
                    'POST',
                    '/lol-lobby/v2/lobby/invitations',
                    lock,
                    5000,
                    [{ toSummonerId: summonerId }]
                );
                if (!response.ok) {
                    setDuoBoardStatus('duoInviteError', 'error');
                    return;
                }
                setDuoBoardStatus('duoInviteSent', 'success');
            } catch (error) {
                console.error('No se pudo invitar desde el cliente LCU:', error);
                setDuoBoardStatus('duoInviteError', 'error');
            }
        }

        async function handleDuoFeedAction(event) {
            const button = event.target.closest('[data-duo-action]');
            if (!button) return;
            const index = Number(button.dataset.duoIndex);
            const entry = duoRenderedEntries[index];
            if (!entry) return;
            if (button.dataset.duoAction === 'invite') {
                await inviteDuoEntry(entry);
                return;
            }
            if (entry.type !== 'own') return;
            button.disabled = true;
            const result = button.dataset.duoAction === 'renew'
                ? await window.aurumDuoFinder.renewPost(entry.id)
                : await window.aurumDuoFinder.deletePost(entry.id);
            button.disabled = false;
            if (!result.ok) {
                setDuoBoardStatus('duoPostUpdateError', 'error');
                return;
            }
            const action = button.dataset.duoAction;
            setDuoBoardStatus(result.offline
                ? action === 'renew' ? 'duoOfflinePostRenewed' : 'duoOfflinePostDeleted'
                : action === 'renew' ? 'duoPostRenewed' : 'duoPostDeleted',
            result.offline ? 'offline' : 'success');
            renderDuoFeed();
        }

        document.getElementById('btn-aurum-match').addEventListener('click', openAurumMatch);
        document.getElementById('aurum-match-close').addEventListener('click', closeAurumMatch);
        aurumMatchModal.addEventListener('click', event => {
            if (event.target === aurumMatchModal) closeAurumMatch();
        });
        document.getElementById('duo-publish-open').addEventListener('click', openDuoPublish);
        document.getElementById('duo-publish-empty').addEventListener('click', openDuoPublish);
        document.getElementById('duo-publish-close').addEventListener('click', closeDuoPublish);
        document.getElementById('duo-publish-cancel').addEventListener('click', closeDuoPublish);
        duoPublishModal.addEventListener('click', event => {
            if (event.target === duoPublishModal) closeDuoPublish();
        });
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape') return;
            if (duoPublishModal.style.display === 'flex') closeDuoPublish();
            else if (aurumMatchModal.style.display === 'flex') closeAurumMatch();
        });
        duoPublishForm.addEventListener('submit', publishDuoAnnouncement);
        duoQueueFilter.addEventListener('change', renderDuoFeed);
        duoRoleFilter.addEventListener('change', renderDuoFeed);
        duoFeed.addEventListener('click', handleDuoFeedAction);
        document.getElementById('duo-refresh').addEventListener('click', syncDuoLcuFriends);
        window.aurumDuoFinder.initialize(({ online }) => {
            setDuoBoardStatus(online ? 'duoGlobalOnline' : 'duoOfflineMode', online ? 'success' : 'offline');
            renderDuoFeed();
        }).catch(error => {
            console.error('No se pudo iniciar el tablón de Aurum Match:', error);
            setDuoBoardStatus('duoOfflineMode', 'offline');
            renderDuoFeed();
        });

        function renderRankedFocusWidget(state) {
            const isActive = !!(state && state.active);
            rankedFocusWidget.hidden = !isActive;
            rankedFocusWidget.setAttribute('aria-hidden', String(!isActive));
            if (!isActive) return;

            const totalMinutes = Math.floor(state.elapsedSeconds / 60);
            const seconds = state.elapsedSeconds % 60;
            const minutes = totalMinutes % 60;
            const hours = Math.floor(totalMinutes / 60);
            rankedFocusTimer.textContent = hours
                ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
                : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            rankedFocusQueue.textContent = t(state.queueType === 'flex' ? 'focusQueueFlex' : 'focusQueueSoloDuo');
            rankedFocusAccount.textContent = state.accountLabel || t('focusAccountUnknown');
        }

        window.addEventListener('aurum-ranked-focus-change', event => {
            renderRankedFocusWidget(event.detail);
        });

        function setSettingsCategory(category, focusTab = false) {
            const selectedTab = settingsTabs.find(tab => tab.dataset.settingsTab === category);
            if (!selectedTab) return;

            activeSettingsCategory = category;
            settingsTabs.forEach(tab => {
                const isSelected = tab === selectedTab;
                tab.classList.toggle('is-active', isSelected);
                tab.setAttribute('aria-selected', String(isSelected));
                tab.tabIndex = isSelected ? 0 : -1;
            });
            settingsSections.forEach(section => {
                section.hidden = section.dataset.settingsCategory !== category;
            });
            settingsContent.setAttribute('aria-labelledby', selectedTab.id);

            try {
                localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, category);
            } catch (error) {
                console.error('No se pudo guardar la categoría de Ajustes:', error);
            }
            if (focusTab) selectedTab.focus();
        }

        function fillSettingsForm() {
            setLanguageSel.value = currentLang;
            setVisualTheme.value = window.aurumTheme.getTheme();
            setLaunchStartup.checked = settings.launchAtStartup;
            setStartMinimized.checked = settings.startMinimized;
            setChristmasTheme.checked = settings.christmasTheme;
            setRankedFocus.checked = window.aurumFocusMode.getState().enabled;
            setAutoRefresh.checked = settings.autoRefresh;
            const soundState = window.aurumSoundboard.getState();
            soundboardVolume.value = String(soundState.volume);
            soundboardVolumeValue.value = `${soundState.volume}%`;
            soundboardVolumeValue.textContent = `${soundState.volume}%`;
            christmasMusicVolumeInput.value = String(christmasMusicVolume);
            christmasMusicVolumeValue.value = `${christmasMusicVolume}%`;
            christmasMusicVolumeValue.textContent = `${christmasMusicVolume}%`;
            setRankNotifications.checked = settings.rankChangeNotifications;
            setDesktopNotifications.checked = settings.desktopRankNotifications;
            setRefreshMinutes.value = settings.refreshMinutes;
            setRefreshMinutes.classList.remove('invalid');
            highlightPreset(settings.refreshMinutes);
            document.querySelectorAll('input[name="login-mode"]').forEach(r => r.checked = (r.value === settings.loginMode));
            setLaunchGame.checked = settings.launchGame;
            setAutoUpdates.checked = settings.autoCheckUpdates;
            setStIds.checked = settings.streamerIds;
            setStLogin.checked = settings.streamerLogin;
            setStDescs.checked = settings.streamerDescs;
            setStPass.checked = settings.streamerPass;
            setTrayIcon.checked = settings.trayIcon;
            setTrayClose.checked = settings.closeToTray;
            setTrayClose.disabled = !settings.trayIcon;
            setTrayShortcutOn.checked = settings.trayShortcutOn;
            pendingShortcut = settings.trayShortcut;
            stopShortcutRecording();
            shortcutWarn.hidden = !shortcutFailed;
            renderUpdateStatus();
            syncDependentControls();
        }

        function openSettings() {
            dataPathLabel.textContent = dataPath;
            accountsCountLabel.textContent = readAccounts().length;
            document.getElementById('app-version-label').textContent = remoteApp.getVersion();
            fillSettingsForm();   // Cancelar descarta cambios: el formulario siempre parte de lo guardado
            setSettingsCategory(activeSettingsCategory);
            settingsModal.style.display = 'flex';
        }

        function closeSettings() {
            settingsModal.style.display = 'none';
        }

        // Registra/actualiza el inicio automático con Windows
        function applySystemSettings() {
            try {
                const args = ['--startup'];
                if (settings.startMinimized) args.push('--minimized');
                // En desarrollo (npm start) el ejecutable es electron.exe y necesita la ruta de la app
                if (!remoteApp.isPackaged) args.unshift(remoteApp.getAppPath());
                remoteApp.setLoginItemSettings({
                    openAtLogin: settings.launchAtStartup,
                    path: remoteApp.getPath('exe'),
                    args
                });
            } catch (e) {
                console.error('No se pudo configurar el inicio con Windows', e);
            }
        }

        presetButtons.forEach(btn => btn.addEventListener('click', () => {
            const min = parseInt(btn.dataset.min, 10);
            setRefreshMinutes.value = min;
            setRefreshMinutes.classList.remove('invalid');
            highlightPreset(min);
        }));
        setRefreshMinutes.addEventListener('input', () => {
            setRefreshMinutes.classList.remove('invalid');
            highlightPreset(parseInt(setRefreshMinutes.value, 10));
        });
        setAutoRefresh.addEventListener('change', syncDependentControls);
        soundboardVolume.addEventListener('input', () => {
            try {
                const state = window.aurumSoundboard.setVolume(soundboardVolume.value);
                soundboardVolumeValue.value = `${state.volume}%`;
                soundboardVolumeValue.textContent = `${state.volume}%`;
            } catch (error) {
                console.error('No se pudo guardar el volumen de audio:', error);
                soundboardVolume.value = String(window.aurumSoundboard.getState().volume);
            }
        });
        christmasMusicVolumeInput.addEventListener('input', () => {
            const volume = Math.max(0, Math.min(100, Math.round(Number(christmasMusicVolumeInput.value))));
            try {
                localStorage.setItem(CHRISTMAS_MUSIC_VOLUME_KEY, String(volume));
                christmasMusicVolume = volume;
                christmasMusicVolumeValue.value = `${volume}%`;
                christmasMusicVolumeValue.textContent = `${volume}%`;
                if (christmasMusicPlaying) fadeChristmasAudio(christmasMusicVolume / 100);
            } catch (error) {
                console.error('No se pudo guardar el volumen de la música ambiental:', error);
                christmasMusicVolumeInput.value = String(christmasMusicVolume);
            }
        });
        document.querySelectorAll('[data-sound-preview]').forEach(button => {
            button.addEventListener('click', () => {
                try {
                    window.aurumSoundboard.play(button.dataset.soundPreview);
                } catch (error) {
                    console.error('No se pudo reproducir la vista previa de audio:', error);
                }
            });
        });
        soundboardToggle.addEventListener('click', () => {
            try {
                window.aurumSoundboard.toggleMuted();
                refreshSoundboardButton();
            } catch (error) {
                console.error('No se pudo actualizar el silencio de audio:', error);
            }
        });
        setVisualTheme.addEventListener('change', () => {
            setVisualTheme.value = window.aurumTheme.setTheme(setVisualTheme.value);
        });
        setLaunchStartup.addEventListener('change', syncDependentControls);
        setDesktopNotifications.addEventListener('change', async () => {
            if (setDesktopNotifications.checked && !(await ensureDesktopNotificationPermission())) {
                setDesktopNotifications.checked = false;
            }
        });

        btnSaveSettings.addEventListener('click', () => {
            const minutes = Number(setRefreshMinutes.value);
            if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
                setRefreshMinutes.classList.add('invalid');
                setRefreshMinutes.focus();
                showNeonNotification(t('invalidMinutes'));
                return;
            }

            const prev = { ...settings };
            const checkedMode = document.querySelector('input[name="login-mode"]:checked');
            settings = {
                ...settings,
                language: setLanguageSel.value,
                visualTheme: window.aurumTheme.setTheme(setVisualTheme.value),
                launchAtStartup: setLaunchStartup.checked,
                startMinimized: setStartMinimized.checked,
                christmasTheme: setChristmasTheme.checked,
                autoRefresh: setAutoRefresh.checked,
                rankChangeNotifications: setRankNotifications.checked,
                desktopRankNotifications: setDesktopNotifications.checked,
                refreshMinutes: minutes,
                loginMode: checkedMode ? checkedMode.value : 'riotClient',
                launchGame: setLaunchGame.checked,
                autoCheckUpdates: setAutoUpdates.checked,
                streamerIds: setStIds.checked,
                streamerLogin: setStLogin.checked,
                streamerDescs: setStDescs.checked,
                streamerPass: setStPass.checked,
                trayIcon: setTrayIcon.checked,
                closeToTray: setTrayClose.checked,
                trayShortcutOn: setTrayShortcutOn.checked,
                trayShortcut: pendingShortcut,
                trayHintShown: settings.trayHintShown
            };
            try {
                window.aurumFocusMode.setEnabled(setRankedFocus.checked);
                updateRankedFocusState();
            } catch (error) {
                console.error('No se pudo guardar la preferencia de Ranked Focus:', error);
                setRankedFocus.checked = window.aurumFocusMode.getState().enabled;
                showNeonNotification(t('focusSaveError'));
            }
            saveSettings();
            applyChristmasTheme();
            applyStreamerMode();
            pushTrayConfig({ warn: true });

            if (prev.launchAtStartup !== settings.launchAtStartup || prev.startMinimized !== settings.startMinimized) {
                applySystemSettings();
            }
            if (prev.refreshMinutes !== settings.refreshMinutes || prev.autoRefresh !== settings.autoRefresh) {
                secondsRemaining = getRefreshSeconds();
                updateUpdatePillRing();
            }
            if (settings.language !== currentLang) {
                currentLang = settings.language;
                applyLanguage();
                refreshUpdateUi();
            }
            updateTimerLabel();
            closeSettings();
            showNeonNotification(t('settingsSaved'));
        });

        btnSettings.addEventListener('click', openSettings);
        btnCloseSettings.addEventListener('click', closeSettings);
        btnXSettings.addEventListener('click', closeSettings);
        settingsTabs.forEach(tab => {
            tab.addEventListener('click', () => setSettingsCategory(tab.dataset.settingsTab));
            tab.addEventListener('keydown', event => {
                const currentIndex = settingsTabs.indexOf(tab);
                let nextIndex = currentIndex;
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % settingsTabs.length;
                else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
                else if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = settingsTabs.length - 1;
                else return;
                event.preventDefault();
                setSettingsCategory(settingsTabs[nextIndex].dataset.settingsTab, true);
            });
        });
        setSettingsCategory(activeSettingsCategory);
        settingsModal.addEventListener('mousedown', (e) => { if (e.target === settingsModal) closeSettings(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && settingsModal.style.display === 'flex') closeSettings();
        });
        btnOpenFolder.addEventListener('click', () => shell.showItemInFolder(dataPath));
        document.getElementById('btn-support-discord').addEventListener('click', async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
                await ipcRenderer.invoke('support:open-discord');
            } catch (error) {
                console.error('No se pudo abrir el Discord de soporte:', error);
                showNeonNotification(t('supportDiscordError'));
            } finally {
                button.disabled = false;
            }
        });
        btnCopyDiagnostics.addEventListener('click', async () => {
            btnCopyDiagnostics.disabled = true;
            try {
                const info = await ipcRenderer.invoke('diagnostics:collect');
                const clientStateKey = {
                    active: 'clientSyncActive',
                    unknown: 'clientSyncUnknown',
                    offline: 'clientSyncOffline',
                    waiting: 'clientSyncWaiting',
                    error: 'clientSyncError'
                }[clientSyncBanner.dataset.state] || 'clientSyncWaiting';
                const clean = value => String(value).replace(/[|\r\n]/g, ' ');
                const report = [
                    '# Aurum Accounts diagnostics',
                    '',
                    `- App version: ${clean(info.appVersion)}`,
                    `- Packaged build: ${info.packaged ? 'Yes' : 'No'}`,
                    `- Operating system: ${clean(info.platform)} ${clean(info.osVersion)}`,
                    `- OS architecture: ${clean(info.osArchitecture)}`,
                    `- Process architecture: ${clean(info.processArchitecture)}`,
                    `- Electron: ${clean(info.electronVersion)}`,
                    `- Chromium: ${clean(info.chromiumVersion)}`,
                    `- Node.js: ${clean(info.nodeVersion)}`,
                    `- Main-process IPC: ${t('diagnosticsAvailable')}`,
                    `- Windows secure storage: ${t(info.secureStorageAvailable ? 'diagnosticsAvailable' : 'diagnosticsUnavailable')}`,
                    `- System tray: ${t(info.trayAvailable ? 'diagnosticsAvailable' : 'diagnosticsUnavailable')}`,
                    `- Native notifications: ${t(info.notificationsAvailable ? 'diagnosticsAvailable' : 'diagnosticsUnavailable')}`,
                    `- League Client: ${t(clientStateKey)}`,
                    '',
                    `> ${t('diagnosticsPrivacy')}`
                ].join('\n');
                clipboard.writeText(report);
                showNeonNotification(t('diagnosticsCopied'));
            } catch (e) {
                console.error('No se pudo recopilar o copiar el diagnóstico', e);
                showNeonNotification(t('diagnosticsError'));
            } finally {
                btnCopyDiagnostics.disabled = false;
            }
        });
        document.getElementById('btn-data-folder').addEventListener('click', () => shell.showItemInFolder(dataPath));
        document.getElementById('sb-version').textContent = 'v' + remoteApp.getVersion();

        // ---------- Modo streamer ----------
        // Difumina lo que permite identificar o acceder a una cuenta (Riot IDs, usuarios de inicio de sesión,
        // descripciones, rutas...) para poder enseñar la app en directo o en capturas. El difuminado lo hace
        // el CSS; aquí solo se ponen las clases del <body> según los ajustes.
        const streamerBtn = document.getElementById('streamer-btn');

        function applyStreamerMode() {
            const on = !!settings.streamerMode;
            const cl = document.body.classList;
            cl.toggle('streamer', on);
            cl.toggle('st-ids', !!settings.streamerIds);
            cl.toggle('st-login', !!settings.streamerLogin);
            cl.toggle('st-desc', !!settings.streamerDescs);
            cl.toggle('st-pass', !!settings.streamerPass);
            streamerBtn.classList.toggle('active', on);
            streamerBtn.setAttribute('aria-pressed', String(on));
            updateRankedFocusState();
            renderDuoMatch();
            if (on && settings.streamerPass) accPassword.type = 'password';   // si estaba a la vista, se vuelve a ocultar
            populateCategorySelect(readAccounts());
            syncTray();   // el menú de la bandeja también oculta nombres y marca la casilla
        }

        function toggleStreamerMode() {
            settings.streamerMode = !settings.streamerMode;
            saveSettings();
            applyStreamerMode();
            showNeonNotification(t(settings.streamerMode ? 'streamerOn' : 'streamerOff'));
        }
        streamerBtn.addEventListener('click', toggleStreamerMode);

        // ---------- Bandeja del sistema ----------
        // El icono, su menú y el atajo global viven en el proceso principal (main.js). Desde aquí solo se le envía la
        // lista de cuentas SIN credenciales (id + etiqueta) y los textos ya traducidos, y se atiende lo que el usuario
        // elige en el menú. Las contraseñas no salen nunca de este proceso.
        let pendingShortcut = settings.trayShortcut;   // combinación elegida en Ajustes (se aplica al guardar)
        let recordingShortcut = false;
        let shortcutFailed = false;                    // el último intento de registrar el atajo falló

        // Etiqueta de una cuenta en el menú: respeta lo que el modo streamer esté ocultando
        function trayLabel(account, index) {
            const hiddenIds = settings.streamerMode && settings.streamerIds;
            const hiddenLogin = settings.streamerMode && settings.streamerLogin;
            const hiddenDesc = settings.streamerMode && settings.streamerDescs;
            let primary = '';
            if (account.riotId) { if (!hiddenIds) primary = account.riotId; }
            else if (account.loginUser && !hiddenLogin) primary = account.loginUser;
            const desc = account.description && !hiddenDesc ? account.description : '';
            let who = primary;
            if (desc) who = primary ? `${primary} (${desc})` : desc;
            if (!who) who = t('trayAccountN').replace('{n}', () => index + 1);
            const tier = account.soloq && account.soloq.tier ? account.soloq.tier : '';
            const rank = tier && tier.toUpperCase() !== 'UNRANKED' ? prettyTier(tier) : '';
            return rank ? `${who} · ${rank}` : who;
        }

        function syncTray(accounts) {
            if (accounts) trayAccountsCache = accounts;
            if (!trayAccountsCache) return;
            clearTimeout(traySyncTimer);
            traySyncTimer = setTimeout(() => {
                const sorted = trayAccountsCache.slice().sort(accountComparator(sortSelect.value));
                ipcRenderer.send('tray:accounts', {
                    accounts: sorted.map((a, i) => ({ id: a.id, label: trayLabel(a, i) })),
                    streamer: !!settings.streamerMode,
                    strings: {
                        open: t('trayOpen'), loginWith: t('trayLoginWith'), noAccounts: t('trayNoAccounts'),
                        more: t('trayMore'), streamer: t('setStreamer'), quit: t('trayQuit')
                    }
                });
            }, 150);
        }

        // Configuración de la bandeja para el proceso principal; avisa si el atajo no se pudo registrar
        function pushTrayConfig({ warn = false } = {}) {
            return ipcRenderer.invoke('tray:config', {
                trayIcon: settings.trayIcon, closeToTray: settings.closeToTray,
                trayShortcutOn: settings.trayShortcutOn, trayShortcut: settings.trayShortcut
            }).then(res => {
                shortcutFailed = !!(res && res.shortcutOk === false);
                if (shortcutFailed && warn) showNeonNotification(t('shortcutFailed'));
                return res;
            }).catch(() => null);
        }

        function trayNotify(body) {
            ipcRenderer.send('tray:notify', { title: 'Aurum Accounts', body });
        }

        // Cuenta elegida en el menú de la bandeja
        function trayLogin(id) {
            const account = readAccounts().find(a => a.id === id);
            if (!account) return;
            const background = document.visibilityState === 'hidden';   // ventana oculta o minimizada: nadie la mira
            const say = (text) => { if (background) trayNotify(text); else showNeonNotification(text); };
            if (loginSession && loginSession.state === 'running') { say(t('trayLoginBusy')); return; }
            if (settings.loginMode === 'previousWindow') {
                // Ese modo hace Alt+Tab antes de escribir: desde la bandeja saltaría a otra ventana y la contraseña
                // podría acabar donde no toca. Se abre la app para hacerlo desde ahí.
                ipcRenderer.send('tray:show');
                showNeonNotification(t('trayNeedsWindow'));
                return;
            }
            startLogin(account, { fromTray: background });
        }

        ipcRenderer.on('tray:login', (event, id) => trayLogin(id));
        ipcRenderer.on('tray:toggle-streamer', () => toggleStreamerMode());
        ipcRenderer.on('tray:hidden', () => {
            if (settings.trayHintShown) return;
            settings.trayHintShown = true;   // el aviso de "sigo en la bandeja" sale solo la primera vez
            saveSettings();
            trayNotify(t('trayHint'));
        });

        // --- Grabador de la combinación de teclas (Ajustes) ---
        const SHORTCUT_KEYS = { Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };

        // Devuelve la combinación en formato de Electron ("Control+Alt+K"), 'invalid' si no sirve como atajo
        // global, o null si la tecla no está admitida. Un atajo global "pisa" esa combinación en todo Windows,
        // por eso se exige al menos Ctrl/Alt/Win (y dos modificadores si es una letra o un número).
        function acceleratorFromEvent(e) {
            const code = e.code || '';
            let key = null, plain = false;
            if (/^Key[A-Z]$/.test(code)) { key = code.slice(3); plain = true; }
            else if (/^Digit[0-9]$/.test(code)) { key = code.slice(5); plain = true; }
            else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
            else if (SHORTCUT_KEYS[code]) { key = SHORTCUT_KEYS[code]; plain = code === 'Space'; }
            if (!key) return null;
            const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
            const strong = mods.some(m => m !== 'Shift');
            if (!strong || (plain && mods.length < 2)) return 'invalid';
            return [...mods, key].join('+');
        }

        function prettyAccelerator(acc) {
            return acc ? acc.split('+').map(p => ({ Control: 'Ctrl', Super: 'Win' }[p] || p)).join(' + ') : t('shortcutNone');
        }

        function renderShortcutBtn() {
            shortcutBtn.textContent = recordingShortcut ? t('shortcutPress') : prettyAccelerator(pendingShortcut);
            shortcutBtn.classList.toggle('recording', recordingShortcut);
        }

        function stopShortcutRecording() {
            recordingShortcut = false;
            renderShortcutBtn();
        }

        function onShortcutKey(e) {
            if (!recordingShortcut) return;
            e.preventDefault();
            e.stopImmediatePropagation();   // mientras se graba, ningún otro atajo de la app debe reaccionar
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // se espera a la tecla principal
            if (e.key === 'Escape') { stopShortcutRecording(); return; }
            if (e.key === 'Backspace' || e.key === 'Delete') { pendingShortcut = ''; stopShortcutRecording(); return; }
            const acc = acceleratorFromEvent(e);
            if (acc === 'invalid') { showNeonNotification(t('shortcutInvalid')); return; }   // sigue grabando
            if (!acc) return;
            pendingShortcut = acc;
            stopShortcutRecording();
        }

        shortcutBtn.addEventListener('click', () => { recordingShortcut = true; renderShortcutBtn(); shortcutBtn.focus(); });
        shortcutBtn.addEventListener('blur', stopShortcutRecording);
        document.addEventListener('keydown', onShortcutKey, true);   // en captura: va antes que el resto
        setTrayIcon.addEventListener('change', () => { setTrayClose.disabled = !setTrayIcon.checked; });

        // Atajos: Ctrl+F buscar, Ctrl+N añadir cuenta, Ctrl+H modo streamer
        document.addEventListener('keydown', (e) => {
            if (!e.ctrlKey || e.altKey || e.shiftKey) return;
            const key = e.key.toLowerCase();
            const overlayOpen = drawer.classList.contains('open') || settingsModal.style.display === 'flex'
                || confirmModal.style.display === 'flex' || loginOverlay.classList.contains('open');
            if (key === 'f' && !overlayOpen) {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
            } else if (key === 'n' && !overlayOpen) {
                e.preventDefault();
                openDrawer('add');
            } else if (key === 'h') {   // también con paneles abiertos: sirve justo para taparlos
                e.preventDefault();
                toggleStreamerMode();
            }
        });

        btnExport.addEventListener('click', async () => {
            const res = await dialog.showSaveDialog({ defaultPath: 'accounts-backup.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
            if (!res.canceled && res.filePath && fs.existsSync(dataPath)) fs.copyFileSync(dataPath, res.filePath);
        });

        btnImport.addEventListener('click', async () => {
            const res = await dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
            if (!res.canceled && res.filePaths.length > 0) {
                try {
                    const imported = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf-8'));
                    if (!Array.isArray(imported)) throw new Error('No es una lista de cuentas');
                    writeAccounts(imported);
                    loadAccounts(); // readAccounts() migra y cifra lo importado
                } catch (e) {
                    console.error('Error importando cuentas', e);
                    showNeonNotification(t('importError'));
                }
            }
        });

        searchInput.addEventListener('input', loadAccounts);
        filterRegion.addEventListener('change', loadAccounts);
        filterCategory.addEventListener('change', loadAccounts);
        sortSelect.addEventListener('change', loadAccounts);
        clientSyncImport.addEventListener('click', importDetectedClientAccount);
        loadChampionData();
        
        applyStreamerMode();
        applyViewMode(settings.viewMode);
        pushTrayConfig();
        applyLanguage();
        syncWithGameClient();
        setInterval(syncWithGameClient, 5000);
        pollGameflowPhase();
        setInterval(pollGameflowPhase, 750);
        if (accountsRecovered) showNeonNotification(t('accountsRecovered'));
        // Refresca la ruta del inicio con Windows: si la app se actualiza y cambia de nombre o de
        // carpeta, la entrada que registró la versión anterior quedaría apuntando a un .exe que ya no existe.
        // (Solo en la app instalada: en desarrollo registraría electron.exe y pisaría la buena.)
        if (settings.launchAtStartup && remoteApp.isPackaged) applySystemSettings();

        // ---------- Búsqueda de actualizaciones (GitHub Releases) ----------
        // Cambia esto por tu repositorio: publica cada versión como Release con tag "v3.0.3" o "3.0.3".
        const UPDATE_REPO = 'Dulciiss/league-accounts-clone';
        const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000; // cada 6 h mientras la app está abierta

        const btnCheckUpdates = document.getElementById('btn-check-updates');
        const updateStatusEl = document.getElementById('update-status');
        // state: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'
        let updateState = { state: 'idle', version: null, url: null };

        function compareVersions(a, b) {
            const pa = String(a).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
            const pb = String(b).replace(/^v/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const diff = (pa[i] || 0) - (pb[i] || 0);
                if (diff !== 0) return diff > 0 ? 1 : -1;
            }
            return 0;
        }

        // Instalador: la actualización se descarga e instala desde la propia app (ver updater.js).
        // Portable / modo desarrollo: se avisa y se abre la página de la release.
        let selfUpdate = false;
        let silentCheck = false;
        ipcRenderer.invoke('update:capabilities')
            .then(c => { selfUpdate = !!(c && c.selfUpdate); })
            .catch(() => { /* sin actualización automática */ });

        // Primera línea del error, acortada: permite saber por qué falló (red, 404, release incompleta...)
        function errorDetail(message) {
            const first = String(message || '').split('\n')[0].trim();
            return first ? ` [${first.length > 110 ? first.slice(0, 107) + '...' : first}]` : '';
        }

        // ---------- Aviso de actualización ----------
        // Ventana en el centro que no desaparece sola: el usuario elige "Actualizar ahora" o "Más tarde".
        // Con "Más tarde" queda un botón fijo en la barra superior y la ventana vuelve a salir en la próxima
        // comprobación automática (al arrancar y cada 6 h). No se muestra encima de un login, de los ajustes,
        // del panel de cuentas ni de otra confirmación: espera a que se cierren.
        const updateModal = document.getElementById('update-modal');
        const updateModalTitle = document.getElementById('update-modal-title');
        const updateModalText = document.getElementById('update-modal-text');
        const updateProgress = document.getElementById('update-progress');
        const updateProgressBar = document.getElementById('update-progress-bar');
        const updateLaterBtn = document.getElementById('update-later');
        const updateActionBtn = document.getElementById('update-action');
        const updatePill = document.getElementById('update-pill');
        const updatePillVersion = document.getElementById('update-pill-version');
        const updatePillRingProgress = document.querySelector('.tb-update-pill-ring-progress');
const RING_CIRCUMFERENCE = 2 * Math.PI * 9; // 56.55
let updateDismissed = true;   // true = no hay que enseñar la ventana (aún no toca o ya la pospuso)
        let updateWanted = false;     // el usuario ya pidió actualizar (para enseñar el resultado o el error)
        let updateModalTimer = null;

        function updateOverlayBusy() {
            return drawer.classList.contains('open') || settingsModal.style.display === 'flex'
                || confirmModal.style.display === 'flex' || loginOverlay.classList.contains('open');
        }

        function startUpdateDownload() {
            updateWanted = true;
            silentCheck = false;
            ipcRenderer.send('update:download');
        }

        function postponeUpdate() {
            updateDismissed = true;
            updateWanted = false;
            renderUpdateModal();
        }

        function fillUpdateModal() {
            const { state, version, percent, url } = updateState;
            const fill = (v) => t(v).replace('{version}', () => version);
            updateProgress.style.display = 'none';
            updateLaterBtn.style.display = '';
            updateActionBtn.style.display = '';
            updateLaterBtn.textContent = t('updLater');
            updateLaterBtn.onclick = postponeUpdate;

            if (state === 'available') {
                updateModalTitle.textContent = t('updModalTitle');
                updateModalText.textContent = fill('updModalText');
                if (selfUpdate) {
                    updateActionBtn.textContent = t('updNow');
                    updateActionBtn.onclick = startUpdateDownload;
                } else {
                    updateActionBtn.textContent = t('updDownload');
                    updateActionBtn.onclick = () => { shell.openExternal(url); postponeUpdate(); };
                }
            } else if (state === 'downloading') {
                updateModalTitle.textContent = t('updModalTitle');
                updateModalText.textContent = `${t('updDownloading')} ${percent || 0}%`;
                updateProgress.style.display = 'block';
                updateProgressBar.style.width = `${percent || 0}%`;
                updateLaterBtn.style.display = 'none';
                updateActionBtn.style.display = 'none';
            } else if (state === 'ready') {
                updateModalTitle.textContent = t('updReady');
                updateModalText.textContent = fill('updReadyText');
                updateActionBtn.textContent = t('updRestart');
                updateActionBtn.onclick = () => ipcRenderer.send('update:install');
            } else if (state === 'error') {
                updateModalTitle.textContent = t('updFailedTitle');
                updateModalText.textContent = t('updError') + errorDetail(updateState.message);
                updateLaterBtn.textContent = t('closeBtn');
                updateActionBtn.textContent = t('loginRetry');
                updateActionBtn.onclick = startUpdateDownload;
            }
        }

        function renderUpdateModal() {
            clearTimeout(updateModalTimer);
            const { state, version } = updateState;
            const pending = ['available', 'downloading', 'ready'].includes(state);
            const wantModal = !updateDismissed && (pending || (state === 'error' && updateWanted));
            const wasOpen = updateModal.style.display === 'flex';
            let showModal = wantModal;
            if (wantModal && updateOverlayBusy()) {
                showModal = false;
                updateModalTimer = setTimeout(renderUpdateModal, 3000);   // vuelve a intentarlo cuando se cierre
            }
            if (showModal) {
                fillUpdateModal();
                updateModal.style.display = 'flex';
                if (!wasOpen && updateActionBtn.style.display !== 'none') updateActionBtn.focus();
            } else {
                updateModal.style.display = 'none';
            }
            updatePill.classList.toggle('show', pending && !showModal);
            updatePillVersion.textContent = version ? `v${version}` : '';
        }

        // Tras cambiar de idioma hay que volver a escribir los textos que genera el JS
        function refreshUpdateUi() {
            syncTray();   // el menú de la bandeja cambia de idioma
            renderUpdateStatus();
        }

        updatePill.addEventListener('click', () => { updateDismissed = false; renderUpdateModal(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && updateModal.style.display === 'flex' && updateState.state !== 'downloading') postponeUpdate();
        });

        function updateBusy() {
            return ['checking', 'downloading', 'ready'].includes(updateState.state);
        }

        function renderUpdateStatus() {
            const { state, version, url, percent } = updateState;
            btnCheckUpdates.disabled = state === 'checking' || state === 'downloading';
            btnCheckUpdates.classList.toggle('checking', state === 'checking');
            updateStatusEl.className = 'update-status';
            updateStatusEl.innerHTML = '';

            if (state === 'checking') {
                updateStatusEl.textContent = t('updChecking');
            } else if (state === 'latest') {
                updateStatusEl.classList.add('ok');
                updateStatusEl.textContent = t('updLatest');
            } else if (state === 'error') {
                updateStatusEl.classList.add('error');
                updateStatusEl.textContent = t('updError') + errorDetail(updateState.message);
            } else if (state === 'available') {
                updateStatusEl.classList.add('available');
                const label = document.createElement('span');
                label.textContent = `${t('updAvailable')} ${version}`;
                const btn = document.createElement('button');
                btn.className = 'update-download';
                if (selfUpdate) {
                    btn.textContent = t('updDownloadInstall');
                    btn.addEventListener('click', startUpdateDownload);
                } else {
                    btn.textContent = t('updDownload');
                    btn.addEventListener('click', () => shell.openExternal(url));
                }
                updateStatusEl.append(label, btn);
            } else if (state === 'downloading') {
                updateStatusEl.classList.add('available');
                updateStatusEl.textContent = `${t('updDownloading')} ${percent || 0}%`;
            } else if (state === 'ready') {
                updateStatusEl.classList.add('available');
                const label = document.createElement('span');
                label.textContent = `${t('updReady')} (${version})`;
                const btn = document.createElement('button');
                btn.className = 'update-download';
                btn.textContent = t('updRestart');
                btn.addEventListener('click', () => ipcRenderer.send('update:install'));
                updateStatusEl.append(label, btn);
            }
            renderUpdateModal();
        }

        // Estados que llegan del proceso principal (solo instalador)
        ipcRenderer.on('update:state', (event, s) => {
            if (s.state === 'checking') {
                updateState = { state: 'checking', version: null, url: null };
            } else if (s.state === 'available') {
                updateState = { state: 'available', version: s.version, url: null };
                if (silentCheck) updateDismissed = false;   // aviso automático: sale la ventana
            } else if (s.state === 'latest') {
                updateState = { state: 'latest', version: null, url: null };
            } else if (s.state === 'downloading') {
                updateState = { state: 'downloading', version: updateState.version, url: null, percent: s.percent };
            } else if (s.state === 'ready') {
                updateState = { state: 'ready', version: s.version, url: null };
                if (updateWanted) updateDismissed = false;   // lo pidió el usuario: ofrecer reiniciar
            } else if (s.state === 'error') {
                console.error('Error de actualización:', s.message);
                updateState = { state: silentCheck ? 'idle' : 'error', version: null, url: null, message: s.message };
            }
            renderUpdateStatus();
        });

        // silent = true: solo avisa (con un toast) si hay una versión nueva
        async function checkForUpdates({ silent = false } = {}) {
            if (updateBusy()) return;
            silentCheck = silent;
            if (selfUpdate) {
                ipcRenderer.send('update:check');
                return;
            }
            updateState = { state: 'checking', version: null, url: null };
            renderUpdateStatus();
            try {
                const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
                    headers: { 'Accept': 'application/vnd.github+json' }
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const release = await res.json();
                const latest = String(release.tag_name || '').replace(/^v/i, '');
                if (latest && compareVersions(latest, remoteApp.getVersion()) > 0) {
                    updateState = { state: 'available', version: latest, url: release.html_url };
                    if (silent) updateDismissed = false;   // aviso automático: sale la ventana
                } else {
                    updateState = { state: 'latest', version: null, url: null };
                }
            } catch (err) {
                console.error('Error buscando actualizaciones:', err);
                updateState = { state: silent ? 'idle' : 'error', version: null, url: null, message: err && err.message };
            }
            renderUpdateStatus();
        }

        btnCheckUpdates.addEventListener('click', () => checkForUpdates());

        // Comprobación automática: al arrancar (con margen) y periódicamente
        setTimeout(() => { if (settings.autoCheckUpdates) checkForUpdates({ silent: true }); }, 5000);
        setInterval(() => { if (settings.autoCheckUpdates) checkForUpdates({ silent: true }); }, UPDATE_CHECK_EVERY_MS);

        // ---------- Actualización automática (intervalo configurable en Ajustes) ----------
        function getRefreshSeconds() {
            return settings.refreshMinutes * 60;
        }

        let secondsRemaining = getRefreshSeconds();
        let isRefreshing = false;

        function updateTimerLabel() {
            document.getElementById('auto-refresh-box').classList.toggle('busy', isRefreshing);
            if (isRefreshing) {
                autoRefreshTimerLabel.textContent = t('refreshing');
            } else if (!settings.autoRefresh) {
                autoRefreshTimerLabel.textContent = t('autoRefreshOff');
            } else if (secondsRemaining >= 60) {
                autoRefreshTimerLabel.textContent = `${t('nextIn')} ${Math.ceil(secondsRemaining / 60)} ${t('unitMin')}`;
            } else {
                autoRefreshTimerLabel.textContent = `${t('nextIn')} ${secondsRemaining}${t('unitSec')}`;
            }
            updateUpdatePillRing();
            updateAutoRefreshProgressRing();
        }

        function updateUpdatePillRing() {
            if (!updatePillRingProgress) return;
            const totalSeconds = getRefreshSeconds();
            if (totalSeconds <= 0) return;
            const progress = secondsRemaining / totalSeconds; // 1 = lleno (acaba de refrescar), 0 = vacío (va a refrescar)
            const offset = RING_CIRCUMFERENCE * (1 - progress); // se vacía conforme avanza el tiempo
            updatePillRingProgress.style.strokeDashoffset = offset;
            // Opacidad: visible cuando hay tiempo, más tenue cuando falta poco
            updatePillRingProgress.style.strokeOpacity = progress < 0.05 ? '0.3' : '1';
        }

        function updateAutoRefreshProgressRing() {
            const progressCircle = document.getElementById('auto-refresh-progress-circle');
            if (!progressCircle) return;
            const totalSeconds = getRefreshSeconds();
            if (totalSeconds <= 0) return;
            const progress = Math.max(0, Math.min(1, secondsRemaining / totalSeconds));
            progressCircle.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - progress);
        }

        async function runRefresh() {
            if (isRefreshing) return;
            isRefreshing = true;
            updateTimerLabel();
            try {
                await refreshRanksFromOpgg();
            } catch (err) {
                console.error("Error en la actualización de rangos:", err);
            } finally {
                isRefreshing = false;
                secondsRemaining = getRefreshSeconds();
                updateTimerLabel();
                updateUpdatePillRing();
            }
        }

        // Pulsar la caja fuerza una actualización aunque la automática esté desactivada
        document.getElementById('auto-refresh-box').addEventListener('click', runRefresh);

        setInterval(() => {
            if (isRefreshing) return;
            if (settings.autoRefresh) {
                secondsRemaining--;
                if (secondsRemaining <= 0) {
                    runRefresh();
                    return;
                }
            }
            updateTimerLabel();
        }, 1000);

        updateTimerLabel();
        updateUpdatePillRing();
