FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p logs data/plugins config/plugins

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
