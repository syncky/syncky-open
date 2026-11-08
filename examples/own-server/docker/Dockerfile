FROM node:22.15.0-bookworm-slim
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY package.json ./
COPY src/ ./src/
COPY docker/server.js docker/sql.js ./docker/
USER node
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "docker/server.js"]
