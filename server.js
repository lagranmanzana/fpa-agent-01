import express from "express";
import { google } from "googleapis";

const app = express();
const port = process.env.PORT || 3000;

// 👉 ID de tu documento (FPA - Defog)
const spreadsheetId = "1lGZbo2J6_mGGHf8dtvI-T_NtJwXvOZre_hC_8OYZkpQ";

// --- Helpers ---
function requireEnvJSON() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON");
  return JSON.parse(raw);
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
  // Si hay espacios o símbolos, Google Sheets requiere comillas simples
  return /^[A-Za-z0-9_]+$/.test(title) ? title : `'${title.replace(/'/g, "''")}'`;
}

// --- Rutas ---
app.get("/", (_req, res) => {
  res.send("✅ fpa-agent-01 corriendo (Google Sheets conectado)");
});

// Lista todas las pestañas
app.get("/tabs", async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const titles = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);
    res.json({ ok: true, spreadsheetId, tabs: titles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Lee una pestaña concreta (?name=OrdersTable&range=A1:Z50)
app.get("/sheet", async (req, res) => {
  try {
    const name = req.query.name;
    const range = req.query.range || "A1:Z50";
    if (!name) return res.status(400).json({ ok: false, error: "Falta query ?name=" });
    const sheets = await getSheetsClient();
    const qName = quoteTabIfNeeded(String(name));
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

// Lee TODAS las pestañas (opcionalmente limita filas/columnas: ?rows=50&cols=Z)
app.get("/all-sheets", async (req, res) => {
  try {
    const rows = Math.max(parseInt(req.query.rows || "50", 10), 1);
    const cols = (req.query.cols || "Z").toUpperCase(); // última columna a leer
    const sheets = await getSheetsClient();

    // 1) Obtener títulos de pestañas
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const titles = (meta.data.sheets || []).map(s => s.properties?.title).filter(Boolean);

    // 2) Construir rangos seguros
    const ranges = titles.map(t => `${quoteTabIfNeeded(t)}!A1:${cols}${rows}`);

    // 3) Leer en batch
    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges,
    });

    // 4) Empaquetar respuesta { tabName: values }
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

// Mantén también un test rápido sobre OrdersTable si quieres
app.get("/test-sheets", async (_req, res) => {
  try {
    const sheets = await getSheetsClient();
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "OrdersTable!A1:Z5",
    });
    res.json({ ok: true, values: r.data.values || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(port, () => {
  console.log(`Servidor escuchando en http://localhost:${port}`);
});

