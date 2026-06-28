@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title TurboWarp WebSocket 联机服务器

echo ========================================
echo   TurboWarp WebSocket 联机服务器 v1.1
echo ========================================
echo.

:: ========== 1. 检测并安装 Node.js ==========
:check_node
node -v >nul 2>&1
if %errorlevel% equ 0 goto node_ok

echo [✘] 未检测到 Node.js 环境，准备自动安装...

set NODE_INSTALLED=0
set MSI_NAME=node-v24.14.1-x64.msi
set DOWNLOAD_URL=https://nodejs.org/dist/v24.14.1/%MSI_NAME%

:: 优先尝试本地安装包
if exist "%MSI_NAME%" (
    echo [*] 发现本地安装包 %MSI_NAME%，开始安装...
    call :install_msi "%MSI_NAME%"
    if !NODE_INSTALLED! equ 1 goto node_ok
    echo [✘] 本地安装包安装失败，将尝试联网下载...
)

:: 本地安装失败或文件不存在，联网下载安装
echo [*] 正在从官方源下载 Node.js 安装包...
call :download_and_install
if !NODE_INSTALLED! equ 1 goto node_ok

echo [✘] 自动安装 Node.js 失败，请手动安装后重新运行本脚本。
echo     官方下载地址：https://nodejs.org/
pause
exit /b 1

:install_msi
echo 正在安装 %~1 （静默模式，可能需要管理员权限）...
msiexec /i "%~1" /quiet /norestart
if %errorlevel% neq 0 (
    echo [*] 静默安装失败，尝试以 /passive 模式安装（可能需要点击允许）...
    msiexec /i "%~1" /passive /norestart
    if %errorlevel% neq 0 (
        echo [✘] 安装失败，错误代码：%errorlevel%
        exit /b 1
    )
)

:: 刷新环境变量，验证安装
set "PATH=%ProgramFiles%\nodejs;%PATH%"
node -v >nul 2>&1
if %errorlevel% equ 0 (
    set NODE_INSTALLED=1
    echo [✓] Node.js 安装成功
) else (
    echo [✘] 安装后仍无法调用 node，请检查系统环境变量或手动重启脚本。
)
exit /b

:download_and_install
powershell -Command "Invoke-WebRequest -Uri '%DOWNLOAD_URL%' -OutFile '%MSI_NAME%'"
if not exist "%MSI_NAME%" (
    echo [✘] 下载失败，请检查网络连接或确认版本 %MSI_NAME% 存在。
    exit /b 1
)
echo [✓] 下载完成
call :install_msi "%MSI_NAME%"
exit /b

:node_ok
echo [✓] Node.js 环境正常
echo.

:: ========== 2. 检查依赖 ==========
if not exist "node_modules" (
    echo [*] 首次启动，正在安装依赖 ws...
    npm install ws --registry=https://registry.npmmirror.com
    if %errorlevel% neq 0 (
        echo [✘] 依赖安装失败，请检查网络连接
        pause
        exit
    )
    echo [✓] 依赖安装完成！
    echo.
)

:: ========== 3. 启动服务器 ==========
echo [*] 服务器启动中，请勿关闭此窗口...
echo [*] 如需停止服务器，请按 Ctrl+C
echo.
echo [✓] 服务器已启动 %date% %time%
echo ----------------------------------------
node server.js
echo ----------------------------------------
echo [✘] 服务器进程已退出，5 秒后自动重启...
timeout /t 5 >nul
cls
goto check_node