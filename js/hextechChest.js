(function () {
    const STORAGE_KEY = 'aurum-accounts-hextech-chests';
    const ACHIEVEMENTS_PER_BONUS_CHEST = 3;
    const FRAGMENT_IDS = Object.freeze(['vision', 'objective', 'tempo', 'reset']);
    const COSMETICS = Object.freeze([
        { id: 'hextech-seal', nameKey: 'chestEmblemHextech' },
        { id: 'void-mark', nameKey: 'chestEmblemVoid' },
        { id: 'soul-fighter-emblem', nameKey: 'chestEmblemSoulFighter' }
    ]);
    const REWARDS = Object.freeze([
        { id: 'mastery-50', type: 'masteryXp', xp: 50 },
        { id: 'mastery-100', type: 'masteryXp', xp: 100 },
        ...COSMETICS.map(cosmetic => ({ id: cosmetic.id, type: 'emblem', emblemId: cosmetic.id })),
        { id: 'fragment-vision', type: 'fragment', fragmentId: 'vision' },
        { id: 'fragment-objective', type: 'fragment', fragmentId: 'objective' },
        { id: 'fragment-tempo', type: 'fragment', fragmentId: 'tempo' },
        { id: 'fragment-reset', type: 'fragment', fragmentId: 'reset' }
    ]);

    function localDateKey(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function emptyStore(date) {
        return {
            version: 1,
            date,
            dailyAvailable: true,
            bonusChests: 0,
            achievementUnlocks: [],
            bonusMilestones: 0,
            pendingReward: null,
            cosmetics: [],
            fragments: []
        };
    }

    function normalizePendingReward(reward) {
        if (!reward || typeof reward !== 'object' || Array.isArray(reward)
            || typeof reward.rewardId !== 'string' || !reward.rewardId) return null;
        const definition = REWARDS.find(item => item.id === reward.id && item.type === reward.type);
        if (!definition) return null;
        const normalized = {
            ...definition,
            rewardId: reward.rewardId,
            openedAt: Number.isFinite(reward.openedAt) ? reward.openedAt : 0
        };
        if (definition.type === 'emblem') {
            if (reward.emblemId !== definition.emblemId || typeof reward.permanent !== 'boolean') return null;
            normalized.permanent = reward.permanent;
        }
        return normalized;
    }

    function readStore() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return emptyStore(localDateKey());
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new TypeError('Formato de cofres Hextech guardados no válido.');
            }
            const store = {
                ...emptyStore(localDateKey()),
                ...parsed,
                dailyAvailable: typeof parsed.dailyAvailable === 'boolean' ? parsed.dailyAvailable : true,
                bonusChests: Number.isInteger(parsed.bonusChests) ? Math.max(0, parsed.bonusChests) : 0,
                pendingReward: normalizePendingReward(parsed.pendingReward),
                achievementUnlocks: Array.isArray(parsed.achievementUnlocks)
                    ? [...new Set(parsed.achievementUnlocks.filter(item => typeof item === 'string'))]
                    : [],
                bonusMilestones: Number.isInteger(parsed.bonusMilestones) ? Math.max(0, parsed.bonusMilestones) : 0,
                cosmetics: Array.isArray(parsed.cosmetics)
                    ? parsed.cosmetics.filter(item => item && COSMETICS.some(cosmetic => cosmetic.id === item.id)
                        && Number.isFinite(item.unlockedAt)
                        && (item.permanent === true || Number.isFinite(item.expiresAt)))
                    : [],
                fragments: Array.isArray(parsed.fragments)
                    ? parsed.fragments.filter(item => item && FRAGMENT_IDS.includes(item.id))
                    : []
            };
            const today = localDateKey();
            if (store.date !== today) {
                store.date = today;
                store.dailyAvailable = true;
                writeStore(store);
            }
            return store;
        } catch (error) {
            console.error('No se pudieron leer los cofres Hextech guardados:', error);
            throw error;
        }
    }

    function writeStore(store) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (error) {
            console.error('No se pudieron guardar los cofres Hextech:', error);
            throw error;
        }
    }

    function accountIdentity(account) {
        if (account && typeof account.puuid === 'string' && account.puuid.trim()) {
            return `puuid:${account.puuid.trim().toLowerCase()}`;
        }
        if (account && typeof account.riotId === 'string' && account.riotId.trim()) {
            return `riotid:${account.riotId.trim().toLowerCase()}`;
        }
        if (account && account.id !== undefined && account.id !== null) return `account:${String(account.id)}`;
        throw new TypeError('El logro necesita una identidad de cuenta válida.');
    }

    function getState() {
        const store = readStore();
        const now = Date.now();
        const activeCosmetics = store.cosmetics
            .filter(cosmetic => cosmetic.permanent === true || (Number.isFinite(cosmetic.expiresAt) && cosmetic.expiresAt > now))
            .sort((left, right) => right.unlockedAt - left.unlockedAt);
        return {
            available: (store.dailyAvailable ? 1 : 0) + store.bonusChests,
            dailyAvailable: store.dailyAvailable,
            bonusChests: store.bonusChests,
            pendingReward: store.pendingReward ? { ...store.pendingReward } : null,
            fragments: store.fragments.slice(-10).reverse(),
            activeEmblem: activeCosmetics.length ? { ...activeCosmetics[0] } : null,
            cosmetics: activeCosmetics.map(cosmetic => ({ ...cosmetic }))
        };
    }

    function noteAchievementUnlock(account, achievementId) {
        if (typeof achievementId !== 'string' || !achievementId) {
            throw new TypeError('El logro necesita un identificador válido.');
        }
        const store = readStore();
        const unlockKey = `${accountIdentity(account)}:${achievementId}`;
        if (store.achievementUnlocks.includes(unlockKey)) return { earned: 0, available: getState().available };

        store.achievementUnlocks.push(unlockKey);
        const milestones = Math.floor(store.achievementUnlocks.length / ACHIEVEMENTS_PER_BONUS_CHEST);
        const earned = Math.max(0, milestones - store.bonusMilestones);
        if (earned) {
            store.bonusChests += earned;
            store.bonusMilestones = milestones;
        }
        writeStore(store);
        if (earned) {
            window.dispatchEvent(new CustomEvent('aurum-hextech-chest-earned', { detail: { earned } }));
        }
        return { earned, available: (store.dailyAvailable ? 1 : 0) + store.bonusChests };
    }

    function openChest(options = {}) {
        const store = readStore();
        if (store.pendingReward) return { ...store.pendingReward };
        if (!store.dailyAvailable && store.bonusChests < 1) {
            throw new RangeError('No hay cofres Hextech disponibles.');
        }

        const pool = options.allowMasteryXp === false
            ? REWARDS.filter(reward => reward.type !== 'masteryXp')
            : REWARDS;
        const reward = { ...pool[Math.floor(Math.random() * pool.length)] };
        reward.rewardId = `chest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        reward.openedAt = Date.now();
        if (reward.type === 'emblem') {
            const existing = store.cosmetics.find(item => item.id === reward.emblemId);
            reward.permanent = existing && existing.permanent === true ? true : Math.random() < 0.25;
        }
        if (store.dailyAvailable) store.dailyAvailable = false;
        else store.bonusChests -= 1;
        store.pendingReward = reward;
        writeStore(store);
        if (window.aurumSoundboard) window.aurumSoundboard.play('chestOpen');
        return { ...reward };
    }

    function claimPending(account) {
        const store = readStore();
        const reward = store.pendingReward;
        if (!reward) throw new RangeError('No hay ninguna recompensa pendiente.');

        if (reward.type === 'masteryXp') {
            if (!account) throw new TypeError('Selecciona una cuenta para reclamar la XP de maestría.');
            if (!window.aurumMastery) throw new Error('El módulo de maestría no está disponible.');
            window.aurumMastery.awardChestXp(account, reward.rewardId, reward.xp);
        } else if (reward.type === 'emblem') {
            const cosmetic = COSMETICS.find(item => item.id === reward.emblemId);
            if (!cosmetic) throw new Error(`Emblema Hextech desconocido: ${reward.emblemId}`);
            const current = store.cosmetics.find(item => item.id === cosmetic.id);
            const permanent = reward.permanent === true || !!(current && current.permanent);
            store.cosmetics = store.cosmetics.filter(item => item.id !== cosmetic.id);
            store.cosmetics.push({
                ...cosmetic,
                permanent,
                unlockedAt: Date.now(),
                expiresAt: permanent ? null : Math.max(Date.now(), current && current.expiresAt || 0) + 24 * 60 * 60 * 1000
            });
        } else if (reward.type === 'fragment') {
            store.fragments.push({ id: reward.fragmentId, collectedAt: Date.now() });
            store.fragments = store.fragments.slice(-100);
        } else {
            throw new Error(`Tipo de recompensa Hextech desconocido: ${reward.type}`);
        }

        store.pendingReward = null;
        writeStore(store);
        return { ...reward, state: getState() };
    }

    function animateOpening(canvas, onComplete) {
        const context = canvas && canvas.getContext('2d');
        if (!context) throw new Error('No se pudo inicializar el canvas del cofre Hextech.');
        const width = canvas.width;
        const height = canvas.height;
        const style = getComputedStyle(document.documentElement);
        const accent = style.getPropertyValue('--accent-color').trim() || '#c9a85c';
        const glow = style.getPropertyValue('--glow-color').trim() || 'rgba(201, 168, 92, 0.35)';
        const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const duration = reducedMotion ? 250 : 1500;
        const particles = Array.from({ length: 44 }, () => ({
            angle: Math.random() * Math.PI * 2,
            distance: 18 + Math.random() * 45,
            speed: 0.6 + Math.random() * 1.4,
            size: 1.5 + Math.random() * 3.5,
            phase: Math.random() * Math.PI * 2
        }));
        let frame = null;
        let cancelled = false;
        const startedAt = performance.now();

        function draw(now) {
            if (cancelled) return;
            const progress = Math.min(1, (now - startedAt) / duration);
            const eased = 1 - (1 - progress) ** 3;
            context.clearRect(0, 0, width, height);
            const centerX = width / 2;
            const centerY = height / 2 + 8;
            const pulse = 0.8 + Math.sin(progress * Math.PI * 8) * 0.12;
            const radius = 36 + eased * 46;
            const halo = context.createRadialGradient(centerX, centerY, 8, centerX, centerY, radius * 2.2);
            halo.addColorStop(0, glow);
            halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
            context.fillStyle = halo;
            context.fillRect(0, 0, width, height);

            particles.forEach(particle => {
                const distance = particle.distance + eased * 72 * particle.speed;
                const x = centerX + Math.cos(particle.angle + progress * 2) * distance;
                const y = centerY + Math.sin(particle.angle + progress * 2) * distance;
                const alpha = Math.max(0, 1 - progress * 0.72) * (0.55 + Math.sin(now / 170 + particle.phase) * 0.35);
                context.beginPath();
                context.fillStyle = `rgba(255, 218, 132, ${alpha})`;
                context.arc(x, y, particle.size * (1 - progress * 0.25), 0, Math.PI * 2);
                context.fill();
            });

            context.save();
            context.translate(centerX, centerY);
            context.scale(pulse, pulse);
            context.shadowColor = accent;
            context.shadowBlur = 18 + eased * 24;
            context.strokeStyle = accent;
            context.lineWidth = 3;
            context.beginPath();
            for (let side = 0; side < 6; side += 1) {
                const angle = Math.PI / 3 * side - Math.PI / 6;
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius;
                if (side === 0) context.moveTo(x, y);
                else context.lineTo(x, y);
            }
            context.closePath();
            context.fillStyle = `rgba(201, 168, 92, ${0.08 + eased * 0.12})`;
            context.fill();
            context.stroke();
            context.shadowBlur = 0;
            context.strokeStyle = 'rgba(255, 237, 190, 0.9)';
            context.lineWidth = 2;
            context.beginPath();
            context.moveTo(-26, -8);
            context.lineTo(-26, 18);
            context.lineTo(26, 18);
            context.lineTo(26, -8);
            context.closePath();
            context.stroke();
            context.beginPath();
            context.moveTo(-31, -8);
            context.lineTo(0, -25 - eased * 10);
            context.lineTo(31, -8);
            context.stroke();
            context.restore();

            if (progress < 1) frame = requestAnimationFrame(draw);
            else if (typeof onComplete === 'function') onComplete();
        }

        frame = requestAnimationFrame(draw);
        return () => {
            cancelled = true;
            if (frame !== null) cancelAnimationFrame(frame);
            context.clearRect(0, 0, width, height);
        };
    }

    window.aurumHextechChest = Object.freeze({
        cosmetics: COSMETICS,
        localDateKey,
        getState,
        noteAchievementUnlock,
        openChest,
        claimPending,
        animateOpening
    });
})();
