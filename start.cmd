@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   TV Hub - نسخة الويب
echo   -------------------
echo   جارٍ تشغيل الخادم المحلي...
echo.

start "" "http://localhost:8731"
node server.cjs 8731

echo.
echo   توقّف الخادم. اضغط أي مفتاح للإغلاق.
pause >nul
