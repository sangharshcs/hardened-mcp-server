# Standard base image - the "before" side of the Docker Hardened Images
# migration described in README.md.
#
# node:24-trixie-slim is the same baseline Docker's own official DHI Node.js
# lab uses for comparison:
# https://docs.docker.com/guides/lab-dhi-node/
FROM node:24-trixie-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "src/server.js"]
