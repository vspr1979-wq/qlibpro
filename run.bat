@echo off
REM OptionSignal - Windows 11 launcher
cd /d %~dp0

if not exist .venv (
  echo Creating virtual environment...
  py -3.11 -m venv .venv || py -m venv .venv || python -m venv .venv
)

call .venv\Scripts\activate.bat

echo Installing dependencies (first run only)...
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo Starting OptionSignal at http://127.0.0.1:5000 ...
python app.py
pause
