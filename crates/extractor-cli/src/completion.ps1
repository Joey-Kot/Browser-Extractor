# Adapted from Serper. Copyright (c) 2026 Joey Kot <joey.kot.x@gmail.com>.
# MIT license text is available in THIRD_PARTY_LICENSES/MIT.txt.

Register-ArgumentCompleter -Native -CommandName 'scrape' -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    # Read literal tokens to avoid evaluating expressions during completion.
    $words = [System.Collections.Generic.List[string]]::new()
    $quote = $null
    foreach ($element in $commandAst.CommandElements) {
        if ($element.Extent.StartOffset -ge $cursorPosition) {
            break
        }
        if ($wordToComplete -ne '' -and $element.Extent.EndOffset -ge $cursorPosition) {
            if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                $element.StringConstantType -eq 'SingleQuoted') {
                $quote = "'"
                $words.Add($element.Value)
            } elseif ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
                      $element.StringConstantType -eq 'DoubleQuoted') {
                $quote = '"'
                $words.Add($element.Value)
            } else {
                $words.Add($wordToComplete)
            }
            break
        }
        if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
            $words.Add($element.Value)
        } else {
            $words.Add($element.Extent.Text)
        }
    }
    if ($wordToComplete -eq '') {
        $words.Add('')
    }
    # Legacy native argument passing drops empty strings, including quoted words from the AST.
    if ($PSVersionTable.PSVersion -lt [version]'7.3' -or $PSNativeCommandArgumentPassing -eq 'Legacy') {
        for ($index = 0; $index -lt $words.Count; $index++) {
            if ($words[$index] -eq '') {
                $words[$index] = '""'
            }
        }
    }

    $previous = $env:SCRAPE_COMPLETE
    try {
        $env:SCRAPE_COMPLETE = 'powershell'
        $results = & scrape -- @words
    } finally {
        if ($null -eq $previous) {
            Remove-Item Env:SCRAPE_COMPLETE -ErrorAction SilentlyContinue
        } else {
            $env:SCRAPE_COMPLETE = $previous
        }
    }
    foreach ($result in $results) {
        $parts = $result -split "`t", 2
        $description = if ($parts.Count -gt 1) { $parts[1] } else { $parts[0] }
        $candidate = if ($quote -eq "'" -or ($quote -eq $null -and $parts[0] -match '[^a-zA-Z0-9_./:\\=-]')) {
            "'" + $parts[0].Replace("'", "''") + "'"
        } elseif ($quote -eq '"') {
            '"' + $parts[0].Replace('`', '``').Replace('$', '`$').Replace('"', '`"') + '"'
        } else {
            $parts[0]
        }
        [System.Management.Automation.CompletionResult]::new(
            $candidate, $parts[0], 'ParameterValue', $description
        )
    }
}
