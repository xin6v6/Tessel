import index from "./index.html";

const server = Bun.serve({
  port: 3456,
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`\n🔗 Agent Graph UI → http://localhost:${server.port}\n`);
