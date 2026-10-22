require('dotenv').config();
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { YoutubeTranscript } = require('youtube-transcript');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// =====================================================================
// CONFIGURACIÓN
// =====================================================================
const CFG = {
    urlPanel: (process.env.URL_PANEL || 'https://panel-youtube-familia.onrender.com').replace(/\/$/, ''),
    claveWorker: process.env.CLAVE_WORKER || '',

    // Capítulos (la narración final): modelo de calidad.
    modelo: process.env.MODELO_CLAUDE || 'claude-sonnet-5-5',
    // Plan y shorts: puedes poner uno más barato, p. ej. claude-haiku-5-5
    modeloEconomico: process.env.MODELO_ECONOMICO || process.env.MODELO_CLAUDE || 'claude-sonnet-5-5',

    telegram: {
        token: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || ''
    },
    driveUrl: process.env.DRIVE_CARPETA_URL || '',

    intervaloMin: Number(process.env.INTERVALO_MIN || 5),
    duracionMin: Number(process.env.DURACION_MIN || 10),
    shortsPorVideo: Number(process.env.SHORTS_POR_VIDEO || 3),
    palabrasPorMinuto: 145,
    minutosPorCapitulo: 3,
    maxCharsTranscripcion: 60000,

    fps: 30,
    pausaEscena: 0.35,
    concurrenciaRender: Number(process.env.CONCURRENCIA_RENDER || 3),

    imagen: {
        proveedor: (process.env.IMAGEN_PROVEEDOR || 'comfyui').toLowerCase(),
        comfyUrl: process.env.COMFY_URL || 'http://127.0.0.1:8188',
        forgeUrl: process.env.FORGE_URL || 'http://127.0.0.1:7860',
        checkpoint: process.env.COMFY_CHECKPOINT || '',
        pasos: Number(process.env.IMAGEN_PASOS || 28),
        cfg: Number(process.env.IMAGEN_CFG || 6.5),
        negativo: 'text, letters, words, watermark, logo, signature, blurry, low quality, deformed, extra fingers, bad anatomy, modern clothing, cartoon'
    }
};

const FORMATOS = {
    horizontal: {
        ancho: 1920, alto: 1080, imgAncho: 1344, imgAlto: 768,
        fuente: 62, outline: 4, margenH: 120, margenV: 70, palabrasSub: 6, colorSub: '&H00FFFFFF'
    },
    vertical: {
        ancho: 1080, alto: 1920, imgAncho: 768, imgAlto: 1344,
        fuente: 84, outline: 5, margenH: 80, margenV: 560, palabrasSub: 4, colorSub: '&H0000FFFF'
    }
};

const DIR = {
    cache: path.join(__dirname, 'cache'),
    transcripciones: path.join(__dirname, 'cache', 'transcripciones'),
    guiones: path.join(__dirname, 'cache', 'guiones'),
    audio: path.join(__dirname, 'cache', 'audio'),
    imagenes: path.join(__dirname, 'cache', 'imagenes'),
    trabajo: path.join(__dirname, 'trabajo'),
    // Si usas Google Drive para escritorio, apunta SALIDA_DIR a una carpeta sincronizada
    salida: process.env.SALIDA_DIR || path.join(__dirname, 'salida'),
    musica: path.join(__dirname, 'musica')
};

// Nichos: definen audiencia, tono, voz por defecto y estilo visual
const NICHOS = {
    misterio: {
        audiencia: 'personas mayores de 50 años de habla hispana, apasionadas por los misterios históricos, la arqueología prohibida y los enigmas sin resolver',
        tono: 'misterio, intriga y respeto, similar a los documentales clásicos',
        voz: 'es-MX-JorgeNeural',
        estilo: 'cinematic dramatic lighting, moody atmosphere, volumetric fog, ancient, oil painting style, highly detailed, dark tones'
    },
    historia: {
        audiencia: 'adultos de habla hispana interesados en historia universal y grandes personajes',
        tono: 'narrativo, riguroso y apasionante, como un buen documental histórico',
        voz: 'es-ES-AlvaroNeural',
        estilo: 'epic historical painting, realistic, warm cinematic lighting, highly detailed, museum quality'
    },
    ciencia: {
        audiencia: 'público curioso de habla hispana que disfruta la divulgación científica',
        tono: 'claro, entusiasta y sorprendente, sin tecnicismos innecesarios',
        voz: 'es-MX-DaliaNeural',
        estilo: 'clean cinematic illustration, vivid colors, dramatic lighting, highly detailed, sharp focus'
    }
};

// Canales: se leen de canales.json (el mismo archivo que usa el panel).
// Campos: id, nombre, nicho y, opcional, "voz" para sobrescribir la voz del nicho.
function cargarCanales() {
    let lista;
    try {
        lista = JSON.parse(fsSync.readFileSync(path.join(__dirname, 'canales.json'), 'utf-8'));
    } catch (e) {
        throw new Error(`No se pudo leer canales.json: ${e.message}`);
    }
    for (const c of lista) {
        if (!c.id || !NICHOS[c.nicho]) {
            throw new Error(`Canal inválido en canales.json: ${JSON.stringify(c)}. Nichos disponibles: ${Object.keys(NICHOS).join(', ')}`);
        }
    }
    return lista;
}
const CANALES = cargarCanales();

let usarGPU = !process.env.FORZAR_CPU;
const CLIENT_ID = crypto.randomUUID();

// Contador de tokens del proyecto en curso
const USO = { entrada: 0, cacheLeida: 0, cacheEscrita: 0, salida: 0 };
function reiniciarUso() { USO.entrada = 0; USO.cacheLeida = 0; USO.cacheEscrita = 0; USO.salida = 0; }

