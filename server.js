// server.js
import express from "express";
import { URL } from "url";

const app = express();

// --- Config ---
const PROXY_ORIGIN = "https://ownerrez-ua-proxy.onrender.com";
const APP_BASE = "https://app.ownerrez.com";
const API_BASE = "https://api.ownerrez.com";

// Header obligatorio para API OwnerRez
const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

// Fallbacks (puedes moverlos a variables de entorno en Render)
const FALLBACK_CLIENT_ID =
    process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const FALLBACK_REDIRECT =
    process.env.GPT_REDIRECT_URI ||
    "https://chat.openai.com/aip/g-4c7fcb8735f81f7eda9337dc66fdc10c530695c2/oauth/callback";

// Salud
app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (token usa x-www-form-urlencoded)
app.use(express.raw({ type: () => true, limit: "10mb" }));

// -------- Utils --------
function cloneHeaders(req) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
        headers[k] = v;
    }
    headers["User-Agent"] = UA; // inyecta UA para API/token
    return headers;
}

async function proxyTo(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;
    const init = {
        method: req.method,
        headers: cloneHeaders(req),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual"
    };
    const resp = await fetch(targetUrl, init);

    // Copia headers (sin manipular cookies/Location)
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

function ensureAuthorizeParams(u) {
    const q = u.searchParams;
    if (!q.get("client_id") || q.get("client_id").trim() === "") {
        q.set("client_id", FALLBACK_CLIENT_ID);
    }
    if (!q.get("redirect_uri") || q.get("redirect_uri").trim() === "") {
        q.set("redirect_uri", FALLBACK_REDIRECT);
    }
    if (!q.get("response_type")) q.set("response_type", "code");
}

// -------- Rutas clave --------

// 1) Token SIEMPRE proxyeado (necesita UA) → API
app.all("/oauth/access_token", (req, res) => proxyTo(req, res, API_BASE));

// 2) Authorize: normaliza params y REDIRIGE 302 a la web (NO proxyear UI)
app.all("/oauth/authorize", (req, res) => {
    const u = new URL(req.url, PROXY_ORIGIN);
    ensureAuthorizeParams(u);
    const target = `${APP_BASE}${u.pathname}?${u.searchParams.toString()}`;
    return res.redirect(302, target); // deja que el navegador hable directo con app.ownerrez.com
});

// 3) Cualquier ruta "web" → REDIRIGE 302 a la web (login, consent, etc.)
function isWebPath(pathname) {
    return (
        pathname.startsWith("/oauth/") ||
        pathname === "/oauth" ||
        pathname.startsWith("/login") ||
        pathname.startsWith("/signin") ||
        pathname.startsWith("/account") ||
        pathname.startsWith("/identity") ||
        pathname === "/"
    );
}

app.use((req, res, next) => {
    const pathname = new URL(req.url, PROXY_ORIGIN).pathname;
    if (isWebPath(pathname)) {
        const target = APP_BASE + req.originalUrl;
        return res.redirect(302, target);
    }
    return proxyTo(req, res, API_BASE); // el resto (ej. /v2/...) sí va proxyeado a API
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy listening on", PORT));
