// server.js
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');

const app = express();
const port = 3000;

// Configuración de almacenamiento temporal para los archivos que suban tus papás
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));

app.post('/ensamblar', upload.fields([{ name: 'imagen' }, { name: 'audio' }]), (req, res) => {
    const imagePath = req.files['imagen'][0].path;
    const audioPath = req.files['audio'][0].path;
    const outputPath = path.join(__dirname, 'public', `video_final_${Date.now()}.mp4`);

    console.log("Iniciando renderizado automático...");

    // Comando FFmpeg: Toma la imagen, aplica un zoom lento continuo, añade el audio y corta el video al terminar el audio.
    ffmpeg()
        .input(imagePath)
        .loop() // Repite la imagen
        .input(audioPath)
        // Filtro complejo: Zoom in muy lento desde el centro para dar efecto documental
        .complexFilter([
            "zoompan=z='min(zoom+0.001,1.5)':d=7000:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080"
        ])
        .outputOptions([
            '-c:v libx264',
            '-tune stillimage',
            '-c:a aac',
            '-b:a 192k',
            '-pix_fmt yuv420p',
            '-shortest' // Termina el video exactamente cuando acaba el audio
        ])
        .save(outputPath)
        .on('end', () => {
            console.log("Renderizado completo.");
            // Limpia los archivos temporales
            fs.unlinkSync(imagePath);
            fs.unlinkSync(audioPath);
            res.json({ success: true, downloadUrl: '/' + path.basename(outputPath) });
        })
        .on('error', (err) => {
            console.error("Error en FFmpeg:", err);
            res.status(500).json({ error: 'Fallo al procesar el video' });
        });
});

app.listen(port, () => {
    console.log(`Fábrica de videos lista en http://localhost:${port}`);
});