// =====================================================================
// UTILIDADES
// =====================================================================
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const dormir = (ms) => new Promise(r => setTimeout(r, ms));

async function existe(ruta) {
    try { await fs.access(ruta); return true; } catch { return false; }
}

async function crearCarpetas() {
    for (const d of Object.values(DIR)) await fs.mkdir(d, { recursive: true });
}

function extraerIdVideo(url) {
    const m = url.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
    return m ? m[1] : hash(url);
}

function slug(texto) {
    return String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'proyecto';
}

function decodificarEntidades(t) {
    return t
        .replace(/&amp;#39;|&#39;/g, "'")
        .replace(/&amp;quot;|&quot;/g, '"')
        .replace(/&amp;amp;|&amp;/g, '&')
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
        .replace(/\[(Music|Applause|Música|Aplausos)\]/gi, '')
        .replace(/\s+/g, ' ').trim();
}

async function enParalelo(tareas, limite) {
    const resultados = new Array(tareas.length);
    let siguiente = 0;
    async function obrero() {
        while (true) {
            const k = siguiente++;
            if (k >= tareas.length) return;
            resultados[k] = await tareas[k]();
        }
    }
    await Promise.all(Array.from({ length: Math.min(limite, tareas.length) }, obrero));
    return resultados;
}

function ejecutarFfmpeg(args, cwd) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], { cwd: cwd || __dirname });
        let err = '';
        p.stderr.on('data', d => { err += d.toString(); });
        p.on('error', reject);
        p.on('close', code => {
            if (code === 0) resolve(err);
            else reject(new Error(`ffmpeg falló (código ${code}):\n${err.slice(-900)}`));
        });
    });
}

async function duracionAudio(ruta) {
    const salida = await new Promise((resolve) => {
        const p = spawn(ffmpegPath, ['-hide_banner', '-i', ruta]);
        let err = '';
        p.stderr.on('data', d => { err += d.toString(); });
        p.on('close', () => resolve(err));
    });
    const m = salida.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
    if (!m) throw new Error(`No se pudo leer la duración de ${ruta}`);
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function detectarGPU() {
    if (!usarGPU) return;
    try {
        const salida = await new Promise((resolve) => {
            const p = spawn(ffmpegPath, ['-hide_banner', '-encoders']);
            let out = '';
            p.stdout.on('data', d => { out += d.toString(); });
            p.on('close', () => resolve(out));
        });
        if (!salida.includes('h264_nvenc')) {
            usarGPU = false;
            console.log('[Sistema] ⚠️ Este ffmpeg no incluye NVENC. Se usará CPU (libx264).');
            console.log('          Instala un ffmpeg "full" y define FFMPEG_PATH en .env para usar tu GPU.');
        } else {
            console.log('[Sistema] 🟢 NVENC disponible: el render usará tu GPU.');
        }
    } catch {
        usarGPU = false;
    }
}

function argsCodecVideo() {
    return usarGPU
        ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];
}

async function ejecutarRender(construirArgs, cwd) {
    try {
        await ejecutarFfmpeg(construirArgs(), cwd);
    } catch (e) {
        if (!usarGPU) throw e;
        console.log('[Sistema] ⚠️ NVENC falló, cambiando a CPU para el resto del proceso.');
        usarGPU = false;
        await ejecutarFfmpeg(construirArgs(), cwd);
    }
}

// --- JSON con auto-reparación ---
// Si la respuesta quedó cortada, descarta el fragmento incompleto y cierra las estructuras
// justo después de la última escena completa (no deja frases a medias).
function repararJSON(crudo) {
    const ini = crudo.indexOf('{');
    if (ini === -1) throw new Error('La respuesta no contiene JSON.');
    let texto = crudo.slice(ini);
    const fin = texto.lastIndexOf('}');
    if (fin === -1) throw new Error('No hay JSON recuperable.');
    texto = texto.slice(0, fin + 1);
    for (const cierre of ['', ']}', ']}]}']) {
        try { return JSON.parse(texto + cierre); } catch { /* prueba el siguiente cierre */ }
    }
    throw new Error('El JSON está dañado y no se pudo reparar.');
}

function extraerJSON(crudo) {
    const ini = crudo.indexOf('{');
    const fin = crudo.lastIndexOf('}');
    if (ini === -1 || fin === -1) throw new Error('La respuesta no contiene JSON.');
    try {
        return JSON.parse(crudo.slice(ini, fin + 1));
    } catch {
        const datos = repararJSON(crudo);
        console.log('[Guionista] 🩹 La respuesta venía incompleta: se descartó el fragmento final y se rescató el resto.');
        return datos;
    }
}

function contarPalabras(texto) {
    return texto.trim().split(/\s+/).filter(Boolean).length;
}

