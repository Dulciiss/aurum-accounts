(function () {
    const STORAGE_KEY = 'aurum-accounts-mastery';
    const XP_PER_GAME = 10;
    const LEVEL_THRESHOLDS = Object.freeze([0, 100, 250, 450, 700, 1000, 1400]);
    const titles = Object.freeze([
        { id: 'apprentice', level: 1, nameKey: 'masteryTitleApprentice' },
        { id: 'constant-summoner', level: 3, nameKey: 'masteryTitleConstantSummoner' },
        { id: 'nexus-strategist', level: 5, nameKey: 'masteryTitleNexusStrategist' },
        { id: 'aurum-legend', level: 7, nameKey: 'masteryTitleAurumLegend' }
    ]);

    function identityKeys(account) {
        const keys = [];
        if (account && typeof account.puuid === 'string' && account.puuid.trim()) {
            keys.push(`puuid:${account.puuid.trim().toLowerCase()}`);
        }
        if (account && typeof account.riotId === 'string' && account.riotId.trim()) {
            keys.push(`riotid:${account.riotId.trim().toLowerCase()}`);
        }
        if (account && account.id !== undefined && account.id !== null && String(account.id)) {
            keys.push(`account:${String(account.id)}`);
        }
        if (!keys.length) throw new TypeError('La cuenta necesita un PUUID, Riot ID o identificador local.');
        return keys;
    }

    function readStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { version: 1, accounts: {} };
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !parsed.accounts
                || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
                throw new TypeError('Formato de maestrías guardadas no válido.');
            }
            return parsed;
        } catch (error) {
            console.error('No se pudieron leer las maestrías guardadas:', error);
            return { version: 1, accounts: {} };
        }
    }

    function writeStore(store) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (error) {
            console.error('No se pudieron guardar las maestrías:', error);
            throw error;
        }
    }

    function emptyRecord() {
        return {
            xp: 0,
            equippedTitleId: 'apprentice',
            trackedGames: [],
            awardedAchievements: [],
            awardedChestRewards: []
        };
    }

    function readRecord(account, store = readStore()) {
        const keys = identityKeys(account);
        const primaryKey = keys[0];
        const records = keys.slice().reverse()
            .map(key => store.accounts[key])
            .filter(record => record && typeof record === 'object' && !Array.isArray(record));
        if (!records.length) return { key: primaryKey, record: emptyRecord(), store };

        const record = emptyRecord();
        records.forEach(saved => {
            if (Number.isFinite(saved.xp) && saved.xp >= 0) record.xp = Math.max(record.xp, Math.floor(saved.xp));
            if (typeof saved.equippedTitleId === 'string') record.equippedTitleId = saved.equippedTitleId;
            if (Array.isArray(saved.trackedGames)) {
                record.trackedGames = [...new Set([...record.trackedGames, ...saved.trackedGames.filter(id => typeof id === 'string')])].slice(-500);
            }
            if (Array.isArray(saved.awardedAchievements)) {
                record.awardedAchievements = [...new Set([
                    ...record.awardedAchievements,
                    ...saved.awardedAchievements.filter(id => typeof id === 'string')
                ])];
            }
            if (Array.isArray(saved.awardedChestRewards)) {
                record.awardedChestRewards = [...new Set([
                    ...record.awardedChestRewards,
                    ...saved.awardedChestRewards.filter(id => typeof id === 'string')
                ])];
            }
        });

        const needsMigration = !store.accounts[primaryKey] || keys.slice(1).some(key => store.accounts[key]);
        if (needsMigration) {
            store.accounts[primaryKey] = record;
            keys.slice(1).forEach(key => { delete store.accounts[key]; });
            writeStore(store);
        }
        return { key: primaryKey, record, store };
    }

    function levelForXp(xp) {
        let level = 1;
        for (let index = 1; index < LEVEL_THRESHOLDS.length; index += 1) {
            if (xp < LEVEL_THRESHOLDS[index]) break;
            level = index + 1;
        }
        return level;
    }

    function makeState(record) {
        const level = levelForXp(record.xp);
        const currentThreshold = LEVEL_THRESHOLDS[level - 1];
        const nextThreshold = LEVEL_THRESHOLDS[level] || null;
        const unlockedTitles = titles.filter(title => title.level <= level);
        const equippedTitle = unlockedTitles.find(title => title.id === record.equippedTitleId) || unlockedTitles[0];
        return {
            xp: record.xp,
            level,
            badgeText: `M${level}`,
            xpIntoLevel: record.xp - currentThreshold,
            xpForNextLevel: nextThreshold === null ? 0 : nextThreshold - currentThreshold,
            nextLevel: nextThreshold === null ? null : level + 1,
            progressPercent: nextThreshold === null
                ? 100
                : Math.min(100, Math.floor(((record.xp - currentThreshold) / (nextThreshold - currentThreshold)) * 100)),
            equippedTitleId: equippedTitle.id,
            equippedTitle,
            unlockedTitles
        };
    }

    function getState(account) {
        return makeState(readRecord(account).record);
    }

    function addXp(account, amount) {
        if (!Number.isFinite(amount) || amount <= 0) throw new TypeError('La cantidad de XP debe ser un número positivo.');
        const { key, record, store } = readRecord(account);
        const previousLevel = levelForXp(record.xp);
        const awarded = Math.floor(amount);
        record.xp += awarded;
        store.accounts[key] = record;
        writeStore(store);
        const result = makeState(record);
        const levelUp = result.level > previousLevel;
        if (levelUp && window.aurumSoundboard) window.aurumSoundboard.play('levelUp');
        return { awarded, levelUp, ...result };
    }

    function awardAchievement(account, achievementId) {
        if (typeof achievementId !== 'string' || !achievementId) {
            throw new TypeError('El logro necesita un identificador válido.');
        }
        const { key, record, store } = readRecord(account);
        if (record.awardedAchievements.includes(achievementId)) return { awarded: 0, ...makeState(record) };
        const previousLevel = levelForXp(record.xp);
        record.awardedAchievements.push(achievementId);
        record.xp += 50;
        store.accounts[key] = record;
        writeStore(store);
        const result = makeState(record);
        if (window.aurumSoundboard) window.aurumSoundboard.play('levelUp');
        return { awarded: 50, levelUp: result.level > previousLevel, ...result };
    }

    function awardChestXp(account, rewardId, amount) {
        if (typeof rewardId !== 'string' || !rewardId) throw new TypeError('La recompensa necesita un identificador válido.');
        if (!Number.isFinite(amount) || amount <= 0) throw new TypeError('La cantidad de XP debe ser un número positivo.');
        const { key, record, store } = readRecord(account);
        if (record.awardedChestRewards.includes(rewardId)) return { awarded: 0, ...makeState(record) };
        const previousLevel = levelForXp(record.xp);
        const awarded = Math.floor(amount);
        record.awardedChestRewards.push(rewardId);
        record.xp += awarded;
        store.accounts[key] = record;
        writeStore(store);
        const result = makeState(record);
        const levelUp = result.level > previousLevel;
        if (levelUp && window.aurumSoundboard) window.aurumSoundboard.play('levelUp');
        return { awarded, levelUp, ...result };
    }

    function gameIdentity(game) {
        for (const key of ['id', 'gameId', 'game_id', 'matchId', 'match_id']) {
            if (game && game[key] !== undefined && game[key] !== null && String(game[key])) {
                return `id:${String(game[key])}`;
            }
        }
        return `game:${JSON.stringify([
            game && game.timestamp || '',
            game && game.champ || '',
            game && game.result || '',
            game && game.gameType || ''
        ])}`;
    }

    function addNewGames(account, games) {
        if (!Array.isArray(games)) return { gamesAdded: 0, xpAwarded: 0 };
        const { key, record, store } = readRecord(account);
        const tracked = new Set(record.trackedGames);
        const previousLevel = levelForXp(record.xp);
        let gamesAdded = 0;
        games.forEach(game => {
            const id = gameIdentity(game);
            if (tracked.has(id)) return;
            tracked.add(id);
            gamesAdded += 1;
        });
        if (!gamesAdded) return { gamesAdded: 0, xpAwarded: 0 };

        const xpAwarded = gamesAdded * XP_PER_GAME;
        record.xp += xpAwarded;
        record.trackedGames = [...tracked].slice(-500);
        store.accounts[key] = record;
        writeStore(store);
        const result = makeState(record);
        const levelUp = result.level > previousLevel;
        if (levelUp && window.aurumSoundboard) window.aurumSoundboard.play('levelUp');
        return { gamesAdded, xpAwarded, levelUp, ...result };
    }

    function equipTitle(account, titleId) {
        const { key, record, store } = readRecord(account);
        const state = makeState(record);
        if (!state.unlockedTitles.some(title => title.id === titleId)) {
            throw new RangeError('El título solicitado aún no está desbloqueado.');
        }
        record.equippedTitleId = titleId;
        store.accounts[key] = record;
        writeStore(store);
        return makeState(record);
    }

    window.aurumMastery = Object.freeze({
        titles,
        addXp,
        awardAchievement,
        awardChestXp,
        addNewGames,
        equipTitle,
        getState
    });
})();
