const DISCORD_WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[^/\s]+(?:\?.*)?$/;
const EMBED_COLOR = 0xc9a85c;
const FIELD_LIMIT = 1024;
const RELEASES_URL = 'https://github.com/Dulciiss/aurum-accounts/releases/tag/';
const DOWNLOADS_URL = 'https://dulciiss.github.io/aurum-accounts/#descargar';

function normalizeItems(items, name) {
    if (!Array.isArray(items)) {
        throw new TypeError(`${name} debe ser una lista.`);
    }

    return items.map((item) => {
        if (typeof item !== 'string') {
            throw new TypeError(`Cada elemento de ${name} debe ser texto.`);
        }
        return item.trim();
    }).filter(Boolean);
}

function formatField(items, emptyMessage) {
    const lines = items.length ? items.map((item) => `• ${item}`) : [emptyMessage];
    let value = '';

    for (const line of lines) {
        const separator = value ? '\n' : '';
        const remaining = FIELD_LIMIT - value.length - separator.length;
        if (remaining <= 0) break;

        if (line.length <= remaining) {
            value += separator + line;
        } else {
            value += separator + `${line.slice(0, Math.max(0, remaining - 1))}…`;
            break;
        }
    }

    return value;
}

function buildEmbed({ version, changes = [], fixes = [], publishedAt = new Date() }) {
    if (typeof version !== 'string' || !version.trim()) {
        throw new TypeError('La versión es obligatoria.');
    }
    if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
        throw new TypeError('La fecha de publicación no es válida.');
    }

    const cleanVersion = version.trim().replace(/^v/i, '');
    const normalizedChanges = normalizeItems(changes, 'Novedades');
    const normalizedFixes = normalizeItems(fixes, 'Correcciones');
    const publishedLabel = new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC'
    }).format(publishedAt);

    return {
        title: `Aurum Accounts v${cleanVersion}`,
        url: `${RELEASES_URL}v${encodeURIComponent(cleanVersion)}`,
        description: '¡Nueva versión disponible!',
        color: EMBED_COLOR,
        fields: [
            { name: '✨ Novedades', value: formatField(normalizedChanges, 'Sin novedades indicadas.'), inline: false },
            { name: '🛠️ Correcciones', value: formatField(normalizedFixes, 'Sin correcciones indicadas.'), inline: false }
        ],
        footer: { text: `Aurum Accounts · Publicado el ${publishedLabel} UTC` },
        timestamp: publishedAt.toISOString()
    };
}

function parseReleaseNotes(body = '') {
    const changes = [];
    const fixes = [];
    let currentSection = changes;

    for (const rawLine of String(body).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const heading = line.match(/^#{1,6}\s+(.+)$/);
        if (heading) {
            currentSection = /\b(fix(?:es|ed)?|bug(?:s)?|correcciones?)\b/i.test(heading[1])
                ? fixes
                : changes;
            continue;
        }

        currentSection.push(line);
    }

    return { changes, fixes };
}

async function sendDiscordChangelog({
    version,
    changes = [],
    fixes = [],
    publishedAt = new Date(),
    webhookUrl = process.env.DISCORD_WEBHOOK_URL
}) {
    if (typeof webhookUrl !== 'string' || !DISCORD_WEBHOOK_URL_PATTERN.test(webhookUrl)) {
        throw new Error('Configura DISCORD_WEBHOOK_URL con una URL válida de webhook de Discord.');
    }

    const embed = buildEmbed({ version, changes, fixes, publishedAt });
    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            embeds: [embed],
            components: [{
                type: 1,
                components: [{
                    type: 5,
                    label: 'Descargar',
                    url: DOWNLOADS_URL
                }]
            }]
        }),
        signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
        throw new Error(`Discord rechazó el webhook (HTTP ${response.status}).`);
    }
}

async function main() {
    const version = process.env.VERSION;
    if (!version) throw new Error('Falta la variable VERSION.');

    const { changes, fixes } = parseReleaseNotes(process.env.RELEASE_BODY || '');
    await sendDiscordChangelog({ version, changes, fixes });
    console.log(`Changelog de Aurum Accounts ${version} enviado a Discord.`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`No se pudo enviar el changelog a Discord: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { buildEmbed, parseReleaseNotes, sendDiscordChangelog };
