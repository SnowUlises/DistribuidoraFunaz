import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PDF_PATH = path.join(process.cwd(), 'public', 'pedidos-pdf');
if (!fs.existsSync(PDF_PATH)) fs.mkdirSync(PDF_PATH, { recursive: true });

app.put('/api/actualizar-pedido/:id', async (req, res) => {
  try {
    const pedidoId = req.params.id;
    const { items, stockUpdates } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items inválidos' });
    }
    // Actualizar stock solo para ítems con cantidad aumentada
    for (const update of stockUpdates) {
      const { data: prod } = await supabase
        .from('productos')
        .select('*')
        .eq('id', update.id)
        .single();
      if (prod) {
        const newStock = Math.max(0, (Number(prod.stock) || 0) - update.cantidad);
        const { error: updErr } = await supabase
          .from('productos')
          .update({ stock: newStock })
          .eq('id', update.id);
        if (updErr) console.error('❌ Error actualizando stock:', updErr);
      }
    }
    // Actualizar el pedido en la base de datos
    const total = items.reduce((sum, item) => sum + (item.cantidad * item.precio_unitario), 0);
    const { error } = await supabase
      .from('pedidos')
      .update({ items, total })
      .eq('id', pedidoId);
    if (error) {
      console.error('❌ Error actualizando pedido:', error);
      return res.status(500).json({ error: `Error al actualizar el pedido: ${error.message}` });
    }
    res.json({ ok: true, mensaje: 'Pedido actualizado' });
  } catch (err) {
    console.error('❌ Exception en actualizar-pedido:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

app.post('/api/generar-pdf-peticion', async (req, res) => {
  try {
    const { user, items, total, fecha } = req.body;
    if (!user || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Datos inválidos: user o items faltantes' });
    }
    // Validar y preparar datos para el PDF
    const pedido = {
      id: `preview_${Date.now()}`, // ID único temporal para el PDF
      user: user || 'Invitado',
      items: items.map(item => ({
        id: item.id,
        nombre: item.nombre,
        cantidad: Number(item.cantidad) || 0,
        precio_unitario: Number(item.precio_unitario * 1.1) || 0,
        subtotal: Number(item.subtotal) || 0
      })),
      total: Number(total) || 0,
      fecha: fecha || new Date().toISOString()
    };
    // Generar PDF
    const pdfBuffer = await generarPDF(pedido);
    // Subir a Storage con nombre único
    const pdfFileName = `preview_${pedido.id}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('pedidos-pdf')
      .upload(pdfFileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadErr) {
      console.error('❌ Error subiendo PDF:', uploadErr);
      return res.status(500).json({ error: 'No se pudo subir el PDF' });
    }
    // Generar URL firmada
    const { data: signed, error: signedErr } = await supabase
      .storage
      .from('pedidos-pdf')
      .createSignedUrl(pdfFileName, 60 * 60 * 24 * 7); // 7 días de expiración
    if (signedErr) {
      console.error('❌ Error generando URL firmada:', signedErr);
      return res.status(500).json({ error: 'No se pudo obtener URL del PDF' });
    }
    const url = signed.signedUrl;
    res.json({ ok: true, pdf: url });
  } catch (err) {
    console.error('❌ Error en generar-pdf-peticion:', err);
    res.status(500).json({ error: err.message || 'Error generando PDF de petición' });
  }
});

app.delete('/api/peticiones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('Peticiones')
      .delete()
      .eq('id', id);
    if (error) {
      console.error('❌ Supabase delete error:', error);
      return res.status(500).json({ error: `Error al eliminar la petición: ${error.message}` });
    }
    res.json({ ok: true, mensaje: 'Petición eliminada' });
  } catch (err) {
    console.error('❌ Exception en DELETE /api/peticiones:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});
/* -----------------------------
 📦 LISTAR PRODUCTOS
----------------------------- */
app.get('/api/productos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('productos').select('*');
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando productos:', err);
    res.status(500).json({ error: 'No se pudieron cargar productos' });
  }
});
/* -----------------------------
 📦 LISTAR PEDIDOS
----------------------------- */
app.get('/api/pedidos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pedidos')
      .select('*')
      .order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando pedidos:', err);
    res.status(500).json({ error: 'No se pudieron cargar pedidos' });
  }
});
app.get('/api/peticiones', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('Peticiones')
      .select('*')
      .order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('❌ Error cargando peticiones:', err);
    res.status(500).json({ error: 'No se pudieron cargar peticiones' });
  }
});
app.get('/api/pedidos/:id/pdf', async (req, res) => {
  try {
    const pedidoId = req.params.id;
    const { data: pedido, error: pedidoErr } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single();
    if (pedidoErr || !pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    // Generar PDF
    const pdfBuffer = await generarPDF(pedido);
    // Subir a Storage
    const pdfFileName = `pedido_${pedidoId}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('pedidos-pdf')
      .upload(pdfFileName, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });
    if (uploadErr) return res.status(500).json({ error: 'No se pudo subir el PDF' });
    // Siempre generar URL firmada para asegurar acceso (funciona para buckets públicos o privados)
    const { data: signed, error: signedErr } = await supabase
      .storage
      .from('pedidos-pdf')
      .createSignedUrl(pdfFileName, 60 * 60 * 24 * 7); // 7 días de expiración
    if (signedErr) return res.status(500).json({ error: 'No se pudo obtener URL del PDF' });
    const url = signed.signedUrl;
    return res.json({ ok: true, pdf: url });
  } catch (err) {
    console.error('❌ PDF error:', err);
    res.status(500).json({ error: err.message || 'Error generando PDF' });
  }
});
/* -----------------------------
 📦 GUARDAR PEDIDOS
----------------------------- */
app.post('/api/guardar-pedidos', async (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0) {
      return res.status(400).json({ error: 'Pedido inválido' });
    }
    let total = 0;
    const items = [];
    // Start a transaction
    for (const it of pedidoItems) {
      const prodId = it.id;
      const { data: prod, error: prodError } = await supabase
        .from('productos')
        .select('*')
        .eq('id', prodId)
        .single();
      if (prodError || !prod) {
        return res.status(400).json({ error: `Producto con ID ${prodId} no encontrado` });
      }
      const cantidadFinal = Number(it.cantidad) || 0;
      if (cantidadFinal <= 0) {
        return res.status(400).json({ error: `Cantidad inválida para producto ${prodId}` });
      }
      // Validate stock
      const currentStock = Number(prod.stock) || 0;
      if (currentStock < cantidadFinal) {
        return res.status(400).json({ error: `Stock insuficiente para producto ${prod.nombre} (ID: ${prodId})` });
      }
      const precioUnitario = Number(it.precio ?? it.precio_unitario ?? prod.precio) || 0;
      const subtotal = cantidadFinal * precioUnitario;
      total += subtotal;
      items.push({
        id: prodId,
        nombre: prod.nombre,
        cantidad: cantidadFinal,
        precio_unitario: precioUnitario,
        subtotal
      });
      // Update stock
      const newStock = currentStock - cantidadFinal;
      const { error: updErr } = await supabase
        .from('productos')
        .update({ stock: newStock })
        .eq('id', prodId);
      if (updErr) {
        return res.status(500).json({ error: `Error actualizando stock para producto ${prodId}: ${updErr.message}` });
      }
    }
    if (items.length === 0) {
      return res.status(400).json({ error: 'No hay items válidos para el pedido' });
    }
    const id = Date.now().toString();
    const payload = { id, user: usuarioPedido, fecha: new Date().toISOString(), items, total };
    console.log('💾 Guardando pedido:', payload);
    const { data, error } = await supabase
      .from('pedidos')
      .insert([payload])
      .select()
      .single();
    if (error) {
      return res.status(500).json({ error: `Error al guardar el pedido: ${error.message}` });
    }
    const returnedId = data?.id ?? id;
    res.json({
      ok: true,
      mensaje: 'Pedido guardado',
      id: returnedId,
      endpoint_pdf: `/api/pedidos/${returnedId}/pdf`
    });
  } catch (err) {
    console.error('❌ Exception en guardar-pedidos:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});
app.post('/api/Enviar-Peticion', async (req, res) => {
    try {
        console.log('Received payload:', JSON.stringify(req.body, null, 2)); // Log payload for debugging
        const { nombre, telefono, items: pedidoItems, total: providedTotal } = req.body;
        // Validate input
        if (!nombre || !telefono || !Array.isArray(pedidoItems) || pedidoItems.length === 0) {
            return res.status(400).json({ error: 'Petición inválida: nombre, telefono, o items faltantes' });
        }
        // Convert telefono to integer
        const telefonoNum = parseInt(telefono.replace(/\D/g, '')); // Remove non-digits
        if (isNaN(telefonoNum)) {
            return res.status(400).json({ error: 'Número de teléfono inválido' });
        }
        let total = 0;
        const processedItems = [];
        // Process each item
        for (const it of pedidoItems) {
            const prodId = it.id;
            if (!prodId) {
                console.warn(`⚠️ Item sin ID: ${JSON.stringify(it)}`);
                continue;
            }
            // Fetch product
            const { data: prod, error: prodError } = await supabase
                .from('productos')
                .select('*')
                .eq('id', prodId)
                .single();
            if (prodError || !prod) {
                console.warn(`⚠️ Producto no encontrado para ID ${prodId}:`, prodError?.message || 'No product');
                continue;
            }
            const cantidadFinal = Number(it.cantidad) || 0;
            if (cantidadFinal <= 0) {
                console.warn(`⚠️ Cantidad inválida para producto ${prodId}: ${it.cantidad}`);
                continue;
            }
            const precioUnitario = Number(it.precio ?? prod.precio) || 0;
            const subtotal = cantidadFinal * precioUnitario;
            total += subtotal;
            processedItems.push({
                id: prodId,
                nombre: prod.nombre,
                cantidad: cantidadFinal,
                precio_unitario: precioUnitario,
                subtotal
            });
        }
        if (processedItems.length === 0) {
            return res.status(400).json({ error: 'No hay items válidos para la petición' });
        }
        // Round total to integer for int8 column
        const totalInt = Math.round(total);
        // Insert into Peticiones table
        const payload = {
            nombre,
            telefono: telefonoNum,
            items: processedItems,
            total: totalInt,
            fecha: new Date().toISOString()
        };
        console.log('💾 Guardando petición:', payload);
        const { data, error } = await supabase
            .from('Peticiones')
            .insert([payload])
            .select()
            .single();
        if (error) {
            console.error('❌ Supabase insert error:', error);
            return res.status(500).json({ error: `Error al guardar la petición: ${error.message}` });
        }
        const returnedId = data?.id;
        res.json({
            ok: true,
            mensaje: 'Petición guardada',
            id: returnedId
        });
    } catch (err) {
        console.error('❌ Exception en Enviar-Peticion:', err);
        res.status(500).json({ error: err.message || 'Error interno del servidor' });
    }
});
async function generarPDF(pedido) {
  return new Promise((resolve, reject) => {
    const items = Array.isArray(pedido.items) ? pedido.items : [];
    const doc = new PDFDocument({
      size: [267, 862], // Tamaño fijo para impresora térmica
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Logo (centrado y más grande)
    const logoPath = path.join(process.cwd(), 'public', 'logo.png');
    if (fs.existsSync(logoPath)) {
      const logoWidth = 150; // Aumentado de 100 a 150 para hacerlo más grande
      const xPosition = (267 - logoWidth) / 2; // Cálculo para centrar (ancho página - ancho logo) / 2
      doc.image(logoPath, xPosition, 20, { width: logoWidth });
      doc.moveDown(10); // Ajustado para dar más espacio tras el logo más grande
    } else {
      doc.moveDown(3);
    }
    // Encabezado
    doc.font('Helvetica-Bold').fontSize(16).text(`${pedido.user || 'Invitado'}`, { align: 'center' }); // Reemplazo de "Distribuidora Funaz"
    doc.moveDown(1);
    doc.font('Helvetica').fontSize(14);
    doc.text(`Dirección: Calle Colon 1740 Norte`);
    doc.text(`Factura N°: ${pedido.id || ''}`);
    doc.text(`Pedidos: 2645583761`);
    doc.text(`Consultas: 2645156933`);
    doc.moveDown(1.5);
    const fecha = new Date(pedido.fecha || Date.now());
    doc.fontSize(14).text(`Fecha: ${fecha.toLocaleDateString()} ${fecha.toLocaleTimeString()}`, { align: 'center' });
    doc.moveDown(1.5);
    doc.moveTo(20, doc.y).lineTo(247, doc.y).stroke(); // Ajustado a 247 para respetar márgenes
    doc.moveDown(1.5);
    // Título
    doc.fontSize(18).font('Helvetica-Bold').text('PEDIDO', { underline: true, align: 'center' });
    doc.moveDown(2);
    // Ítems
    let total = 0;
    items.forEach(item => {
      const cant = Number(item.cantidad) || 0;
      const precio = Number(item.precio_unitario ?? item.precio) || 0;
      const subtotal = cant * precio;
      total += subtotal;
      doc.fontSize(14).font('Helvetica-Bold').text(`${item.nombre || ''}`);
      doc.font('Helvetica').fontSize(14);
      doc.text(`${cant} x $${precio.toFixed(2)}`, { continued: true });
      doc.text(` $${subtotal.toFixed(2)}`, { align: 'right' });
      doc.moveDown(1.2);
    });
    // Total
    doc.moveDown(2);
    doc.moveTo(20, doc.y).lineTo(247, doc.y).stroke();
    doc.moveDown(1.5);
    doc.fontSize(20).font('Helvetica-Bold').text(`TOTAL: $${total.toFixed(2)}`, { align: 'center' });
    doc.moveDown(3);
    doc.fontSize(14).text('¡Gracias por su compra!', { align: 'center' });
    doc.end();
  });
}
/* -----------------------------
 ❌ ELIMINAR PEDIDO
----------------------------- */
app.delete('/api/eliminar-pedido/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { recibido } = req.body; // Obtener el estado recibido del cuerpo de la solicitud
    console.log(`🗑️ Intentando eliminar pedido ID: ${id}, recibido: ${recibido}`);
    // Buscar el pedido en la base de datos
    const { data: pedido, error: pedidoError } = await supabase
      .from('pedidos')
      .select('*')
      .eq('id', id)
      .single();
    console.log('📦 Pedido encontrado:', pedido);
    if (pedidoError || !pedido) {
      console.error('❌ Pedido no encontrado:', pedidoError);
      return res.status(404).json({ error: 'Pedido no encontrado' });
    }
    // Restaurar stock solo si el pedido NO está marcado como recibido
    if (!recibido) {
      for (const it of pedido.items || []) {
        const prodId = it.id;
        console.log(`🔄 Restaurando stock para producto ${prodId} (+${it.cantidad})`);
        const { data: prod } = await supabase
          .from('productos')
          .select('*')
          .eq('id', prodId)
          .single();
        if (prod) {
          const newStock = (Number(prod.stock) || 0) + (Number(it.cantidad) || 0);
          await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
        }
      }
    } else {
      console.log('🚫 Pedido marcado como recibido, no se restaura el stock');
    }
    // Eliminar el pedido
    await supabase.from('pedidos').delete().eq('id', id);
    // Eliminar el PDF asociado (si existe)
    const { error: delErr } = await supabase.storage
      .from('pedidos-pdf')
      .remove([`pedido_${id}.pdf`]);
    if (delErr) console.warn('⚠️ Error borrando PDF:', delErr);
    else console.log(`🗑️ PDF pedido_${id}.pdf eliminado`);
    res.json({ ok: true, mensaje: `Pedido eliminado${!recibido ? ' y stock restaurado' : ''}`, pedidoId: id });
  } catch (err) {
    console.error('❌ Exception en eliminar-pedido:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});
app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});




