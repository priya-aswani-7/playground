const Koa = require("koa");
const Router = require("@koa/router");
const cors = require("@koa/cors");
const proxyHandler = require("./proxyHandler");
const morgan = require("koa-morgan");
const bodyParser = require("koa-bodyparser");
const serve = require("koa-static");
const path = require("path");
const fs = require("fs");

// Ensure public directory exists
const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

// Create Koa app and router
const app = new Koa();
const router = new Router();

proxyHandler.register(router);

// Error handling middleware
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.log("+======================+");
    console.error("Server error:", err);
    console.log("+======================+");
    ctx.status = err.status || 500;
    ctx.body = {
      success: false,
      message: err.message || "Internal Server Error",
      error: process.env.NODE_ENV === "production" ? null : err.stack,
    };
    ctx.app.emit("error", err, ctx);
  }
});

// Configure middleware
app.use(morgan("dev"));
app.use(
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Origin", "Accept"],
    credentials: true,
    keepHeadersOnError: true,
    maxAge: 86400,
  })
);
app.use(bodyParser({ enableTypes: ["json", "form", "text"], jsonLimit: "10mb", formLimit: "10mb", textLimit: "10mb" }));

// Custom middleware to handle root path without URL parameter
app.use(async (ctx, next) => {
  if (ctx.path === "/" && !ctx.query.url) {
    ctx.type = "html";
    ctx.body = fs.createReadStream(path.join(publicDir, "index.html"));
    return;
  }
  await next();
});

app.use(router.routes()).use(router.allowedMethods());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("+======================+");
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("+======================+");
  console.log("Waiting for requests...");
});

// Handle uncaught errors
app.on("error", (err, ctx) => {
  console.error("Server error:", err);
});
