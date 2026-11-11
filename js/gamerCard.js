(function () {
    const WIDTH = 1000;
    const HEIGHT = 560;

    function normalizeResult(result) {
        const value = String(result || '').toUpperCase();
        if (value === 'WIN' || value === 'VICTORY') return 'WIN';
        if (value === 'LOSE' || value === 'LOSS' || value === 'DEFEAT') return 'LOSE';
        return '';
    }

    function fitText(context, value, maxWidth) {
        let text = String(value || '');
        if (context.measureText(text).width <= maxWidth) return text;
        while (text.length && context.measureText(`${text}…`).width > maxWidth) {
            text = text.slice(0, -1);
        }
        return `${text}…`;
    }

    function loadImage(dataUrl) {
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return Promise.resolve(null);
        return new Promise(resolve => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = dataUrl;
        });
    }

    async function createGamerCard(account, achievementState, labels, assets = {}) {
        const [logo, splash] = await Promise.all([
            loadImage(assets.logoDataUrl),
            loadImage(assets.splashDataUrl)
        ]);
        const canvas = document.createElement('canvas');
        canvas.width = WIDTH;
        canvas.height = HEIGHT;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No se pudo inicializar el canvas de la tarjeta.');

        const root = getComputedStyle(document.documentElement);
        const theme = {
            background: root.getPropertyValue('--bg-main').trim() || '#0b0c10',
            card: root.getPropertyValue('--bg-card').trim() || '#10131a',
            text: root.getPropertyValue('--text-color').trim() || '#e2e8f0',
            accent: root.getPropertyValue('--accent-color').trim() || '#c9a85c',
            glow: root.getPropertyValue('--glow-color').trim() || 'rgba(59, 130, 246, 0.32)',
            muted: root.getPropertyValue('--muted-color').trim() || '#7c8494'
        };
        const games = Array.isArray(account.recentGames) ? account.recentGames.slice(0, 10) : [];
        const results = games.map(game => normalizeResult(game && game.result));
        const decisiveGames = results.filter(Boolean);
        const wins = decisiveGames.filter(result => result === 'WIN').length;
        const winRate = decisiveGames.length ? Math.round((wins / decisiveGames.length) * 100) : null;
        let streak = 0;
        if (results.length) {
            const latestResult = results[0];
            if (latestResult) {
                for (const result of results) {
                    if (result !== latestResult) break;
                    streak += 1;
                }
            }
        }
        const streakLabel = results[0] === 'WIN'
            ? (streak === 1 ? labels.win : labels.wins)
            : (streak === 1 ? labels.loss : labels.losses);
        const streakText = streak ? `${streak} ${streakLabel}` : labels.none;
        const unlockedCount = achievementState && achievementState.unlocked
            ? Object.keys(achievementState.unlocked).length
            : 0;
        const queue = account.soloq || {};
        const rank = queue.tier && queue.tier !== 'UNRANKED' ? queue.tier : labels.unranked;
        const lp = Number.isFinite(Number(queue.lp)) ? `${Number(queue.lp)} LP` : '0 LP';
        const riotId = account.riotId || account.loginUser || '—';
        const region = String(account.region || '—').toUpperCase();

        context.fillStyle = theme.background;
        context.fillRect(0, 0, WIDTH, HEIGHT);
        const glow = context.createRadialGradient(790, 80, 20, 790, 80, 520);
        glow.addColorStop(0, theme.glow);
        glow.addColorStop(1, 'transparent');
        context.fillStyle = glow;
        context.fillRect(0, 0, WIDTH, HEIGHT);

        context.fillStyle = theme.card;
        context.globalAlpha = 0.86;
        context.beginPath();
        context.roundRect(32, 32, WIDTH - 64, HEIGHT - 64, 28);
        context.fill();
        context.globalAlpha = 1;

        context.save();
        context.beginPath();
        context.roundRect(34, 34, WIDTH - 68, HEIGHT - 68, 26);
        context.clip();
        if (splash) {
            const scale = Math.max((WIDTH - 68) / splash.width, (HEIGHT - 68) / splash.height);
            const drawWidth = splash.width * scale;
            const drawHeight = splash.height * scale;
            context.globalAlpha = 0.22;
            context.drawImage(splash, (WIDTH - drawWidth) / 2, (HEIGHT - drawHeight) / 2, drawWidth, drawHeight);
        }
        const overlay = context.createLinearGradient(0, 0, WIDTH, HEIGHT);
        overlay.addColorStop(0, theme.background);
        overlay.addColorStop(0.52, `${theme.background}e8`);
        overlay.addColorStop(1, `${theme.background}cc`);
        context.globalAlpha = 0.82;
        context.fillStyle = overlay;
        context.fillRect(34, 34, WIDTH - 68, HEIGHT - 68);
        context.globalAlpha = 1;
        context.restore();

        if (logo) {
            context.save();
            context.globalAlpha = 0.08;
            const logoSize = 310;
            context.drawImage(logo, (WIDTH - logoSize) / 2, (HEIGHT - logoSize) / 2, logoSize, logoSize);
            context.restore();
        }
        context.strokeStyle = theme.accent;
        context.globalAlpha = 0.55;
        context.lineWidth = 2;
        context.beginPath();
        context.roundRect(32, 32, WIDTH - 64, HEIGHT - 64, 28);
        context.stroke();
        context.globalAlpha = 1;

        context.fillStyle = theme.accent;
        context.globalAlpha = 0.12;
        context.beginPath();
        context.moveTo(760, 32);
        context.lineTo(968, 32);
        context.lineTo(968, 240);
        context.closePath();
        context.fill();
        context.globalAlpha = 1;

        context.textBaseline = 'middle';
        context.fillStyle = theme.accent;
        context.font = '700 19px "Segoe UI", sans-serif';
        context.fillText('AURUM ACCOUNTS', 72, 82);
        context.fillStyle = theme.muted;
        context.font = '600 16px "Segoe UI", sans-serif';
        context.textAlign = 'right';
        context.fillText(String(document.documentElement.dataset.theme || 'hextech').replace(/([A-Z])/g, ' $1').toUpperCase(), 928, 82);
        context.textAlign = 'left';

        context.fillStyle = theme.text;
        context.font = '700 42px "Segoe UI", sans-serif';
        context.fillText(fitText(context, riotId, 820), 72, 153);
        context.fillStyle = theme.muted;
        context.font = '600 19px "Segoe UI", sans-serif';
        context.fillText(`${labels.region}: ${region}`, 74, 199);

        const metrics = [
            [labels.rank, rank, lp],
            [labels.winRate, winRate === null ? labels.noData : `${winRate}%`, `${wins}/${decisiveGames.length} ${labels.games}`],
            [labels.streak, streakText, `${games.length} ${labels.recentGames}`],
            [labels.trophies, `${unlockedCount}`, labels.unlocked]
        ];
        const metricWidth = 204;
        const metricGap = 20;
        const metricTop = 268;
        metrics.forEach(([title, value, detail], index) => {
            const x = 72 + index * (metricWidth + metricGap);
            context.fillStyle = theme.background;
            context.globalAlpha = 0.72;
            context.beginPath();
            context.roundRect(x, metricTop, metricWidth, 172, 16);
            context.fill();
            context.globalAlpha = 1;
            context.strokeStyle = theme.accent;
            context.globalAlpha = 0.22;
            context.lineWidth = 1;
            context.stroke();
            context.globalAlpha = 1;

            context.fillStyle = theme.muted;
            context.font = '700 14px "Segoe UI", sans-serif';
            context.fillText(fitText(context, title.toUpperCase(), metricWidth - 28), x + 16, metricTop + 29);
            context.fillStyle = theme.text;
            context.font = '700 25px "Segoe UI", sans-serif';
            context.fillText(fitText(context, value, metricWidth - 28), x + 16, metricTop + 82);
            context.fillStyle = theme.accent;
            context.font = '600 15px "Segoe UI", sans-serif';
            context.fillText(fitText(context, detail, metricWidth - 28), x + 16, metricTop + 130);
        });

        context.fillStyle = theme.muted;
        context.font = '500 14px "Segoe UI", sans-serif';
        context.fillText('AURUM · SEASON III', 72, 477);
        if (labels.emblem) {
            const emblemColor = labels.emblemId === 'void-mark' ? '#b78cff'
                : labels.emblemId === 'soul-fighter-emblem' ? '#ff64d8'
                    : '#79e6f4';
            context.save();
            context.translate(260, 477);
            context.fillStyle = emblemColor;
            context.strokeStyle = emblemColor;
            context.lineWidth = 1.5;
            context.beginPath();
            for (let side = 0; side < 6; side += 1) {
                const angle = Math.PI / 3 * side - Math.PI / 6;
                const x = Math.cos(angle) * 9;
                const y = Math.sin(angle) * 9;
                if (side === 0) context.moveTo(x, y);
                else context.lineTo(x, y);
            }
            context.closePath();
            context.stroke();
            context.font = '600 14px "Segoe UI", sans-serif';
            context.fillText(fitText(context, labels.emblem, 190), 17, 0);
            context.restore();
        }
        context.textAlign = 'right';
        context.fillText(labels.shareCard, 928, 477);

        if (splash && typeof splash.close === 'function') splash.close();
        return canvas;
    }

    window.aurumGamerCard = Object.freeze({ createGamerCard });
})();
