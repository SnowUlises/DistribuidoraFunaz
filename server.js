const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/imagenes', express.static(path.join(__dirname, 'public', 'imagenes')));

// Rutas de archivos
const DATA_PATH = path.join(__dirname, 'productos.json');
const PEDIDOS_PATH = path.join(__dirname, 'pedidos');
const IMG_PATH = path.join(__dirname, 'public', 'imagenes');

// Crear carpetas si no existen
if (!fs.existsSync(PEDIDOS_PATH)) fs.mkdirSync(PEDIDOS_PATH);
if (!fs.existsSync(IMG_PATH)) fs.mkdirSync(IMG_PATH);

// Cargar productos
let productos = [];
let nextId = 1;

if (fs.existsSync(DATA_PATH)) {
  productos = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  if (productos.length > 0) {
    nextId = Math.max(...productos.map(p => p.id)) + 1;
  }
}

function guardar() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify(productos, null, 2));
  } catch (err) {
    console.error("Error al guardar productos:", err);
  }
}

/* ========================
      RUTAS PRODUCTOS
======================== */
app.get('/api/productos', (req, res) => {
  res.json(productos);
});

app.get('/api/productos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const producto = productos.find(p => p.id === id);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  res.json(producto);
});

app.post('/api/productos', (req, res) => {
  const { nombre, precio, categoria, stock } = req.body;
  if (!nombre || precio == null) return res.status(400).json({ error: 'Datos incompletos' });

  const idActual = nextId++;
  const nuevo = { 
    id: idActual, 
    nombre, 
    precio, 
    categoria, 
    stock, 
    imagen: `/imagenes/${idActual}.png` 
  };
  productos.push(nuevo);
  guardar();
  res.status(201).json(nuevo);
});

app.put('/api/productos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = productos.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'No existe' });

  productos[index] = { ...productos[index], ...req.body };
  guardar();
  res.json(productos[index]);
});

app.delete('/api/productos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const index = productos.findIndex(p => p.id === id);
  if (index === -1) return res.status(404).json({ error: 'No existe' });

  const rutaImg = path.join(IMG_PATH, `${id}.png`);
  if (fs.existsSync(rutaImg)) fs.unlinkSync(rutaImg);

  productos = productos.filter(p => p.id !== id);
  guardar();
  res.status(204).end();
});

/* ========================
     UPLOAD DE IMÁGENES
======================== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, IMG_PATH),
  filename: (req, file, cb) => cb(null, `${req.params.id}.png`)
});
const upload = multer({ storage });

app.post('/api/upload/:id', upload.single('imagen'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  res.status(200).json({ mensaje: 'Imagen subida' });
});

app.delete('/api/upload/:id', (req, res) => {
  const rutaImg = path.join(IMG_PATH, `${req.params.id}.png`);
  if (fs.existsSync(rutaImg)) {
    fs.unlinkSync(rutaImg);
    return res.status(204).end();
  }
  res.status(404).json({ error: 'Imagen no encontrada' });
});

/* ========================
     PDF DE PEDIDOS
======================== */
app.post('/api/guardar-pedido', (req, res) => {
  const { usuario, index, pedido, info } = req.body;
  if (!usuario || !Array.isArray(pedido)) return res.status(400).send('Datos inválidos');

  const filePath = path.join(PEDIDOS_PATH, `${usuario}-${index}.pdf`);
  const doc = new PDFDocument({ size: [220, 600], margins: { top: 10, bottom: 10, left: 10, right: 10 } });

  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Logo
  const logoPath = path.join(__dirname, 'public', 'logo.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 60, 10, { width: 100 });
    doc.moveDown(7);
  }

  doc.font('Courier').fontSize(9);
  doc.text(`Usuario: ${usuario}`);
  doc.text(`Nombre: ${info?.nombre || ''} ${info?.apellido || ''}`);
  doc.text(`Teléfono: ${info?.telefono || ''}`);
  doc.text(`Email: ${info?.email || ''}`);
  doc.moveDown();
  const fecha = new Date();
  doc.text(`Fecha: ${fecha.toLocaleDateString()} ${fecha.toLocaleTimeString()}`, { align: 'center' });
  doc.moveDown(0.5).moveTo(10, doc.y).lineTo(210, doc.y).stroke();
  doc.moveDown(0.5).fontSize(10).text('PEDIDO', { underline: true, align: 'center' }).moveDown(0.5);

  let total = 0;
  pedido.forEach(p => {
    const subtotal = p.cantidad * p.precio;
    total += subtotal;
    doc.text(`${p.cantidad} x ${p.nombre}`, { continued: true });
    doc.text(` $${subtotal.toFixed(2)}`, { align: 'right' });
  });

  doc.moveDown(0.5).moveTo(10, doc.y).lineTo(210, doc.y).stroke();
  doc.moveDown(0.5).fontSize(14).text(`TOTAL: $${total.toFixed(2)}`, { align: 'center' });
  doc.end();

  stream.on('finish', () => res.send('Pedido guardado en PDF'));
  stream.on('error', err => {
    console.error(err);
    res.status(500).send('Error al guardar PDF');
  });
});
const simpleGit = require('simple-git');
const git = simpleGit();

