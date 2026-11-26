# SETUP_GEMINI.bat 이 마지막에 띄우는 안내 창 (읽기 전용 텍스트 상자 + 복사 버튼)
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -STA -File setup-guide.ps1 -ExtDir <폴더> -ExtId <ID> [-ClipOk 1] [-TextOut <txt 경로>]
# -TextOut 을 주면 창을 띄우지 않고 같은 안내문을 UTF-8 텍스트 파일로만 저장합니다(메모장 대체용).
param(
  [Parameter(Mandatory = $true)][string]$ExtDir,
  [Parameter(Mandatory = $true)][string]$ExtId,
  [string]$ClipOk = '0',
  [string]$TextOut = ''
)
$ErrorActionPreference = 'Stop'

$clipLine = if ($ClipOk -eq '1') { '(이 경로는 클립보드에 이미 복사되어 있습니다)' } else { '(아래 「폴더 경로 복사」 버튼으로 복사하세요)' }
$guide = @"
고모 창작실 - Gemini 연결 설정

Native Host 등록을 마쳤습니다. 이제 Chrome 에서 확장 프로그램을 불러오세요.
아래 단계는 이 컴퓨터에서 한 번만 하면 됩니다.
(개발자 모드를 켜는 일은 Chrome 이 막아 두어서 자동으로 할 수 없습니다)

1. Chrome 주소창에 chrome://extensions 를 엽니다.
   설정 파일이 이 화면을 띄우려고 시도했습니다.

2. 오른쪽 위에서 「개발자 모드」를 켭니다.

3. 「압축해제된 확장 프로그램을 로드합니다」를 누르고 아래 폴더를 선택합니다.
   $clipLine

   $ExtDir

4. GOMO Gemini Connector 카드에 표시된 ID 가 아래와 같은지 확인합니다.

   $ExtId

   예전에 불러온 확장이 있고 ID 가 다르면, 그 카드를 제거한 뒤
   위 폴더를 다시 불러오세요.

5. Chrome 을 완전히 종료했다가 다시 켭니다.
   창만 닫지 말고, 트레이 아이콘이 있으면 종료까지 하세요.

그다음 Gemini 에 로그인한 탭을 열고, 고모 창작실에서
환경 설정 → AI 연결 → 연결 상태 확인 을 누르세요.
"@
$guide = $guide -replace "`r?`n", "`r`n"

if ($TextOut) {
  [System.IO.File]::WriteAllText($TextOut, $guide, (New-Object System.Text.UTF8Encoding($true)))
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$font = New-Object System.Drawing.Font('Malgun Gothic', 10)

$form = New-Object System.Windows.Forms.Form
$form.Text = '고모 창작실 - Gemini 연결 설정'
$form.Size = New-Object System.Drawing.Size(680, 620)
$form.MinimumSize = New-Object System.Drawing.Size(480, 360)
$form.StartPosition = 'CenterScreen'
$form.Font = $font
$form.TopMost = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true
$box.ReadOnly = $true
$box.ScrollBars = 'Vertical'
$box.WordWrap = $true
$box.Dock = 'Fill'
$box.BackColor = [System.Drawing.SystemColors]::Window
$box.Font = $font
$box.Text = $guide

$bar = New-Object System.Windows.Forms.FlowLayoutPanel
$bar.Dock = 'Bottom'
$bar.FlowDirection = 'RightToLeft'
$bar.AutoSize = $true
$bar.Padding = New-Object System.Windows.Forms.Padding(8)

function New-BarButton([string]$text, [scriptblock]$onClick) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.AutoSize = $true
  $b.Padding = New-Object System.Windows.Forms.Padding(6, 2, 6, 2)
  $b.Add_Click($onClick)
  return $b
}
$status = New-Object System.Windows.Forms.Label
$status.AutoSize = $true
$status.Margin = New-Object System.Windows.Forms.Padding(8, 10, 8, 0)
$status.ForeColor = [System.Drawing.Color]::SeaGreen

$close = New-BarButton '닫기' { $form.Close() }
$copyId = New-BarButton '확장 ID 복사' { [System.Windows.Forms.Clipboard]::SetText($ExtId); $status.Text = '확장 ID 를 복사했습니다.' }
$copyDir = New-BarButton '폴더 경로 복사' { [System.Windows.Forms.Clipboard]::SetText($ExtDir); $status.Text = '폴더 경로를 복사했습니다.' }
$top = New-Object System.Windows.Forms.CheckBox
$top.Text = '항상 위에'
$top.AutoSize = $true
$top.Checked = $true
$top.Margin = New-Object System.Windows.Forms.Padding(8, 8, 8, 0)
$top.Add_CheckedChanged({ $form.TopMost = $top.Checked })

$bar.Controls.AddRange(@($close, $copyId, $copyDir, $top, $status))
$form.Controls.Add($box)
$form.Controls.Add($bar)
$form.AcceptButton = $close
$form.CancelButton = $close
$form.Add_Shown({ $form.Activate(); $box.SelectionLength = 0; $close.Focus() })
[void]$form.ShowDialog()
exit 0
