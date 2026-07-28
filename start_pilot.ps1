$env:PORT="3001"
$env:MODEL_NAME="qwen3.5:9b"
$env:LOG_DIR="./logs_pilot"
$env:MEMORY_DIR="./memory_pilot"
$env:TEMPERATURE="0.2"
$env:OLLAMA_TIMEOUT_MS="300000"

Write-Host "Starting Pilot Instance (Qwen 3.5 9B) on Port 3001..."
node server.js
