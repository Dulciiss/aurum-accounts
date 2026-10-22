        const fs = require('fs');
        const path = require('path');
        const { exec, spawn } = require('child_process');
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

        const DEFAULT_SETTINGS = {
            language: getSystemLanguage(),
            launchAtStartup: false,
            startMinimized: false,
            autoRefresh: true,
            refreshMinutes: 15,          // 900 s, como hasta ahora
            loginMode: 'riotClient',     // 'riotClient' | 'previousWindow'
            launchGame: false,
            autoCheckUpdates: true,
            streamerMode: false,         // modo streamer activado ahora mismo
            streamerIds: true,           // ...qué se oculta cuando está activado:
            streamerLogin: true,
            streamerDescs: false,
            streamerPass: true
        };

        function loadSettings() {
            try {
                if (fs.existsSync(settingsPath)) {
                    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
                }
            } catch (e) {
                console.error('Error leyendo settings.json, se usan los valores por defecto', e);
            }
            return { ...DEFAULT_SETTINGS };
        }

        function saveSettings() {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
        }

        let settings = loadSettings();
        let currentLang = translations[settings.language] ? settings.language : getSystemLanguage();

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
        window.addEventListener('click', () => closeAllDropdowns());
        langBtn.addEventListener('click', () => closeAllDropdowns());

        const btnAdd = document.querySelector('.btn-add');
        const btnSettings = document.querySelector('.btn-menu');
        const btnImport = document.getElementById('btn-import');
        const btnExport = document.getElementById('btn-export');
        

        const settingsModal = document.getElementById('settings-modal');
        const btnCloseSettings = document.getElementById('close-settings');
        const btnOpenFolder = document.getElementById('btn-open-folder');
        const dataPathLabel = document.getElementById('data-path-label');
        const accountsCountLabel = document.getElementById('accounts-count-label');

        const confirmModal = document.getElementById('confirm-modal');
        const confirmText = document.getElementById('confirm-text');
        const confirmYes = document.getElementById('confirm-yes');
        const confirmNo = document.getElementById('confirm-no');
        let accountToDelete = null;

        const mainContent = document.querySelector('.main-content');
        const searchInput = document.getElementById('search-input');
        const filterRegion = document.getElementById('filter-region');
        const sortSelect = document.getElementById('sort-select');
        const rankStatsContainer = document.getElementById('rank-stats-container');
        const autoRefreshTimerLabel = document.getElementById('auto-refresh-timer');

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
        const EMPTY_QUEUE = () => ({ tier: 'UNRANKED', lp: 0, minLp: 0, maxLp: 100 });

        function escapeHtml(str) {
            return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        }

        function newAccountId() {
            return 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
            accounts.forEach(acc => {
                if (!acc.id) { acc.id = newAccountId(); changed = true; }
                const normRegion = normalizeRegion(acc.region) || 'euw';
                if (acc.region !== normRegion) { acc.region = normRegion; changed = true; }
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

        // Devuelve { notFound } o { level, soloq, flex, lastSeason } o null si no se pudo leer
        function parseOpggProfile(html, acc) {
            const text = htmlToText(html);
            const { name, tag } = splitRiotId(acc.riotId);

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
            return { level, soloq: soloq || EMPTY_QUEUE(), flex, lastSeason, ladder, topChampions };
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

        function showNeonNotification(message) {
            const existingToast = document.querySelector('.neon-toast');
            if (existingToast) existingToast.remove();

            const toast = document.createElement('div');
            toast.className = 'neon-toast';
            toast.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                    <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <span>${message}</span>
            `;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('hiding');
                setTimeout(() => toast.remove(), 400);
            }, 4000);
        }

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
        const LEAGUE_IMAGES = ['LeagueClient.exe', 'LeagueClientUx.exe'];
        function listLeaguePids() {
            return Promise.all(LEAGUE_IMAGES.map(listProcessPids)).then(sets => new Set(sets.flatMap(set => [...set])));
        }

        // ---------- API local del Riot Client ----------
        // El cliente publica su puerto y contraseña en un "lockfile"; con eso se le puede pedir
        // abrir el juego directamente, sin depender de la ventana ni de pulsar "Jugar".
        function readRiotLockfile() {
            const lockPath = path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'Riot Client', 'Config', 'lockfile');
            try {
                const [, , port, password] = fs.readFileSync(lockPath, 'utf8').trim().split(':');
                return port && password ? { port: Number(port), password } : null;
            } catch (e) {
                return null;
            }
        }

        // Siempre resuelve: { ok, status, note, body }
        function riotClientRequest(method, apiPath) {
            return new Promise(resolve => {
                const lock = readRiotLockfile();
                if (!lock) { resolve({ ok: false, status: 0, note: 'sin lockfile' }); return; }
                let finished = false;
                const finish = result => { if (!finished) { finished = true; resolve(result); } };
                const req = https.request({
                    host: '127.0.0.1', port: lock.port, path: apiPath, method,
                    headers: { Authorization: 'Basic ' + Buffer.from('riot:' + lock.password).toString('base64') },
                    rejectUnauthorized: false, // certificado local autofirmado
                    timeout: 5000
                }, res => {
                    let body = '';
                    res.on('data', chunk => { if (body.length < 300) body += chunk; });
                    res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body }));
                });
                req.on('timeout', () => { req.destroy(); finish({ ok: false, status: 0, note: 'timeout' }); });
                req.on('error', e => finish({ ok: false, status: 0, note: e.code || 'error' }));
                req.end();
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
            renderLogin();
            loginBtnClose.focus();
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
        }

        // Solo ejecuta fn si esta sesión sigue en curso (no se canceló)
        function loginLater(session, ms, fn) {
            const id = setTimeout(() => {
                if (loginSession === session && session.state === 'running') fn();
            }, ms);
            session.timers.push(id);
        }

        function startLogin(account) {
            if (loginSession && loginSession.state === 'running') return;
            const password = getAccountPassword(account);
            if (!password) {
                showNeonNotification(t('errNoPassword'));
                return;
            }

            const steps = buildLoginSteps();
            const session = {
                account, steps,
                status: steps.map(() => 'pending'),
                state: 'running', footer: '', child: null, timers: []
            };
            loginSession = session;

            // Procesos del juego que ya estaban abiertos: así solo damos por bueno uno nuevo
            session.leagueBaseline = new Set();
            if (settings.launchGame) listLeaguePids().then(pids => { session.leagueBaseline = pids; });

            const tierBase = account.soloq && account.soloq.tier ? account.soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
            document.getElementById('login-emblem-img').src = tierIcons[tierBase] || tierIcons['UNRANKED'];
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

        function renderCard(account) {
            const newCard = document.createElement('div');
            newCard.className = 'account-card';

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

            // Últimas 10 partidas
            let recentHtml = '';
            if (!notFound && Array.isArray(account.recentGames) && account.recentGames.length) {
                const games = account.recentGames.slice(0, 10);
                const w = games.filter(g => g.result === 'WIN').length;
                const l = games.filter(g => g.result === 'LOSE').length;
                const recentWr = Math.round((w / Math.max(1, w + l)) * 100);
                recentHtml = `
                <div class="card-section" style="position: relative; z-index: 1;">
                    <div class="sec-label">${escapeHtml(t('secRecent'))}
                        <span class="recent-summary ${wrTier(recentWr, w + l)}">${w}${escapeHtml(t('winShort'))} ${l}${escapeHtml(t('lossShort'))} · ${recentWr}%</span>
                    </div>
                    <div class="recent-row">
                        ${games.map(g => {
                            const img = champImg(g.champ);
                            const cls = g.result === 'WIN' ? 'win' : g.result === 'LOSE' ? 'loss' : 'remake';
                            const label = `${champName(g.champ)} · ${t(cls === 'win' ? 'gameWin' : cls === 'loss' ? 'gameLoss' : 'gameRemake')}`;
                            return `<div class="recent-game ${cls}" title="${escapeHtml(label)}">${img ? `<img src="${img}" alt="">` : `<span>${escapeHtml(champName(g.champ).slice(0, 2))}</span>`}</div>`;
                        }).join('')}
                    </div>
                </div>`;
            }
            const flexText = (flex.tier || 'UNRANKED') === 'UNRANKED' ? t('unranked') : `${prettyTier(flex.tier)} · ${flex.lp} LP`;
            const showLevel = hasRiotId(account) && account.level;

            newCard.innerHTML = `
                <div style="position: absolute; top: 30%; left: 50%; width: 220px; height: 220px; background: radial-gradient(circle, ${rankTheme.glow} 0%, transparent 70%); border-radius: 50%; pointer-events: none; animation: cardRadarWave 6s ease-in-out infinite; z-index: 0;"></div>

                <div style="position: relative; z-index: 1; display: flex; gap: 14px; align-items: center;">
                    <img src="${iconUrl}" alt="" style="width: 52px; height: 52px; min-width: 52px; object-fit: contain; transform: scale(3.5); transform-origin: center; filter: drop-shadow(0 0 8px ${rankTheme.glow});">
                    <div style="flex-grow: 1; min-width: 0;">
                        <div class="acc-name-line sens sens-id" title="${escapeHtml(account.riotId || account.loginUser)}">
                            <span class="acc-name">${escapeHtml(shownName)}</span>${tag ? `<span class="acc-tag">#${escapeHtml(tag)}</span>` : ''}
                        </div>
                        <div class="acc-badges">
                            <span class="acc-badge region">${escapeHtml(region)}</span>
                            ${showLevel ? `<span class="acc-badge">${escapeHtml(t('levelShort'))} ${escapeHtml(account.level)}</span>` : ''}
                            <span class="acc-badge user sens sens-login" title="${escapeHtml(t('fieldLoginUser'))}">${USER_ICON}${escapeHtml(account.loginUser)}</span>
                            ${ladderHtml}
                        </div>
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

                ${account.description ? `<div class="acc-description sens sens-desc" style="position: relative; z-index: 1;" title="${escapeHtml(account.description)}">${escapeHtml(account.description)}</div>` : ''}

                <div class="card-actions" style="position: relative; z-index: 1; margin-top: 12px; display: flex; gap: 8px; border-top: 1px solid #1f2029; padding-top: 12px;">
                    <button class="btn-login">${LOGIN_ICON}<span>${escapeHtml(t('loginAction'))}</span></button>
                    <button class="card-icon-btn" data-copy="riot" data-tip="${escapeHtml(t('copyRiotId'))}" aria-label="${escapeHtml(t('copyRiotId'))}" ${hasRiotId(account) ? '' : 'disabled'}>${CLIPBOARD_ICON}${OK_ICON}</button>
                    <button class="card-icon-btn" data-copy="password" data-tip="${escapeHtml(t('copyPassword'))}" aria-label="${escapeHtml(t('copyPassword'))}">${KEY_ICON}${OK_ICON}</button>
                </div>
            `;

            newCard.querySelectorAll('.card-icon-btn').forEach(btn => btn.addEventListener('click', (e) => {
                e.stopPropagation();
                copyFromAccount(account, btn.dataset.copy, btn);
            }));

            newCard.querySelector('.btn-login').addEventListener('click', () => {
                startLogin(account);
            });

            const fixBtn = newCard.querySelector('.nf-fix');
            if (fixBtn) fixBtn.addEventListener('click', () => openDrawer('edit', account));

            newCard.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                openCardMenu(e.clientX, e.clientY, account);
            });

            mainContent.appendChild(newCard);
        }

        // ---------- Menú contextual (clic derecho en una tarjeta) ----------
        const cardMenu = document.getElementById('card-menu');
        let menuAccountId = null;

        function openCardMenu(x, y, account) {
            menuAccountId = account.id;
            cardMenu.querySelector('[data-action="opgg"]').disabled = !hasRiotId(account);
            cardMenu.classList.add('open');
            const { width, height } = cardMenu.getBoundingClientRect();
            cardMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
            cardMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
            const firstEnabled = cardMenu.querySelector('.ctx-item:not(:disabled)');
            if (firstEnabled) firstEnabled.focus();
        }

        function closeCardMenu() {
            cardMenu.classList.remove('open');
            menuAccountId = null;
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
                const items = [...cardMenu.querySelectorAll('.ctx-item:not(:disabled)')];
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

        function loadAccounts() {
            const allAccounts = readAccounts();
            populateRegionSelects(allAccounts);
            updateRankDistribution(allAccounts);
            mainContent.innerHTML = '';

            if (allAccounts.length === 0) {
                renderEmptyState();
                return;
            }

            const searchTerm = searchInput.value.toLowerCase();
            const selectedRegion = filterRegion.value;
            const sortBy = sortSelect.value;

            const filteredAccounts = allAccounts.filter(acc => {
                const haystack = [acc.riotId, acc.loginUser, acc.description].filter(Boolean).join(' ').toLowerCase();
                const matchesRegion = selectedRegion === 'all' || (acc.region || 'euw').toLowerCase() === selectedRegion;
                return haystack.includes(searchTerm) && matchesRegion;
            });

            filteredAccounts.sort((a, b) => {
                if (sortBy === 'rank') {
                    const tierA = a.soloq && a.soloq.tier ? a.soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
                    const tierB = b.soloq && b.soloq.tier ? b.soloq.tier.toUpperCase().split(' ')[0] : 'UNRANKED';
                    const weightA = rankWeights[tierA] !== undefined ? rankWeights[tierA] : 0;
                    const weightB = rankWeights[tierB] !== undefined ? rankWeights[tierB] : 0;
                    if (weightA !== weightB) return weightB - weightA;
                    return (b.soloq ? b.soloq.lp : 0) - (a.soloq ? a.soloq.lp : 0);
                }
                return displayName(a).localeCompare(displayName(b));
            });

            if (filteredAccounts.length === 0) {
                renderNoResults();
                return;
            }
            filteredAccounts.forEach(acc => renderCard(acc));
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
                    if (typeof g.game_length_second === 'number' && g.game_length_second < 240) result = 'REMAKE';
                    return champ !== null && result ? { champ, result } : null;
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
            if (accounts.length === 0) return;

            const results = new Map();
            for (const acc of accounts) {
                try {
                    const html = await httpGetText(opggUrl(acc));
                    const data = parseOpggProfile(html, acc);
                    if (!data) {
                        // Se guarda la página para poder ver qué cambió en OP.GG
                        try { fs.writeFileSync(path.join(path.dirname(dataPath), 'opgg-debug.html'), html); } catch (e) { /* sin permiso */ }
                        console.warn(`OP.GG: no se pudieron leer los datos de ${acc.riotId} (página guardada en opgg-debug.html)`);
                    } else if (data.notFound) {
                        results.set(acc.id, { riotId: acc.riotId, region: acc.region, opggStatus: 'notFound' });
                    } else {
                        let recentGames = null;
                        try { recentGames = await fetchRecentGames(acc); }
                        catch (e) { console.warn(`OP.GG MCP: ${acc.riotId}:`, e.message); }
                        results.set(acc.id, { riotId: acc.riotId, region: acc.region, opggStatus: 'ok', opggUpdatedAt: Date.now(), ...data, recentGames });
                    }
                } catch (e) {
                    if (e.statusCode === 404) results.set(acc.id, { riotId: acc.riotId, region: acc.region, opggStatus: 'notFound' });
                    else console.error(`OP.GG: error consultando ${acc.riotId}:`, e.message);
                }
                await new Promise(r => setTimeout(r, 1200)); // no saturar OP.GG
            }

            if (!results.size) return;
            // Se guarda sobre lo que haya en disco; si la cuenta se borró o cambió de Riot ID mientras tanto, se ignora
            const disk = readAccounts();
            disk.forEach(a => {
                const r = results.get(a.id);
                if (!r || a.riotId !== r.riotId || a.region !== r.region) return;
                a.opggStatus = r.opggStatus;
                if (r.opggStatus === 'ok') {
                    if (r.level) a.level = r.level;
                    a.soloq = r.soloq;
                    a.flex = r.flex;
                    a.lastSeason = r.lastSeason;
                    a.opggUpdatedAt = r.opggUpdatedAt;
                    a.ladder = r.ladder;
                    a.topChampions = r.topChampions;
                    if (r.recentGames) a.recentGames = r.recentGames; // si falla, se conservan las anteriores
                }
            });
            writeAccounts(disk);
            loadAccounts();
            showNeonNotification(t('syncMsg'));
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
                const riotChanged = acc.riotId !== riotId || acc.region !== region;
                Object.assign(acc, { loginUser, riotId, region, description });
                if (password) setAccountPassword(acc, password);
                if (riotChanged) {
                    // El rango guardado era de otro Riot ID/región
                    Object.assign(acc, { level: null, soloq: EMPTY_QUEUE(), flex: EMPTY_QUEUE(), lastSeason: null });
                    delete acc.opggUpdatedAt;
                    delete acc.opggStatus;
                    delete acc.ladder;
                    delete acc.topChampions;
                    delete acc.recentGames;
                    needsRefresh = !!riotId;
                }
            } else {
                const acc = {
                    id: newAccountId(), loginUser, riotId, region, description,
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
                    description: '', level: null, soloq: EMPTY_QUEUE(), flex: EMPTY_QUEUE(), lastSeason: null
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
        const setLaunchStartup = document.getElementById('set-launch-startup');
        const setStartMinimized = document.getElementById('set-start-minimized');
        const setAutoRefresh = document.getElementById('set-auto-refresh');
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

        function highlightPreset(minutes) {
            presetButtons.forEach(b => b.classList.toggle('active', parseInt(b.dataset.min, 10) === minutes));
        }

        function syncDependentControls() {
            intervalBlock.classList.toggle('interval-disabled', !setAutoRefresh.checked);
            setStartMinimized.disabled = !setLaunchStartup.checked;
        }

        function fillSettingsForm() {
            setLanguageSel.value = currentLang;
            setLaunchStartup.checked = settings.launchAtStartup;
            setStartMinimized.checked = settings.startMinimized;
            setAutoRefresh.checked = settings.autoRefresh;
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
            renderUpdateStatus();
            syncDependentControls();
        }

        function openSettings() {
            dataPathLabel.textContent = dataPath;
            accountsCountLabel.textContent = readAccounts().length;
            document.getElementById('app-version-label').textContent = remoteApp.getVersion();
            fillSettingsForm();   // Cancelar descarta cambios: el formulario siempre parte de lo guardado
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
        setLaunchStartup.addEventListener('change', syncDependentControls);

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
                launchAtStartup: setLaunchStartup.checked,
                startMinimized: setStartMinimized.checked,
                autoRefresh: setAutoRefresh.checked,
                refreshMinutes: minutes,
                loginMode: checkedMode ? checkedMode.value : 'riotClient',
                launchGame: setLaunchGame.checked,
                autoCheckUpdates: setAutoUpdates.checked,
                streamerIds: setStIds.checked,
                streamerLogin: setStLogin.checked,
                streamerDescs: setStDescs.checked,
                streamerPass: setStPass.checked
            };
            saveSettings();
            applyStreamerMode();

            if (prev.launchAtStartup !== settings.launchAtStartup || prev.startMinimized !== settings.startMinimized) {
                applySystemSettings();
            }
            if (prev.refreshMinutes !== settings.refreshMinutes || prev.autoRefresh !== settings.autoRefresh) {
                secondsRemaining = getRefreshSeconds();
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
        settingsModal.addEventListener('mousedown', (e) => { if (e.target === settingsModal) closeSettings(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && settingsModal.style.display === 'flex') closeSettings();
        });
        btnOpenFolder.addEventListener('click', () => shell.showItemInFolder(dataPath));
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
            if (on && settings.streamerPass) accPassword.type = 'password';   // si estaba a la vista, se vuelve a ocultar
        }

        function toggleStreamerMode() {
            settings.streamerMode = !settings.streamerMode;
            saveSettings();
            applyStreamerMode();
            showNeonNotification(t(settings.streamerMode ? 'streamerOn' : 'streamerOff'));
        }
        streamerBtn.addEventListener('click', toggleStreamerMode);

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
        sortSelect.addEventListener('change', loadAccounts);
        loadChampionData();
        
        applyStreamerMode();
        applyLanguage();
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
