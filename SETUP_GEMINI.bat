@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo ========================================
echo  고모 창작실 - Gemini 연결 설정
echo ========================================
echo 이 파일을 다시 실행해도 안전합니다.
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

set "NODEVER="
set "NODEMAJOR="
set "NODEMINOR="
for /f "tokens=1 delims=v" %%a in ('node -v 2^>nul') do set "NODEVER=%%a"
if not defined NODEVER goto :old_node
for /f "tokens=1,2 delims=." %%a in ("%NODEVER%") do (
  set "NODEMAJOR=%%a"
  set "NODEMINOR=%%b"
)
if not defined NODEMAJOR goto :old_node
if not defined NODEMINOR set "NODEMINOR=0"
if %NODEMAJOR% LSS 22 goto :old_node
if %NODEMAJOR% EQU 22 if %NODEMINOR% LSS 12 goto :old_node

where npm >nul 2>nul
if errorlevel 1 goto :no_npm

if not exist "node_modules\electron" (
  echo 필요한 구성을 설치합니다. 시간이 조금 걸릴 수 있습니다...
  call npm install
  if errorlevel 1 goto :npm_failed
)

echo Native Host 를 등록합니다...
call npm run native:register
if errorlevel 1 goto :reg_failed
call npm run native:check
if errorlevel 1 goto :reg_failed
echo.

set "FIXED_ID="
for /f "usebackq delims=" %%i in (`node native-host\extension-id.mjs`) do set "FIXED_ID=%%i"
if not defined FIXED_ID set "FIXED_ID=ekibpgmnknamcpplppceoaogmcbcabbo"

set "EXTDIR=%~dp0extension"
echo 확장 폴더 경로를 클립보드에 복사하는 중...
<nul set /p="%EXTDIR%" | clip
if errorlevel 1 (
  echo 클립보드 복사에 실패했습니다. 아래 경로를 직접 복사하세요.
) else (
  echo 확장 폴더 경로를 클립보드에 복사했습니다.
)
echo.

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "CHROME_X86=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%CHROME_X86%" set "CHROME=%CHROME_X86%"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo Chrome 확장 프로그램 화면을 여는 중입니다...
if defined CHROME (
  start "" "%CHROME%" chrome://extensions
) else (
  start "" chrome chrome://extensions
)
if errorlevel 1 echo Chrome 을 자동으로 열지 못했습니다. 주소창에 chrome://extensions 를 직접 입력하세요.
echo 화면이 안 열리면 Chrome 주소창에 chrome://extensions 를 직접 입력하세요.
echo.
echo ------------------------------------------------
echo  이제 Chrome 에서 확장 프로그램을 불러오세요.
echo  아래 단계는 이 컴퓨터에서 한 번만 하면 됩니다.
echo  개발자 모드를 켜는 일은 Chrome 이 막아 두어서
echo  자동으로 할 수 없습니다.
echo ------------------------------------------------
echo.
echo  1. Chrome 주소창에  chrome://extensions  를 엽니다.
echo     이 파일이 그 화면을 띄우려고 시도했습니다.
echo  2. 오른쪽 위에서  개발자 모드  를 켭니다.
echo     이 컴퓨터에서 한 번만 켜면 됩니다.
echo  3. 압축해제된 확장 프로그램을 로드합니다  를 누르고
echo     아래 폴더를 선택합니다. 경로는 클립보드에도 복사되어 있습니다.
echo.
echo     %EXTDIR%
echo.
echo  4. GOMO Gemini Connector 카드에 표시된 ID 가
echo     아래와 같은지 확인합니다.
echo.
echo     %FIXED_ID%
echo.
echo     예전에 불러온 확장이 있고 ID 가 다르면, 그 카드를
echo     제거한 뒤 위 폴더를 다시 불러오세요.
echo  5. Chrome 을 완전히 종료했다가 다시 켭니다.
echo     창만 닫지 말고, 트레이 아이콘이 있으면 종료까지 하세요.
echo.
echo  그다음 Gemini 에 로그인한 탭을 열고, 고모 창작실에서
echo  환경 설정 - AI 연결 - 연결 상태 확인 을 누르세요.
echo.
pause
exit /b 0

:no_node
echo [오류] Node.js 가 설치되어 있지 않습니다.
echo Node.js 22.12 이상을 https://nodejs.org 에서 설치한 뒤
echo 이 파일을 다시 실행하세요. LTS 버전을 권장합니다.
start https://nodejs.org
pause
exit /b 1

:old_node
echo [오류] Node.js 버전이 너무 낮습니다. 지금 버전: %NODEVER%
echo Node.js 22.12 이상을 https://nodejs.org 에서 설치한 뒤
echo 이 파일을 다시 실행하세요. LTS 버전을 권장합니다.
start https://nodejs.org
pause
exit /b 1

:no_npm
echo [오류] npm 을 찾을 수 없습니다. Node.js 를 다시 설치해 주세요.
echo 다운로드: https://nodejs.org
start https://nodejs.org
pause
exit /b 1

:npm_failed
echo [오류] npm install 이 실패했습니다.
echo 인터넷 연결과 Node.js 버전을 확인한 뒤 다시 실행하세요.
pause
exit /b 1

:reg_failed
echo [오류] Native Host 등록 또는 확인에 실패했습니다.
echo 위 메시지를 확인한 뒤 이 파일을 다시 실행하세요.
pause
exit /b 1
