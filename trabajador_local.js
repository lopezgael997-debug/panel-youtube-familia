require('dotenv').config();
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
        // Une todos los fragmentos de texto en un solo párrafo largo
        return transcript.map(t => t.text).join(' ');
    } catch (error) {
        throw new Error('No se pudieron extraer los subtítulos (quizás el video no tiene CC).');
    }
}

// --- AGENTE GUIONISTA: Escribe la historia con Claude 3.5 ---
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
    
    Video original de referencia: ${tituloIdea}
    Texto a adaptar: ${textoCrudo}
    `;

const respuesta = await anthropic.messages.create({
    model: "claude-sonnet-5-5", // Usar exactamente el ID de la lista de tu proveedor
    max_tokens: 2500,
    temperature: 0.7,
    messages: [{ role: "user", content: promptMaestro }]
});

    return respuesta.content[0].text;
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
                
                // Paso 3: Guardar guion en disco duro
                const rutaGuion = path.join(__dirname, `Guion_${proyecto.id}.txt`);
                await fs.writeFile(rutaGuion, guionEspanol, 'utf-8');
                console.log(`[Sistema] 💾 Guion guardado exitosamente en: ${rutaGuion}`);
                
                // Nota: El renderizado de video está pausado temporalmente 
                // hasta que integremos el Agente de Voz (XTTSv2) en el siguiente paso.

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