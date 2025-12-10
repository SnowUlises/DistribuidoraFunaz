import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(bodyParser.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const PDF_PATH = path.join(process.cwd(), 'public', 'pedidos-pdf');
if (!fs.existsSync(PDF_PATH)) fs.mkdirSync(PDF_PATH, { recursive: true });

/* =========================================================
   VARIABLES GLOBALES PARA EL MONITOR DE STOCK (BACKEND)
   ========================================================= */
// Mantiene una copia en memoria del stock para detectar cambios externos
let globalStockSnapshot = {}; 

/* =========================================================
   FUNCIONES AUXILIARES
   ========================================================= */

async function ejecutarLogicaMonitor() {
    try {
        // Bajamos la realidad actual de la DB
        const { data: productosDB } = await supabase.from('productos').select('*');
        if(!productosDB) return;

        let cambiosDetectados = 0;

        for (const p of productosDB) {
            const stockReal = Number(p.stock);
            const stockMemoria = globalStockSnapshot[p.id];

            // Caso A: Producto nuevo
            if (stockMemoria === undefined) {
                globalStockSnapshot[p.id] = stockReal;
                continue;
            }

            // Caso B: Desajuste detectado
            if (stockReal !== stockMemoria) {
                const diferencia = stockReal - stockMemoria;
                console.log(`⚠️ [Monitor] Cambio detectado en ${p.nombre}: ${stockMemoria} -> ${stockReal}`);
                
                await registrarMovimiento(
                    p.id, 
                    p.nombre, 
                    diferencia, 
                    stockMemoria, 
                    stockReal, 
                    'AJUSTE_DETECTADO_DB', 
                    'MONITOR_AUTO'
                );
                
                globalStockSnapshot[p.id] = stockReal;
                cambiosDetectados++;
            }
        }
        return cambiosDetectados;
    } catch (e) {
        console.error("Error en ciclo del monitor:", e);
        return 0;
    }
}

// 1. REGISTRAR MOVIMIENTO Y ACTUALIZAR MEMORIA
async function registrarMovimiento(prodId, nombre, cambio, stockAnt, stockNue, tipo, ref) {
  try {
    // A. Guardamos en la base de datos (Historial)
    await supabase.from('historial_stock').insert([{
      producto_id: prodId,
      producto_nombre: nombre,
      cantidad_cambio: cambio,
      stock_anterior: stockAnt,
      stock_nuevo: stockNue,
      tipo_movimiento: tipo,
      referencia_id: ref,
      fecha: new Date().toISOString()
    }]);

    // B. ACTUALIZAMOS LA FOTO EN MEMORIA (IMPORTANTE)
    // Esto evita que el monitor detecte este cambio legal como un "desajuste"
    globalStockSnapshot[prodId] = Number(stockNue);
    
  } catch (e) {
    console.error("Error registrando historial:", e);
  }
}

// 2. MONITOR DE STOCK (Se ejecuta automáticamente)
async function iniciarMonitorStock() {
    console.log("🔍 [Monitor] Iniciando vigilancia de stock...");

    // PASO 1: Carga inicial de la "foto"
    const { data: prods } = await supabase.from('productos').select('*');
    if(prods) {
        prods.forEach(p => {
            globalStockSnapshot[p.id] = Number(p.stock);
        });
        console.log(`📸 [Monitor] Foto inicial cargada: ${prods.length} productos.`);
    }

    // PASO 2: Bucle infinito (cada 60 segundos)
    setInterval(async () => {
        try {
            // Bajamos la realidad actual de la DB
            const { data: productosDB } = await supabase.from('productos').select('*');
            if(!productosDB) return;

            for (const p of productosDB) {
                const stockReal = Number(p.stock);
                const stockMemoria = globalStockSnapshot[p.id];

                // Caso A: Producto nuevo que no conocíamos
                if (stockMemoria === undefined) {
                    globalStockSnapshot[p.id] = stockReal;
                    continue;
                }

                // Caso B: El stock cambió sin pasar por nuestros endpoints de venta
                // (Ej: Alguien editó directo en Supabase o hubo un ajuste manual)
                if (stockReal !== stockMemoria) {
                    const diferencia = stockReal - stockMemoria;
                    console.log(`⚠️ [Monitor] Cambio detectado en ${p.nombre}: ${stockMemoria} -> ${stockReal}`);
                    
                    // Guardamos el historial automáticamente
                    await registrarMovimiento(
                        p.id, 
                        p.nombre, 
                        diferencia, 
                        stockMemoria, 
                        stockReal, 
                        'AJUSTE_DETECTADO_DB', 
                        'MONITOR_AUTO'
                    );
                    
                    // Actualizamos la foto para que coincida
                    globalStockSnapshot[p.id] = stockReal;
                }
            }
        } catch (e) {
            console.error("Error en ciclo del monitor:", e);
        }
    }, 60000); // 60000 ms = 1 minuto
}

// Iniciamos el monitor al arrancar el servidor
iniciarMonitorStock();


/* =========================================================
   ENDPOINTS (ACTUALIZADOS CON EL NUEVO REGISTRO)
   ========================================================= */

/* --- LEER HISTORIAL --- */
app.get('/api/historial', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('historial_stock')
      .select('*')
      .order('fecha', { ascending: false })
      .limit(500);

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* --- MARCAR REVISADO --- */
app.put('/api/historial-check/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('historial_stock')
      .update({ revisado: true })
      .eq('id', id);
    
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* --- ACTUALIZAR PEDIDO (MODIFICAR) --- */
app.put('/api/actualizar-pedido/:id', async (req, res) => {
  try {
    const pedidoId = req.params.id;
    const { items, stockUpdates } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items inválidos' });
    }
    
    // Actualizar stock
    for (const update of stockUpdates) {
      const { data: prod } = await supabase.from('productos').select('*').eq('id', update.id).single();
      if (prod) {
        const stockAnterior = Number(prod.stock ?? 0);
        const cantidadRestada = Number(update.cantidad ?? 0);
        const newStock = stockAnterior - cantidadRestada;
        
        const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', update.id);
        
        if (updErr) console.error('❌ Error actualizando stock:', updErr);
        else {
            // REGISTRO Y ACTUALIZACION DE SNAPSHOT
            await registrarMovimiento(update.id, prod.nombre, -cantidadRestada, stockAnterior, newStock, 'MODIF_PEDIDO', pedidoId);
        }
      }
    }
    
    // Actualizar pedido
    const total = items.reduce((sum, item) => sum + (item.cantidad * item.precio_unitario), 0);
    const { error } = await supabase.from('pedidos').update({ items, total }).eq('id', pedidoId);
    
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

/* --- GUARDAR PEDIDO (VENTA) --- */
app.post('/api/guardar-pedidos', async (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0) {
      return res.status(400).json({ error: 'Pedido inválido' });
    }
    let total = 0;
    const items = [];
    const id = Date.now().toString();

    // Loop de items
    for (const it of pedidoItems) {
      const prodId = it.id;
      const { data: prod, error: prodError } = await supabase.from('productos').select('*').eq('id', prodId).single();
      if (prodError || !prod) {
        return res.status(400).json({ error: `Producto con ID ${prodId} no encontrado` });
      }
      
      const cantidadFinal = Number(it.cantidad) || 0;
      if (cantidadFinal <= 0) {
        return res.status(400).json({ error: `Cantidad inválida para producto ${prodId}` });
      }
      
      const stockAnterior = Number(prod.stock) || 0;
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
      
      // Update DB
      const newStock = stockAnterior - cantidadFinal;
      const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
      
      if (updErr) {
        return res.status(500).json({ error: `Error actualizando stock para producto ${prodId}: ${updErr.message}` });
      } else {
        // REGISTRO Y ACTUALIZACION DE SNAPSHOT
        await registrarMovimiento(prodId, prod.nombre, -cantidadFinal, stockAnterior, newStock, 'VENTA', id);
      }
    }
    
    if (items.length === 0) return res.status(400).json({ error: 'No hay items válidos para el pedido' });
    
    const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const payload = { id, user: usuarioPedido, fecha: fechaLocal, items, total };
    console.log('💾 Guardando pedido:', payload);
    
    const { data, error } = await supabase.from('pedidos').insert([payload]).select().single();
    if (error) return res.status(500).json({ error: `Error al guardar el pedido: ${error.message}` });
    
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

app.post('/api/forzar-monitor', async (req, res) => {
    try {
        console.log("⚡ Forzando monitor desde frontend...");
        const cambios = await ejecutarLogicaMonitor();
        res.json({ ok: true, mensaje: 'Monitor ejecutado', cambios: cambios });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- ELIMINAR PEDIDO (RESTAURAR) --- */
app.delete('/api/eliminar-pedido/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { recibido } = req.body;
    console.log(`🗑️ Intentando eliminar pedido ID: ${id}, recibido: ${recibido}`);
    
    const { data: pedido, error: pedidoError } = await supabase.from('pedidos').select('*').eq('id', id).single();
    if (pedidoError || !pedido) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Restaurar stock si no fue recibido
    if (!recibido) {
      for (const it of pedido.items || []) {
        const prodId = it.id;
        console.log(`🔄 Restaurando stock para producto ${prodId} (+${it.cantidad})`);
        
        const { data: prod } = await supabase.from('productos').select('*').eq('id', prodId).single();
        if (prod) {
          const stockAnterior = Number(prod.stock) || 0;
          const cantidadRestaurar = Number(it.cantidad) || 0;
          const newStock = stockAnterior + cantidadRestaurar;
          
          const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
          
          if (!updErr) {
             // REGISTRO Y ACTUALIZACION DE SNAPSHOT
             await registrarMovimiento(prodId, prod.nombre, cantidadRestaurar, stockAnterior, newStock, 'ELIMINAR_PEDIDO', id);
          }
        }
      }
    }

    await supabase.from('pedidos').delete().eq('id', id);
    const { error: delErr } = await supabase.storage.from('pedidos-pdf').remove([`pedido_${id}.pdf`]);
    if (delErr) console.warn('⚠️ Error borrando PDF:', delErr);

    res.json({ ok: true, mensaje: 'Pedido eliminado y stock restaurado', pedidoId: id });
  } catch (err) {
    console.error('❌ Exception en eliminar-pedido:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

/* =========================================================
   RESTO DE ENDPOINTS (PDF, PETICIONES, LISTADOS)
   ========================================================= */

// GENERAR PDF DE PETICIÓN (PREVIEW)
app.post('/api/generar-pdf-peticion', async (req, res) => {
  try {
    const { user, items, total, fecha } = req.body;
    if (!user || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }
    const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const pedido = {
      id: `preview_${Date.now()}`,
      user: user || 'Invitado',
      items: items.map(item => ({
        id: item.id,
        nombre: item.nombre,
        cantidad: Number(item.cantidad) || 0,
        precio_unitario: Number(item.precio_unitario * 1.1) || 0,
        subtotal: Number(item.subtotal) || 0
      })),
      total: Number(total) || 0,
      fecha: fechaLocal || new Date().toISOString()
    };
    
    const pdfBuffer = await generarPDF(pedido);
    const pdfFileName = `preview_${pedido.id}.pdf`;
    
    const { error: uploadErr } = await supabase.storage.from('pedidos-pdf').upload(pdfFileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) return res.status(500).json({ error: 'No se pudo subir el PDF' });
    
    const { data: signed, error: signedErr } = await supabase.storage.from('pedidos-pdf').createSignedUrl(pdfFileName, 60 * 60 * 24 * 7);
    if (signedErr) return res.status(500).json({ error: 'No se pudo obtener URL' });
    
    res.json({ ok: true, pdf: signed.signedUrl });
  } catch (err) {
    console.error('❌ Error en generar-pdf-peticion:', err);
    res.status(500).json({ error: err.message });
  }
});

// ELIMINAR PETICIÓN
app.delete('/api/peticiones/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('Peticiones').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, mensaje: 'Petición eliminada' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LISTAR PRODUCTOS
app.get('/api/productos', async (req, res) => {
  try {
    const step = 1000;
    let from = 0;
    let all = [];
    let done = false;

    while (!done) {
      const { data, error } = await supabase.from('productos').select('*', { head: false }).range(from, from + step - 1);
      if (error) throw error;
      if (!data.length) done = true;
      else {
        all = all.concat(data);
        from += step;
      }
    }
    res.json(all);
  } catch (err) {
    console.error('❌ Error cargando productos:', err);
    res.status(500).json({ error: 'No se pudieron cargar productos' });
  }
});

// LISTAR PEDIDOS
app.get('/api/pedidos', async (req, res) => {
  try {
    const { data, error } = await supabase.from('pedidos').select('*').order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error cargando pedidos' });
  }
});

// LISTAR PETICIONES
app.get('/api/peticiones', async (req, res) => {
  try {
    const { data, error } = await supabase.from('Peticiones').select('*').order('fecha', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error cargando peticiones' });
  }
});

// OBTENER PDF DE UN PEDIDO
app.get('/api/pedidos/:id/pdf', async (req, res) => {
  try {
    const pedidoId = req.params.id;
    const { data: pedido, error: pedidoErr } = await supabase.from('pedidos').select('*').eq('id', pedidoId).single();
    if (pedidoErr || !pedido) return res.status(404).json({ error: 'Pedido no encontrado' });
    
    const pdfBuffer = await generarPDF(pedido);
    const pdfFileName = `pedido_${pedidoId}.pdf`;
    
    const { error: uploadErr } = await supabase.storage.from('pedidos-pdf').upload(pdfFileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) return res.status(500).json({ error: 'No se pudo subir PDF' });
    
    const { data: signed, error: signedErr } = await supabase.storage.from('pedidos-pdf').createSignedUrl(pdfFileName, 604800);
    if (signedErr) return res.status(500).json({ error: 'Error obteniendo URL' });
    
    res.json({ ok: true, pdf: signed.signedUrl });
  } catch (err) {
    console.error('❌ PDF error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GUARDAR PETICIÓN (ENVIAR)
app.post('/api/Enviar-Peticion', async (req, res) => {
    try {
        console.log('Received payload:', JSON.stringify(req.body, null, 2));
        const { nombre, telefono, items: pedidoItems } = req.body;
        
        if (!nombre || !telefono || !Array.isArray(pedidoItems) || pedidoItems.length === 0) {
            return res.status(400).json({ error: 'Datos incompletos' });
        }
        
        const telefonoNum = parseInt(telefono.replace(/\D/g, ''));
        if (isNaN(telefonoNum)) return res.status(400).json({ error: 'Teléfono inválido' });
        
        let total = 0;
        const processedItems = [];
        const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        
        for (const it of pedidoItems) {
            const prodId = it.id;
            const { data: prod, error: prodError } = await supabase.from('productos').select('*').eq('id', prodId).single();
            if (prodError || !prod) continue;
            
            const cantidadFinal = Number(it.cantidad) || 0;
            if (cantidadFinal <= 0) continue;
            
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
        
        if (processedItems.length === 0) return res.status(400).json({ error: 'No hay items válidos' });
        
        const totalInt = Math.round(total);
        const payload = {
            nombre,
            telefono: telefonoNum,
            items: processedItems,
            total: totalInt,
            fecha: fechaLocal
        };
        
        const { data, error } = await supabase.from('Peticiones').insert([payload]).select().single();
        if (error) return res.status(500).json({ error: error.message });
        
        res.json({ ok: true, mensaje: 'Petición guardada', id: data?.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* =========================================================
   GENERADOR DE PDF (USADO POR TODOS)
   ========================================================= */
async function generarPDF(pedido) {
  return new Promise(async (resolve, reject) => {
    const items = Array.isArray(pedido.items) ? pedido.items : [];
    const doc = new PDFDocument({
      size: [267, 862], 
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    
    // Logo
    const { data: logoBlob, error: logoError } = await supabase.storage.from('imagenes').download('logo.png');
    if (logoError) {
      console.error('Error downloading logo:', logoError);
    } else {
      const logoBuffer = Buffer.from(await logoBlob.arrayBuffer());
      doc.image(logoBuffer, 100, 20, { width: 100 });
      doc.moveDown(8);
    }
    
    // Encabezado
    doc.font('Helvetica-Bold').fontSize(16).text(`${pedido.user || 'Invitado'}`, { align: 'center' });
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
    doc.moveTo(20, doc.y).lineTo(247, doc.y).stroke();
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

app.listen(PORT, () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});

