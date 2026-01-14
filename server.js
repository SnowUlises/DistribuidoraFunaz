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


/* --- NUEVO: OBTENER LISTA SIMPLE DE CLIENTES PARA EL CARRITO --- */
app.get('/api/lista-clientes', async (req, res) => {
  try {
    // Solo traemos nombre y user_id para no cargar datos pesados
    const { data, error } = await supabase
      .from('clients_v2')
      .select('name, user_id')
      .order('name', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Error listando clientes:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/dump', async (req, res) => {
  try {
    // 1. Pedidos: Solo necesitamos fecha, total, usuario e items (para categorías)
    // Usamos .csv() o seleccionamos columnas específicas para reducir peso
    const { data: pedidos, error: errPed } = await supabase
      .from('pedidos')
      .select('id, user, total, fecha, items'); // Solo lo vital

    if (errPed) throw errPed;

    // 2. Productos: Necesario para saber la Categoría de cada item vendido
    const { data: productos, error: errProd } = await supabase
      .from('productos')
      .select('id, nombre, categoria, precio');

    if (errProd) throw errProd;

    res.json({ pedidos, productos });
  } catch (err) {
    console.error('❌ Error analytics dump:', err);
    res.status(500).json({ error: err.message });
  }
});

// MODIFICADO: Ahora acepta un parámetro opcional 'razonDetallada'
async function registrarMovimiento(prodId, nombre, cambio, stockAnt, stockNue, tipo, ref, razonDetallada = null) {
  try {
    // A. Guardamos en la base de datos (Historial oficial)
    await supabase.from('historial_stock').insert([{
      producto_id: prodId,
      producto_nombre: nombre,
      cantidad_cambio: cambio,
      stock_anterior: stockAnt,
      stock_nuevo: stockNue,
      tipo_movimiento: tipo,
      referencia_id: ref,
      razon: razonDetallada, // <--- NUEVA COLUMNA CON INFO DETALLADA
      fecha: new Date().toISOString()
    }]);

    const { error } = await supabase
        .from('monitor_snapshot')
        .upsert({ id: prodId, stock: stockNue });

    if (error) console.error("❌ Error actualizando snapshot en venta:", error.message);

  } catch (e) {
    console.error("Error registrando historial:", e);
  }
}

// 2. LÓGICA DEL MONITOR (CON PAGINACIÓN AUTOMÁTICA)
async function ejecutarLogicaMonitor() {
    try {
        // --- A. OBTENER REALIDAD (Tabla Productos - TODOS) ---
        let productosReales = [];
        let from = 0;
        const limit = 1000;
        let reading = true;

        // Bucle para leer de 1000 en 1000
        while (reading) {
            const { data, error } = await supabase
                .from('productos')
                .select('*')
                .range(from, from + limit - 1);

            if (error) {
                console.error("Error leyendo productos reales:", error);
                return 0; 
            }

            if (data && data.length > 0) {
                productosReales = productosReales.concat(data);
                if (data.length < limit) reading = false; // Terminamos
                else from += limit; // Siguiente página
            } else {
                reading = false;
            }
        }
        
        if (productosReales.length === 0) return 0;

        // --- B. OBTENER FOTO ANTERIOR (Tabla monitor_snapshot - TODAS) ---
        let snapshotData = [];
        from = 0;
        reading = true;

        while (reading) {
            const { data, error } = await supabase
                .from('monitor_snapshot')
                .select('*')
                .range(from, from + limit - 1);

            if (error) {
                console.error("Error leyendo snapshot:", error);
                return 0;
            }

            if (data && data.length > 0) {
                snapshotData = snapshotData.concat(data);
                if (data.length < limit) reading = false;
                else from += limit;
            } else {
                reading = false;
            }
        }

        // Mapeo para búsqueda rápida
        const snapshotMap = {};
        snapshotData.forEach(item => {
            snapshotMap[item.id] = Number(item.stock);
        });

        let cambiosDetectados = 0;
        let snapshotUpdates = [];

        // --- C. COMPARAR ---
        for (const prod of productosReales) {
            const stockReal = Number(prod.stock);
            const stockFoto = snapshotMap[prod.id]; 

            // Si hay diferencia o es un producto nuevo que no teníamos rastreado
            if (stockFoto !== undefined && stockReal !== stockFoto) {
                const diferencia = stockReal - stockFoto;
                console.log(`⚠️ [Monitor] Cambio detectado en ${prod.nombre}: ${stockFoto} -> ${stockReal}`);
                
                await supabase.from('historial_stock').insert([{
                    producto_id: prod.id,
                    producto_nombre: prod.nombre,
                    cantidad_cambio: diferencia,
                    stock_anterior: stockFoto,
                    stock_nuevo: stockReal,
                    tipo_movimiento: 'ajuste db',
                    referencia_id: 'MONITOR',
                    razon: 'Ajuste automático por discrepancia en DB',
                    fecha: new Date().toISOString()
                }]);
                
                cambiosDetectados++;
            }

            // Agregamos a la lista de actualizaciones si hubo cambio o si es nuevo
            if (stockFoto === undefined || stockReal !== stockFoto) {
                snapshotUpdates.push({ id: prod.id, stock: stockReal });
            }
        }

        // --- D. ACTUALIZAR SNAPSHOT (Por lotes para no saturar) ---
        if (snapshotUpdates.length > 0) {
            const batchSize = 1000;
            for (let i = 0; i < snapshotUpdates.length; i += batchSize) {
                const batch = snapshotUpdates.slice(i, i + batchSize);
                const { error: errUpsert } = await supabase
                    .from('monitor_snapshot')
                    .upsert(batch);
                
                if (errUpsert) console.error("Error guardando lote de snapshot:", errUpsert);
            }
            if (cambiosDetectados > 0) console.log(`✅ Snapshot actualizado (${snapshotUpdates.length} items procesados).`);
        }
        
        return cambiosDetectados;

    } catch (e) {
        console.error("Error crítico en monitor:", e);
        return 0;
    }
}

// 3. INICIAR MONITOR AUTOMÁTICO
function iniciarMonitorStock() {
    console.log("🔍 [Monitor] Iniciando vigilancia de stock (Vía Tabla DB)...");

    // Ejecución inicial inmediata para cargar la primera foto si está vacía
    ejecutarLogicaMonitor();

    // Intervalo automático (cada 60 segundos)
    setInterval(async () => {
        await ejecutarLogicaMonitor();
    }, 60000); 
}

// Iniciamos el monitor al arrancar el servidor
iniciarMonitorStock();


/* =========================================================
   ENDPOINTS
   ========================================================= */

/* --- NUEVO: FORZAR MONITOR DESDE FRONTEND --- */
app.post('/api/forzar-monitor', async (req, res) => {
    try {
        console.log("⚡ Forzando monitor desde frontend...");
        const cambios = await ejecutarLogicaMonitor();
        res.json({ ok: true, mensaje: 'Monitor ejecutado', cambios: cambios });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- LEER HISTORIAL --- */
/* --- LEER HISTORIAL (CON RANGO DE FECHAS) --- */
app.get('/api/historial', async (req, res) => {
  try {
    // 1. Recibimos las fechas del frontend (si no envían, usamos valores por defecto)
    const { desde, hasta } = req.query;

    let query = supabase
      .from('historial_stock')
      .select('*')
      .order('fecha', { ascending: false });

    // 2. Si hay fechas, filtramos. Si no, limitamos a 500 por seguridad.
    if (desde && hasta) {
        query = query.gte('fecha', desde).lte('fecha', hasta);
    } else {
        query = query.limit(500);
    }

    const { data, error } = await query;

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

    // --- NUEVO: Obtener datos del pedido original para el historial detallado ---
    const { data: datosPedido } = await supabase
        .from('pedidos')
        .select('user, nombre_negocio, fecha')
        .eq('id', pedidoId)
        .single();

    const nombreCliente = datosPedido?.user || 'Desconocido';
    const nombreNegocio = datosPedido?.nombre_negocio || 'Sin Negocio';
    const fechaPedido = datosPedido?.fecha ? new Date(datosPedido.fecha).toLocaleDateString() : 'Sin Fecha';
    
    const razonString = `Modif. Pedido #${pedidoId} | Cliente: ${nombreCliente} | Negocio: ${nombreNegocio} | Fecha: ${fechaPedido}`;
    // --------------------------------------------------------------------------
    
    // 1. Actualizar stock
    for (const update of stockUpdates) {
      const { data: prod } = await supabase.from('productos').select('*').eq('id', update.id).single();
      if (prod) {
        const stockAnterior = Number(prod.stock ?? 0);
        const cantidadRestada = Number(update.cantidad ?? 0);
        const newStock = stockAnterior - cantidadRestada;
        
        const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', update.id);
        
        if (updErr) console.error('❌ Error actualizando stock:', updErr);
        else {
            // PASAMOS LA RAZÓN DETALLADA AQUI
            await registrarMovimiento(update.id, prod.nombre, -cantidadRestada, stockAnterior, newStock, 'MODIF_PEDIDO', pedidoId, razonString);
        }
      }
    }
    
    // 2. Calcular nuevo total
    const total = items.reduce((sum, item) => sum + (item.cantidad * item.precio_unitario), 0);
    
    // 3. Actualizar tabla 'pedidos'
    const { error } = await supabase.from('pedidos').update({ items, total }).eq('id', pedidoId);
    
    if (error) {
      console.error('❌ Error actualizando pedido:', error);
      return res.status(500).json({ error: `Error al actualizar el pedido: ${error.message}` });
    }

    // =========================================================================
    // --- NUEVO: SINCRONIZAR CON DEUDAS + REGISTRAR HISTORIAL DETALLADO ---
    // =========================================================================
    try {
        // [CAMBIO 1] Agregamos 'nombre_negocio' al select
        const { data: pedidoInfo } = await supabase
            .from('pedidos')
            .select('user_id, estado, nombre_negocio') 
            .eq('id', pedidoId)
            .single();

        if (pedidoInfo && pedidoInfo.user_id && pedidoInfo.estado === 'Preparado') {
            
            runInQueue(pedidoInfo.user_id, async () => {
                const { data: clients } = await supabase.from('clients_v2').select('*').eq('user_id', pedidoInfo.user_id);
                
                if (clients && clients.length > 0) {
                    const cliente = clients[0];
                    let deudaItems = cliente.data.items || [];
                
                    // B. BUSCAR Y ACTUALIZAR
                    const indexDeuda = deudaItems.findIndex(i => i.id === String(pedidoId) && i.type === 'debt');
                    
                    if (indexDeuda !== -1) {
                         const montoNuevo = Math.round(total);
                         const montoAnterior = deudaItems[indexDeuda].amount;
                         
                         // Solo si el monto cambió
                         if (montoAnterior !== montoNuevo) {
                             
                             // --- PREPARAR DATOS VISUALES ---
                             const idVis = String(pedidoId).slice(-4);
                             const negocioStr = pedidoInfo.nombre_negocio ? ` | ${pedidoInfo.nombre_negocio}` : '';
                             const fmtAnt = montoAnterior.toLocaleString('es-AR');
                             const fmtNew = montoNuevo.toLocaleString('es-AR');
                             
                             const mensajeDetallado = `🔄 Update Pedido #${idVis}${negocioStr} ($${fmtAnt} ➔ $${fmtNew})`;
                             // -------------------------------

                             console.log(mensajeDetallado);
                             
                             // TOMAR SNAPSHOT
                             const oldItemsSnapshot = JSON.parse(JSON.stringify(deudaItems)); 
                             
                             // 1. Modificamos el monto en la lista actual
                             deudaItems[indexDeuda].amount = montoNuevo;
                             
                             // [OPCIONAL] Actualizamos también la nota si cambió el nombre del negocio
                             if(pedidoInfo.nombre_negocio) {
                                 deudaItems[indexDeuda].notes = pedidoInfo.nombre_negocio;
                             }
                      
                             // 2. Preparamos el Historial
                             let history = cliente.data.history || [];
                             history.unshift({
                                 timestamp: Date.now(),
                                 items: oldItemsSnapshot,
                                 action: mensajeDetallado, // <--- USAMOS EL MENSAJE DETALLADO
                                 type: 'edit' // Icono de edición (lápiz o similar)
                             });

                             if (history.length > 500) history.pop();

                             // 3. Guardamos TODO
                             await supabase
                                 .from('clients_v2')
                                 .update({ 
                                     data: { 
                                         ...cliente.data, 
                                         items: deudaItems,
                                         history: history 
                                     } 
                                 })
                                 .eq('id', cliente.id);
                         }
                    }
                }
            });
        }
    } catch (errSync) {
        console.error("⚠️ Error menor sincronizando deuda:", errSync);
    }
    // =========================================================================

    res.json({ ok: true, mensaje: 'Pedido actualizado y sincronizado con historial' });

  } catch (err) {
    console.error('❌ Exception en actualizar-pedido:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
  }
});

/* --- GUARDAR PEDIDO (VENTA / ACEPTAR PETICIÓN) --- */
app.post('/api/guardar-pedidos', async (req, res) => {
  try {
    const pedidoItems = req.body.pedido;
    // Capturamos el nombre de usuario (fallback a 'usuario' o 'invitado')
    const usuarioPedido = req.body.user || req.body.usuario || 'invitado';
    
    // 🔥 CORRECCIÓN CLAVE: Capturar IDs y Datos de Negocio
    // Agregamos fallbacks por si el frontend los envía con otros nombres comunes (uid, negocio)
    const userId = req.body.user_id || req.body.uid || null;
    const nombreNegocio = req.body.nombre_negocio || req.body.negocio || null; 

    if (!Array.isArray(pedidoItems) || pedidoItems.length === 0) {
      return res.status(400).json({ error: 'Pedido inválido' });
    }

    let total = 0;
    const items = [];
    // Usamos timestamp para el ID, asegurando que sea string
    const id = Date.now().toString();

    // --- Procesamiento de Items y Stock ---
    for (const it of pedidoItems) {
      const prodId = it.id;
      // Consultar producto actual en DB
      const { data: prod, error: prodError } = await supabase.from('productos').select('*').eq('id', prodId).single();
      
      if (prodError || !prod) {
        return res.status(400).json({ error: `Producto con ID ${prodId} no encontrado` });
      }
      
      const cantidadFinal = Number(it.cantidad) || 0;
      if (cantidadFinal <= 0) {
        return res.status(400).json({ error: `Cantidad inválida para producto ${prodId}` });
      }
      
      const stockAnterior = Number(prod.stock) || 0;
      // Prioridad: Precio del item (si hubo descuento/edición) > Precio DB
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
      
      // Actualizar Stock en DB
      const newStock = stockAnterior - cantidadFinal;
      const { error: updErr } = await supabase.from('productos').update({ stock: newStock }).eq('id', prodId);
      
      if (updErr) {
        return res.status(500).json({ error: `Error actualizando stock para producto ${prodId}: ${updErr.message}` });
      } else {
        // Registrar movimiento en historial y snapshot
        await registrarMovimiento(prodId, prod.nombre, -cantidadFinal, stockAnterior, newStock, 'VENTA', id);
      }
    }
    
    if (items.length === 0) return res.status(400).json({ error: 'No hay items válidos para el pedido' });
    
    // Ajuste de fecha local (GMT-3 aprox)
    const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    
    // --- 🔥 ARMADO DEL PAYLOAD CON LOS DATOS DE USUARIO Y NEGOCIO ---
    const payload = { 
        id, 
        user: usuarioPedido, 
        fecha: fechaLocal, 
        items, 
        total,
        user_id: userId,
        nombre_negocio: nombreNegocio
    };
    
    console.log('💾 Guardando pedido completo:', payload);
    
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

/* --- ELIMINAR PEDIDO (RESTAURAR) --- */
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
      const razonRestauracion = `Restauración por eliminación de Pedido #${id} (${pedido.user})`; // Info básica

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
             // MODIFICADO: Pasamos la razón
             await registrarMovimiento(prodId, prod.nombre, cantidadRestaurar, stockAnterior, newStock, 'ELIMINAR_PEDIDO', id, razonRestauracion);
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


app.post('/api/generar-pdf-masivo', async (req, res) => {
  try {
    const { pedidos } = req.body; 
    
    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      return res.status(400).json({ error: 'Lista de pedidos inválida' });
    }

    console.log(`🚀 Streaming PDF Gigante de ${pedidos.length} pedidos...`);

    // 1. Configurar cabeceras para que el navegador sepa que es un PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=pedidos_masivos_${Date.now()}.pdf`);

    const doc = new PDFDocument({
      size: [267, 862], 
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
      autoFirstPage: false
    });
    doc.pipe(res);

    // 4. Cargar logo una sola vez (caché en memoria de esta petición)
    let logoBuffer = null;
    try {
        const { data: logoBlob } = await supabase.storage.from('imagenes').download('logo.png');
        if (logoBlob) logoBuffer = Buffer.from(await logoBlob.arrayBuffer());
    } catch (e) {
        console.error("No se pudo cargar logo, continuando sin él.");
    }

    // 5. Iterar y dibujar usando tu función auxiliar existente 'dibujarPedidoEnDoc'
    for (const pedido of pedidos) {
        // Añadimos página para este pedido
        doc.addPage({ size: [267, 862], margins: { top: 20, bottom: 20, left: 20, right: 20 } });
        
        await dibujarPedidoEnDoc(doc, pedido, logoBuffer);
    }

    // 6. Cerrar el documento (esto termina la transmisión al navegador)
    doc.end();

  } catch (err) {
    console.error('❌ Error generando PDF Masivo (Stream):', err);
    if (!res.headersSent) {
        res.status(500).json({ error: err.message });
    } else {
        res.end();
    }
  }
});

// GENERAR PDF DE PETICIÓN (PREVIEW) - 🔥 AHORA SÍ MUESTRA EL NEGOCIO
app.post('/api/generar-pdf-peticion', async (req, res) => {
  try {
    const { user, items, total, fecha, nombre_negocio } = req.body;

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
        precio_unitario: Number(item.precio_unitario) || 0, 
        subtotal: Number(item.subtotal) || 0
      })),
      total: Number(total) || 0,
      fecha: fechaLocal || new Date().toISOString(),
      nombre_negocio: nombre_negocio 
    };
    
    const pdfBuffer = await generarPDF(pedido);
    const pdfFileName = `_${pedido.id}.pdf`;
    
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

// HISTORIAL DE USUARIO
app.get('/api/mis-pedidos', async (req, res) => {
  try {
    const userId = req.query.uid;
    if (!userId) return res.status(400).json({ error: 'Falta User ID' });

    // 1. Buscar en Peticiones (Pendientes)
    const { data: peticiones, error: errPet } = await supabase
      .from('Peticiones')
      .select('*')
      .eq('user_id', userId);
    if (errPet) throw errPet;

    // 2. Buscar en Pedidos (Aprobados)
    const { data: pedidos, error: errPed } = await supabase
      .from('pedidos')
      .select('*')
      .eq('user_id', userId);
    if (errPed) throw errPed;

    // 3. Unificar y etiquetar
    const listaPeticiones = (peticiones || []).map(p => ({
      ...p, tipo: 'peticion', estado_etiqueta: '⏳ Pendiente', color_estado: '#FF9800'
    }));
    const listaPedidos = (pedidos || []).map(p => ({
      ...p, tipo: 'pedido', estado_etiqueta: '✅ Preparado', color_estado: '#4CAF50'
    }));

    const historial = [...listaPeticiones, ...listaPedidos].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    res.json(historial);
  } catch (err) {
    console.error('❌ Error cargando historial:', err);
    res.status(500).json({ error: 'Error al obtener historial' });
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

app.post('/api/Enviar-Peticion', async (req, res) => {
    try {
        console.log('Received payload:', JSON.stringify(req.body, null, 2));
        
        // 1. Extraer datos (AGREGAMOS 'telefono')
        let { nombre, telefono, items: pedidoItems, total: providedTotal, user_id, nombre_negocio } = req.body;
        
        // Remove "Nombre: " prefix if present
        if (nombre && nombre.startsWith('Nombre: ')) {
            nombre = nombre.slice('Nombre: '.length).trim();
        }

        // 2. Validación
        if (!nombre || !Array.isArray(pedidoItems) || pedidoItems.length === 0) {
            return res.status(400).json({ error: 'Petición inválida: nombre o items faltantes' });
        }

        // 3. Procesar items
        let total = 0;
        const processedItems = [];
        
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
        const fechaLocal = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
        let telefonoLimpio = null;
        if (telefono) {
            telefonoLimpio = telefono.toString().replace(/\D/g, ''); 
            // Si quedó vacío después de limpiar (ej: el usuario puso "no tengo"), enviamos null
            if (telefonoLimpio === '') telefonoLimpio = null;
        }

        // 4. Payload CON telefono
        const payload = {
            nombre,
            telefono: telefonoLimpio, // <--- AQUÍ SE GUARDA EL DATO
            items: processedItems,
            total: totalInt,
            fecha: fechaLocal,
            user_id: user_id || null,
            nombre_negocio: nombre_negocio || null
        };
        
        console.log('💾 Guardando petición:', payload);

        const { data, error } = await supabase.from('Peticiones').insert([payload]).select().single();
        if (error) return res.status(500).json({ error: error.message });
        
        res.json({ ok: true, mensaje: 'Petición guardada', id: data?.id });
    } catch (err) {
        console.error('❌ Exception en Enviar-Peticion:', err);
        res.status(500).json({ error: err.message });
    }
});

/* =========================================================
   GENERADOR DE PDF (LÓGICA COMPARTIDA)
   ========================================================= */

async function dibujarPedidoEnDoc(doc, pedido, logoBuffer) {
    if (logoBuffer) {
      doc.image(logoBuffer, 100, 20, { width: 100 });
    }
    doc.moveDown(8);
    
    // 🔥 CAMBIO: Encabezado con Nombre y debajo el Negocio centrado
    doc.font('Helvetica-Bold').fontSize(16).text(`${pedido.user || 'Invitado'}`, { align: 'center' });
    
    if (pedido.nombre_negocio) {
        doc.fontSize(14).font('Helvetica-Bold').text(`${pedido.nombre_negocio}`, { align: 'center' });
    }

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
    const items = Array.isArray(pedido.items) ? pedido.items : [];
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
}

// Función para generar PDF individual (usa la lógica compartida)
async function generarPDF(pedido) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({
      size: [267, 862], 
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    
    try {
        const { data: logoBlob } = await supabase.storage.from('imagenes').download('logo.png');
        const logoBuffer = logoBlob ? Buffer.from(await logoBlob.arrayBuffer()) : null;
        
        await dibujarPedidoEnDoc(doc, pedido, logoBuffer);
        doc.end();
    } catch (e) {
        reject(e);
    }
  });
}

// Función para generar PDF MASIVO (concatenado)
async function generarPDFMasivo(pedidos) {
  return new Promise(async (resolve, reject) => {
    const doc = new PDFDocument({
      size: [267, 862], 
      margins: { top: 20, bottom: 20, left: 20, right: 20 },
      autoFirstPage: false 
    });
    
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    
    try {
        // Cargar logo una sola vez
        const { data: logoBlob } = await supabase.storage.from('imagenes').download('logo.png');
        const logoBuffer = logoBlob ? Buffer.from(await logoBlob.arrayBuffer()) : null;
        
        // Iterar y agregar páginas
        for (const pedido of pedidos) {
            doc.addPage({ size: [267, 862], margins: { top: 20, bottom: 20, left: 20, right: 20 } });
            await dibujarPedidoEnDoc(doc, pedido, logoBuffer);
        }
        
        doc.end();
    } catch (e) {
        reject(e);
    }
  });
}


/* =========================================================
   SISTEMA DE COLAS (Pegar esto al inicio del archivo o antes de las rutas)
   ========================================================= */
const userQueues = {};

function runInQueue(userId, task) {
    if (!userQueues[userId]) {
        userQueues[userId] = Promise.resolve();
    }
    const nextTask = userQueues[userId].then(() => task()).catch(err => console.error("Error en cola:", err));
    userQueues[userId] = nextTask;
    return nextTask;
}

/* =========================================================
   ENDPOINT MODIFICADO (REEMPLAZAR EL TUYO POR ESTE)
   ========================================================= */
app.put('/api/actualizar-estado-pedido/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body; 

    // 1. Actualizar estado en pedidos (Esto pasa inmediatamente)
    const { data: pedidoActualizado, error } = await supabase
      .from('pedidos')
      .update({ estado })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    // LÓGICA DE COBRANZAS (Solo si pasa a Preparado)
    if (estado === 'Preparado') {
        const pedido = pedidoActualizado;

        if (!pedido.user_id) {
            console.log(`⚠️ Pedido sin user_id. Se omite cobranza.`);
        } else {
            // 🔥 INICIO DE LA COLA
              runInQueue(pedido.user_id, async () => {
                  
                  // 2. BUSCAR CLIENTE
                  const { data: clientes } = await supabase
                      .from('clients_v2')
                      .select('*')
                      .eq('user_id', pedido.user_id);
              
                  if (clientes && clientes.length > 0) {
                      const cliente = clientes[0];
                      let items = cliente.data.items || [];
                      let history = cliente.data.history || []; 
              
                      // ============================================================
                      // 🧹 ZONA DE LIMPIEZA
                      // ============================================================
                      const fechaLimite = new Date();
                      fechaLimite.setMonth(fechaLimite.getMonth() - 3);
              
                      items = items.filter(item => {
                          if (item.type !== 'debt') return true;
                          if (!item.date) return true;
                          const fechaItem = new Date(item.date);
                          if (isNaN(fechaItem.getTime())) return true;
                          return (fechaItem > fechaLimite) || ((item.amount - item.paid) > 0);
                      });
              
                      // ============================================================
                      // 🧠 LÓGICA INTELIGENTE (CREACIÓN O ACTUALIZACIÓN)
                      // ============================================================
                      const indexYaExiste = items.findIndex(i => i.id === String(pedido.id));
                      const montoNuevo = Math.round(pedido.total);
                      const idPedido = String(pedido.id).slice(-4);
                      const nombreNegocio = pedido.nombre_negocio ? ` | ${pedido.nombre_negocio}` : '';
                      const fecha = pedido.fecha || new Date().toISOString();
                      
                      let huboCambios = false;
                      let mensajeHistorial = '';
                      let tipoAccion = 'debt'; // Por defecto deuda
              
                      if (indexYaExiste === -1) {
                          // ----------------------------------------------------
                          // CASO A: ES NUEVO (Crear)
                          // ----------------------------------------------------
                          
                          // Snapshot antes de tocar nada
                          const oldItemsSnapshot = JSON.parse(JSON.stringify(items));
              
                          items.unshift({
                              id: String(pedido.id),
                              type: 'debt',
                              amount: montoNuevo,
                              paid: 0,
                              date: fecha,
                              notes: pedido.nombre_negocio || '', 
                              color: 'orange'
                          });
              
                          // Mensaje Detallado para Nuevo
                          mensajeHistorial = `📦 Nuevo Pedido #${idPedido}${nombreNegocio} ($${montoNuevo.toLocaleString('es-AR')})`;
                          tipoAccion = 'debt';
                          huboCambios = true;
              
                          // Guardar historial del snapshot
                          history.unshift({
                              timestamp: Date.now(),
                              items: oldItemsSnapshot,
                              action: mensajeHistorial,
                              type: tipoAccion
                          });
              
                      } else {
                          // ----------------------------------------------------
                          // CASO B: YA EXISTE (Verificar si cambió el monto)
                          // ----------------------------------------------------
                          const itemExistente = items[indexYaExiste];
                          const montoViejo = itemExistente.amount;
              
                          if (montoViejo !== montoNuevo) {
                              // Snapshot antes de modificar
                              const oldItemsSnapshot = JSON.parse(JSON.stringify(items));
              
                              // Actualizamos el monto del item existente
                              items[indexYaExiste].amount = montoNuevo;
                              // Opcional: Actualizar nota si cambió
                              if(pedido.nombre_negocio) items[indexYaExiste].notes = pedido.nombre_negocio;
              
                              // Mensaje Detallado para Actualización
                              // Aquí reemplazamos el mensaje genérico "🔄 Sync..." por el que tú quieres
                              mensajeHistorial = `🔄 Update Pedido #${idPedido}${nombreNegocio} ($${montoViejo.toLocaleString('es-AR')} ➔ $${montoNuevo.toLocaleString('es-AR')})`;
                              tipoAccion = 'edit';
                              huboCambios = true;
              
                              // Guardar historial
                              history.unshift({
                                  timestamp: Date.now(),
                                  items: oldItemsSnapshot,
                                  action: mensajeHistorial,
                                  type: tipoAccion
                              });
                          } else {
                              console.log(`ℹ️ El pedido #${idPedido} ya existe y el monto es igual. No se toca.`);
                          }
                      }
              
                      // ============================================================
                      // 💾 GUARDAR SOLO SI HUBO CAMBIOS
                      // ============================================================
                      if (huboCambios) {
                          if (history.length > 500) history.pop(); // Limpieza historial
              
                          await supabase
                              .from('clients_v2')
                              .update({ data: { ...cliente.data, items, history } })
                              .eq('id', cliente.id);
                          
                          console.log(`✅ Guardado: ${mensajeHistorial}`);
                      }
              
                  } else {
                      console.log(`⚠️ No existe perfil de cobranzas para user_id: ${pedido.user_id}`);
                  }
              });
        }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});


/* --- NUEVO: CREAR PRODUCTO --- */
app.post('/api/crear-producto', async (req, res) => {
  try {
    const { nombre, precio, categoria, stock, link } = req.body;

    const { data, error } = await supabase
      .from('productos')
      .insert([{
        nombre,
        precio,
        categoria,
        stock,
        link,
        sku: null,       // Solicitado null
        stock_leo: null, // Solicitado null
        imagen: null     // Se actualizará en el paso 2
      }])
      .select()
      .single();

    if (error) throw error;

    const nuevoId = data.id;
    const nombreImagen = `imagenes/${nuevoId}.png`;

    // 2. Actualizamos la imagen con la ID generada
    const { error: updateError } = await supabase
      .from('productos')
      .update({ imagen: nombreImagen })
      .eq('id', nuevoId);

    if (updateError) throw updateError;

    res.json({ ok: true, mensaje: 'Producto creado', id: nuevoId, imagen: nombreImagen });

  } catch (err) {
    console.error('❌ Error creando producto:', err);
    res.status(500).json({ error: err.message });
  }
});

// ⚠️ PUERTO CONFIGURADO PARA RENDER
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});



















