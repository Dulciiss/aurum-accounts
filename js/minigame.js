(function () {
    const HIGH_SCORE_KEY = 'aurum-poro-dodge-high-score';
    const ACHIEVEMENT_SCORE = 500;
    const WORLD_WIDTH = 800;
    const WORLD_HEIGHT = 460;

    function readHighScore() {
        try {
            const score = Number(localStorage.getItem(HIGH_SCORE_KEY) || 0);
            return Number.isFinite(score) && score >= 0 ? Math.floor(score) : 0;
        } catch (error) {
            console.error('No se pudo leer el récord de Poro Dodge:', error);
            return 0;
        }
    }

    function createPoroDodge(canvas, labels, onScore, onAchievement, onGameOver) {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('No se pudo inicializar el canvas de Poro Dodge.');

        const highScore = { value: readHighScore() };
        const player = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT - 62, radius: 22, targetX: null, targetY: null };
        let score = 0;
        let hazards = [];
        let cookies = [];
        let running = false;
        let gameOver = false;
        let rafId = null;
        let lastFrame = 0;
        let hazardTimer = 0;
        let cookieTimer = 0;
        let achievementUnlocked = false;
        const keys = new Set();

        function setScore(nextScore) {
            score = nextScore;
            onScore(score, highScore.value);
        }

        function persistHighScore() {
            try {
                localStorage.setItem(HIGH_SCORE_KEY, String(highScore.value));
            } catch (error) {
                console.error('No se pudo guardar el récord de Poro Dodge:', error);
            }
        }

        function drawBackground() {
            const gradient = context.createLinearGradient(0, 0, 0, WORLD_HEIGHT);
            gradient.addColorStop(0, '#111827');
            gradient.addColorStop(1, '#080b12');
            context.fillStyle = gradient;
            context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
            context.strokeStyle = 'rgba(255,255,255,0.035)';
            context.lineWidth = 1;
            for (let x = 0; x <= WORLD_WIDTH; x += 40) {
                context.beginPath();
                context.moveTo(x, 0);
                context.lineTo(x, WORLD_HEIGHT);
                context.stroke();
            }
            for (let y = 0; y <= WORLD_HEIGHT; y += 40) {
                context.beginPath();
                context.moveTo(0, y);
                context.lineTo(WORLD_WIDTH, y);
                context.stroke();
            }
        }

        function drawPoro() {
            context.save();
            context.translate(player.x, player.y);
            context.shadowColor = 'rgba(255, 255, 255, 0.4)';
            context.shadowBlur = 14;
            context.fillStyle = '#f2eee5';
            context.beginPath();
            context.ellipse(0, 4, 25, 22, 0, 0, Math.PI * 2);
            context.fill();
            context.shadowBlur = 0;
            context.fillStyle = '#e2ddd2';
            context.beginPath();
            context.moveTo(-16, -10);
            context.quadraticCurveTo(-31, -31, -12, -24);
            context.quadraticCurveTo(-5, -20, -4, -11);
            context.fill();
            context.beginPath();
            context.moveTo(16, -10);
            context.quadraticCurveTo(31, -31, 12, -24);
            context.quadraticCurveTo(5, -20, 4, -11);
            context.fill();
            context.fillStyle = '#29303d';
            context.beginPath();
            context.arc(-8, 1, 2.4, 0, Math.PI * 2);
            context.arc(8, 1, 2.4, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = '#eb9b9b';
            context.beginPath();
            context.ellipse(0, 9, 4, 2.5, 0, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = '#ef9d8d';
            context.beginPath();
            context.ellipse(0, 15, 3, 5, 0, 0, Math.PI * 2);
            context.fill();
            context.restore();
        }

        function drawHazard(hazard) {
            context.save();
            context.translate(hazard.x, hazard.y);
            context.rotate(hazard.rotation);
            context.shadowColor = hazard.color;
            context.shadowBlur = 12;
            context.fillStyle = hazard.color;
            if (hazard.type === 'orb') {
                context.beginPath();
                context.arc(0, 0, hazard.radius, 0, Math.PI * 2);
                context.fill();
                context.fillStyle = 'rgba(255,255,255,0.7)';
                context.beginPath();
                context.arc(-hazard.radius * 0.28, -hazard.radius * 0.28, hazard.radius * 0.27, 0, Math.PI * 2);
                context.fill();
            } else {
                context.fillRect(-hazard.radius, -hazard.radius, hazard.radius * 2, hazard.radius * 2);
            }
            context.restore();
        }

        function drawCookie(cookie) {
            context.save();
            context.translate(cookie.x, cookie.y);
            context.shadowColor = '#f5bc55';
            context.shadowBlur = 14;
            context.fillStyle = '#d99b42';
            context.beginPath();
            context.arc(0, 0, 12, 0, Math.PI * 2);
            context.fill();
            context.shadowBlur = 0;
            context.fillStyle = '#f8d98b';
            [[-4, -3], [4, -4], [3, 4], [-4, 4]].forEach(([x, y]) => {
                context.beginPath();
                context.arc(x, y, 1.8, 0, Math.PI * 2);
                context.fill();
            });
            context.restore();
        }

        function drawOverlay(title, subtitle) {
            context.fillStyle = 'rgba(3, 5, 10, 0.72)';
            context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillStyle = '#f5d88b';
            context.font = '700 30px "Segoe UI", sans-serif';
            context.fillText(title, WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 18);
            context.fillStyle = '#cbd5e1';
            context.font = '500 15px "Segoe UI", sans-serif';
            context.fillText(subtitle, WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 22);
            context.textAlign = 'left';
        }

        function render() {
            drawBackground();
            cookies.forEach(drawCookie);
            hazards.forEach(drawHazard);
            drawPoro();
            if (gameOver) drawOverlay(labels.gameOver, labels.restartHint);
            else if (!running) drawOverlay(labels.ready, labels.instructions);
        }

        function spawnHazard() {
            const size = 12 + Math.random() * 12;
            const side = Math.random() < 0.32;
            hazards.push({
                x: side ? (Math.random() < 0.5 ? -size : WORLD_WIDTH + size) : Math.random() * WORLD_WIDTH,
                y: side ? Math.random() * WORLD_HEIGHT * 0.72 : -size,
                radius: size,
                type: Math.random() < 0.58 ? 'orb' : 'bolt',
                color: ['#9b69f5', '#55b6ef', '#f05d78'][Math.floor(Math.random() * 3)],
                vx: side ? (Math.random() < 0.5 ? 1 : -1) * (100 + Math.random() * 90) : (Math.random() - 0.5) * 90,
                vy: side ? (Math.random() - 0.5) * 80 : 130 + Math.random() * 100,
                rotation: Math.random() * Math.PI
            });
        }

        function spawnCookie() {
            cookies.push({ x: 28 + Math.random() * (WORLD_WIDTH - 56), y: -16, radius: 12, vy: 90 + Math.random() * 45 });
        }

        function endGame() {
            running = false;
            gameOver = true;
            if (rafId !== null) cancelAnimationFrame(rafId);
            rafId = null;
            render();
            onGameOver(score);
        }

        function update(delta) {
            const seconds = Math.min(delta / 1000, 0.04);
            const speed = 280;
            if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) player.x -= speed * seconds;
            if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) player.x += speed * seconds;
            if (keys.has('ArrowUp') || keys.has('w') || keys.has('W')) player.y -= speed * seconds;
            if (keys.has('ArrowDown') || keys.has('s') || keys.has('S')) player.y += speed * seconds;
            if (player.targetX !== null) {
                player.x += (player.targetX - player.x) * Math.min(1, seconds * 10);
                player.y += (player.targetY - player.y) * Math.min(1, seconds * 10);
            }
            player.x = Math.max(player.radius, Math.min(WORLD_WIDTH - player.radius, player.x));
            player.y = Math.max(player.radius, Math.min(WORLD_HEIGHT - player.radius, player.y));

            hazardTimer += delta;
            cookieTimer += delta;
            if (hazardTimer >= 720) {
                spawnHazard();
                hazardTimer = 0;
            }
            if (cookieTimer >= 1250) {
                spawnCookie();
                cookieTimer = 0;
            }

            hazards.forEach(hazard => {
                hazard.x += hazard.vx * seconds;
                hazard.y += hazard.vy * seconds;
                hazard.rotation += seconds * 2.5;
                if (Math.hypot(player.x - hazard.x, player.y - hazard.y) < player.radius + hazard.radius * 0.72) endGame();
            });
            if (gameOver) return;
            hazards = hazards.filter(hazard => hazard.y < WORLD_HEIGHT + 35 && hazard.x > -45 && hazard.x < WORLD_WIDTH + 45);

            cookies = cookies.filter(cookie => {
                cookie.y += cookie.vy * seconds;
                if (Math.hypot(player.x - cookie.x, player.y - cookie.y) < player.radius + cookie.radius) {
                    setScore(score + 100);
                    if (score > highScore.value) {
                        highScore.value = score;
                        persistHighScore();
                        onScore(score, highScore.value);
                    }
                    if (!achievementUnlocked && score >= ACHIEVEMENT_SCORE) {
                        achievementUnlocked = true;
                        onAchievement(score);
                    }
                    return false;
                }
                return cookie.y < WORLD_HEIGHT + cookie.radius;
            });
        }

        function frame(timestamp) {
            if (!running) return;
            if (!lastFrame) lastFrame = timestamp;
            const delta = timestamp - lastFrame;
            lastFrame = timestamp;
            update(delta);
            render();
            if (running) rafId = requestAnimationFrame(frame);
        }

        function start() {
            if (gameOver) {
                score = 0;
                hazards = [];
                cookies = [];
                hazardTimer = 0;
                cookieTimer = 0;
                achievementUnlocked = false;
                player.x = WORLD_WIDTH / 2;
                player.y = WORLD_HEIGHT - 62;
                setScore(0);
            }
            if (running) return;
            running = true;
            gameOver = false;
            lastFrame = 0;
            rafId = requestAnimationFrame(frame);
        }

        function pause() {
            running = false;
            if (rafId !== null) cancelAnimationFrame(rafId);
            rafId = null;
            keys.clear();
            clearPointer();
            render();
        }

        function dispose() {
            pause();
            keys.clear();
        }

        function setPointer(event) {
            const rect = canvas.getBoundingClientRect();
            player.targetX = (event.clientX - rect.left) * WORLD_WIDTH / rect.width;
            player.targetY = (event.clientY - rect.top) * WORLD_HEIGHT / rect.height;
        }

        function clearPointer() {
            player.targetX = null;
            player.targetY = null;
        }

        function onKeyDown(event) {
            if (running && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a', 'A', 'd', 'D', 'w', 'W', 's', 'S'].includes(event.key)) {
                event.preventDefault();
                keys.add(event.key);
            }
        }

        function onKeyUp(event) { keys.delete(event.key); }

        canvas.addEventListener('pointermove', setPointer);
        canvas.addEventListener('pointerleave', clearPointer);
        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('keyup', onKeyUp);
        onScore(score, highScore.value);
        render();

        return Object.freeze({ start, pause, dispose, highScore: highScore.value });
    }

    window.aurumPoroDodge = Object.freeze({ createPoroDodge, achievementScore: ACHIEVEMENT_SCORE });
})();
