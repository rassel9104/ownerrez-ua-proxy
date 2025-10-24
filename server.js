// server.js
import express from "express";
import { URL } from "url";

const app = express();

// 🔧 Identificador requerido por OwnerRez en TODAS las llamadas
const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

// ✅ Fallbacks (también puedes setearlos como Environment Variables en Render)
const FALLBACK_CLIENT_ID =
    process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const FALLBACK_REDIRECT =
    process.env.GPT_REDIRECT_URI ||
    "https://chat.openai.com/aip/g-4c7fcb8735f81f7eda9337dc66fdc10c530695c2/oauth/callback";

// Salud
app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (incluye x-www-form-urlencoded del token endpoint)
app.use(express.raw({ type: () => true, limit: "10mb" }));

// ---- utilidades ----
function buildHeaders(req) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
        headers[k] = v;
    }
    headers["User-Agent"] = UA;
    return headers;
}

async function forward(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;
    const init = {
        method: req.method,
        headers: buildHeaders(req),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual"
    };
    const resp = await fetch(targetUrl, init);
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

function isWebPath(pathname) {
    // Rutas que pertenecen al sitio web (no a la API) de OwnerRez:
    return (
        pathname.startsWith("/oauth/") || // /oauth/authorize, callbacks, etc.
        pathname === "/oauth" ||
        pathname.startsWith("/login") ||
        pathname.startsWith("/signin") ||
        pathname.startsWith("/account") ||
        pathname.startsWith("/identity") ||
        pathname === "/" // raíz si la UI redirige
    );
}

// ---- ruteo OAuth / API ----

// Token SIEMPRE contra API
app.all("/oauth/access_token", (req, res) =>
    forward(req, res, "https://api.ownerrez.com")
);

// Authorize: rellena client_id / redirect_uri si vinieran vacíos y envía a APP
app.all("/oauth/authorize", async (req, res) => {
    const incoming = new URL(req.url, "https://proxy.local");
    const q = incoming.searchParams;

    // Si no viene client_id o viene vacío, lo fijamos
    if (!q.get("client_id") || q.get("client_id").trim() === "") {
        q.set("client_id", FALLBACK_CLIENT_ID);
    }
    // Si no viene redirect_uri o viene vacío, lo fijamos
    if (!q.get("redirect_uri") || q.get("redirect_uri").trim() === "") {
        q.set("redirect_uri", FALLBACK_REDIRECT);
    }
    // Asegura response_type=code
    if (!q.get("response_type")) q.set("response_type", "code");

    // Reconstruye URL local con los parámetros corregidos
    req.url = "/oauth/authorize?" + q.toString();

    return forward(req, res, "https://app.ownerrez.com");
});

// Catch-all:
// - Si es ruta "web" → APP
// - Si es API (/v2/...) → API
app.use((req, res) => {
    const pathname = new URL(req.url, "https://proxy.local").pathname;
    if (isWebPath(pathname)) {
        return forward(req, res, "https://app.ownerrez.com");
    }
    return forward(req, res, "https://api.ownerrez.com");
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy listening on", PORT));
