const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// =====================================================================
// SEGURIDAD: dos claves distintas (se configuran como variables de entorno en Render)
//   CLAVE_FAMILIA -> para quien usa la página web
//   CLAVE_WORKER  -> para tu PC (el trabajador local)
// =====================================================================
const CLAVE_FAMILIA = process.env.CLAVE_FAMILIA || '';
const CLAVE_WORKER = process.env.CLAVE_WORKER || '';
if (!CLAVE_FAMILIA || !CLAVE_WORKER) {
    console.warn('⚠️ Faltan CLAVE_FAMILIA y/o CLAVE_WORKER. Las rutas protegidas responderán 503 hasta configurarlas.');
}

function clavesIguales(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function protegerCon(claveEsperada) {
    return (req, res, next) => {
        if (!claveEsperada) return res.status(503).json({ error: 'El servidor no tiene claves configuradas.' });
        if (!clavesIguales(req.get('x-clave') || '', claveEsperada)) {
            return res.status(401).json({ error: 'Clave incorrecta.' });
        }
        next();
    };
}
const soloFamilia = protegerCon(CLAVE_FAMILIA);
const soloWorker = protegerCon(CLAVE_WORKER);

// =====================================================================
// CANALES (perfiles). Se leen de canales.json, el mismo archivo que usa el worker.
// =====================================================================
let CANALES = [];
try {
    CANALES = JSON.parse(fs.readFileSync(path.join(__dirname, 'canales.json'), 'utf-8'));
} catch (e) {
    console.error('No se pudo leer canales.json:', e.message);
}

// =====================================================================
// "Base de datos": archivo JSON.
// OJO: en el plan gratuito de Render el disco es temporal; si el servicio se
// redespliega, se pierde. El historial importante vive en tu PC (cache/historial.json).
// =====================================================================
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
let proyectos = [];
try {
    proyectos = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
} catch { /* primera vez */ }

function guardar() {
    try {
        if (proyectos.length > 200) proyectos = proyectos.slice(-200);
        fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
        fs.writeFileSync(DB_FILE, JSON.stringify(proyectos));
    } catch (e) {
        console.warn('No se pudo guardar la base de datos:', e.message);
    }
}

let ultimoId = 0;
function nuevoId() {
    ultimoId = Math.max(Date.now(), ultimoId + 1);
    return ultimoId;
}

function extraerIdVideo(url) {
    const m = String(url).match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
    return m ? m[1] : null;
}

const ESTADOS = ['pendiente', 'produciendo', 'listo', 'error'];

// =====================================================================
// RUTAS PÚBLICAS
// =====================================================================
app.get('/api/salud', (req, res) => res.json({ ok: true }));

app.get('/api/canales', (req, res) => {
    res.json(CANALES.map(c => ({ id: c.id, nombre: c.nombre, nicho: c.nicho })));
});

// =====================================================================
// RUTAS DE LA FAMILIA (clave familiar)
// =====================================================================
app.post('/api/nuevo-video', soloFamilia, (req, res) => {
    const { titulo, url, canal, forzar } = req.body || {};

    if (typeof titulo !== 'string' || !titulo.trim() || titulo.length > 150) {
        return res.status(400).json({ error: 'El título es obligatorio (máx. 150 caracteres).' });
    }
    const idVideo = extraerIdVideo(url);
    if (!idVideo) {
        return res.status(400).json({ error: 'La URL debe ser de un video de YouTube.' });
    }
    const canalElegido = CANALES.find(c => c.id === canal);
    if (!canalElegido) {
        return res.status(400).json({ error: 'Elige un canal válido.' });
    }

    const duracion = Math.min(60, Math.max(1, parseInt(req.body.duracion, 10) || 10));
    const shorts = Math.min(10, Math.max(0, Number.isFinite(parseInt(req.body.shorts, 10)) ? parseInt(req.body.shorts, 10) : 3));

    // Anti-duplicados: el mismo video de referencia no se repite en el mismo canal
    const repetido = proyectos.find(p =>
        p.canal === canalElegido.id && p.idVideo === idVideo && p.estado !== 'error');
    if (repetido && !forzar) {
        return res.status(409).json({
            error: `Ese video ya fue enviado a "${canalElegido.nombre}" ("${repetido.titulo}").`
        });
    }

    const proyecto = {
        id: nuevoId(),
        titulo: titulo.trim(),
        url: String(url).trim(),
        idVideo,
        canal: canalElegido.id,
        nicho: canalElegido.nicho,
        duracion,
        shorts,
        estado: 'pendiente',
        mensaje: 'En cola, esperando a la PC de producción',
        progreso: 0,
        archivos: [],
        creado: new Date().toISOString(),
        actualizado: new Date().toISOString()
    };
    proyectos.push(proyecto);
    guardar();
    console.log('Nuevo proyecto recibido:', proyecto.id, proyecto.titulo);

    res.json({ mensaje: '¡Proyecto enviado a la cola de producción!', proyecto });
});

app.get('/api/proyectos', soloFamilia, (req, res) => {
    const lista = proyectos.slice(-30).reverse().map(p => ({
        id: p.id, titulo: p.titulo, canal: p.canal, duracion: p.duracion, shorts: p.shorts,
        estado: p.estado, mensaje: p.mensaje, progreso: p.progreso, creado: p.creado,
        titulo_youtube: p.titulo_youtube || '', drive_url: p.drive_url || ''
    }));
    res.json(lista);
});

app.post('/api/reintentar/:id', soloFamilia, (req, res) => {
    const p = proyectos.find(x => x.id === Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado.' });
    if (p.estado !== 'error') return res.status(400).json({ error: 'Solo se pueden reintentar proyectos con error.' });
    p.estado = 'pendiente';
    p.mensaje = 'Reintentando: en cola de nuevo';
    p.progreso = 0;
    p.actualizado = new Date().toISOString();
    guardar();
    res.json({ ok: true });
});

// =====================================================================
// RUTAS DEL WORKER (clave del worker)
// =====================================================================
// Devuelve lo pendiente y también lo que quedó "produciendo" (si el worker se cortó,
// retoma sin gastar de nuevo gracias a la caché local).
app.get('/api/obtener-cola', soloWorker, (req, res) => {
    const cola = proyectos
        .filter(p => p.estado === 'pendiente' || p.estado === 'produciendo')
        .sort((a, b) => a.creado.localeCompare(b.creado));
    res.json(cola);
});

app.post('/api/actualizar/:id', soloWorker, (req, res) => {
    const p = proyectos.find(x => x.id === Number(req.params.id));
    if (!p) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const { estado, mensaje, progreso, archivos, titulo_youtube, drive_url } = req.body || {};
    if (estado !== undefined) {
        if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });
        p.estado = estado;
    }
    if (typeof mensaje === 'string') p.mensaje = mensaje.slice(0, 300);
    if (Number.isFinite(progreso)) p.progreso = Math.min(100, Math.max(0, Math.round(progreso)));
    if (Array.isArray(archivos)) p.archivos = archivos.slice(0, 20).map(a => String(a).slice(0, 200));
    if (typeof titulo_youtube === 'string') p.titulo_youtube = titulo_youtube.slice(0, 200);
    if (typeof drive_url === 'string') p.drive_url = drive_url.slice(0, 500);
    p.actualizado = new Date().toISOString();
    guardar();
    res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de producción en línea en el puerto ${PORT}`);
});
