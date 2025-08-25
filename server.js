// server.js (ESM)
// Node + Express + Google Sheets + OpenAI + Frontend estático

import express from "express";
import { google } from "googleapis";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const port = process.env.PORT || 3000;

// --- Servir el frontend (carpeta /public) ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// 👉 ID de tu documento (FPA - Defog), puedes sobreescribirlo en Render con SPREADSHEET_ID
const spreadsheetId =
  process.env.SPREADSHEET_ID ||
  "1lGZbo2J6_mGGHf8dtvI-T_NtJwXvOZre_hC_8OYZkpQ";

// --- Helpers ---
function requireEnvJSON() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido");
  }
}

async function getSheetsClient() {
  const creds = requireEnvJSON();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

function quoteTabIfNeeded(title) {
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${String(title).replace(/'/g, "''")}'`;
}

function parseNumber(n) {
  if (typeof n === "number") return n;
  if (typeof n !== "string") return 0;
  // Quita símbolos, separadores europeos, etc.
  const cleaned = n.replace(/[^\d,.\-]/g, "").replace(/\./g, "").replace(",", ".");
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : 0;
}

function toISODate(d) {
  // Normaliza a YYYY-MM-DD
  const iso = new Date(d);
  if (isNaN(iso.getTime())) return null;
  const y = iso.getFullYear();
  const m = String(iso.getMonth() + 1).padStart(2, "0");
  const day = String(iso.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rowsToCSV(rows, maxRows = 200) {
  const cut = (rows || []).slice(0, maxRows);
  return cut
    .map(r =>
      (r || [])
        .map(v => (typeof v === "string" ? v.replace(/\r?\n/g, " ") : v))
        .join(",")
    )
    .join("\n");
}

// --- OpenAI (ChatGPT) ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Rutas existentes (status / tabs / sheet / all-sheets / analyze genérico) ----
app.get("/", (_req, res) => {
  res.send("✅ fpa-agent-01 corriendo (Google Sheets + ChatGPT listos)");
});

app.get("/tabs", async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const titles = (meta.data.sheets || [])
      .map(s => s.properties?.title)
      .filter(Boolean);
    res.json({ ok: true, spreadsheetId, tabs: titles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/sheet", async (req, res) => {
  try {
    const name = String(req.query.name || "");
    const range = String(req.query.range || "A1:Z50");
    if (!name) return res.status(400).json({ ok: false, error: "Falta query ?name=" });
    const sheets = await getSheetsClient();
    const qName = quoteTabIfNeeded(name);
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${qName}!${range}`,
    });
    res.json({ ok: true, tab: name, range, values: r.data.values || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/all-sheets", async (req, res) => {
  try {
    const rows = Math.max(parseInt(req.query.rows || "50", 10), 1);
    const cols = (req.query.cols || "Z").toUpperCase();
    const sheets = await getSheetsClient();

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const titles = (meta.data.sheets || [])
      .map(s => s.properties?.title)
      .filter(Boolean);

    const ranges = titles.map(t => `${quoteTabIfNeeded(t)}!A1:${cols}${rows}`);
    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
    });

    const result = {};
    (resp.data.valueRanges || []).forEach((vr, i) => {
      result[titles[i]] = vr.values || [];
    });

    res.json({ ok: true, spreadsheetId, rows, cols, tabs: titles, data: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- NUEVO: KPIs y series temporales sobre OrdersTable (o la que indiques) ----

// Devuelve KPIs sumarios del periodo
app.get("/metrics", async (req, res) => {
  try {
    const sheetName = String(req.query.sheet || "OrdersTable");
    const start = String(req.query.start || "1970-01-01"); // YYYY-MM-DD
    const end = String(req.query.end || "2999-12-31");     // YYYY-MM-DD

    const sheets = await getSheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteTabIfNeeded(sheetName)}!A1:Z100000`,
    });

    const values = r.data.values || [];
    if (values.length < 2) {
      return res.json({ ok: true, metrics: { totalSales: 0, orders: 0, aov: 0 } });
    }

    const headers = values[0].map(h => String(h || "").trim().toLowerCase());
    const rows = values.slice(1);

    // Localiza columnas (tolerante a mayúsculas/minúsculas/espacios)
    const idxPrice = headers.findIndex(h => h.replace(/\s+/g, "") === "itemprice");
    const idxDate  = headers.findIndex(h => h.replace(/\s+/g, "") === "purchasedatetime");

    if (idxPrice === -1 || idxDate === -1) {
      return res.status(400).json({ ok: false, error: "No encuentro columnas 'Item Price' o 'purchase date time'." });
    }

    // Filtra por fechas y agrega
    let totalSales = 0;
    let orders = 0;

    const startMs = new Date(start + "T00:00:00").getTime();
    const endMs   = new Date(end   + "T23:59:59").getTime();

    rows.forEach(row => {
      const dateStr = row[idxDate];
      const iso = toISODate(dateStr);
      if (!iso) return;
      const t = new Date(iso + "T12:00:00").getTime(); // noon to avoid TZ edges
      if (t >= startMs && t <= endMs) {
        const price = parseNumber(row[idxPrice]);
        totalSales += price;
        orders += 1; // si tienes una columna 'quantity' podríamos multiplicar
      }
    });

    const aov = orders > 0 ? totalSales / orders : 0;

    res.json({
      ok: true,
      metrics: {
        totalSales,
        orders,
        aov,
        start,
        end,
        sheet: sheetName,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Devuelve la serie temporal por día del periodo (suma de Item Price)
app.get("/timeseries", async (req, res) => {
  try {
    const sheetName = String(req.query.sheet || "OrdersTable");
    const start = String(req.query.start || "1970-01-01");
    const end   = String(req.query.end   || "2999-12-31");

    const sheets = await getSheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteTabIfNeeded(sheetName)}!A1:Z100000`,
    });

    const values = r.data.values || [];
    if (values.length < 2) {
      return res.json({ ok: true, timeseries: [] });
    }

    const headers = values[0].map(h => String(h || "").trim().toLowerCase());
    const rows = values.slice(1);

    const idxPrice = headers.findIndex(h => h.replace(/\s+/g, "") === "itemprice");
    const idxDate  = headers.findIndex(h => h.replace(/\s+/g, "") === "purchasedatetime");

    if (idxPrice === -1 || idxDate === -1) {
      return res.status(400).json({ ok: false, error: "No encuentro columnas 'Item Price' o 'purchase date time'." });
    }

    const startMs = new Date(start + "T00:00:00").getTime();
    const endMs   = new Date(end   + "T23:59:59").getTime();

    const map = new Map();
    rows.forEach(row => {
      const iso = toISODate(row[idxDate]);
      if (!iso) return;
      const t = new Date(iso + "T12:00:00").getTime();
      if (t < startMs || t > endMs) return;
      const price = parseNumber(row[idxPrice]);
      map.set(iso, (map.get(iso) || 0) + price);
    });

    // Orden cronológico
    const timeseries = Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value }));

    res.json({ ok: true, timeseries, start, end, sheet: sheetName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Informe ejecutivo sobre KPIs/serie (para UI) ----
const EXEC_SUMMARY_SYSTEM = `
Eres analista FP&A. Recibirás KPIs y una serie temporal diaria de ventas (Item Price).
Devuelve un resumen ejecutivo en 5-7 líneas, en español, incluyendo:
- Contexto del período y evolución.
- Lectura de tendencia, estacionalidad y picos.
- 4-5 bullets con insights y recomendaciones accionables.
- Si faltan datos (p.ej., unidades) dilo brevemente.
Sé claro, directo y evita jerga innecesaria.
`.trim();

app.post("/analyze-metrics", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ ok: false, error: "Falta OPENAI_API_KEY en variables de entorno." });
    }
    const { metrics, timeseries, userPrompt = "" } = req.body || {};
    const content = `
Periodo: ${metrics?.start ?? "?"} a ${metrics?.end ?? "?"}
Ventas totales: ${metrics?.totalSales?.toFixed?.(2) ?? metrics?.totalSales}
Pedidos: ${metrics?.orders}
AOV: ${metrics?.aov?.toFixed?.(2) ?? metrics?.aov}

Serie (primeros 10 puntos):
${(timeseries || []).slice(0, 10).map(p => `${p.date}: ${p.value}`).join("\n")}

${userPrompt ? `Instrucciones extra del usuario: ${userPrompt}` : ""}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: EXEC_SUMMARY_SYSTEM },
        { role: "user", content },
      ],
    });

    const text = completion.choices?.[0]?.message?.content ?? "Sin contenido.";
    res.json({ ok: true, summary: text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Arranque ---
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});
