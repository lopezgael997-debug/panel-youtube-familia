const express = require('express');
const path = require('path');
const app = express();

// Configuraciones para procesar los datos del formulario
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir la carpeta 'public' donde estará la página web
app.use(express.static(path.join(__dirname, 'public')));

// Base de datos temporal en memoria (Aquí caerán los videos propuestos)
let colaDeTrabajo = [];

// Ruta para recibir nuevos proyectos desde la web
app.post('/api/nuevo-video', (req, res) => {
    const { titulo, url, miniatura } = req.body;
    
    if(!titulo || !url) {
        return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    const nuevoProyecto = {
        id: Date.now(),
        titulo,
        url,
        miniatura,
        estado: 'Pendiente de renderizado en PC Local'
    };

    colaDeTrabajo.push(nuevoProyecto);
    console.log('Nuevo proyecto recibido:', nuevoProyecto);
    
    res.json({ mensaje: '¡Video enviado a la cola de producción exitosamente!', proyecto: nuevoProyecto });
});

// Ruta secreta para que tu PC local descargue el trabajo pendiente
app.get('/api/obtener-cola', (req, res) => {
    res.json(colaDeTrabajo);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor de producción en línea en el puerto ${PORT}`);
});