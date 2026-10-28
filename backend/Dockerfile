FROM node:22-bookworm-slim

ENV NODE_ENV=development
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
EXPOSE 5000

CMD ["npm", "run", "dev"]