// =====================================================================
// COMUNICACIÓN CON EL PANEL
// =====================================================================
async function pedirCola() {
    for (let intento = 1; intento <= 4; intento++) {
        try {
            const r = await fetch(`${CFG.urlPanel}/api/obtener-cola`, { headers: { 'x-clave': CFG.claveWorker } });
            if (r.status === 401 || r.status === 503) {
                const e = new Error(`El panel rechazó la clave (HTTP ${r.status}). Revisa que CLAVE_WORKER sea igual en .env y en Render.`);
                e.fatal = true;
                throw e;
            }
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (e) {
            if (e.fatal || intento === 4) throw e;
            console.log(`[Sistema] ⏳ El panel no responde (${e.message}). Reintentando en 20 s (puede estar despertando)...`);
            await dormir(20000);
        }
    }
}

// Devuelve una función que informa el avance al panel (con límite de frecuencia)
function crearReportero(proyecto) {
    let ultimo = 0;
    return async (datos, forzar = false) => {
        const ahora = Date.now();
        if (!forzar && ahora - ultimo < 4000) return;
        ultimo = ahora;
        try {
            await fetch(`${CFG.urlPanel}/api/actualizar/${proyecto.id}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-clave': CFG.claveWorker },
                body: JSON.stringify(datos)
            });
        } catch { /* no es crítico */ }
    };
}

async function avisarTelegram(texto) {
    const { token, chatId } = CFG.telegram;
    if (!token || !chatId) return;
    try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: texto })
        });
        if (!r.ok) console.log(`[Sistema] ⚠️ Telegram respondió HTTP ${r.status}. Revisa el token y el chat id.`);
    } catch (e) {
        console.log(`[Sistema] ⚠️ No se pudo avisar por Telegram: ${e.message}`);
    }
}

// =====================================================================
// HISTORIAL LOCAL (anti-repetición por canal)
// =====================================================================
const ARCHIVO_HISTORIAL = path.join(DIR.cache, 'historial.json');

async function leerHistorial() {
    try { return JSON.parse(await fs.readFile(ARCHIVO_HISTORIAL, 'utf-8')); } catch { return []; }
}

async function registrarHistorial(entrada) {
    const h = await leerHistorial();
    h.push(entrada);
    await fs.writeFile(ARCHIVO_HISTORIAL, JSON.stringify(h, null, 1), 'utf-8');
}

async function temasPrevios(canalId) {
    const h = await leerHistorial();
    return h.filter(x => x.canal === canalId).slice(-40).map(x => x.titulo_youtube || x.titulo);
}

// =====================================================================
// AGENTE CAZADOR: subtítulos de YouTube (con caché)
// =====================================================================
async function obtenerTranscripcion(url, idVideo) {
    const archivo = path.join(DIR.transcripciones, `${idVideo}.txt`);
    if (await existe(archivo)) {
        console.log('[Cazador] ♻️ Transcripción ya descargada, reutilizando.');
        return fs.readFile(archivo, 'utf-8');
    }
    console.log(`[Cazador] 🕵️‍♂️ Extrayendo subtítulos de: ${url}`);
    let texto;
    try {
        const transcript = await YoutubeTranscript.fetchTranscript(url);
        texto = decodificarEntidades(transcript.map(t => t.text).join(' '));
    } catch (error) {
        throw new Error('No se pudieron extraer los subtítulos (quizás el video no tiene CC).');
    }
    await fs.writeFile(archivo, texto, 'utf-8');
    return texto;
}

// =====================================================================
// AGENTE GUIONISTA: plan + capítulos + shorts (todo con caché)
// =====================================================================
function promptSistema(nicho) {
    return `Eres un guionista experto en YouTube. Tu audiencia son ${nicho.audiencia}.
Escribes en español neutro con un tono de ${nicho.tono}.

Reglas permanentes de contenido:
- Reescribe con tus propias palabras; nunca copies frases del material original.
- Elimina promociones, saludos y "paja" del youtuber original.
- No inventes datos, fechas, cifras ni citas. Si el material no alcanza, completa con contexto histórico o científico ampliamente aceptado y presenta lo incierto como hipótesis ("según algunas teorías...").
- La narración es SOLO texto para decir en voz alta: sin títulos, asteriscos ni acotaciones.

Reglas de retención (que la gente no se vaya):
- Frases cortas y ritmo variado: alterna datos concretos con momentos de tensión.
- Abre bucles de curiosidad ("pero lo más extraño aún estaba por venir") y ciérralos más adelante.
- Cada minuto o dos, incluye un giro, una pregunta o un dato sorprendente.
- Evita el lenguaje robótico y las muletillas: "en este video", "sin más preámbulos", "es importante destacar", "en conclusión", "cabe mencionar".

Reglas de imagen:
- Los "prompt_imagen" van en INGLÉS, describen una escena visual concreta (lugar, objetos, luz, ambiente) en 20 a 40 palabras, sin texto ni letras en la imagen y sin rostros reconocibles de personas reales.

Respondes ÚNICAMENTE con JSON válido, sin texto adicional ni bloques de código.`;
}

async function llamarClaude({ modelo, nicho, contexto, instruccion, maxTokens }) {
    const contenido = contexto ? [contexto, { type: 'text', text: instruccion }] : instruccion;
    const respuesta = await anthropic.messages.create({
        model: modelo,
        max_tokens: maxTokens,
        system: promptSistema(nicho),
        messages: [{ role: 'user', content: contenido }]
    });
    const crudo = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!crudo) throw new Error(`Claude no devolvió texto (stop_reason: ${respuesta.stop_reason})`);
    if (respuesta.stop_reason === 'max_tokens') {
        console.log('[Guionista] ⚠️ La respuesta llegó al límite de tokens; se intentará rescatar lo completo.');
    }
    const u = respuesta.usage || {};
    USO.entrada += u.input_tokens || 0;
    USO.cacheLeida += u.cache_read_input_tokens || 0;
    USO.cacheEscrita += u.cache_creation_input_tokens || 0;
    USO.salida += u.output_tokens || 0;
    console.log(`          (${modelo} | entrada: ${u.input_tokens || 0} | caché leída: ${u.cache_read_input_tokens || 0} | salida: ${u.output_tokens || 0})`);
    return crudo;
}

// Lee de caché o genera y guarda ANTES de interpretar (así nunca se paga dos veces)
async function jsonConCache(archivo, generar, validar) {
    let crudo;
    if (await existe(archivo)) {
        crudo = await fs.readFile(archivo, 'utf-8');
    } else {
        crudo = await generar();
        await fs.writeFile(archivo, crudo, 'utf-8');
    }
    try {
        const datos = extraerJSON(crudo);
        validar(datos);
        return datos;
    } catch (e) {
        throw new Error(`${e.message} Corrige o borra este archivo: ${archivo}`);
    }
}

function validarEscenas(escenas) {
    if (!Array.isArray(escenas) || escenas.length === 0) throw new Error('No hay escenas.');
    for (const e of escenas) {
        if (typeof e.narracion !== 'string' || !e.narracion.trim()) throw new Error('Hay una escena sin narración.');
        e.prompt_imagen = e.prompt_imagen || 'mysterious ancient landscape, dramatic sky';
    }
}

async function obtenerGuion(proyecto, canal, nicho, idVideo, minutos) {
    const clave = `${idVideo}_${canal.id}_${minutos}m`;
    const numCaps = Math.max(1, Math.round(minutos / CFG.minutosPorCapitulo));
    const palabrasCap = Math.round((minutos * CFG.palabrasPorMinuto) / numCaps);

    let contexto = null;
    const getContexto = async () => {
        if (contexto) return contexto;
        let texto = await obtenerTranscripcion(proyecto.url, idVideo);
        if (texto.length > CFG.maxCharsTranscripcion) texto = texto.slice(0, CFG.maxCharsTranscripcion);
        contexto = {
            type: 'text',
            text: `MATERIAL DE REFERENCIA (transcripción en inglés del video "${proyecto.titulo}"):\n${texto}`,
            cache_control: { type: 'ephemeral' }
        };
        return contexto;
    };

    // --- 1) Plan ---
    const plan = await jsonConCache(
        path.join(DIR.guiones, `${clave}_plan.json`),
        async () => {
            console.log(`[Guionista] 🗺️ Planificando video de ${minutos} min en ${numCaps} capítulos para "${canal.nombre}"...`);
            const previos = await temasPrevios(canal.id);
            const bloquePrevios = previos.length
                ? `\nVideos ya producidos en este canal (no repitas el mismo enfoque ni títulos parecidos):\n${previos.map(t => '- ' + t).join('\n')}\n`
                : '';
            return llamarClaude({
                modelo: CFG.modeloEconomico, nicho, contexto: await getContexto(), maxTokens: 3000,
                instruccion: `Planifica un video de ${minutos} minutos basado en el material de referencia, dividido en EXACTAMENTE ${numCaps} capítulos.
El primer capítulo debe abrir con un gancho espectacular y el último cerrar de forma memorable.
${bloquePrevios}
Responde con este JSON:
{
  "titulo_youtube": "título atractivo en español",
  "descripcion": "descripción de 2 a 3 líneas",
  "etiquetas": ["etiqueta1", "etiqueta2"],
  "capitulos": [ { "titulo": "...", "resumen": "2 a 3 oraciones con los puntos que debe cubrir" } ]
}`
            });
        },
        (d) => { if (!Array.isArray(d.capitulos) || d.capitulos.length === 0) throw new Error('El plan no trae capítulos.'); }
    );

    // --- 2) Capítulos ---
    const escenas = [];
    const total = plan.capitulos.length;
    for (let i = 0; i < total; i++) {
        const cap = await jsonConCache(
            path.join(DIR.guiones, `${clave}_cap${String(i + 1).padStart(2, '0')}.json`),
            async () => {
                console.log(`[Guionista] ✍️ Escribiendo capítulo ${i + 1}/${total}: ${plan.capitulos[i].titulo}`);
                const previo = escenas.slice(-2).map(e => e.narracion).join(' ');
                return llamarClaude({
                    modelo: CFG.modelo, nicho, contexto: await getContexto(), maxTokens: 8000,
                    instruccion: `PLAN COMPLETO DEL VIDEO:
${JSON.stringify(plan.capitulos, null, 1)}

Escribe AHORA solo el capítulo ${i + 1} de ${total}: "${plan.capitulos[i].titulo}".
- Longitud: entre ${palabrasCap} y ${Math.round(palabrasCap * 1.2)} palabras de narración en total, sin pasarte.
- ${i === 0 ? 'Empieza con un gancho espectacular en los primeros 15 segundos.' : 'Continúa con naturalidad, sin saludar ni repetir la introducción. Viene después de: "' + previo + '"'}
- ${i === total - 1 ? 'Este es el último capítulo: cierra de forma memorable.' : 'No cierres la historia: deja la tensión abierta para el siguiente capítulo.'}
- Divide en escenas de 1 a 3 oraciones (30 a 50 palabras cada una).

JSON:
{ "escenas": [ { "narracion": "texto", "prompt_imagen": "english visual description" } ] }`
                });
            },
            (d) => validarEscenas(d.escenas)
        );
        escenas.push(...cap.escenas);
    }

    const palabras = escenas.reduce((a, e) => a + contarPalabras(e.narracion), 0);
    console.log(`[Guionista] 📜 ${escenas.length} escenas, ${palabras} palabras (≈ ${(palabras / CFG.palabrasPorMinuto).toFixed(1)} min).`);

    return { titulo_youtube: plan.titulo_youtube, descripcion: plan.descripcion, etiquetas: plan.etiquetas, escenas, clave };
}

async function obtenerShorts(guion, nicho, cantidad) {
    const datos = await jsonConCache(
        path.join(DIR.guiones, `${guion.clave}_shorts${cantidad}.json`),
        async () => {
            console.log(`[Guionista] 📱 Escribiendo ${cantidad} shorts...`);
            const narracion = guion.escenas.map(e => e.narracion).join('\n');
            return llamarClaude({
                modelo: CFG.modeloEconomico, nicho, contexto: null, maxTokens: 8000,
                instruccion: `Este es el guion completo de un video largo:

${narracion}

Crea ${cantidad} guiones de YouTube Shorts (vertical), cada uno sobre un momento o dato DISTINTO y atractivo del video.
Reglas:
- Cada short dura unos 45 a 55 segundos (≈ 120 a 135 palabras en total).
- Debe funcionar solo, sin haber visto el video: abre con un gancho fuerte en la primera frase y termina con una pregunta o invitación a ver el video completo.
- Divide en 7 a 9 escenas de 14 a 20 palabras.

JSON:
{ "shorts": [ { "titulo": "título corto con gancho", "descripcion": "1 línea", "escenas": [ { "narracion": "texto", "prompt_imagen": "english visual description" } ] } ] }`
            });
        },
        (d) => {
            if (!Array.isArray(d.shorts) || d.shorts.length === 0) throw new Error('No hay shorts.');
            d.shorts.forEach(s => validarEscenas(s.escenas));
        }
    );
    return datos.shorts.slice(0, cantidad);
}

// =====================================================================
// AGENTE LOCUTOR: voz por escena (con caché)
// =====================================================================
function limpiarTextoParaVoz(texto) {
    return texto.replace(/[*_#`>~]/g, '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}

async function sintetizar(texto, voz) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voz, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const resultado = await tts.toStream(texto);
    const stream = resultado.audioStream || resultado; // compatible con msedge-tts v1 y v2
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function audioDeEscena(texto, voz) {
    const limpio = limpiarTextoParaVoz(texto);
    const archivo = path.join(DIR.audio, `${hash(voz + '|' + limpio)}.mp3`);
    if (await existe(archivo)) return archivo;

    for (let intento = 1; intento <= 3; intento++) {
        try {
            const buffer = await sintetizar(limpio, voz);
            if (buffer.length < 1000) throw new Error('Audio vacío');
            await fs.writeFile(archivo, buffer);
            return archivo;
        } catch (e) {
            if (intento === 3) throw new Error(`Falló la voz: ${e.message}`);
            await dormir(1500 * intento);
        }
    }
}

// =====================================================================
// AGENTE PINTOR: imágenes con IA en tu GPU (ComfyUI o Forge/A1111)
// =====================================================================
let imagenIAverificada = false;

async function verificarImagenIA() {
    if (imagenIAverificada) return;
    const I = CFG.imagen;

    if (I.proveedor === 'forge') {
        try {
            const r = await fetch(`${I.forgeUrl}/sdapi/v1/options`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
        } catch (e) {
            throw new Error(`No se pudo conectar con Forge/A1111 en ${I.forgeUrl} (${e.message}). Ábrelo con el argumento --api.`);
        }
    } else {
        let datos;
        try {
            const r = await fetch(`${I.comfyUrl}/object_info/CheckpointLoaderSimple`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            datos = await r.json();
        } catch (e) {
            throw new Error(`No se pudo conectar con ComfyUI en ${I.comfyUrl} (${e.message}). Abre ComfyUI antes de ejecutar el worker.`);
        }
        const lista = datos?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
        if (lista.length === 0) {
            throw new Error('ComfyUI no tiene modelos. Copia un checkpoint SDXL (.safetensors) en ComfyUI/models/checkpoints y reinicia ComfyUI.');
        }
        if (!I.checkpoint) {
            I.checkpoint = lista[0];
            console.log(`[Pintor] ℹ️ COMFY_CHECKPOINT no definido, se usará: ${I.checkpoint}`);
        } else if (!lista.includes(I.checkpoint)) {
            throw new Error(`El checkpoint "${I.checkpoint}" no existe en ComfyUI. Disponibles: ${lista.join(', ')}`);
        }
    }
    console.log(`[Pintor] 🟢 Generador de imágenes listo (${I.proveedor}).`);
    imagenIAverificada = true;
}

async function imagenComfy(prompt, semilla, formato) {
    const I = CFG.imagen;
    const flujo = {
        '3': { class_type: 'KSampler', inputs: { seed: semilla, steps: I.pasos, cfg: I.cfg, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
        '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: I.checkpoint } },
        '5': { class_type: 'EmptyLatentImage', inputs: { width: formato.imgAncho, height: formato.imgAlto, batch_size: 1 } },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: I.negativo, clip: ['4', 1] } },
        '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
        '9': { class_type: 'PreviewImage', inputs: { images: ['8', 0] } }
    };

    const r = await fetch(`${I.comfyUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: flujo, client_id: CLIENT_ID })
    });
    if (!r.ok) throw new Error(`ComfyUI rechazó el flujo: ${(await r.text()).slice(0, 300)}`);
    const { prompt_id } = await r.json();

    const limite = Date.now() + 5 * 60 * 1000;
    while (Date.now() < limite) {
        await dormir(800);
        const h = await (await fetch(`${I.comfyUrl}/history/${prompt_id}`)).json();
        const item = h[prompt_id];
        if (!item) continue;
        if (item.status && item.status.status_str === 'error') throw new Error('ComfyUI reportó un error al generar.');
        const img = Object.values(item.outputs || {}).flatMap(o => o.images || [])[0];
        if (img) {
            const v = await fetch(`${I.comfyUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || '')}&type=${encodeURIComponent(img.type || 'temp')}`);
            if (!v.ok) throw new Error(`No se pudo descargar la imagen (HTTP ${v.status})`);
            return Buffer.from(await v.arrayBuffer());
        }
    }
    throw new Error('Tiempo agotado esperando a ComfyUI.');
}

async function imagenForge(prompt, semilla, formato) {
    const I = CFG.imagen;
    const r = await fetch(`${I.forgeUrl}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            prompt, negative_prompt: I.negativo, steps: I.pasos, cfg_scale: I.cfg,
            width: formato.imgAncho, height: formato.imgAlto, seed: semilla, sampler_name: 'DPM++ 2M Karras'
        })
    });
    if (!r.ok) throw new Error(`Forge respondió HTTP ${r.status}`);
    const datos = await r.json();
    if (!datos.images || !datos.images[0]) throw new Error('Forge no devolvió imagen.');
    return Buffer.from(datos.images[0], 'base64');
}

async function generarImagen(promptEscena, nicho, formato) {
    const I = CFG.imagen;
    const prompt = `${promptEscena}, ${nicho.estilo}`;
    const archivo = path.join(DIR.imagenes, `${hash([prompt, formato.imgAncho, formato.imgAlto, I.proveedor, I.checkpoint].join('|'))}.png`);
    if (await existe(archivo)) return archivo;

    const semilla = parseInt(hash(prompt).slice(0, 8), 16);
    let ultimoError;
    for (let intento = 1; intento <= 3; intento++) {
        try {
            const buffer = I.proveedor === 'forge'
                ? await imagenForge(prompt, semilla, formato)
                : await imagenComfy(prompt, semilla, formato);
            await fs.writeFile(archivo, buffer);
            return archivo;
        } catch (e) {
            ultimoError = e;
            console.log(`[Pintor] ⚠️ Intento ${intento}/3 falló: ${e.message}`);
            await dormir(2000 * intento);
        }
    }
    throw new Error(`No se pudo generar la imagen: ${ultimoError.message}`);
}

// =====================================================================
// AGENTE EDITOR: clips, subtítulos, música y render final
// =====================================================================
async function renderizarEscena({ imagen, audio, duracion, indice, carpeta, formato }) {
    const nombre = `escena_${String(indice).padStart(3, '0')}.mp4`;
    const destino = path.join(carpeta, nombre);
    if (await existe(destino)) return nombre;

    const par = (n) => Math.round(n / 2) * 2;
    const W = formato.ancho, H = formato.alto;
    const frames = Math.max(1, Math.round(duracion * CFG.fps));
    const paso = (0.18 / frames).toFixed(6);
    const zoom = indice % 2 === 0
        ? `min(zoom+${paso},1.18)`
        : `if(eq(on,0),1.18,max(zoom-${paso},1.0))`;
    const fade = 0.4;

    const filtro = [
        `scale=${par(W * 1.4)}:${par(H * 1.4)}:force_original_aspect_ratio=increase`,
        `crop=${par(W * 1.4)}:${par(H * 1.4)}`,
        `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${CFG.fps}`,
        `fade=t=in:st=0:d=${fade}`,
        `fade=t=out:st=${Math.max(0, duracion - fade).toFixed(2)}:d=${fade}`,
        'format=yuv420p'
    ].join(',');

    const temporal = path.join(carpeta, `tmp_${nombre}`);
    await ejecutarRender(() => [
        '-i', imagen, '-i', audio,
        '-vf', filtro,
        '-af', 'apad',
        '-t', duracion.toFixed(3),
        ...argsCodecVideo(),
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        '-r', String(CFG.fps),
        temporal
    ]);
    await fs.rename(temporal, destino);
    return nombre;
}

function formatoTiempoAss(seg) {
    const cs = Math.round(seg * 100);
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function generarSubtitulosAss(escenas, formato) {
    const cabecera = `[Script Info]
ScriptType: v4.00+
PlayResX: ${formato.ancho}
PlayResY: ${formato.alto}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${formato.fuente},${formato.colorSub},&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${formato.outline},1,2,${formato.margenH},${formato.margenH},${formato.margenV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const lineas = [];
    let inicioEscena = 0;

    for (const esc of escenas) {
        const palabras = esc.narracion.replace(/\s+/g, ' ').trim().split(' ');
        const trozos = [];
        for (let i = 0; i < palabras.length; i += formato.palabrasSub) {
            trozos.push(palabras.slice(i, i + formato.palabrasSub).join(' '));
        }
        const totalCaracteres = trozos.reduce((a, t) => a + t.length, 0);
        const tiempoVoz = esc.duracion - CFG.pausaEscena;
        let t = inicioEscena;

        for (const trozo of trozos) {
            const dur = tiempoVoz * (trozo.length / totalCaracteres);
            const texto = trozo.replace(/[{}]/g, '').replace(/\\/g, '');
            lineas.push(`Dialogue: 0,${formatoTiempoAss(t)},${formatoTiempoAss(t + dur)},Default,,0,0,0,,${texto}`);
            t += dur;
        }
        inicioEscena += esc.duracion;
    }
    return cabecera + lineas.join('\n') + '\n';
}

async function elegirMusica(nichoKey) {
    for (const carpeta of [path.join(DIR.musica, nichoKey), DIR.musica]) {
        try {
            const archivos = (await fs.readdir(carpeta)).filter(f => /\.(mp3|wav|m4a|ogg)$/i.test(f));
            if (archivos.length) return path.join(carpeta, archivos[Math.floor(Math.random() * archivos.length)]);
        } catch { /* la carpeta no existe */ }
    }
    return null;
}

async function ensamblarVideo({ clips, escenas, carpeta, nichoKey, destinoFinal, formato }) {
    await fs.writeFile(path.join(carpeta, 'lista.txt'), clips.map(c => `file '${c}'`).join('\n'), 'utf-8');
    await ejecutarFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'lista.txt', '-c', 'copy', 'union.mp4'], carpeta);

    await fs.writeFile(path.join(carpeta, 'subs.ass'), generarSubtitulosAss(escenas, formato), 'utf-8');
    const musica = await elegirMusica(nichoKey);

    if (musica) {
        console.log(`[Editor] 🎵 Música de fondo: ${path.basename(musica)}`);
        await ejecutarRender(() => [
            '-i', 'union.mp4',
            '-stream_loop', '-1', '-i', musica,
            '-filter_complex',
            '[0:v]subtitles=subs.ass[v];[1:a]volume=0.10[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]',
            '-map', '[v]', '-map', '[a]',
            ...argsCodecVideo(),
            '-c:a', 'aac', '-b:a', '192k',
            '-movflags', '+faststart',
            'final.mp4'
        ], carpeta);
    } else {
        await ejecutarRender(() => [
            '-i', 'union.mp4',
            '-vf', 'subtitles=subs.ass',
            ...argsCodecVideo(),
            '-c:a', 'copy',
            '-movflags', '+faststart',
            'final.mp4'
        ], carpeta);
    }
    await fs.copyFile(path.join(carpeta, 'final.mp4'), destinoFinal);
}

// Produce una pieza completa (video largo o short). onProgreso(fracción 0..1, texto)
async function producirPieza({ etiqueta, escenas, formato, nicho, nichoKey, carpeta, destinoFinal, onProgreso }) {
    await fs.mkdir(carpeta, { recursive: true });
    const total = escenas.length;
    const avisar = (f, txt) => { if (onProgreso) onProgreso(f, `${etiqueta}: ${txt}`); };

    // 1) Voz
    console.log(`[Locutor] 🎙️ ${etiqueta}: grabando ${total} escenas...`);
    avisar(0.02, 'narrando');
    const audios = await enParalelo(escenas.map(e => async () => {
        const audio = await audioDeEscena(e.narracion, nicho.voz);
        e.duracion = (await duracionAudio(audio)) + CFG.pausaEscena;
        return audio;
    }), 2);
    const segundos = escenas.reduce((a, e) => a + e.duracion, 0);
    console.log(`[Locutor] ⏱️ Duración real de la narración: ${(segundos / 60).toFixed(1)} min`);
    avisar(0.12, 'narración lista');

    // 2) Imágenes con IA
    const imagenes = [];
    for (let i = 0; i < total; i++) {
        console.log(`[Pintor] 🎨 ${etiqueta}: imagen ${i + 1}/${total}`);
        if (i % 3 === 0) avisar(0.12 + 0.58 * (i / total), `imagen ${i + 1}/${total}`);
        imagenes.push(await generarImagen(escenas[i].prompt_imagen, nicho, formato));
    }

    // 3) Clips en paralelo
    let hechos = 0;
    const clips = await enParalelo(escenas.map((e, i) => async () => {
        const clip = await renderizarEscena({ imagen: imagenes[i], audio: audios[i], duracion: e.duracion, indice: i, carpeta, formato });
        hechos++;
        if (hechos % 10 === 0 || hechos === total) {
            console.log(`[Editor] 🎬 ${etiqueta}: clips ${hechos}/${total}`);
            avisar(0.70 + 0.22 * (hechos / total), `clips ${hechos}/${total}`);
        }
        return clip;
    }), CFG.concurrenciaRender);

    // 4) Ensamblado
    console.log(`[Editor] 🎞️ ${etiqueta}: ensamblando...`);
    avisar(0.95, 'ensamblando');
    await ensamblarVideo({ clips, escenas, carpeta, nichoKey, destinoFinal, formato });
    await fs.rm(carpeta, { recursive: true, force: true });
    console.log(`[Sistema] ✅ ${etiqueta} listo: ${destinoFinal}`);
}

// =====================================================================
// AGENTE CAPATAZ
// =====================================================================
async function escribirInfo(carpetaProyecto, info) {
    await fs.writeFile(path.join(carpetaProyecto, 'info.json'), JSON.stringify(info, null, 2), 'utf-8');
}

async function producirVideo(proyecto, reportar) {
    const canal = CANALES.find(c => c.id === proyecto.canal);
    if (!canal) {
        throw new Error(`El canal "${proyecto.canal}" no existe en canales.json. Disponibles: ${CANALES.map(c => c.id).join(', ')}`);
    }
    const nichoKey = canal.nicho;
    const nicho = { ...NICHOS[nichoKey], voz: canal.voz || NICHOS[nichoKey].voz };
    const idVideo = extraerIdVideo(proyecto.url);

    const minutos = Math.min(60, Math.max(1, Number(proyecto.duracion) || CFG.duracionMin));
    const cantidadShorts = proyecto.shorts !== undefined && proyecto.shorts !== null
        ? Math.max(0, Math.min(10, Number(proyecto.shorts) || 0))
        : CFG.shortsPorVideo;

    // Carpeta final: <SALIDA>/<canal>/<id>_<titulo>/
    const nombreCarpeta = `${proyecto.id}_${slug(proyecto.titulo)}`;
    const carpetaProyecto = path.join(DIR.salida, canal.id, nombreCarpeta);
    await fs.mkdir(carpetaProyecto, { recursive: true });
    const rutaVideo = path.join(carpetaProyecto, 'Video.mp4');
    const rutaShort = (n) => path.join(carpetaProyecto, `Short_${n}.mp4`);

    const videoListo = await existe(rutaVideo);
    let shortsListos = true;
    for (let n = 1; n <= cantidadShorts; n++) if (!(await existe(rutaShort(n)))) shortsListos = false;

    if (videoListo && shortsListos) {
        console.log('[Sistema] ✅ Este proyecto ya estaba producido por completo.');
        await reportar({ estado: 'listo', progreso: 100, mensaje: 'Ya estaba producido', drive_url: CFG.driveUrl }, true);
        return;
    }

    await verificarImagenIA();

    console.log(`[Sistema] 🎯 Canal: ${canal.nombre} (${nichoKey}) | Duración objetivo: ${minutos} min | Shorts: ${cantidadShorts}`);
    await reportar({ estado: 'produciendo', progreso: 3, mensaje: 'Escribiendo el guion' }, true);

    const guion = await obtenerGuion(proyecto, canal, nicho, idVideo, minutos);
    await reportar({ progreso: 5, mensaje: `Guion listo (${guion.escenas.length} escenas)`, titulo_youtube: guion.titulo_youtube }, true);

    const info = {
        canal: canal.id,
        proyecto: proyecto.titulo,
        referencia: proyecto.url,
        video: { titulo: guion.titulo_youtube, descripcion: guion.descripcion, etiquetas: guion.etiquetas },
        shorts: []
    };
    await escribirInfo(carpetaProyecto, info);

    const archivos = [];
    const hayShorts = cantidadShorts > 0;
    const tramoVideo = hayShorts ? 60 : 90;

    // --- Video largo ---
    if (!videoListo) {
        await producirPieza({
            etiqueta: 'Video', escenas: guion.escenas, formato: FORMATOS.horizontal,
            nicho, nichoKey, carpeta: path.join(DIR.trabajo, String(proyecto.id)), destinoFinal: rutaVideo,
            onProgreso: (f, txt) => reportar({ progreso: 5 + f * tramoVideo, mensaje: txt })
        });
    }
    archivos.push('Video.mp4');

    // --- Shorts verticales ---
    let shortsFallidos = 0;
    if (hayShorts) {
        await reportar({ progreso: 65, mensaje: 'Escribiendo los shorts' }, true);
        const shorts = await obtenerShorts(guion, nicho, cantidadShorts);
        const tramoShort = 30 / shorts.length;

        for (let n = 1; n <= shorts.length; n++) {
            const s = shorts[n - 1];
            info.shorts.push({ archivo: `Short_${n}.mp4`, titulo: s.titulo, descripcion: s.descripcion });
            await escribirInfo(carpetaProyecto, info);

            if (await existe(rutaShort(n))) { archivos.push(`Short_${n}.mp4`); continue; }
            try {
                await producirPieza({
                    etiqueta: `Short ${n}`, escenas: s.escenas, formato: FORMATOS.vertical,
                    nicho, nichoKey, carpeta: path.join(DIR.trabajo, `${proyecto.id}_short${n}`), destinoFinal: rutaShort(n),
                    onProgreso: (f, txt) => reportar({ progreso: 65 + (n - 1) * tramoShort + f * tramoShort, mensaje: txt })
                });
                archivos.push(`Short_${n}.mp4`);
            } catch (e) {
                shortsFallidos++;
                console.error(`❌ Falló el Short ${n}:`, e.message);
            }
        }
    }

    // --- Cierre: historial, panel, Telegram ---
    await registrarHistorial({
        canal: canal.id, titulo: proyecto.titulo, titulo_youtube: guion.titulo_youtube,
        url: proyecto.url, fecha: new Date().toISOString()
    });

    const mensajeFinal = shortsFallidos > 0
        ? `Video listo, pero ${shortsFallidos} short(s) fallaron. Usa Reintentar.`
        : 'Todo listo';
    await reportar({
        estado: shortsFallidos > 0 ? 'error' : 'listo',
        progreso: 100, mensaje: mensajeFinal, archivos,
        titulo_youtube: guion.titulo_youtube, drive_url: CFG.driveUrl
    }, true);

    const lineasShorts = info.shorts.slice(0, 5).map(s => `  • ${s.titulo}`).join('\n');
    await avisarTelegram(
        `🎬 Video listo\n` +
        `Canal: ${canal.nombre}\n` +
        `Título sugerido: ${guion.titulo_youtube}\n` +
        `Shorts: ${archivos.length - 1}${lineasShorts ? '\n' + lineasShorts : ''}\n` +
        `📁 ${CFG.driveUrl || carpetaProyecto}\n` +
        `Carpeta: ${canal.id}/${nombreCarpeta}`
    );

    console.log(`[Sistema] 🧾 Claude en este proyecto → entrada: ${USO.entrada} | caché leída: ${USO.cacheLeida} | caché escrita: ${USO.cacheEscrita} | salida: ${USO.salida} tokens`);
}

async function procesarCola() {
    console.log('📡 Conectando con el panel para buscar trabajo...');
    try {
        const proyectos = await pedirCola();

        if (!Array.isArray(proyectos) || proyectos.length === 0) {
            console.log('📭 La fila está vacía.');
            return;
        }
        console.log(`📦 ¡Se encontraron ${proyectos.length} proyectos pendientes!`);

        for (const proyecto of proyectos) {
            console.log(`\n===========================================`);
            console.log(`🚀 Iniciando producción: "${proyecto.titulo}"`);
            reiniciarUso();
            const reportar = crearReportero(proyecto);
            try {
                await producirVideo(proyecto, reportar);
            } catch (error) {
                console.error(`❌ Falló el proyecto "${proyecto.titulo}":`, error.message);
                await reportar({ estado: 'error', mensaje: error.message.slice(0, 280) }, true);
            }
        }
        console.log('\n🏁 Flujo terminado.');
    } catch (error) {
        console.error('❌ Error conectando con el panel:', error.message);
    }
}

async function main() {
    if (!CFG.claveWorker) {
        console.error('❌ Falta CLAVE_WORKER en el archivo .env (debe ser igual a la que pongas en Render).');
        process.exit(1);
    }
    await crearCarpetas();
    await detectarGPU();

    if (process.argv.includes('--vigilar')) {
        console.log(`👀 Modo vigilancia: revisando la cola cada ${CFG.intervaloMin} minutos.`);
        while (true) {
            await procesarCola();
            await dormir(CFG.intervaloMin * 60 * 1000);
        }
    } else {
        await procesarCola();
    }
}

main();
