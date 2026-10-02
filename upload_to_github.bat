@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================================
echo        YuAI GitHub 自动化发布/推送脚本
echo ========================================================
echo.

:: 检查 git
where git >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 系统中未找到 git 命令，请先安装 Git！
    pause
    exit /b 1
)

:: 进入脚本所在目录
cd /d "%~dp0"

:: 检查当前分支
for /f "tokens=*" %%i in ('git branch --show-current 2^>nul') do set CURRENT_BRANCH=%%i
if "%CURRENT_BRANCH%"=="" set CURRENT_BRANCH=main

echo [1/4] 检查本地仓库状态 (分支: %CURRENT_BRANCH%)...
git status --short

:: 检查是否有未暂存或未提交的变更
git status --porcelain | findstr /r "^.[MD]" >nul 2>nul
set HAS_CHANGES=%errorlevel%
git status --porcelain | findstr /r "^\?\?" >nul 2>nul
set HAS_UNTRACKED=%errorlevel%

if %HAS_CHANGES% equ 0 goto DO_COMMIT
if %HAS_UNTRACKED% equ 0 goto DO_COMMIT
goto SKIP_COMMIT

:DO_COMMIT
echo.
set /p COMMIT_MSG="[2/4] 输入本次提交说明 (直接回车默认: 'chore: update YuAI release'): "
if "%COMMIT_MSG%"=="" set COMMIT_MSG=chore: update YuAI release

echo 正在暂存文件...
git add -A
echo 正在提交: %COMMIT_MSG%
git commit -m "%COMMIT_MSG%"
goto DO_PUSH

:SKIP_COMMIT
echo [2/4] 工作区干净，无新的代码需要提交。
goto DO_PUSH

:DO_PUSH
echo.
echo [3/4] 检查远程仓库配置...
git remote -v

:: 检查是否配置了 origin
git remote | findstr /x "origin" >nul 2>nul
if %errorlevel% neq 0 (
    echo [提示] 尚未配置远程仓库 origin。
    set /p REPO_URL="请输入远程仓库 URL (例如 https://github.com/Addmsfw/YuAI.git): "
    if "!REPO_URL!"=="" (
        echo [错误] 仓库地址不能为空！
        pause
        exit /b 1
    )
    git remote add origin "!REPO_URL!"
)

echo.
echo [4/4] 正在推送到 GitHub (%CURRENT_BRANCH%)...
git push origin %CURRENT_BRANCH%

if %errorlevel% equ 0 (
    echo.
    echo ========================================================
    echo  [成功] 项目已成功推送到 GitHub 远程仓库！
    echo ========================================================
) else (
    echo.
    echo ========================================================
    echo  [推送失败] 请检查以下几项：
    echo   1. 网络是否畅通、代理是否需要开启
    echo   2. 是否具有该仓库的写入权限
    echo   3. 若提示凭据错误，可使用带有 repo 权限的 Personal Access Token 登录
    echo ========================================================
)

echo.
pause
