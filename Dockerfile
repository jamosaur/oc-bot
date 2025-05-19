# Dockerfile for Discord OC Bot
FROM node:latest

# Set working directory
WORKDIR /usr/src/app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose (not strictly needed for Discord bots, but for healthchecks)
EXPOSE 3000

# Command to run the bot
#CMD ["node", "dist/index.js"]
CMD ["node", "--trace-warnings", "dist/index.js"]
