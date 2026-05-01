# Usa uma imagem Node bem leve (Debian Slim)
FROM node:20-slim

# Instala apenas as dependências CRÍTICAS para o Chrome rodar no Linux
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libgbm-dev \
    libasound2 \
    libxrender1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    fonts-liberation \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Configurações do Puppeteer para não baixar o Chrome de novo (usar o que vem no pacote)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome

# Cria a pasta do app
WORKDIR /app

# Copia apenas os arquivos de dependências primeiro (otimiza build)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o resto do código
COPY . .

# Comando para rodar
CMD ["node", "index.js"]