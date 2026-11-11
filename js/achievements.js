(function () {
    const STORAGE_KEY = 'aurum-accounts-achievements';
    const RANK_ORDER = {
        IRON: 1,
        BRONZE: 2,
        SILVER: 3,
        GOLD: 4,
        PLATINUM: 5,
        EMERALD: 6,
        DIAMOND: 7,
        MASTER: 8,
        GRANDMASTER: 9,
        CHALLENGER: 10
    };
    const catalog = Object.freeze([
        { id: 'win_streak_5', nameKey: 'achievementWinStreakName', descriptionKey: 'achievementWinStreakDesc' },
        { id: 'lp_climber', nameKey: 'achievementLpClimberName', descriptionKey: 'achievementLpClimberDesc' },
        { id: 'comeback_king', nameKey: 'achievementComebackName', descriptionKey: 'achievementComebackDesc' },
        { id: 'night_owl', nameKey: 'achievementNightOwlName', descriptionKey: 'achievementNightOwlDesc' },
        { id: 'account_collector', nameKey: 'achievementCollectorName', descriptionKey: 'achievementCollectorDesc' },
        { id: 'poro_dodger', nameKey: 'achievementPoroDodgerName', descriptionKey: 'achievementPoroDodgerDesc', secret: true }
    ]);

    function accountIdentityKeys(account) {
        const identities = [];
        if (account && typeof account.puuid === 'string' && account.puuid.trim()) {
            identities.push(`puuid:${account.puuid.trim().toLowerCase()}`);
        }
        if (account && typeof account.riotId === 'string' && account.riotId.trim()) {
            identities.push(`riotid:${account.riotId.trim().toLowerCase()}`);
        }
        if (account && account.id) identities.push(`account:${String(account.id)}`);
        return identities.length ? identities : ['account:unknown'];
    }

    function readUnlocks() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { version: 1, accounts: {} };
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || !parsed.accounts
                || typeof parsed.accounts !== 'object' || Array.isArray(parsed.accounts)) {
                throw new TypeError('Formato de logros guardados no válido.');
            }
            return parsed;
        } catch (error) {
            console.error('No se pudieron leer los logros guardados:', error);
            return { version: 1, accounts: {} };
        }
    }

    function normalizeResult(result) {
        const value = String(result || '').toUpperCase();
        if (value === 'WIN' || value === 'VICTORY') return 'WIN';
        if (value === 'LOSE' || value === 'LOSS' || value === 'DEFEAT') return 'LOSE';
        return value === 'REMAKE' ? 'REMAKE' : '';
    }

    function readGameTimestamp(game) {
        const raw = game && (
            game.timestamp ?? game.created_at ?? game.createdAt ??
            game.played_at ?? game.playedAt ?? game.gameCreation
        );
        if (raw === null || raw === undefined || raw === '') return null;
        const numeric = typeof raw === 'number' ? raw : (/^\d+$/.test(String(raw)) ? Number(raw) : NaN);
        const timestamp = Number.isFinite(numeric)
            ? (numeric < 1e12 ? numeric * 1000 : numeric)
            : Date.parse(String(raw));
        return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
    }

    function hasWinStreak(games) {
        let streak = 0;
        for (const game of games) {
            streak = normalizeResult(game && game.result) === 'WIN' ? streak + 1 : 0;
            if (streak >= 5) return true;
        }
        return false;
    }

    function hasComeback(games) {
        for (let index = 0; index < games.length; index += 1) {
            if (normalizeResult(games[index] && games[index].result) !== 'WIN') continue;
            let losses = 0;
            for (let previous = index + 1; previous < games.length; previous += 1) {
                const result = normalizeResult(games[previous] && games[previous].result);
                if (result !== 'LOSE') break;
                losses += 1;
            }
            if (losses >= 3) return true;
        }
        return false;
    }

    function rankTier(point) {
        const tier = String(point && point.tier || '').toUpperCase().split(/\s+/)[0];
        return RANK_ORDER[tier] || 0;
    }

    function hasLpClimb(history) {
        if (!Array.isArray(history) || history.length < 2) return false;
        for (let index = 1; index < history.length; index += 1) {
            const previous = history[index - 1];
            const current = history[index];
            if (!previous || !current) continue;

            const previousOrder = Number.isFinite(previous.rankOrder) ? previous.rankOrder : null;
            const currentOrder = Number.isFinite(current.rankOrder) ? current.rankOrder : null;
            if (previousOrder !== null && currentOrder !== null) {
                if (currentOrder > previousOrder) return true;
                if (currentOrder === previousOrder && Number(current.lp) - Number(previous.lp) >= 50) return true;
            } else if (String(previous.tier || '').toUpperCase() === String(current.tier || '').toUpperCase()
                && Number(current.lp) - Number(previous.lp) >= 50) {
                return true;
            }

            const previousTier = rankTier(previous), currentTier = rankTier(current);
            if (currentTier > previousTier) return true;
        }
        return false;
    }

    function isNightGame(game) {
        const timestamp = readGameTimestamp(game);
        if (timestamp === null) return false;
        const hour = new Date(timestamp).getHours();
        return hour >= 3 && hour < 6;
    }

    function evaluateAchievements(accountData, allAccounts) {
        const account = accountData && typeof accountData === 'object' ? accountData : {};
        const games = Array.isArray(account.recentGames) ? account.recentGames.slice(0, 10) : [];
        const history = Array.isArray(account.lpHistory) ? account.lpHistory : [];
        const criteria = {
            win_streak_5: hasWinStreak(games),
            lp_climber: hasLpClimb(history),
            comeback_king: hasComeback(games) || hasComeback([...games].reverse()),
            night_owl: games.some(isNightGame),
            account_collector: Array.isArray(allAccounts) && allAccounts.length >= 5
        };
        const identityKeys = accountIdentityKeys(account);
        const identity = identityKeys[0];
        const unlocks = readUnlocks();
        const savedForAccount = {};
        identityKeys.slice().reverse().forEach(key => {
            const saved = unlocks.accounts[key];
            if (saved && typeof saved === 'object' && !Array.isArray(saved)) Object.assign(savedForAccount, saved);
        });
        const newlyUnlocked = [];
        const now = new Date().toISOString();
        let changed = !unlocks.accounts[identity] && identityKeys.slice(1).some(key => !!unlocks.accounts[key]);

        catalog.forEach(achievement => {
            if (criteria[achievement.id] && !savedForAccount[achievement.id]) {
                savedForAccount[achievement.id] = now;
                newlyUnlocked.push({ ...achievement, unlockedAt: now });
                changed = true;
            }
        });

        if (changed) {
            unlocks.accounts[identity] = savedForAccount;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(unlocks));
            } catch (error) {
                console.error('No se pudieron guardar los logros:', error);
            }
        }
        newlyUnlocked.forEach(achievement => {
            if (window.aurumMastery) {
                try {
                    const award = window.aurumMastery.awardAchievement(account, achievement.id);
                    if (!award.awarded && window.aurumSoundboard) window.aurumSoundboard.play('levelUp');
                } catch (error) {
                    console.error(`No se pudo añadir XP por desbloquear el logro ${achievement.id}:`, error);
                }
            } else if (window.aurumSoundboard) {
                window.aurumSoundboard.play('levelUp');
            }
            if (window.aurumHextechChest) {
                try {
                    window.aurumHextechChest.noteAchievementUnlock(account, achievement.id);
                } catch (error) {
                    console.error(`No se pudo registrar el logro ${achievement.id} para los cofres Hextech:`, error);
                }
            }
        });

        return {
            identity,
            unlocked: { ...savedForAccount },
            newlyUnlocked,
            total: catalog.length
        };
    }

    function unlockAchievement(accountData, achievementId) {
        const achievement = catalog.find(item => item.id === achievementId);
        if (!achievement) throw new Error(`Unknown achievement: ${achievementId}`);

        const identityKeys = accountIdentityKeys(accountData && typeof accountData === 'object' ? accountData : {});
        const identity = identityKeys[0];
        const unlocks = readUnlocks();
        const savedForAccount = {};
        identityKeys.slice().reverse().forEach(key => {
            const saved = unlocks.accounts[key];
            if (saved && typeof saved === 'object' && !Array.isArray(saved)) Object.assign(savedForAccount, saved);
        });

        const alreadyUnlocked = !!savedForAccount[achievementId];
        if (!alreadyUnlocked) savedForAccount[achievementId] = new Date().toISOString();
        unlocks.accounts[identity] = savedForAccount;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(unlocks));
        } catch (error) {
            console.error('No se pudo guardar el logro:', error);
            throw error;
        }
        if (!alreadyUnlocked && window.aurumMastery) {
            try {
                const award = window.aurumMastery.awardAchievement(accountData, achievementId);
                if (!award.awarded && window.aurumSoundboard) window.aurumSoundboard.play('levelUp');
            } catch (error) {
                console.error(`No se pudo añadir XP por desbloquear el logro ${achievementId}:`, error);
            }
        } else if (!alreadyUnlocked && window.aurumSoundboard) {
            window.aurumSoundboard.play('levelUp');
        }
        if (!alreadyUnlocked && window.aurumHextechChest) {
            try {
                window.aurumHextechChest.noteAchievementUnlock(accountData, achievementId);
            } catch (error) {
                console.error(`No se pudo registrar el logro ${achievementId} para los cofres Hextech:`, error);
            }
        }

        return {
            achievement: { ...achievement, unlockedAt: savedForAccount[achievementId] },
            newlyUnlocked: !alreadyUnlocked
        };
    }

    window.aurumAchievements = Object.freeze({
        catalog,
        evaluateAchievements,
        unlockAchievement
    });
})();