async function gitPushCambios() {
  try {
    await git.add('./productos.json');
    await git.commit(`Actualización de stock ${new Date().toLocaleString()}`);
    await git.push('origin', 'main'); // cambia 'main' si tu rama es distinta
    console.log('Cambios enviados a GitHub 🚀');
  } catch (err) {
    console.error('Error al hacer git push:', err);
  }
}
/* ========================
     GUARDAR PEDIDOS JSON
======================== */
// Reemplaza tu handler viejo por este (colócalo en server.js)
app.post('/api/guardar-pedidos', (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';

    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0) {
      return res.status(400).json({ error: 'Pedido inválido' });
    }

    // Clonamos productos en memoria para procesar y calcular totales
    const orden = {
      user: usuarioPedido,
      fecha: new Date().toISOString(),
      items: [],
      total: 0
    };

    // Procesar cada ítem: reducir stock en productos (persistiremos después)
    for (const it of pedidoItems) {
      const id = Number(it.id);
      const cantidadSolicitada = Number(it.cantidad) || 0;
      if (!id || cantidadSolicitada <= 0) continue;

      const producto = productos.find(p => Number(p.id) === id);
      if (!producto) {
        // si no existe el producto lo omitimos (podrías registrar en "skipped")
        continue;
      }

      const stockActual = Number(producto.stock) || 0;
      const cantidadFinal = Math.min(cantidadSolicitada, stockActual);

      // restamos stock en el producto guardado en memoria
      producto.stock = Math.max(0, stockActual - cantidadFinal);

      const precioUnitario = Number(producto.precio || 0);
      const subtotal = precioUnitario * cantidadFinal;

      orden.items.push({
        id: producto.id,
        nombre: producto.nombre,
        cantidad: cantidadFinal,
        precio_unitario: precioUnitario,
        subtotal: subtotal
      });

      orden.total += subtotal;
    }

    // Guardar cambios en productos.json usando tu función guardar()
    guardar(); // esto hace writeFileSync a DATA_PATH

    // Guardar el pedido en un archivo de pedidos (array acumulado)
    const pedidosFile = path.join(PEDIDOS_PATH, 'pedidos.json');
    let pedidosArr = [];
    if (fs.existsSync(pedidosFile)) {
      try {
        const raw = fs.readFileSync(pedidosFile, 'utf8');
        pedidosArr = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(pedidosArr)) pedidosArr = [];
      } catch (e) {
        pedidosArr = [];
      }
    }

    // Añadimos la orden (si querés un id, lo agregamos aquí)
    pedidosArr.push(orden);
    fs.writeFileSync(pedidosFile, JSON.stringify(pedidosArr, null, 2));
    gitPushCambios();

    
    res.status(200).send('Pedidos guardados');
  } catch (err) {
    console.error('Error guardando pedido:', err);
    return res.status(500).json({ error: 'Error interno al guardar pedido' });
  }
});

// DELETE /api/eliminar-pedido/:usuario/:index
app.delete('/api/eliminar-pedido/:usuario/:index', async (req, res) => {
  const { usuario, index } = req.params;
  const idx = Number(index);

  // 1) borrar el PDF (si existe)
  try {
    const pdfPath = path.join(PEDIDOS_PATH, `${usuario}-${index}.pdf`);
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
  } catch (err) {
    console.error('Error borrando PDF (se continua):', err);
  }

  // 2) actualizar pedidos/pedidos.json (buscamos la N-ésima orden del usuario)
  try {
    const pedidosFile = path.join(PEDIDOS_PATH, 'pedidos.json');
    if (!fs.existsSync(pedidosFile)) {
      return res.status(404).send('No existe archivo de pedidos en servidor.');
    }

    const raw = fs.readFileSync(pedidosFile, 'utf8') || '[]';
    let pedidosArr;
    try { pedidosArr = JSON.parse(raw); } catch (e) { pedidosArr = []; }

    if (!Array.isArray(pedidosArr) || pedidosArr.length === 0) {
      return res.status(404).send('No hay pedidos registrados.');
    }

    // encontrar la posición global (en el array) de la idx-ésima orden de este usuario
    let foundPos = -1;
    let count = 0;
    for (let i = 0; i < pedidosArr.length; i++) {
      if ((pedidosArr[i].user || '') === usuario) {
        if (count === idx) { foundPos = i; break; }
        count++;
      }
    }

    if (foundPos === -1) {
      return res.status(404).send('Pedido no encontrado para ese usuario/index.');
    }

    // quitar la orden del arreglo
    const removed = pedidosArr.splice(foundPos, 1);

    // escribir archivo actualizado
    fs.writeFileSync(pedidosFile, JSON.stringify(pedidosArr, null, 2));

    // 3) intentar push a Github (no hacemos fallar la respuesta si falla el push)
    try {
      if (typeof gitPushCambios === 'function') {
        gitPushCambios();
      }
    } catch (e) {
      console.error('Aviso: fallo al pushear cambios tras eliminar pedido:', e);
      // seguimos, porque ya actualizamos el archivo localmente
    }

    return res.send({ ok: true, mensaje: 'Pedido eliminado y registro actualizado', eliminado: removed[0] || null });
  } catch (err) {
    console.error('Error eliminando pedido en servidor:', err);
    return res.status(500).send('Error interno al eliminar pedido');
  }
});
/* ========================
     OBTENER PEDIDOS
======================== */
app.get('/api/pedidos', (req, res) => {
  try {
    const pedidosFile = path.join(PEDIDOS_PATH, 'pedidos.json');
    if (!fs.existsSync(pedidosFile)) {
      return res.json({});
    }

    const raw = fs.readFileSync(pedidosFile, 'utf8') || '[]';
    let arr = [];
    try { arr = JSON.parse(raw); } catch { arr = []; }

    // Transformar array -> objeto por usuario
    const map = {};
    for (const orden of arr) {
      const u = orden.user || 'invitado';
      if (!map[u]) map[u] = [];

      const items = (orden.items || []).map(it => ({
        id: it.id,
        nombre: it.nombre,
        cantidad: it.cantidad,
        precio: it.precio_unitario ?? 0
      }));
      map[u].push(items);
    }

    res.json(map);
  } catch (err) {
    console.error('Error GET /api/pedidos:', err);
    res.status(500).json({});
  }
});


/* ========================
          SERVIDOR
======================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));







