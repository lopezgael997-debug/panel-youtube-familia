const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');

// Le indicamos a la librería dónde está el motor FFmpeg instalado
ffmpeg.setFfmpegPath(ffmpegPath);

const urlNube = 'https://panel-youtube-familia.onrender.com/api/obtener-cola';

// Función que ensambla el video
function renderizarVideo(titulo, archivoImagen, archivoAudio, archivoSalida) {
    return new Promise((resolve, reject) => {
        console.log(`[FFmpeg] Iniciando renderizado de: ${archivoSalida}...`);
        
        ffmpeg()
            // Entrada 1: La imagen (se repetirá en bucle)
            .input(archivoImagen)
            .loop() 
            // Entrada 2: El audio
            .input(archivoAudio)
            // Configuraciones de video
            .videoCodec('libx264')
            .audioCodec('aac')
            // Forzar que el video dure exactamente lo mismo que el audio
            .outputOptions([
                '-shortest',
                '-pix_fmt yuv420p',
                '-vf scale=1920:1080' // Escala a 1080p
            ])
            .save(archivoSalida)
            .on('end', () => {
                console.log(`[FFmpeg] ¡Video renderizado con éxito!: ${archivoSalida}`);
                resolve();
            })
            .on('error', (err) => {
                console.error('[FFmpeg] Error en el renderizado:', err);
                reject(err);
            });
    });
}

async function revisarTrabajoPendiente() {
    try {
        const respuesta = await fetch(urlNube);
        const proyectos = await respuesta.json();

        if (proyectos.length === 0) return;

        console.log(`\n¡Se detectaron ${proyectos.length} proyectos nuevos en la nube!`);
        
        // Procesamos solo el primero para esta prueba
        const proyecto = proyectos[0];
        console.log(`Procesando: ${proyecto.titulo}`);
        
        // Nombres de archivos locales
        const imagenLocal = path.join(__dirname, 'miniatura.jpg');
        const audioLocal = path.join(__dirname, 'audio.mp3');
        // El nombre del video final sin espacios
        const nombreVideoFinal = path.join(__dirname, `Video_${proyecto.id}.mp4`);

        // Ejecutar el Agente Editor
        await renderizarVideo(proyecto.titulo, imagenLocal, audioLocal, nombreVideoFinal);

        console.log('--- Flujo terminado por ahora ---');
        // NOTA: Aquí en el futuro le avisaremos a la nube que ya terminamos para que lo borre de la lista.

    } catch (error) {
        console.error('Error de conexión:', error);
    }
}

// Para esta prueba, no usaremos el intervalo de 30 segundos, solo lo ejecutaremos una vez directo.
revisarTrabajoPendiente();