require('dotenv').config();
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { YoutubeTranscript } = require('youtube-transcript');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// =====================================================================
// CONFIGURACIÓN
// =====================================================================
const CFG = {
    urlNube: process.env.URL_NUBE || 'https://panel-youtube-familia.onrender.com/api/obtener-cola',
    urlCompletar: process.env.URL_COMPLETAR || '', // opcional: endpoint de tu panel para marcar "listo"
    modelo: process.env.MODELO_CLAUDE || 'claude-sonnet-5-5', // para ahorrar: claude-haiku-5-5
    pexelsKey: process.env.PEXELS_API_KEY || '',
    intervaloMin: Number(process.env.INTERVALO_MIN || 5),
    maxCharsTranscripcion: 40000,
    maxTokensGuion: 8000,
    fps: 30,
    ancho: 1920,
    alto: 1080,
    pausaEscena: 0.35 // segundos de silencio al final de cada escena
};

const DIR = {
    cache: path.join(__dirname, 'cache'),
    transcripciones: path.join(__dirname, 'cache', 'transcripciones'),
    guiones: path.join(__dirname, 'cache', 'guiones'),
    audio: path.join(__dirname, 'cache', 'audio'),
    imagenes: path.join(__dirname, 'cache', 'imagenes'),
    trabajo: path.join(__dirname, 'trabajo'),
    salida: path.join(__dirname, 'salida'),
    musica: path.join(__dirname, 'musica')
};

// Nichos: agrega los tuyos aquí. El panel debe enviar el campo "nicho" en cada proyecto.
const NICHOS = {
    misterio: {
        audiencia: 'personas mayores de 50 años de habla hispana, apasionadas por los misterios históricos, la arqueología prohibida y los enigmas sin resolver',
        tono: 'misterio, intriga y respeto, similar a los documentales clásicos',
        voz: 'es-MX-JorgeNeural'
    },
    historia: {
        audiencia: 'adultos de habla hispana interesados en historia universal y grandes personajes',
        tono: 'narrativo, riguroso y apasionante, como un buen documental histórico',
        voz: 'es-ES-AlvaroNeural'
    },
    ciencia: {
        audiencia: 'público curioso de habla hispana que disfruta la divulgación científica',
        tono: 'claro, entusiasta y sorprendente, sin tecnicismos innecesarios',
        voz: 'es-MX-DaliaNeural'
    }
};
const NICHO_POR_DEFECTO = 'misterio';

let usarGPU = !process.env.FORZAR_CPU;

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

function decodificarEntidades(t) {
    return t
        .replace(/&amp;#39;|&#39;/g, "'")
        .replace(/&amp;quot;|&quot;/g, '"')
        .replace(/&amp;amp;|&amp;/g, '&')
        .replace(/&gt;/g, '>').replace(/&lt;/g, '<')
        .replace(/\[(Music|Applause|Música|Aplausos)\]/gi, '')
        .replace(/\s+/g, ' ').trim();
}

function ejecutarFfmpeg(args, cwd) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, ['-hide_banner', '-y', ...args], { cwd: cwd || __dirname });
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
    // ffmpeg -i devuelve código 1 sin salida, pero imprime la duración en stderr
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

// Ejecuta un render; si falla con GPU, reintenta una vez con CPU
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
// AGENTE GUIONISTA: Claude (con caché: nunca se paga dos veces)
// =====================================================================
function construirPrompt(nicho, titulo, texto) {
    return `Eres un guionista experto en YouTube. Tu audiencia son ${nicho.audiencia}.

Toma esta transcripción cruda en inglés de un video y transfórmala en un guion ORIGINAL en español neutro, con un tono de ${nicho.tono}.

REGLAS:
1. Empieza con un "Gancho" espectacular en los primeros 15 segundos para evitar que se vayan.
2. Elimina toda la "paja", promociones o saludos del youtuber original. Ve directo a la historia.
3. Reescribe con tus propias palabras y estructura; no copies frases del original.
4. Divide el guion en entre 12 y 20 escenas. Cada escena tiene 2 a 4 oraciones de narración.
5. La narración es SOLO texto para decir en voz alta: sin títulos, sin asteriscos, sin acotaciones.
6. Para cada escena da una búsqueda de imagen de stock en INGLÉS (2 a 4 palabras, concreta y visual, p. ej. "ancient ship fog", "stone ruins sunset").

Responde ÚNICAMENTE con JSON válido, sin texto antes ni después ni bloques de código, con esta forma:
{
  "titulo_youtube": "título atractivo en español",
  "descripcion": "descripción de 2 a 3 líneas",
  "etiquetas": ["etiqueta1", "etiqueta2"],
  "escenas": [
    { "narracion": "texto de la escena", "busqueda_imagen": "english keywords" }
  ]
}

Video original de referencia: ${titulo}
Texto a adaptar: ${texto}`;
}

