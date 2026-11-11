(function () {
    const SUPABASE_URL = 'https://ktoszywsngizwiifttvw.supabase.co';
    const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_DYnMv5ogjRz-viZ_Hk9sFw_mFRDgifH';
    const PROFILE_STORAGE_KEY = 'aurum-accounts-aurum-match';
    const POSTS_STORAGE_KEY = 'aurum-accounts-aurum-match-posts';
    const ROLES = Object.freeze(['top', 'jungle', 'mid', 'adc', 'support']);
    const QUEUES = Object.freeze(['soloDuo', 'flex']);
    const BADGES = Object.freeze(['duo-god', 'main-otp', 'tilt-alert', 'smurf']);
    const ANNOUNCEMENT_SELECT = 'id,owner_id,account_key,riot_id,region,queue,primary_role,secondary_role,rank_tier,rank_lp,win_rate,play_style,voice,goal,created_at,updated_at';
    const ANNOUNCEMENT_TTL_MS = 2 * 60 * 60 * 1000;
    const DEFAULT_PROFILE = Object.freeze({
        accountId: '',
        primaryRole: 'top',
        secondaryRole: 'jungle',
        queue: 'soloDuo',
        playStyle: '',
        badges: [],
        voice: 'any',
        goal: ''
    });

    let profile = readProfile();
    let posts = readPosts();
    let globalPosts = [];
    let client = null;
    let ownerId = '';
    let online = false;
    let channel = null;
    let refreshHandler = null;
    let initialized = false;
    let initializing = null;

    function normalizeProfile(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const primaryRole = ROLES.includes(source.primaryRole) ? source.primaryRole : DEFAULT_PROFILE.primaryRole;
        const secondaryRole = ROLES.includes(source.secondaryRole) && source.secondaryRole !== primaryRole
            ? source.secondaryRole
            : '';
        return {
            accountId: typeof source.accountId === 'string' ? source.accountId.slice(0, 100) : '',
            primaryRole,
            secondaryRole,
            queue: QUEUES.includes(source.queue) ? source.queue : DEFAULT_PROFILE.queue,
            playStyle: typeof source.playStyle === 'string' ? source.playStyle.trim().slice(0, 100) : '',
            badges: [...new Set((Array.isArray(source.badges) ? source.badges : [])
                .filter(badge => BADGES.includes(badge)))].slice(0, 2),
            voice: ['yes', 'no', 'any'].includes(source.voice) ? source.voice : 'any',
            goal: typeof source.goal === 'string' ? source.goal.trim().slice(0, 80) : ''
        };
    }

    function normalizePost(value) {
        const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const accountId = source.accountId || source.account_key;
        if (typeof accountId !== 'string' || !accountId) return null;
        const primaryRole = ROLES.includes(source.primaryRole || source.primary_role)
            ? source.primaryRole || source.primary_role
            : DEFAULT_PROFILE.primaryRole;
        const secondaryValue = source.secondaryRole || source.secondary_role || '';
        const secondaryRole = ROLES.includes(secondaryValue) && secondaryValue !== primaryRole ? secondaryValue : '';
        const createdAt = source.createdAt || source.created_at;
        const updatedAt = source.updatedAt || source.updated_at;
        const createdTimestamp = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
        const updatedTimestamp = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
        const rankLp = source.rankLp !== undefined ? source.rankLp : source.rank_lp;
        const winRate = source.winRate !== undefined ? source.winRate : source.win_rate;
        return {
            id: typeof source.id === 'string' && source.id
                ? source.id
                : `post-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            ownerId: typeof source.ownerId === 'string' ? source.ownerId : source.owner_id || '',
            accountId: accountId.slice(0, 100),
            riotId: typeof source.riotId === 'string' ? source.riotId.trim().slice(0, 80) : typeof source.riot_id === 'string' ? source.riot_id.trim().slice(0, 80) : '',
            region: typeof source.region === 'string' ? source.region.trim().toLowerCase().slice(0, 12) : 'euw',
            queue: QUEUES.includes(source.queue) ? source.queue : DEFAULT_PROFILE.queue,
            primaryRole,
            secondaryRole,
            rankTier: typeof (source.rankTier || source.rank_tier) === 'string'
                ? String(source.rankTier || source.rank_tier).slice(0, 32)
                : 'UNRANKED',
            rankLp: Number.isFinite(Number(rankLp)) ? Math.max(0, Number(rankLp)) : 0,
            winRate: winRate !== null && winRate !== undefined && winRate !== ''
                && Number.isFinite(Number(winRate))
                ? Math.min(100, Math.max(0, Number(winRate)))
                : null,
            playStyle: typeof (source.playStyle || source.play_style) === 'string'
                ? String(source.playStyle || source.play_style).trim().slice(0, 100)
                : '',
            voice: ['yes', 'no', 'any'].includes(source.voice) ? source.voice : 'any',
            goal: typeof source.goal === 'string' ? source.goal.trim().slice(0, 80) : '',
            publishedAt: Number.isFinite(createdTimestamp) ? createdTimestamp : Date.now(),
            updatedAt: Number.isFinite(updatedTimestamp) ? updatedTimestamp : Date.now()
        };
    }

    function readProfile() {
        try {
            const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
            return normalizeProfile(raw ? JSON.parse(raw) : DEFAULT_PROFILE);
        } catch (error) {
            console.error('No se pudo leer el perfil de Aurum Match:', error);
            return normalizeProfile(DEFAULT_PROFILE);
        }
    }

    function readPosts() {
        try {
            const raw = localStorage.getItem(POSTS_STORAGE_KEY);
            const stored = raw ? JSON.parse(raw) : [];
            return Array.isArray(stored) ? stored.map(normalizePost).filter(Boolean).slice(0, 100) : [];
        } catch (error) {
            console.error('No se pudieron leer los anuncios locales de Aurum Match:', error);
            return [];
        }
    }

    function copyPost(post) {
        return { ...post };
    }

    function getProfile() {
        return { ...profile, badges: profile.badges.slice() };
    }

    function saveProfile(value) {
        const normalized = normalizeProfile(value);
        localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalized));
        profile = normalized;
        return getProfile();
    }

    function persistPosts() {
        localStorage.setItem(POSTS_STORAGE_KEY, JSON.stringify(posts));
    }

    function saveLocalPost(value) {
        const post = normalizePost(value);
        if (!post) throw new TypeError('El anuncio debe estar asociado a una cuenta.');
        const existingIndex = posts.findIndex(item => item.accountId === post.accountId);
        if (existingIndex >= 0) {
            post.id = posts[existingIndex].id;
            post.publishedAt = posts[existingIndex].publishedAt;
            posts.splice(existingIndex, 1);
        }
        post.updatedAt = Date.now();
        posts.unshift(post);
        posts = posts.slice(0, 100);
        persistPosts();
        return copyPost(post);
    }

    function getPosts() {
        return (online ? globalPosts : posts).map(copyPost);
    }

    function getLocalPosts() {
        return posts.map(copyPost);
    }

    function isOnline() {
        return online;
    }

    function getOwnerId() {
        return ownerId;
    }

    function setOnline(value) {
        online = value;
        if (refreshHandler) refreshHandler({ online, ownerId });
    }

    async function initialize(onStateChange) {
        if (typeof onStateChange === 'function') refreshHandler = onStateChange;
        if (initialized) return { online, ownerId };
        if (initializing) return initializing;

        initializing = (async () => {
            try {
                if (!client) {
                    const { createClient } = require('@supabase/supabase-js');
                    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
                        auth: {
                            autoRefreshToken: true,
                            persistSession: true,
                            detectSessionInUrl: false
                        },
                        realtime: { params: { eventsPerSecond: 5 } }
                    });
                }
                let { data: sessionData, error } = await client.auth.getSession();
                if (error) throw error;
                if (!sessionData.session) {
                    const result = await client.auth.signInAnonymously();
                    if (result.error) throw result.error;
                    sessionData = { session: result.data.session };
                }
                ownerId = sessionData.session && sessionData.session.user && sessionData.session.user.id || '';
                if (!ownerId) throw new Error('Supabase no devolvió una identidad anónima válida.');
                initialized = true;
                await loadAnnouncements();
                subscribeRealtime();
            } catch (error) {
                console.error('No se pudo inicializar el tablón global de Aurum Match:', error);
                setOnline(false);
            } finally {
                initializing = null;
            }
            return { online, ownerId };
        })();
        return initializing;
    }

    function subscribeRealtime() {
        if (!client || channel) return;
        channel = client.channel('public:duo_announcements')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'duo_announcements'
            }, () => {
                loadAnnouncements().catch(error => {
                    console.error('No se pudo actualizar Aurum Match tras un cambio en tiempo real:', error);
                });
            })
            .subscribe(status => {
                if (status === 'SUBSCRIBED') {
                    setOnline(true);
                    loadAnnouncements().catch(error => {
                        console.error('No se pudieron cargar los anuncios tras reconectar Realtime:', error);
                    });
                    return;
                }
                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
                    setOnline(false);
                }
            });
    }

    async function loadAnnouncements() {
        if (!client || !ownerId) return { ok: false, offline: true, posts: getLocalPosts() };
        const cutoff = new Date(Date.now() - ANNOUNCEMENT_TTL_MS).toISOString();
        let data;
        let error;
        try {
            ({ data, error } = await client
                .from('duo_announcements')
                .select(ANNOUNCEMENT_SELECT)
                .gte('created_at', cutoff)
                .order('created_at', { ascending: false })
                .limit(200));
        } catch (requestError) {
            console.error('Falló la petición al tablón global de Aurum Match:', requestError);
            setOnline(false);
            return { ok: false, offline: true, posts: getLocalPosts(), error: requestError };
        }
        if (error) {
            console.error('No se pudieron cargar los anuncios globales de Aurum Match:', error);
            setOnline(false);
            return { ok: false, offline: true, posts: getLocalPosts(), error };
        }
        const now = Date.now();
        globalPosts = (Array.isArray(data) ? data : [])
            .map(normalizePost)
            .filter(post => post && post.publishedAt >= now - ANNOUNCEMENT_TTL_MS)
            .sort((left, right) => right.publishedAt - left.publishedAt);
        setOnline(true);
        return { ok: true, offline: false, posts: globalPosts.map(copyPost) };
    }

    function toDatabasePost(post) {
        return {
            owner_id: ownerId,
            account_key: post.accountId,
            riot_id: post.riotId,
            region: post.region,
            queue: post.queue,
            primary_role: post.primaryRole,
            secondary_role: post.secondaryRole || null,
            rank_tier: post.rankTier,
            rank_lp: post.rankLp,
            win_rate: post.winRate,
            play_style: post.playStyle,
            voice: post.voice,
            goal: post.goal,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
    }

    async function publishPost(value) {
        const post = normalizePost(value);
        if (!post) throw new TypeError('El anuncio debe estar asociado a una cuenta.');

        if (client && ownerId) {
            const { data, error } = await client
                .from('duo_announcements')
                .upsert(toDatabasePost(post), { onConflict: 'owner_id,account_key' })
                .select(ANNOUNCEMENT_SELECT)
                .single();
            if (!error && data) {
                const saved = normalizePost(data);
                posts = posts.filter(item => item.accountId !== saved.accountId);
                globalPosts = [saved, ...globalPosts.filter(item => item.id !== saved.id
                    && !(item.ownerId === ownerId && item.accountId === saved.accountId))]
                    .sort((left, right) => right.publishedAt - left.publishedAt);
                setOnline(true);
                return { ok: true, offline: false, post: copyPost(saved) };
            }
            console.error('No se pudo publicar el anuncio global de Aurum Match:', error);
            setOnline(false);
            return { ok: false, offline: true, post: saveLocalPost(post), error };
        }

        return { ok: false, offline: true, post: saveLocalPost(post) };
    }

    async function renewPost(postId) {
        const localPost = posts.find(item => item.id === postId);
        if (localPost && !online) {
            localPost.publishedAt = Date.now();
            localPost.updatedAt = Date.now();
            persistPosts();
            return { ok: true, offline: true };
        }
        const globalPost = globalPosts.find(item => item.id === postId);
        if (!client || !ownerId || !globalPost || globalPost.ownerId !== ownerId) {
            return { ok: false, offline: !online };
        }
        const now = new Date().toISOString();
        const { data, error } = await client
            .from('duo_announcements')
            .update({ created_at: now, updated_at: now })
            .eq('id', postId)
            .eq('owner_id', ownerId)
            .select(ANNOUNCEMENT_SELECT)
            .maybeSingle();
        if (error || !data) {
            if (error) console.error('No se pudo renovar el anuncio global de Aurum Match:', error);
            setOnline(false);
            return { ok: false, offline: true, error };
        }
        const renewed = normalizePost(data);
        globalPosts = [renewed, ...globalPosts.filter(item => item.id !== renewed.id)]
            .sort((left, right) => right.publishedAt - left.publishedAt);
        return { ok: true, offline: false };
    }

    async function deletePost(postId) {
        const localIndex = posts.findIndex(item => item.id === postId);
        if (localIndex >= 0 && !online) {
            posts.splice(localIndex, 1);
            persistPosts();
            return { ok: true, offline: true };
        }
        const globalPost = globalPosts.find(item => item.id === postId);
        if (!client || !ownerId || !globalPost || globalPost.ownerId !== ownerId) {
            return { ok: false, offline: !online };
        }
        const { data, error } = await client
            .from('duo_announcements')
            .delete()
            .eq('id', postId)
            .eq('owner_id', ownerId)
            .select('id')
            .maybeSingle();
        if (error || !data) {
            if (error) console.error('No se pudo eliminar el anuncio global de Aurum Match:', error);
            setOnline(false);
            return { ok: false, offline: true, error };
        }
        globalPosts = globalPosts.filter(item => item.id !== postId);
        return { ok: true, offline: false };
    }

    function buildAnnouncement(details) {
        if (!details || typeof details !== 'object') throw new TypeError('Faltan los datos del anuncio Aurum Match.');
        const values = [
            `🎮 **Aurum Match · ${details.queue}**`,
            `👤 **${details.riotIdLabel}:** ${details.riotId}`,
            `🏅 **${details.rankLabel}:** ${details.rank}`,
            `📈 **${details.winRateLabel}:** ${details.winRate}`,
            `🎯 **${details.rolesLabel}:** ${details.roles}`,
            `✨ **${details.styleLabel}:** ${details.playStyle || details.noPreference}`,
            details.badges ? `🏷️ **${details.badgesLabel}:** ${details.badges}` : ''
        ];
        return values.filter(Boolean).join('\n');
    }

    window.addEventListener('online', () => {
        if (client && ownerId) {
            loadAnnouncements().catch(error => {
                console.error('No se pudo reconectar al tablón global de Aurum Match:', error);
            });
        } else {
            initialize(refreshHandler);
        }
    });
    window.addEventListener('offline', () => setOnline(false));

    window.aurumDuoFinder = Object.freeze({
        roles: ROLES,
        queues: QUEUES,
        badges: BADGES,
        getProfile,
        saveProfile,
        buildAnnouncement,
        getPosts,
        getLocalPosts,
        getOwnerId,
        isOnline,
        initialize,
        loadAnnouncements,
        publishPost,
        renewPost,
        deletePost
    });
})();
