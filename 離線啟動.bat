@echo off
cd /d "%~dp0"
title 標籤條碼檢查

rem 網頁不能用 file:// 直接開（瀏覽器會擋掉 JS 模組，整個程式載不起來），
rem 所以起一個只聽本機的小伺服器。這個視窗關掉，服務就停止。

where python >nul 2>&1
if errorlevel 1 (
  echo 找不到 python，無法啟動本機版。
  echo 請改用網址開啟： https://pokaihsu1243-create.github.io/label-barcode-check/
  pause
  exit /b 1
)

python "%~dp0devserver.py" 8732
if errorlevel 1 pause
