import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger, getRequestId } from "./lib/logger";
import { errorHandler } from "./middlewares/error-handler";
import { globalLimiter } from "./middlewares/rate-limit";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    // Propagate / generate correlation-id per ogni richiesta
    genReqId: (req) => getRequestId(req as any),
    customProps: (req) => ({
      requestId: (req as any).id,
    }),
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Propagate correlation-id + header di sicurezza di base (niente helmet dep:
// li impostiamo a mano). È una API JSON + SPA servita a parte, quindi headers
// minimi ma utili contro clickjacking / MIME-sniffing.
app.use((req, res, next) => {
  const reqId = (req as any).id;
  if (reqId) res.setHeader("x-request-id", reqId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Dietro il proxy di Render/nginx: fidati del primo hop così req.ip è l'IP
// reale del client (rate-limit per-IP corretto) e cookie `secure` funziona.
app.set("trust proxy", 1);

// CORS: allowlist ESATTA di origin. Con credentials:true NON si può mai
// riflettere un origin arbitrario (leggerebbe i cookie della vittima cross-site).
// Normalizza (togli slash finale) così `https://app/` in FRONTEND_URL matcha
// l'Origin del browser (che non ha mai slash/path finale).
const stripSlash = (s: string) => s.replace(/\/+$/, "");
const allowedOrigins = (process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",").map(u => u.trim())
  : ["http://localhost:5173", "http://localhost:4173"]
).filter(Boolean).map(stripSlash);

app.use(cors({
  origin: (origin, callback) => {
    // niente origin = curl / app native / cron → consentito (nessun cookie ambient da rubare)
    if (!origin || allowedOrigins.includes(stripSlash(origin))) {
      callback(null, true);
    } else {
      callback(new Error("Origin non consentito da CORS"));
    }
  },
  credentials: true,
}));
app.use(cookieParser());
// Limite di default contenuto (era 100mb → memory-DoS anche sulle route
// pubbliche pre-auth). 4mb copre i payload JSON bulk legittimi (generazione
// corse, import stops manuale); i file veri passano da multer, non da qui.
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true, limit: "4mb" }));

// Rate limiting — bucket per utente autenticato (3000/min) o per IP (600/min)
app.use(globalLimiter);

app.use("/api", router);

// Global error handler — must be registered AFTER all routes
app.use(errorHandler);

export default app;
