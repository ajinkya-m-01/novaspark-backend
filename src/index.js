import app from "./app.js";
import { config } from "./config.js";
const server = app.listen(config.PORT, () => {
  console.log(`Backend running at http://localhost:${config.PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${config.PORT} is already in use.`);
  } else {
    console.error("Server error:", err);
  }
});

const handleShutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGTERM", handleShutdown);
process.on("SIGINT", handleShutdown);

export default app;
