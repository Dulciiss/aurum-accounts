(function () {
    const STORAGE_KEY = 'aurum-accounts-soundboard';
    const DEFAULT_STATE = Object.freeze({ muted: false, volume: 35 });
    const SOUNDS = Object.freeze({
        click: [{ frequency: 880, duration: 0.1, gain: 0.18, type: 'sine', delay: 0 }],
        login: [
            { frequency: 523.25, duration: 0.3, gain: 0.2, type: 'sine', delay: 0 },
            { frequency: 659.25, duration: 0.34, gain: 0.18, type: 'sine', delay: 0.12 },
            { frequency: 783.99, duration: 0.42, gain: 0.16, type: 'sine', delay: 0.24 }
        ],
        chestOpen: [
            { frequency: 987.77, duration: 0.42, gain: 0.16, type: 'sine', delay: 0 },
            { frequency: 1318.51, duration: 0.5, gain: 0.12, type: 'triangle', delay: 0.08 },
            { frequency: 1760, duration: 0.56, gain: 0.08, type: 'sine', delay: 0.16 }
        ],
        levelUp: [
            { frequency: 659.25, duration: 0.28, gain: 0.16, type: 'sine', delay: 0 },
            { frequency: 783.99, duration: 0.3, gain: 0.16, type: 'sine', delay: 0.12 },
            { frequency: 987.77, duration: 0.42, gain: 0.15, type: 'triangle', delay: 0.24 }
        ],
        readyCheck: [
            { frequency: 740, duration: 0.2, gain: 0.18, type: 'sine', delay: 0 },
            { frequency: 988, duration: 0.24, gain: 0.15, type: 'sine', delay: 0.2 }
        ]
    });

    function normalizeState(value) {
        return {
            muted: typeof value.muted === 'boolean' ? value.muted : DEFAULT_STATE.muted,
            volume: Number.isFinite(value.volume)
                ? Math.max(0, Math.min(100, Math.round(value.volume)))
                : DEFAULT_STATE.volume
        };
    }

    function readState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULT_STATE };
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new TypeError('Formato de preferencias de audio no válido.');
            }
            return normalizeState(parsed);
        } catch (error) {
            console.error('No se pudieron leer las preferencias de audio:', error);
            return { ...DEFAULT_STATE };
        }
    }

    let state = readState();
    let audioContext = null;
    let masterGain = null;
    let userInteracted = false;
    let warnedUnavailable = false;

    function saveState(nextState) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
        state = nextState;
        if (masterGain && audioContext) {
            const target = state.muted ? 0 : state.volume / 100;
            masterGain.gain.setTargetAtTime(target, audioContext.currentTime, 0.04);
        }
        window.dispatchEvent(new CustomEvent('aurum-soundboard-state-change', { detail: getState() }));
        return getState();
    }

    function getState() {
        return { muted: state.muted, volume: state.volume };
    }

    function ensureAudioContext() {
        if (audioContext) return audioContext;
        const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextConstructor) {
            if (!warnedUnavailable) {
                console.warn('Web Audio API no está disponible en este entorno.');
                warnedUnavailable = true;
            }
            return null;
        }
        audioContext = new AudioContextConstructor();
        masterGain = audioContext.createGain();
        masterGain.gain.value = state.muted ? 0 : state.volume / 100;
        masterGain.connect(audioContext.destination);
        return audioContext;
    }

    function unlock() {
        userInteracted = true;
        let context;
        try {
            context = ensureAudioContext();
        } catch (error) {
            console.warn('No se pudo inicializar el contexto de audio:', error);
            return Promise.resolve(false);
        }
        if (!context || context.state === 'running') return Promise.resolve(!!context);
        return context.resume().then(() => context.state === 'running').catch(error => {
            console.warn('No se pudo reanudar el contexto de audio:', error);
            return false;
        });
    }

    function playNotes(notes) {
        try {
            const context = ensureAudioContext();
            if (!context || !masterGain) return false;
            const start = context.currentTime + 0.015;

            notes.forEach(note => {
                const oscillator = context.createOscillator();
                const envelope = context.createGain();
                const noteStart = start + note.delay;
                const attack = 0.025;
                const decay = Math.min(0.09, note.duration * 0.3);
                const release = Math.min(0.18, note.duration * 0.45);
                const sustainTime = Math.max(noteStart + attack + decay, noteStart + note.duration - release);
                const peak = note.gain;

                oscillator.type = note.type;
                oscillator.frequency.setValueAtTime(note.frequency, noteStart);
                envelope.gain.setValueAtTime(0, noteStart);
                envelope.gain.linearRampToValueAtTime(peak, noteStart + attack);
                envelope.gain.linearRampToValueAtTime(peak * 0.68, noteStart + attack + decay);
                envelope.gain.setValueAtTime(peak * 0.68, sustainTime);
                envelope.gain.linearRampToValueAtTime(0, sustainTime + release);
                oscillator.connect(envelope);
                envelope.connect(masterGain);
                oscillator.start(noteStart);
                oscillator.stop(sustainTime + release + 0.02);
            });
            return true;
        } catch (error) {
            console.warn('No se pudo generar el efecto de audio:', error);
            return false;
        }
    }

    function play(soundId) {
        if (!Object.prototype.hasOwnProperty.call(SOUNDS, soundId)) {
            throw new RangeError(`Efecto de sonido desconocido: ${soundId}`);
        }
        if (state.muted || state.volume === 0 || !userInteracted) return false;
        let context;
        try {
            context = ensureAudioContext();
        } catch (error) {
            console.warn('No se pudo inicializar el contexto de audio:', error);
            return false;
        }
        if (!context) return false;
        if (context.state === 'running') return playNotes(SOUNDS[soundId]);
        context.resume().then(() => {
            if (!state.muted && state.volume > 0) playNotes(SOUNDS[soundId]);
        }).catch(error => console.warn('No se pudo reproducir el efecto de audio:', error));
        return true;
    }

    function setMuted(muted) {
        if (typeof muted !== 'boolean') throw new TypeError('El silencio debe ser un valor booleano.');
        return saveState({ ...state, muted });
    }

    function toggleMuted() {
        return setMuted(!state.muted);
    }

    function setVolume(volume) {
        if (!Number.isFinite(Number(volume))) throw new TypeError('El volumen debe ser un número válido.');
        return saveState({ ...state, volume: Math.max(0, Math.min(100, Math.round(Number(volume)))) });
    }

    if (document && typeof document.addEventListener === 'function') {
        document.addEventListener('pointerdown', unlock, { capture: true, once: true });
        document.addEventListener('keydown', unlock, { capture: true, once: true });
        document.addEventListener('click', event => {
            const target = event.target && event.target.closest
                ? event.target.closest('button.btn-gold, button.btn-add, button.btn-login, button.settings-save')
                : null;
            if (target && !target.disabled && !target.closest('[data-sound-preview]')) play('click');
        });
    }

    window.aurumSoundboard = Object.freeze({ getState, setMuted, toggleMuted, setVolume, play, unlock });
})();
