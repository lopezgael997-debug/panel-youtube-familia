require('dotenv').config();
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { YoutubeTranscript } = require('youtube-transcript');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const urlNube = 'https://panel-youtube-familia.onrender.com/api/obtener-cola';

// --- AGENTE CAZADOR: Extrae los subtítulos de YouTube ---
async function extraerTextoYouTube(url) {
    console.log(`[Cazador] 🕵️‍♂️ Extrayendo subtítulos de: ${url}`);
    try {
        const transcript = await YoutubeTranscript.fetchTranscript(url);
        return transcript.map(t => t.text).join(' ');
    } catch (error) {
        throw new Error('No se pudieron extraer los subtítulos (quizás el video no tiene CC).');
    }
}

// --- AGENTE GUIONISTA: Escribe la historia con Claude ---
async function redactarGuion(textoCrudo, tituloIdea) {
    console.log(`[Guionista] ✍️ Analizando texto en inglés y escribiendo guion...`);

    const promptMaestro = `
    Eres un guionista experto en YouTube. Tu audiencia son personas mayores de 50 años de habla hispana, apasionadas por los misterios históricos, arqueología prohibida y enigmas sin resolver.

    Toma esta transcripción cruda en inglés de un video y transfórmala en un guion original en español neutro.

    REGLAS:
    1. Crea un "Gancho" espectacular en los primeros 15 segundos para evitar que se vayan.
    2. Usa un tono de misterio, intriga y respeto, similar a los documentales clásicos.
    3. Elimina toda la "paja", promociones o saludos del youtuber original. Ve directo a la historia.
    4. Estructúralo en párrafos cortos.
    5. Devuelve ÚNICAMENTE el texto que el narrador dirá en voz alta: sin títulos, sin encabezados, sin asteriscos, sin indicaciones de escena ni acotaciones entre paréntesis.

    Video original de referencia: ${tituloIdea}
    Texto a adaptar: ${textoCrudo}
    `;

    const respuesta = await anthropic.messages.create({
        model: 'claude-sonnet-5-5',
        max_tokens: 4000,
        messages: [{ role: 'user', content: promptMaestro }]
    });

    const guion = respuesta.content
        .filter(bloque => bloque.type === 'text')
        .map(bloque => bloque.text)
        .join('\n');

    if (!guion) {
        console.log('Respuesta completa de la API:', JSON.stringify(respuesta, null, 2));
        throw new Error(`Claude no devolvió texto (stop_reason: ${respuesta.stop_reason})`);
    }

    return guion;
}

// --- Utilidades para la voz ---
function limpiarTextoParaVoz(texto) {
    return texto
        .replace(/[*_#`>~]/g, '')      // símbolos de markdown
        .replace(/\[[^\]]*\]/g, '')    // acotaciones entre corchetes
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function dividirEnTrozos(texto, maxCaracteres = 2000) {
    const parrafos = texto.split(/\n+/).map(p => p.trim()).filter(Boolean);
    const trozos = [];
    let actual = '';

    for (const parrafo of parrafos) {
        if ((actual + '\n' + parrafo).length > maxCaracteres && actual) {
            trozos.push(actual);
            actual = parrafo;
        } else {
            actual = actual ? actual + '\n' + parrafo : parrafo;
        }
    }
    if (actual) trozos.push(actual);
    return trozos;
}

async function sintetizarTrozo(texto) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata('es-MX-JorgeNeural', OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

    // En msedge-tts v2 devuelve { audioStream, metadataStream }; en v1 devuelve el stream directo
    const resultado = await tts.toStream(texto);
    const stream = resultado.audioStream || resultado;

    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

// --- AGENTE DE VOZ: Narra el guion con voz profesional ---
async function generarAudio(texto, idProyecto) {
    console.log(`[Locutor] 🎙️ Entrando a la cabina para grabar la narración...`);
    const rutaAudio = path.join(__dirname, `Narracion_${idProyecto}.mp3`);

    try {
        const trozos = dividirEnTrozos(limpiarTextoParaVoz(texto));
        const buffers = [];

        for (let i = 0; i < trozos.length; i++) {
            console.log(`[Locutor] 🔊 Grabando parte ${i + 1} de ${trozos.length}...`);
            buffers.push(await sintetizarTrozo(trozos[i]));
        }

        await fs.writeFile(rutaAudio, Buffer.concat(buffers));
        console.log(`[Sistema] 🎧 Audio generado exitosamente en: ${rutaAudio}`);
        return rutaAudio;
    } catch (error) {
        console.error('[Locutor] ❌ Error en la grabación:', error.message);
        throw error;
    }
}

// --- AGENTE CAPATAZ: Coordina todo el trabajo ---
async function procesarCola() {
    console.log('📡 Conectando con la nube para buscar trabajo...');
    try {
        const respuesta = await fetch(urlNube);
        const proyectos = await respuesta.json();

        if (proyectos.length === 0) {
            console.log('📭 La fila está vacía.');
            return;
        }

        console.log(`📦 ¡Se encontraron ${proyectos.length} proyectos pendientes!`);

        for (const proyecto of proyectos) {
            console.log(`\n===========================================`);
            console.log(`🚀 Iniciando producción: "${proyecto.titulo}"`);

            try {
                // Paso 1: Extraer
                const textoIngles = await extraerTextoYouTube(proyecto.url);

                // Paso 2: Redactar
                const guionEspanol = await redactarGuion(textoIngles, proyecto.titulo);

                // Paso 3: Guardar guion
                const rutaGuion = path.join(__dirname, `Guion_${proyecto.id}.txt`);
                await fs.writeFile(rutaGuion, guionEspanol, 'utf-8');
                console.log(`[Sistema] 💾 Guion guardado exitosamente en: ${rutaGuion}`);

                // Paso 4: Generar la voz
                const rutaAudio = await generarAudio(guionEspanol, proyecto.id);

                // Siguiente paso: renderizado de video con ffmpeg usando rutaAudio

            } catch (error) {
                console.error(`❌ Falló el proyecto "${proyecto.titulo}":`, error.message);
            }
        }
        console.log('\n🎉 Flujo terminado.');

    } catch (error) {
        console.error('❌ Error conectando con la nube:', error.message);
    }
}

procesarCola();