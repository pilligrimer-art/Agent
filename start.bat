@echo off
title Local Ollama Agent Server
echo ===================================================
echo     Starting Autonomous Agent and Web Interface
echo ===================================================

if not exist "node_modules" (
    echo [Installing dependencies...]
    call npm install
)

echo [Opening interface in browser...]
start "" cmd /c "timeout /t 2 > nul && start http://localhost:3000"

echo [Starting server...]
echo ===================================================
echo To stop the server, close this window or press Ctrl+C
echo ===================================================

node server.js

pause
