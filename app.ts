import path from "path";
import cors from "cors";
import helmet from "helmet";
import express from "express";
import { Borgen, Logger } from "borgen";
import { allowedOrigins, ENV } from "./lib/environments";
import cookieParser from "cookie-parser";
import { helmetConfig } from "./lib/helmet";
import v1router from "./router/uploadGroup";
import { initRabbitMQ } from "./lib/rabbitmq";
import { createTusServer } from "./lib/tusServer";
import { apiReference } from "@scalar/express-api-reference";
import generateOpenAPISpec, { apiDocsServer } from "./docs/openapi";

const app = express();

app.set("trust proxy", true);

// Middleware
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "HEAD"],
    credentials: true,
  })
);

app.use(helmet(helmetConfig));
app.use(Borgen({}));
app.use(express.json({ limit: "200mb" }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: "200mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Initialize TUS server
const tusServer = createTusServer();

app.use(
  "/openapi",
  express.static(path.join(__dirname, "./docs/openapi.json"))
);
app.use(
  "/api/v1/docs",
  apiReference({
    url: `${apiDocsServer}/openapi`,
  })
);

// TUS upload handling - must come before other routes
app.use("/api/v1/tus", (req, res) => {
  tusServer.handle(req, res);
});

// Routes
app.use("/api/v1", v1router);

const startServer = async () => {
  console.log("Starting server...", ENV.NODE_ENV);
  if (ENV.NODE_ENV == "dev") {
    generateOpenAPISpec();
  }

  // Initialize RabbitMQ
  await initRabbitMQ();

  app.listen(ENV.SERVER_PORT, () => {
    Logger.info({ message: `Server is running on port ${ENV.SERVER_PORT}` });
  });
};

startServer();
