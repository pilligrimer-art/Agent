@echo off
title Local Ollama Agent Suite Launcher
chcp 65001 > nul

echo ===================================================
echo     AUTONOMOUS AGENT ENVIRONMENT BOOTSTRAPPER
echo ===================================================
echo.

:: 1. Dependency check
if not exist "node_modules" (
    echo [1/4] Installing npm dependencies...
    call npm install
) else (
    echo [1/4] Dependencies verified.
)
echo.

:: 2. Run Environment Diagnostics
echo [2/4] Running Environment Diagnostics...
node check_env.js
if %ERRORLEVEL% neq 0 (
    echo ❌ Environment diagnostics failed!
    pause
    exit /b %ERRORLEVEL%
)
echo.

:: 3. Run all Contract Tests to ensure regression safety
echo [3/4] Running All Integration & Contract Tests...
call node tests/contract_docs.test.js
if %ERRORLEVEL% neq 0 (
    echo ❌ Documentation contract tests failed!
    pause
    exit /b %ERRORLEVEL%
)
call node tests/contract_schedule.test.js
if %ERRORLEVEL% neq 0 (
    echo ❌ Schedule contract tests failed!
    pause
    exit /b %ERRORLEVEL%
)
call node tests/contract_snippet.test.js
if %ERRORLEVEL% neq 0 (
    echo ❌ Snippet/Loop breaking contract tests failed!
    pause
    exit /b %ERRORLEVEL%
)
echo ✅ All 47 contract tests passed green!
echo.

:: 4. Ensure Ollama Server is running
echo [4/4] Checking Ollama server status...
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:11434/api/tags > temp_code.txt
set /p STATUS_CODE=<temp_code.txt
del temp_code.txt

if "%STATUS_CODE%"=="200" (
    echo ✅ Ollama server is already running!
) else (
    echo 🚀 Starting Ollama server in a new window...
    start "Ollama Serve" cmd /c "ollama serve"
    echo Waiting 5 seconds for Ollama server to initialize...
    timeout /t 5 > nul
)
echo.

:: 5. Open Web Interface and Start Web Server
echo ===================================================
echo  Starting Express Web Server & Opening Browser...
echo ===================================================
start "" cmd /c "timeout /t 2 > nul && start http://localhost:3000"

node server.js

pause
