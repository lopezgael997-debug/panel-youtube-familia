// Este script corre en tu PC local, no en Render.
const urlNube = 'https://panel-youtube-familia.onrender.com/api/obtener-cola';

async function revisarTrabajoPendiente() {
    console.log('Conectando con Render para buscar nuevos videos...');
    try {
        const respuesta = await fetch(urlNube);
        const proyectos = await respuesta.json();

        if (proyectos.length === 0) {
            console.log('No hay videos en la cola. La familia aún no ha enviado nada.');
            return;
        }

        console.log(`¡Se encontraron ${proyectos.length} proyectos pendientes!`);
        
        // Aquí es donde conectaremos a Claude y FFmpeg
        proyectos.forEach(proyecto => {
            console.log(`Iniciando producción de: ${proyecto.titulo}`);
            console.log(`Descargando transcripción de: ${proyecto.url}`);
            console.log(`Generando prompt para miniatura: ${proyecto.miniatura}`);
            console.log('-----------------------------------');
            
            // Futuro código:
            // 1. extraerSubtitulos(proyecto.url)
            // 2. traducirYGuionizar(Claude)
            // 3. renderizarVideo(FFmpeg)
        });

    } catch (error) {
        console.error('Error al conectar con la nube:', error);
    }
}

// Revisa si hay trabajo nuevo en la página cada 30 segundos
setInterval(revisarTrabajoPendiente, 30000);
revisarTrabajoPendiente();