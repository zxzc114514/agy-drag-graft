@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required to uninstall AGY Drag Graft safely. 1>&2
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required to uninstall AGY Drag Graft safely. 1>&2
  exit /b 1
)
node "%~dp0manage.mjs" uninstall %*
exit /b %ERRORLEVEL%
