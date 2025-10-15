FROM node:20-slim

# Instalar dependências necessárias para Chromium/Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libatspi2.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libdrm2 libexpat1 \
    libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
    libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 \
    wget xdg-utils --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar package.json e package-lock.json
COPY package*.json ./

# Instalar dependências de produção
RUN npm ci --omit=dev

# Copiar o resto do código
COPY . .

# Variáveis de ambiente
ENV NODE_ENV=production

# Comando para iniciar o bot
CMD ["node", "index.js"]
