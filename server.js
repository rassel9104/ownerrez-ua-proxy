// server.js
import express from "express";

const app = express();
const UA = "DenOfSin Assistant/1.0 (c_otce6nb6iejzqvmtk7hiaunuhtlwyq6g)";

app.get("/__health", (req, res) => res.json({ ok: true }));

// Acepta cualquier body (incluye x-www-form-urlencoded del token)
app.use(express.raw({ type: () => true, limit: "10mb" }));

function isWebPath(pathname) {
    // Todo lo que es UI/OAuth de la app web:
    return (
        pathname.startsWith("/oauth/") ||   // /oauth/authorize, callbacks, etc.
        pathname === "/oauth" ||
        pathname.startsWith("/login") ||
        pathname.startsWith("/signin") ||
        pathname.startsWith("/account") ||
        pathname.startsWith("/identity") ||
        pathname === "/"                    // raíz si la UI redirige
    );
}

async function forward(req, res, targetBase) {
    const targetUrl = targetBase + req.originalUrl;

    // Copia headers salvo los conflictivos
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lk = k.toLowerCase();
        if (lk === "host" || lk === "content-length" || lk === "user-agent") continue;
        headers[k] = v;
    }
    headers["User-Agent"] = UA;

    const init = {
        method: req.method,
        headers,
        body: (req.method === "GET" || req.method === "HEAD") ? undefined : req.body,
        redirect: "manual"
    };

    const resp = await fetch(targetUrl, init);

    // Propaga headers/cuerpo tal cual
    for (const [k, v] of resp.headers.entries()) res.setHeader(k, v);
    const buf = Buffer.from(await resp.arrayBuffer());
    res.status(resp.status).send(buf);
}

// Token siempre contra API
app.all("/oauth/access_token", (req, res) => forward(req, res, "https://api.ownerrez.com"));

// Resto: decidir si es web (app) o API
app.use((req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (isWebPath(pathname)) {
        // Todo lo web (login, authorize, etc.) a APP
        return forward(req, res, "https://app.ownerrez.com");
    }
    // Lo demás (incl. /v2/...) a API
    return forward(req, res, "https://api.ownerrez.com");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("UA proxy listening on", PORT));
