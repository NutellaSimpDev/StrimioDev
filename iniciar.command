#!/bin/bash
cd "$(dirname "$0")"

# Obtener el puerto configurado en el archivo .env, por defecto 3000
PORT=$(grep -E "^PORT=" .env | cut -d '=' -f2 | tr -d '\r\n[:space:]')
if [ -z "$PORT" ]; then
  PORT=3000
fi

echo "Iniciando StrimioDev en el puerto $PORT..."
(sleep 1.5 && open "http://localhost:$PORT") &
npm run dev:streamer
