(function () {
    const STORAGE_KEY = 'aurum-accounts-ranked-focus';
    const QUEUES = Object.freeze({
        '420': 'soloDuo',
        '440': 'flex'
    });

    function readPreference() {
        try {
            const value = localStorage.getItem(STORAGE_KEY);
            return value === null ? false : JSON.parse(value) === true;
        } catch (error) {
            console.error('No se pudo leer la preferencia de Ranked Focus:', error);
            return false;
        }
    }

    let enabled = readPreference();
    let phase = '';
    let queueId = null;
    let queueName = '';
    let accountLabel = '';
    let gameStartedAt = null;
    let active = false;
    let queueType = '';
    let timer = null;

    function resolveQueueType(id, name) {
        const normalizedId = id === null || id === undefined ? '' : String(id);
        if (QUEUES[normalizedId]) return QUEUES[normalizedId];
        const normalizedName = String(name || '').toLowerCase();
        if (/ranked.*(solo|duo)|(solo|duo).*ranked/.test(normalizedName)) return 'soloDuo';
        if (/ranked.*flex|flex.*ranked/.test(normalizedName)) return 'flex';
        return '';
    }

    function normalizeStartTime(value) {
        if (typeof value === 'string' && !/^\d+$/.test(value)) {
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) return null;
        return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    function getState() {
        const elapsedSeconds = active
            ? Math.max(0, Math.floor((Date.now() - gameStartedAt) / 1000))
            : 0;
        return {
            enabled,
            active,
            phase,
            queueType,
            accountLabel,
            gameStartedAt,
            elapsedSeconds
        };
    }

    function publish() {
        const state = getState();
        document.body.classList.toggle('ranked-focus-active', state.active);
        window.dispatchEvent(new CustomEvent('aurum-ranked-focus-change', { detail: state }));
    }

    function stopTimer() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    }

    function updateGameState(gameState = {}) {
        const previousPhase = phase;
        const nextPhase = String(gameState.phase || '').trim();
        const nextQueueId = gameState.queueId === undefined ? null : gameState.queueId;
        const nextQueueName = String(gameState.queueName || '');
        const nextQueueType = resolveQueueType(nextQueueId, nextQueueName);
        const nextAccountLabel = String(gameState.accountLabel || '');
        const nextStartTime = normalizeStartTime(gameState.startedAt);
        const wasActive = active;
        const sameGame = phase.toUpperCase() === 'INPROGRESS'
            && nextPhase.toUpperCase() === 'INPROGRESS'
            && queueType === nextQueueType;

        phase = nextPhase;
        queueId = nextQueueId;
        queueName = nextQueueName;
        queueType = nextQueueType;
        accountLabel = nextAccountLabel;
        const rankedGameInProgress = phase.toUpperCase() === 'INPROGRESS' && !!queueType;
        active = enabled && rankedGameInProgress;

        if (rankedGameInProgress) {
            if (!sameGame || !gameStartedAt) gameStartedAt = nextStartTime || Date.now();
            else if (nextStartTime) gameStartedAt = nextStartTime;
        } else {
            gameStartedAt = null;
        }

        if (active) {
            if (timer === null) timer = setInterval(publish, 1000);
        } else {
            stopTimer();
        }

        if (wasActive !== active || active || previousPhase !== phase) publish();
        return getState();
    }

    function setEnabled(value) {
        if (typeof value !== 'boolean') throw new TypeError('La preferencia de Ranked Focus debe ser booleana.');
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
        enabled = value;
        return updateGameState({ phase, queueId, queueName, accountLabel, startedAt: gameStartedAt });
    }

    window.aurumFocusMode = Object.freeze({ getState, setEnabled, updateGameState });
})();
