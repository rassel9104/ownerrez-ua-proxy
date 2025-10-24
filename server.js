// server.js
import express from "express";
import { URL } from "url";

const app = express();

// 👇 User-Agent obligatorio para OwnerRez
const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

// 👇 Fallbacks (puedes ponerlos como env vars en Render)
const FALLBACK_CLIENT_ID =
    process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const FALLBACK_REDIRECT =
    process.env.GPT_REDIRECT_URI ||
    "https://chat.openai.com/aip/g-4c7fcb8735f81f7eda9337dc66fdc10c530695c2/oauth/callback";

// Salud
app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (x-www-form-urlencoded, json, binario)
app.use(express.raw({ type: () => true, limit: "10mb" }));

// ---------- utilidades ----------
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
    // Rutas propias del sitio web de OwnerRez (no API)
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

// ---------- Handlers específicos ----------

// 1) TOKEN: siempre contra la API
app.all("/oauth/access_token", (req, res) =>
    forward(req, res, "https://api.ownerrez.com")
);

// 2) AUTHORIZE: completa client_id/redirect_uri si faltan y envía a APP
app.all("/oauth/authorize", async (req, res) => {
    const incoming = new URL(req.url, "https://proxy.local");
    const q = incoming.searchParams;

    if (!q.get("client_id") || q.get("client_id").trim() === "") {
        q.set("client_id", FALLBACK_CLIENT_ID);
    }
    if (!q.get("redirect_uri") || q.get("redirect_uri").trim() === "") {
        q.set("redirect_uri", FALLBACK_REDIRECT);
    }
    if (!q.get("response_type")) q.set("response_type", "code");

    req.url = "/oauth/authorize?" + q.toString(); // reescribe con params corregidos
    return forward(req, res, "https://app.ownerrez.com");
});

// 3) LOGIN: si viene con returnUrl=oauth/authorize?... y client_id vacío,
//    reescribe el returnUrl para incluir client_id/redirect_uri y envía a APP
app.all("/login", async (req, res) => {
    const incoming = new URL(req.url, "https://proxy.local");
    const returnUrl = incoming.searchParams.get("returnUrl") || "";

    // Solo intervenimos si apunta al flujo de authorize
    if (returnUrl.startsWith("oauth/authorize") || returnUrl.startsWith("/oauth/authorize")) {
        // Normaliza a URL absoluta para manipular query interna
        const inner = new URL(
            returnUrl.startsWith("/") ? `https://proxy.local${returnUrl}` : `https://proxy.local/${returnUrl}`
        );
        const iq = inner.searchParams;

        if (!iq.get("client_id") || iq.get("client_id").trim() === "") {
            iq.set("client_id", FALLBACK_CLIENT_ID);
        }
        if (!iq.get("redirect_uri") || iq.get("redirect_uri").trim() === "") {
            iq.set("redirect_uri", FALLBACK_REDIRECT);
        }
        if (!iq.get("response_type")) iq.set("response_type", "code");

        // Reescribe la URL local para que forward use la versión corregida
        req.url = "/oauth/authorize?" + iq.toString();
        return forward(req, res, "https://app.ownerrez.com");
    }

    // Si no es el caso anterior, solo proxy a APP
    return forward(req, res, "https://app.ownerrez.com");
});

// 4) Catch-all: web → APP, resto → API
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
