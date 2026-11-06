const DISCORD_WEBHOOK_URL_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[^/\s]+(?:\?.*)?$/;
const EMBED_COLOR = 15844367; // Color dorado/amarillo característico de Aurum Accounts
const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4000;
const FIELD_NAME_LIMIT = 256;
const FIELD_LIMIT = 1024;
const EMPTY_SECTION_FALLBACK = 'Mejoras generales y ajustes de estabilidad.';
const RELEASES_URL = 'https://github.com/Dulciiss/aurum-accounts/releases/tag/';
const DOWNLOADS_URL = 'https://dulciiss.github.io/aurum-accounts/#descargar';

function truncateText(value, limit) {
    let text = String(value).trim();
    if (text.length <= limit) return text;

    text = text.slice(0, limit - 1);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return `${text.trimEnd()}…`;
}

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
    const lines = items.length ? items.map((item) => `• ${item}`) : [emptyMessage || EMPTY_SECTION_FALLBACK];
    let value = '';

    for (const line of lines) {
        const separator = value ? '\n' : '';
        const remaining = FIELD_LIMIT - value.length - separator.length;
        if (remaining <= 0) break;

        if (line.length <= remaining) {
            value += separator + line;
        } else {
            value += separator + truncateText(line, remaining);
            break;
        }
    }

    return value.trim() || EMPTY_SECTION_FALLBACK;
}

function validatePayload(payload) {
    const embed = payload && Array.isArray(payload.embeds) && payload.embeds[0];
    if (!embed) throw new TypeError('El payload debe incluir un embed.');
    if (typeof embed.title !== 'string' || !embed.title.trim() || embed.title.length > TITLE_LIMIT) {
        throw new TypeError('El título del embed es obligatorio y debe respetar el límite de Discord.');
    }
    if (typeof embed.description !== 'string' || !embed.description.trim() || embed.description.length > DESCRIPTION_LIMIT) {
        throw new TypeError('La descripción del embed es obligatoria y debe respetar el límite de Discord.');
    }
    if (!Array.isArray(embed.fields) || embed.fields.length > 25) {
        throw new TypeError('Los campos del embed no son válidos.');
    }
    for (const field of embed.fields) {
        if (typeof field.name !== 'string' || !field.name.trim() || field.name.length > FIELD_NAME_LIMIT) {
            throw new TypeError('El nombre de cada campo debe ser texto no vacío y respetar el límite de Discord.');
        }
        if (typeof field.value !== 'string' || !field.value.trim() || field.value.length > FIELD_LIMIT) {
            throw new TypeError('El valor de cada campo debe ser texto no vacío y respetar el límite de Discord.');
        }
    }
}

function buildEmbed({ version, changes = [], fixes = [], publishedAt = new Date() }) {
    if (typeof version !== 'string' || !version.trim()) {
        throw new TypeError('La versión es obligatoria.');
    }
    if (!(publishedAt instanceof Date) || Number.isNaN(publishedAt.getTime())) {
        throw new TypeError('La fecha de publicación no es válida.');
    }

    const cleanVersion = version.trim().replace(/^v/i, '');
    if (!cleanVersion) throw new TypeError('La versión es obligatoria.');
    
    const normalizedChanges = normalizeItems(changes, 'Novedades');
    const normalizedFixes = normalizeItems(fixes, 'Correcciones');

    const publishedLabel = new Intl.DateTimeFormat('es-ES', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC'
    }).format(publishedAt);

    // Estructura bilingüe idéntica a la que pediste con la descripción principal y secciones detalladas
    const descriptionText = `
🇪🇸 **¡Ya está aquí la nueva actualización de Aurum Accounts!** Disfruta de todas las mejoras de estabilidad, optimizaciones y novedades que hemos preparado para esta versión.

🇬🇧 **The new update for Aurum Accounts is finally here!** Enjoy all the stability improvements, optimizations, and new features we have prepared for this release.
    `.trim();

    return {
        username: "Aurum Accounts Support",
        author: {
            name: "Neah",
            url: "https://github.com/Dulciiss",
            icon_url: "https://github.com/Dulciiss.png"
        },
        title: truncateText(`Aurum Accounts v${cleanVersion}`, TITLE_LIMIT),
        url: `${RELEASES_URL}v${encodeURIComponent(cleanVersion)}`,
        description: truncateText(descriptionText, DESCRIPTION_LIMIT),
        color: EMBED_COLOR,
        fields: [
            { 
                name: truncateText('🇪🇸 🚀 Novedades y Características', FIELD_NAME_LIMIT), 
                value: formatField(normalizedChanges, EMPTY_SECTION_FALLBACK), 
                inline: false 
            },
            { 
                name: truncateText('🇬🇧 🚀 What\'s New & Features', FIELD_NAME_LIMIT), 
                value: formatField(normalizedChanges, EMPTY_SECTION_FALLBACK), 
                inline: false 
            },
            { 
                name: truncateText('🛠️ Correcciones y Mejoras Técnicas / Bug Fixes', FIELD_NAME_LIMIT), 
                value: formatField(normalizedFixes, EMPTY_SECTION_FALLBACK), 
                inline: false 
            }
        ],
        footer: { text: `Aurum Accounts • v${cleanVersion} · Publicado el ${publishedLabel} UTC` },
        timestamp: publishedAt.toISOString()
    };
}

function parseReleaseNotes(body = '') {
    const changes = [];
    const fixes = [];
    let currentSection = changes;
    const fixHeadingPattern = /\b(?:fix(?:es|ed)?|bugfix(?:es)?|bug(?:s)?|correcciones?)\b/i;

    for (const rawLine of String(body).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const heading = line.match(/^#{1,6}\s+(.+)$/);
        if (heading) {
            currentSection = fixHeadingPattern.test(heading[1]) ? fixes : changes;
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
    const payload = {
        username: "Aurum Accounts Support",
        embeds: [embed],
        components: [{
            type: 1,
            components: [{
                type: 2,
                style: 5,
                label: 'Descargar / Download',
                url: DOWNLOADS_URL
            }]
        }]
    };

    validatePayload(payload);

    const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Discord rechazó el webhook (HTTP ${response.status}): ${errorText}`);
    }
}

async function main() {
    const version = process.env.VERSION;
    if (!version) throw new Error('Falta la variable VERSION.');

    const { changes, fixes } = parseReleaseNotes(process.env.RELEASE_BODY || '');
    await sendDiscordChangelog({ version, changes, fixes });
    console.log(`Changelog de Aurum Accounts ${version} enviado a Discord con éxito.`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`No se pudo enviar el changelog a Discord: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { buildEmbed, parseReleaseNotes, sendDiscordChangelog };