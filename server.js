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
  // Si hay espacios/símbolos, hay que envolver con comillas simples y escapar comillas simples duplicándolas
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${String(title).replace(/'/g, "''")}'`;
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
// Define en Render: OPENAI_API_KEY
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- Rutas API ----
app.get("/", (_req, res) => {
  res.send("✅ fpa-agent-01 corriendo (Google Sheets + ChatGPT listos)");
});

// Lista todas las pestañas de la hoja
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

// Lee una pestaña concreta (?name=OrdersTable&range=A1:Z50)
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

// Lee TODAS las pestañas (?rows=50&cols=Z)
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

// Prompt base FP&A
const SYSTEM_PROMPT = `
Eres un analista FP&A. Recibirás datos de una hoja (CSV; primera fila cabeceras).
Devuelve:
- Resumen ejecutivo (4–6 líneas).
- 5 métricas clave en JSON (keys y valores numéricos si procede).
- Anomalías/insights notables.
- Recomendaciones accionables en viñetas.
Responde en ES. Sé conciso y claro. Si faltan columnas relevantes, indícalo.
`.trim();

// Analiza con OpenAI (?sheet=OrdersTable&range=A1:Z200&maxRows=200&prompt=texto...)
app.get("/analyze", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ ok: false, error: "Falta OPENAI_API_KEY en variables de entorno." });
    }

    const sheetName = String(req.query.sheet || "OrdersTable");
    const range = String(req.query.range || "A1:Z200");
    const maxRows = Math.max(parseInt(req.query.maxRows || "200", 10), 1);
    const userExtra = String(req.query.prompt || "").slice(0, 1500); // prompt opcional desde UI

    const sheets = await getSheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${quoteTabIfNeeded(sheetName)}!${range}`,
    });

    const rows = r.data.values || [];
    if (!rows.length) {
      return res.json({ ok: true, analysis: "No se encontraron filas en el rango indicado.", rows: 0, headers: [] });
    }

    const headers = rows[0];
    const csv = rowsToCSV(rows, maxRows);

    const userPrompt = `
Hoja: ${sheetName}
Rango: ${range}
Filas analizadas (máx ${maxRows}):
${userExtra ? `Instrucciones adicionales del usuario: ${userExtra}\n` : ""}
CSV:
${csv}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const content = completion.choices?.[0]?.message?.content ?? "Sin contenido de respuesta.";
    res.json({
      ok: true,
      sheet: sheetName,
      range,
      rows: rows.length - 1,
      headers,
      analysis: content,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Arranque ---
app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});

