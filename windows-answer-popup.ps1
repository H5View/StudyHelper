Add-Type -AssemblyName PresentationFramework

$window = New-Object System.Windows.Window
$window.Title = 'StudyHelper'
$window.Width = 520
$window.SizeToContent = 'Height'
$window.MinHeight = 130
$window.WindowStartupLocation = 'Manual'
$window.ResizeMode = 'NoResize'
$window.ShowInTaskbar = $false
$window.Topmost = $true
$window.Background = [System.Windows.Media.Brushes]::White

$panel = New-Object System.Windows.Controls.StackPanel
$panel.Margin = '22'

$status = New-Object System.Windows.Controls.TextBlock
$status.FontSize = 13
$status.Foreground = [System.Windows.Media.Brushes]::DimGray
$status.Margin = '0,0,0,8'
$status.Text = 'StudyHelper'
$panel.Children.Add($status)

$answer = New-Object System.Windows.Controls.TextBlock
$answer.FontSize = 25
$answer.FontWeight = 'SemiBold'
$answer.TextWrapping = 'Wrap'
$answer.MaxHeight = 260
$panel.Children.Add($answer)

$window.Content = $panel
$window.Hide()

$script:lastTimestamp = ''
$script:hideAt = $null

function Show-StudyHelperPopup([string]$message, [string]$state) {
    if ($state -eq 'working') {
        $status.Text = 'StudyHelper is working...'
        $answer.Foreground = [System.Windows.Media.Brushes]::SteelBlue
        $script:hideAt = $null
    } elseif ($state -eq 'error') {
        $status.Text = 'StudyHelper'
        $answer.Foreground = [System.Windows.Media.Brushes]::Firebrick
        $script:hideAt = [DateTime]::UtcNow.AddSeconds(5)
    } else {
        $status.Text = 'StudyHelper answer'
        $answer.Foreground = [System.Windows.Media.Brushes]::Black
        $script:hideAt = [DateTime]::UtcNow.AddSeconds(7)
    }

    $answer.Text = $message
    $window.Show()
    $window.Activate()
    $window.Topmost = $true
    $window.Topmost = $false
    $window.Topmost = $true
    $window.Left = [System.Windows.SystemParameters]::WorkArea.Right - $window.ActualWidth - 24
    $window.Top = [System.Windows.SystemParameters]::WorkArea.Top + 24
}

$window.Add_PreviewKeyDown({
    param($sender, $event)
    if ($event.Key -eq [System.Windows.Input.Key]::Escape) {
        $sender.Hide()
        $script:hideAt = $null
    }
})

$window.Add_Closing({
    param($sender, $event)
    $event.Cancel = $true
    $sender.Hide()
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
    try {
        $state = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/latest-answer' -TimeoutSec 1
        if ($state.timestamp -and $state.timestamp -ne $script:lastTimestamp) {
            $script:lastTimestamp = $state.timestamp
            Show-StudyHelperPopup $state.answer $state.status
        }
    } catch {
        # The bridge can be restarting; the next poll will reconnect.
    }

    if ($script:hideAt -and [DateTime]::UtcNow -ge $script:hideAt) {
        $window.Hide()
        $script:hideAt = $null
    }
})
$timer.Start()

$application = New-Object System.Windows.Application
$application.Run()
