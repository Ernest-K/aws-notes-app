FROM node:23-alpine

# Utworzenie katalogu aplikacji
WORKDIR /usr/src/app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy app source
COPY . .

# Default port
EXPOSE 8080

# Command to run the application
CMD ["npm", "start"]