function parsearGuion(crudo) {
    const ini = crudo.indexOf('{');
    const fin = crudo.lastIndexOf('}');
    if (ini === -1 || fin === -1) throw new Error('La respuesta de Claude no contiene JSON.');
    const guion = JSON.parse(crudo.slice(ini, fin + 1));
    if (!Array.isArray(guion.escenas) || guion.escenas.length === 0) {
        throw new Error('El guion no trae escenas.');
    }
    for (const e of guion.escenas) {
        if (typeof e.narracion !== 'string' || !e.narracion.trim()) {
            throw new Error('Hay una escena sin narración.');
        }
        e.busqueda_imagen = e.busqueda_imagen || 'mystery landscape';
    }
    return guion;
}

async function obtenerGuion(proyecto, nichoKey, idVideo) {
    const archivo = path.join(DIR.guiones, `${idVideo}_${nichoKey}.json`);
    let crudo;

    if (await existe(archivo)) {
        console.log('[Guionista] ♻️ Guion ya existe en caché, reutilizando (0 créditos).');
        crudo = await fs.readFile(archivo, 'utf-8');
    } else {
        let texto = await obtenerTranscripcion(proyecto.url, idVideo);
        if (texto.length > CFG.maxCharsTranscripcion) texto = texto.slice(0, CFG.maxCharsTranscripcion);

        console.log(`[Guionista] ✍️ Escribiendo guion con ${CFG.modelo} (nicho: ${nichoKey})...`);
        const respuesta = await anthropic.messages.create({
            model: CFG.modelo,
            max_tokens: CFG.maxTokensGuion,
            messages: [{ role: 'user', content: construirPrompt(NICHOS[nichoKey], proyecto.titulo, texto) }]
        });

        crudo = respuesta.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        if (!crudo) throw new Error(`Claude no devolvió texto (stop_reason: ${respuesta.stop_reason})`);

        // Se guarda ANTES de interpretarlo: aunque el JSON venga mal, no se vuelve a pagar
        await fs.writeFile(archivo, crudo, 'utf-8');
        if (respuesta.stop_reason === 'max_tokens') {
            console.log('[Guionista] ⚠️ El guion llegó al límite de tokens y puede estar incompleto.');
        }
    }

    try {
        return parsearGuion(crudo);
    } catch (e) {
        throw new Error(`${e.message} Revisa o corrige a mano el archivo: ${archivo}`);
    }
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
// AGENTE ARCHIVISTA: imágenes (Pexels + caché + respaldo)
// =====================================================================
async function crearImagenRespaldo(destino) {
    await ejecutarFfmpeg([
        '-f', 'lavfi', '-i', `color=c=0x0d1117:s=${CFG.ancho}x${CFG.alto}`,
        '-frames:v', '1', destino
    ]);
}

async function imagenDeEscena(consulta, indice, usadas) {
    const base = path.join(DIR.imagenes, hash(consulta + '|' + indice));
    const archivo = `${base}.jpg`;
    if (await existe(archivo)) return archivo;

    if (CFG.pexelsKey) {
        try {
            const r = await fetch(
                `https://api.pexels.com/v1/search?query=${encodeURIComponent(consulta)}&orientation=landscape&per_page=8`,
                { headers: { Authorization: CFG.pexelsKey } }
            );
            if (r.ok) {
                const datos = await r.json();
                const fotos = (datos.photos || []).filter(f => !usadas.has(f.id));
                const foto = fotos[0] || (datos.photos || [])[0];
                if (foto) {
                    const img = await fetch(foto.src.large2x || foto.src.large);
                    await fs.writeFile(archivo, Buffer.from(await img.arrayBuffer()));
                    usadas.add(foto.id);
                    return archivo;
                }
            }
        } catch (e) {
            console.log(`[Archivista] ⚠️ Pexels falló para "${consulta}": ${e.message}`);
        }
    } else if (indice === 0) {
        console.log('[Archivista] ⚠️ No hay PEXELS_API_KEY en .env: se usarán fondos oscuros lisos.');
    }

    const respaldo = path.join(DIR.imagenes, 'respaldo.png');
    if (!(await existe(respaldo))) await crearImagenRespaldo(respaldo);
    return respaldo;
}

// =====================================================================
// AGENTE EDITOR: clips con zoom, subtítulos, música y render final
// =====================================================================
async function renderizarEscena({ imagen, audio, duracion, indice, carpeta }) {
    const nombre = `escena_${String(indice).padStart(3, '0')}.mp4`;
    const destino = path.join(carpeta, nombre);
    if (await existe(destino)) return nombre; // reanuda si se cortó a mitad

    const frames = Math.max(1, Math.round(duracion * CFG.fps));
    const paso = (0.18 / frames).toFixed(6);
    const zoom = indice % 2 === 0
        ? `min(zoom+${paso},1.18)`                                   // acercamiento
        : `if(eq(on,0),1.18,max(zoom-${paso},1.0))`;                 // alejamiento
    const fade = 0.45;

    const filtro = [
        `scale=${CFG.ancho * 1.5}:${CFG.alto * 1.5}:force_original_aspect_ratio=increase`,
        `crop=${CFG.ancho * 1.5}:${CFG.alto * 1.5}`,
        `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${CFG.ancho}x${CFG.alto}:fps=${CFG.fps}`,
        `fade=t=in:st=0:d=${fade}`,
        `fade=t=out:st=${Math.max(0, duracion - fade).toFixed(2)}:d=${fade}`,
        'format=yuv420p'
    ].join(',');

    const temporal = path.join(carpeta, `tmp_${nombre}`);
    await ejecutarRender(() => [
        '-i', imagen,
        '-i', audio,
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

function generarSubtitulosAss(escenas) {
    const cabecera = `[Script Info]
ScriptType: v4.00+
PlayResX: ${CFG.ancho}
PlayResY: ${CFG.alto}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,62,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,1,2,120,120,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const lineas = [];
    let inicioEscena = 0;

    for (const esc of escenas) {
        const palabras = esc.narracion.replace(/\s+/g, ' ').trim().split(' ');
        const trozos = [];
        for (let i = 0; i < palabras.length; i += 6) trozos.push(palabras.slice(i, i + 6).join(' '));

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
            if (archivos.length) {
                return path.join(carpeta, archivos[Math.floor(Math.random() * archivos.length)]);
            }
        } catch { /* la carpeta no existe */ }
    }
    return null;
}

async function ensamblarVideo({ clips, escenas, carpeta, nichoKey, destinoFinal }) {
    // 1) Unir clips (mismo códec: se copian sin recodificar)
    await fs.writeFile(path.join(carpeta, 'lista.txt'), clips.map(c => `file '${c}'`).join('\n'), 'utf-8');
    await ejecutarFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'lista.txt', '-c', 'copy', 'union.mp4'], carpeta);

    // 2) Subtítulos + música de fondo + render final
    await fs.writeFile(path.join(carpeta, 'subs.ass'), generarSubtitulosAss(escenas), 'utf-8');
    const musica = await elegirMusica(nichoKey);
    const temporal = path.join(carpeta, 'final.mp4');

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
        console.log('[Editor] ℹ️ Sin música: pon archivos .mp3 en la carpeta "musica" para añadirla.');
        await ejecutarRender(() => [
            '-i', 'union.mp4',
            '-vf', 'subtitles=subs.ass',
            ...argsCodecVideo(),
            '-c:a', 'copy',
            '-movflags', '+faststart',
            'final.mp4'
        ], carpeta);
    }
    await fs.copyFile(temporal, destinoFinal);
}

// =====================================================================
// AGENTE CAPATAZ
// =====================================================================
async function notificarNube(proyecto, rutaVideo, guion) {
    if (!CFG.urlCompletar) return;
    try {
        await fetch(CFG.urlCompletar, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: proyecto.id,
                estado: 'listo',
                archivo: rutaVideo,
                titulo_youtube: guion.titulo_youtube
            })
        });
    } catch (e) {
        console.log(`[Sistema] ⚠️ No se pudo avisar a la nube: ${e.message}`);
    }
}

async function producirVideo(proyecto) {
    const idVideo = extraerIdVideo(proyecto.url);
    let nichoKey = String(proyecto.nicho || NICHO_POR_DEFECTO).toLowerCase();
    if (!NICHOS[nichoKey]) {
        console.log(`[Sistema] ⚠️ Nicho "${nichoKey}" no existe, usando "${NICHO_POR_DEFECTO}".`);
        nichoKey = NICHO_POR_DEFECTO;
    }
    const nicho = NICHOS[nichoKey];

    const destinoFinal = path.join(DIR.salida, `Video_${proyecto.id}.mp4`);
    if (await existe(destinoFinal)) {
        console.log(`[Sistema] ✅ Este video ya fue producido: ${destinoFinal}`);
        return;
    }

    // Paso 1-2: guion (caché o Claude)
    const guion = await obtenerGuion(proyecto, nichoKey, idVideo);
    await fs.writeFile(
        path.join(DIR.salida, `Video_${proyecto.id}.json`),
        JSON.stringify({ titulo: guion.titulo_youtube, descripcion: guion.descripcion, etiquetas: guion.etiquetas }, null, 2),
        'utf-8'
    );
    console.log(`[Guionista] 📜 ${guion.escenas.length} escenas listas. Título: ${guion.titulo_youtube}`);

    // Paso 3: voz + imágenes + clips por escena
    const carpeta = path.join(DIR.trabajo, String(proyecto.id));
    await fs.mkdir(carpeta, { recursive: true });
    const usadas = new Set();
    const clips = [];

    for (let i = 0; i < guion.escenas.length; i++) {
        const esc = guion.escenas[i];
        console.log(`[Editor] 🎬 Escena ${i + 1}/${guion.escenas.length}`);

        const audio = await audioDeEscena(esc.narracion, nicho.voz);
        esc.duracion = (await duracionAudio(audio)) + CFG.pausaEscena;
        const imagen = await imagenDeEscena(esc.busqueda_imagen, i, usadas);

        clips.push(await renderizarEscena({ imagen, audio, duracion: esc.duracion, indice: i, carpeta }));
    }

    // Paso 4: ensamblado final
    console.log('[Editor] 🎞️ Ensamblando video final...');
    await ensamblarVideo({ clips, escenas: guion.escenas, carpeta, nichoKey, destinoFinal });
    await fs.rm(carpeta, { recursive: true, force: true });

    console.log(`[Sistema] 🎉 Video listo: ${destinoFinal}`);
    await notificarNube(proyecto, destinoFinal, guion);
}

async function procesarCola() {
    console.log('📡 Conectando con la nube para buscar trabajo...');
    try {
        const respuesta = await fetch(CFG.urlNube);
        const proyectos = await respuesta.json();

        if (!Array.isArray(proyectos) || proyectos.length === 0) {
            console.log('📭 La fila está vacía.');
            return;
        }
        console.log(`📦 ¡Se encontraron ${proyectos.length} proyectos pendientes!`);

        for (const proyecto of proyectos) {
            console.log(`\n===========================================`);
            console.log(`🚀 Iniciando producción: "${proyecto.titulo}"`);
            try {
                await producirVideo(proyecto);
            } catch (error) {
                console.error(`❌ Falló el proyecto "${proyecto.titulo}":`, error.message);
            }
        }
        console.log('\n🏁 Flujo terminado.');
    } catch (error) {
        console.error('❌ Error conectando con la nube:', error.message);
    }
}

async function main() {
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