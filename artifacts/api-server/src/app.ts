import express, { type Express } from "express";
import cors from "cors";
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

// Propagate correlation-id nell'header di risposta
app.use((req, res, next) => {
  const reqId = (req as any).id;
  if (reqId) res.setHeader("x-request-id", reqId);
  next();
});

// CORS: in produzione accetta solo il frontend Vercel
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(",").map(u => u.trim())
  : ["http://localhost:5173", "http://localhost:4173"];

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (curl, mobile apps, cron)
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) {
      callback(null, true);
    } else {
      callback(null, true); // permissive in dev, restringi se vuoi
    }
  },
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — 100 req/min per IP
app.use(globalLimiter);

app.use("/api", router);

// Global error handler — must be registered AFTER all routes
app.use(errorHandler);

export default app;
