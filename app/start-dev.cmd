@echo off
cd /d "%~dp0"
if "%MINIMAX_API_KEY%"=="" (
  echo [Mirai] MINIMAX_API_KEY is not set. Studio and VN will use local fallbacks.
) else (
  start "Mirai proxy" cmd /c "node server\mirai-proxy.mjs"
)
start "Mirai dev" cmd /c "npm run dev"
echo.
echo Studio: http://localhost:5274/mirai-studio.html
echo VN:     http://localhost:5274/mirai-vn.html
