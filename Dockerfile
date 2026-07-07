# Receipt Analyser — production image (the portable/Fly.io path; Render uses native Node, no Docker).
# The app is STATELESS: all state lives in Supabase (Postgres + Storage), nothing on local disk.
# No build step; the only "native"-ish dep (@hyzyla/pdfium) is WASM, so node:20-slim needs no toolchain.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Prod deps first so this layer is cached until the manifests change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source. .dockerignore keeps .env / node_modules / tests / docs / .git out.
COPY . .

# Least privilege — node:20-slim ships a non-root `node` user; the app never writes to disk.
USER node

# Informational only; the platform maps its own PORT env in (the app reads process.env.PORT).
EXPOSE 3001

# Liveness: hit /health with plain node (no curl/wget in -slim). 0 = healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
