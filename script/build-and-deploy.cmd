@echo off
setlocal DisableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
where bun >nul 2>nul
if errorlevel 1 (
  echo bun was not found on PATH. Install Bun 1.4.0 and retry. 1>&2
  exit /b 1
)
cd /d "%REPO_ROOT%"
bun run desktop:deploy automatic --prompt-stale-cancel %*
exit /b %ERRORLEVEL%
