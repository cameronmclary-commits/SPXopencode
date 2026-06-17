#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Starting ZeroD SPX Dashboard..."
echo ""

# Install backend deps if needed
if [ ! -d "$DIR/options-api/node_modules" ]; then
  echo "Installing backend dependencies..."
  cd "$DIR/options-api" && npm install
fi

# Install frontend deps if needed
if [ ! -d "$DIR/spx-app/node_modules" ]; then
  echo "Installing frontend dependencies..."
  cd "$DIR/spx-app" && npm install
fi

# Start backend
cd "$DIR/options-api"
npm start &
BACKEND_PID=$!
echo "Backend running on http://localhost:3080 (PID: $BACKEND_PID)"

# Start frontend
cd "$DIR/spx-app"
npm run dev &
FRONTEND_PID=$!
echo "Frontend running on http://localhost:5173 (PID: $FRONTEND_PID)"

echo ""
echo "Open http://localhost:5173 in your browser"
echo "Press Ctrl+C to stop both"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
