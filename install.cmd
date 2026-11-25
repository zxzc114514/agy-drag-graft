@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install Node.js, then run this script again. 1>&2
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Upgrade Node.js, then run this script again. 1>&2
  exit /b 1
)
node "%~dp0manage.mjs" install %*
exit /b %ERRORLEVEL%
