(function () {
    const STORAGE_KEY = 'aurum-accounts-theme';
    const themes = Object.freeze({
        hextech: Object.freeze({
            '--bg-main': '#0b0c10',
            '--bg-card': '#10131a',
            '--text-color': '#e2e8f0',
            '--accent-color': '#c9a85c',
            '--accent-hover': '#e8cf8f',
            '--accent-contrast': '#17120a',
            '--glow-color': 'rgba(59, 130, 246, 0.32)',
            '--panel-line': '#1f2430',
            '--muted-color': '#7c8494',
            '--bg-sidebar': '#0b0d12',
            '--bg-header': '#0d0f15'
        }),
        void: Object.freeze({
            '--bg-main': '#090611',
            '--bg-card': '#151022',
            '--text-color': '#eee7ff',
            '--accent-color': '#b56cff',
            '--accent-hover': '#dcafff',
            '--accent-contrast': '#170a24',
            '--glow-color': 'rgba(159, 72, 255, 0.46)',
            '--panel-line': '#38264f',
            '--muted-color': '#a99bbd',
            '--bg-sidebar': '#0d0918',
            '--bg-header': '#100b1b'
        }),
        soulFighter: Object.freeze({
            '--bg-main': '#100914',
            '--bg-card': '#211329',
            '--text-color': '#fff0fb',
            '--accent-color': '#ff4fd8',
            '--accent-hover': '#75f3ff',
            '--accent-contrast': '#21091e',
            '--glow-color': 'rgba(0, 229, 255, 0.38)',
            '--panel-line': '#542d5b',
            '--muted-color': '#c0a5bd',
            '--bg-sidebar': '#160d1b',
            '--bg-header': '#1b1020'
        })
    });

    function setTheme(themeName, options = {}) {
        const selectedTheme = Object.prototype.hasOwnProperty.call(themes, themeName)
            ? themeName
            : 'hextech';
        const root = document.documentElement;
        const variables = themes[selectedTheme];

        root.dataset.theme = selectedTheme;
        Object.entries(variables).forEach(([name, value]) => root.style.setProperty(name, value));
        root.style.setProperty('--gold', variables['--accent-color']);
        root.style.setProperty('--gold-hi', variables['--accent-hover']);
        root.style.setProperty('--gold-glow', variables['--glow-color']);
        root.style.setProperty('--panel', variables['--bg-card']);
        root.style.setProperty('--muted', variables['--muted-color']);

        if (options.persist !== false) {
            try {
                localStorage.setItem(STORAGE_KEY, selectedTheme);
            } catch (error) {
                console.error('No se pudo guardar la preferencia del tema:', error);
            }
        }

        return selectedTheme;
    }

    function getTheme() {
        try {
            const storedTheme = localStorage.getItem(STORAGE_KEY);
            return Object.prototype.hasOwnProperty.call(themes, storedTheme) ? storedTheme : 'hextech';
        } catch (error) {
            console.error('No se pudo leer la preferencia del tema:', error);
            return 'hextech';
        }
    }

    window.aurumTheme = Object.freeze({
        themes: Object.freeze(Object.keys(themes)),
        setTheme,
        getTheme
    });

    setTheme(getTheme(), { persist: false });
})();
