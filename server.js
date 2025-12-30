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
   FUNCIONES AUXILIARES PARA EL MONITOR DE STOCK (BASE DE DATOS)
   ========================================================= */

// 1. REGISTRAR MOVIMIENTO Y ACTUALIZAR SNAPSHOT (Para ventas/modificaciones)
async function registrarMovimiento(prodId, nombre, cambio, stockAnt, stockNue, tipo, ref) {
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
      fecha: new Date().toISOString()
    }]);

    // B. ACTUALIZAMOS LA FOTO EN LA TABLA AUXILIAR 'monitor_snapshot'
    // Esto evita que el monitor detecte este cambio legítimo como un "desajuste"
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
        // Aquí insertamos los datos que antes se borraban:
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

// NUEVO: GENERAR PDF MASIVO (Concatenado)
app.post('/api/generar-pdf-masivo', async (req, res) => {
  try {
    const { pedidos } = req.body; // Array de pedidos completos
    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      return res.status(400).json({ error: 'Lista de pedidos inválida' });
    }

    console.log(`📚 Generando PDF Masivo con ${pedidos.length} pedidos...`);
    const pdfBuffer = await generarPDFMasivo(pedidos);
    const fileName = `giant_${Date.now()}.pdf`;

    // Subir a Supabase
    const { error: uploadErr } = await supabase.storage.from('pedidos-pdf').upload(fileName, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) return res.status(500).json({ error: 'Error subiendo PDF masivo' });

    // Obtener URL firmada (valida por 1 hora)
    const { data: signed, error: signedErr } = await supabase.storage.from('pedidos-pdf').createSignedUrl(fileName, 3600);
    if (signedErr) return res.status(500).json({ error: 'Error firmando URL masiva' });

    res.json({ ok: true, pdf: signed.signedUrl });

  } catch (err) {
    console.error('❌ Error generando PDF Masivo:', err);
    res.status(500).json({ error: err.message });
  }
});

// GENERAR PDF DE PETICIÓN (PREVIEW) - 🔥 AHORA SÍ MUESTRA EL NEGOCIO
app.post('/api/generar-pdf-peticion', async (req, res) => {
  try {
    // 1. Recibimos 'nombre_negocio' desde el frontend
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
      
      // 🔥 AQUÍ ESTÁ LA CLAVE: 
      // Al asignarlo aquí, la función 'generarPDF' verá que existe y lo escribirá en el PDF.
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

    // Ordenar por fecha (más reciente primero)
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

// GUARDAR PETICIÓN (ENVIAR) - 🔥 MODIFICADO: SIN TELÉFONO + NUEVOS CAMPOS
// GUARDAR PETICIÓN (ENVIAR) - 🔥 CORREGIDO: AHORA SÍ GUARDA EL TELÉFONO
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
        
        // LIMPIEZA DE TELÉFONO (Para evitar errores con int8)
        // Esto quita espacios, guiones y paréntesis, dejando solo números.
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

// Función auxiliar para dibujar el contenido de UN pedido en el documento PDF
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
    // autoFirstPage: false permite agregar páginas manualmente en el bucle
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


app.put('/api/actualizar-estado-pedido/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { estado } = req.body; 

    // 1. Actualizar estado en pedidos
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
            return res.json({ ok: true });
        }

        // 2. BUSCAR CLIENTE (Usando la columna user_id directa)
        const { data: clientes, error: errBus } = await supabase
            .from('clients_v2')
            .select('*')
            .eq('user_id', pedido.user_id); // <--- Búsqueda optimizada

        if (clientes && clientes.length > 0) {
            const cliente = clientes[0];
            console.log(`✅ Sincronizando con cliente: ${cliente.name}`);

            let items = cliente.data.items || [];

            // ============================================================
            // 🧹 ZONA DE LIMPIEZA (DELETE OLD)
            // ============================================================
            
            // 1. Calculamos la fecha límite (Hoy - 3 Meses)
            const fechaLimite = new Date();
            fechaLimite.setMonth(fechaLimite.getMonth() - 3);

            const itemsAntes = items.length;

            items = items.filter(item => {
                // A. Si no es deuda (es separador), se queda
                if (item.type !== 'debt') return true;

                // B. Si no tiene fecha válida, se queda (por seguridad)
                if (!item.date) return true;

                const fechaItem = new Date(item.date);
                
                // C. Si la fecha es inválida, se queda
                if (isNaN(fechaItem.getTime())) return true;

                return (fechaItem > fechaLimite) || ((item.amount - item.paid) > 0);
            });

            const borrados = itemsAntes - items.length;
            if(borrados > 0) console.log(`🗑️ Se eliminaron ${borrados} deudas antiguas (+3 meses).`);

            // ============================================================
            // ➕ AGREGAR NUEVA DEUDA
            // ============================================================
            
            const yaExiste = items.find(i => i.id === String(pedido.id));

            if (!yaExiste) {
                items.unshift({
                    id: String(pedido.id),
                    type: 'debt',
                    amount: Math.round(pedido.total),
                    paid: 0,
                    date: pedido.fecha || new Date().toISOString(),
                    notes: pedido.nombre_negocio || '', 
                    color: 'orange'
                });

                // 3. Guardar cambios en DB
                const nuevoData = { ...cliente.data, items: items };
                
                await supabase
                    .from('clients_v2')
                    .update({ data: nuevoData })
                    .eq('id', cliente.id);
                
                console.log("💾 Cliente actualizado (Limpieza + Nueva Deuda).");
            }
        }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ⚠️ PUERTO CONFIGURADO PARA RENDER
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server escuchando en http://localhost:${PORT}`);
});



