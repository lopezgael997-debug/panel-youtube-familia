const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');

// Vinculamos el motor descargado
ffmpeg.setFfmpegPath(ffmpegPath);

const urlNube = 'https://panel-youtube-familia.onrender.com/api/obtener-cola';

// Función para ensamblar 1 solo video
function renderizarVideo(titulo, archivoImagen, archivoAudio, archivoSalida) {
    return new Promise((resolve, reject) => {
        console.log(`\n[FFmpeg] 🎬 Iniciando renderizado: "${titulo}"`);
        
        ffmpeg()
            .input(archivoImagen)
            .loop() 
            .input(archivoAudio)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
                '-shortest',
                '-pix_fmt yuv420p',
                '-vf scale=1920:1080' // Formato horizontal de YouTube
            ])
            .save(archivoSalida)
            .on('end', () => {
                console.log(`[FFmpeg] ✅ Video completado: ${archivoSalida}`);
                resolve();
            })
            .on('error', (err) => {
                console.error('[FFmpeg] ❌ Error en el renderizado:', err.message);
                reject(err);
            });
    });
}

// Función principal: El Agente Capataz
async function procesarCola() {
    console.log('📡 Conectando con la nube para buscar trabajo...');
    try {
        const respuesta = await fetch(urlNube);
        const proyectos = await respuesta.json();

        // Si la familia no ha mandado nada, avisa y se cierra.
        if (proyectos.length === 0) {
            console.log('📭 La fila está vacía. No hay videos pendientes para renderizar.');
            return;
        }

        console.log(`📦 ¡Se encontraron ${proyectos.length} proyectos pendientes!`);
        
        const imagenLocal = path.join(__dirname, 'miniatura.jpg');
        const audioLocal = path.join(__dirname, 'audio.mp3');

        // Bucle secuencial: Renderiza uno por uno para no colapsar la RTX 5070 Ti
        for (const proyecto of proyectos) {
            const nombreVideoFinal = path.join(__dirname, `Video_${proyecto.id}.mp4`);
            await renderizarVideo(proyecto.titulo, imagenLocal, audioLocal, nombreVideoFinal);
        }

        console.log('\n🎉 Toda la fila de trabajo ha sido procesada.');

    } catch (error) {
        console.error('❌ Error conectando con la nube:', error.message);
    }
}

procesarCola();