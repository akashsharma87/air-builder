@echo off
rem Air Builder: double-click to start on Windows.
rem Starts a tiny local web server here and opens the app in your browser.
cd /d "%~dp0"
set PORT=8000
echo.
echo   Air Builder is running at http://localhost:%PORT%
echo   Keep this window open while you use it. Close it to stop.
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"

where python >nul 2>nul && (python -m http.server %PORT% & goto :eof)
where py >nul 2>nul && (py -m http.server %PORT% & goto :eof)
where npx >nul 2>nul && (npx --yes serve -l %PORT% . & goto :eof)

echo   Python isn't installed. Get it free from https://www.python.org/downloads/
echo   (tick "Add python.exe to PATH" while installing), then run this again.
pause
