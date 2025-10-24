// server.js
import express from "express";
import { URL } from "url";

const app = express();

// ------------- Config -------------
const PROXY_ORIGIN = "https://ownerrez-ua-proxy.onrender.com"; // <-- tu dominio
const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";
const FALLBACK_CLIENT_ID =
    process.env.OWNERREZ_CLIENT_ID || "c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g";
const FALLBACK_REDIRECT =
    process.env.GPT_REDIRECT_URI ||
    "https://chat.openai.com/aip/g-4c7fcb8735f81f7eda9337dc66fdc10c530695c2/oauth/callback";

const APP_BASE = "https://app.ownerrez.com";
const API_BASE = "https://api.ownerrez.com";

// ------------- Utils -------------
app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (token usa x-www-form-urlencoded)
app.use(express.raw({ type: () => true, limit: "10mb" }));

function cloneHeaders(req) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
        headers[k] = v;
    }
    headers["User-Agent"] = UA;
    return headers;
}

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

// Reescribe Location absoluto -> dominio del proxy
function rewriteLocation(loc) {
    if (!loc) return loc;
    try {
        const u = new URL(loc);
        if (u.origin === APP_BASE || u.origin === API_BASE) {
            u.protocol = new URL(PROXY_ORIGIN).protocol;
            u.host = new URL(PROXY_ORIGIN).host;
            return u.toString();
        }
        return loc;
    } catch {
        return loc; // no absoluto (p.ej., /login?...) lo dejamos tal cual
    }
}

// Reescribe Set-Cookie Domain=*.ownerrez.com -> Domain=tu-proxy
function rewriteSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) return null;
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const proxyHost = new URL(PROXY_ORIGIN).host;

    return arr.map((sc) => {
        let out = sc;

        // Domain
        out = out.replace(/;\s*Domain=\.?ownerrez\.com/gi, `; Domain=${proxyHost}`);

        // SameSite: asegúrate de que el navegador acepte cookies en flujo OAuth embebido
        if (!/;\s*SameSite=/i.test(out)) {
            out += "; SameSite=None";
        }
        // Secure (por si Render fuerza HTTPS; mantenerlo)
        if (!/;\s*Secure/i.test(out)) {
            out += "; Secure";
        }

        return out;
    });
}

async function pass(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;
    const init = {
        method: req.method,
        headers: cloneHeaders(req),
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual"
    };

    const resp = await fetch(targetUrl, init);

    // Copia/reescribe headers de respuesta
    const headersToSet = new Headers(resp.headers);

    // 1) Reescribe Location a tu dominio (importante para redirecciones OAuth)
    const loc = headersToSet.get("location");
    if (loc) {
        headersToSet.set("location", rewriteLocation(loc));
    }

    // 2) Reescribe Set-Cookie Domain=.ownerrez.com a tu proxy
    const setCookies = resp.headers.getSetCookie?.() || headersToSet.get("set-cookie");
    const rewritten = rewriteSetCookie(setCookies);
    if (rewritten) {
        headersToSet.delete("set-cookie");
        (Array.isArray(rewritten) ? rewritten : [rewritten]).forEach((c) =>
            res.append("set-cookie", c)
        );
    }

    // Transfiere headers restantes
    for (const [k, v] of headersToSet.entries()) {
        if (k.toLowerCase() !== "set-cookie") {
            res.setHeader(k, v);
        }
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

// ------------- Handlers específicos -------------
// Token SIEMPRE a API
app.all("/oauth/access_token", (req, res) => pass(req, res, API_BASE));

// Authorize: asegura client_id / redirect_uri y envía a APP
app.all("/oauth/authorize", (req, res) => {
    const u = new URL(req.url, PROXY_ORIGIN);
    const q = u.searchParams;
    if (!q.get("client_id") || q.get("client_id").trim() === "") {
        q.set("client_id", FALLBACK_CLIENT_ID);
    }
    if (!q.get("redirect_uri") || q.get("redirect_uri").trim() === "") {
        q.set("redirect_uri", FALLBACK_REDIRECT);
    }
    if (!q.get("response_type")) q.set("response_type", "code");
    req.url = "/oauth/authorize?" + q.toString();
    return pass(req, res, APP_BASE);
});

// Login: si viene con returnUrl=oauth/authorize..., completa parámetros y manda a APP
app.all("/login", (req, res) => {
    const u = new URL(req.url, PROXY_ORIGIN);
    const ru = u.searchParams.get("returnUrl") || "";
    if (ru.startsWith("oauth/authorize") || ru.startsWith("/oauth/authorize")) {
        const inner = new URL(ru.startsWith("/") ? `${PROXY_ORIGIN}${ru}` : `${PROXY_ORIGIN}/${ru}`);
        const iq = inner.searchParams;
        if (!iq.get("client_id") || iq.get("client_id").trim() === "") {
            iq.set("client_id", FALLBACK_CLIENT_ID);
        }
        if (!iq.get("redirect_uri") || iq.get("redirect_uri").trim() === "") {
            iq.set("redirect_uri", FALLBACK_REDIRECT);
        }
        if (!iq.get("response_type")) iq.set("response_type", "code");
        req.url = "/oauth/authorize?" + iq.toString();
        return pass(req, res, APP_BASE);
    }
    return pass(req, res, APP_BASE);
});

// Catch-all: web → APP, resto → API
app.use((req, res) => {
    const pathname = new URL(req.url, PROXY_ORIGIN).pathname;
    if (isWebPath(pathname)) return pass(req, res, APP_BASE);
    return pass(req, res, API_BASE);
});

// ------------- Start -------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy listening on", PORT));
