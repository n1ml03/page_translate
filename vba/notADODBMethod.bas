Option Explicit

Sub MergeChecklist()
    ' Objects & Variables
    Dim wbMain As Workbook, wbNew As Workbook, wbTemp As Workbook
    Dim wsCtrl As Worksheet, sht As Worksheet
    Dim fso As Object, fld As Object, fileItem As Object
    Dim dictWanted As Object
    Dim rngList As Range, cell As Range
    Dim folderPath As String, newFileName As String, userSavePath As Variant
    Dim goCode As String, goSource As String, sheetName As String
    
    ' Logging
    Dim strLog As String, countSuccess As Long, countError As Long, countSkipped As Long
    
    ' Error Handling & Performance Setup
    On Error GoTo ErrorHandler
    With Application
        .ScreenUpdating = False
        .DisplayAlerts = False
        .EnableEvents = False
        .Calculation = xlCalculationManual
        .PrintCommunication = False
        .StatusBar = "Initializing..."
    End With
    
    Set wbMain = ThisWorkbook
    On Error Resume Next
    Set wsCtrl = wbMain.Worksheets("ChecklistTool")
    On Error GoTo ErrorHandler
    
    If wsCtrl Is Nothing Then MsgBox "Error: Sheet 'ChecklistTool' not found.", vbCritical: GoTo ExitSub
    
    ' 1. Select Source Folder
    newFileName = wsCtrl.Range("B5").Value
    If newFileName = "" Then newFileName = "Checklist_Merge"
    
    With Application.FileDialog(msoFileDialogFolderPicker)
        .Title = "Select Source Folder"
        .InitialFileName = wbMain.Path & "\"
        If .Show = -1 Then folderPath = .SelectedItems(1) Else GoTo ExitSub
    End With
    
    ' 2. Build Dictionary
    Set dictWanted = CreateObject("Scripting.Dictionary")
    dictWanted.CompareMode = 1 ' Case Insensitive
    Set rngList = wsCtrl.Range("B8:B50")
    
    For Each cell In rngList
        sheetName = Trim(cell.Value)
        If Len(sheetName) > 0 And LCase(sheetName) <> "general operation" Then dictWanted(sheetName) = 1
    Next cell
    
    Set wbNew = Workbooks.Add
    strLog = "--- MERGE LOG ---" & vbNewLine
    
    ' 3. Process Internal Sheets
    If CopySheetIfExists(wbMain, wbNew, "Overview") Then strLog = strLog & "Overview (Internal)" & vbNewLine
    If CopySheetIfExists(wbMain, wbNew, "Updated Location") Then strLog = strLog & "Updated Location (Internal)" & vbNewLine
    
    ' Logic for General Operation
    goCode = Trim(wsCtrl.Range("D5").Value)
    If InStr(goCode, "01") > 0 Then goSource = "GO01"
    If InStr(goCode, "02") > 0 Then goSource = "GO02"
    If InStr(goCode, "03") > 0 Then goSource = "GO03"
    
    If goSource <> "" And SheetExists(wbMain, goSource) Then
        wbMain.Sheets(goSource).Copy After:=wbNew.Sheets(wbNew.Sheets.Count)
        With wbNew.Sheets(wbNew.Sheets.Count)
            .Name = "General Operation"
            .Visible = xlSheetVisible
        End With
    End If
    
    ' 4. Process External Files
    Set fso = CreateObject("Scripting.FileSystemObject")
    Set fld = fso.GetFolder(folderPath)
    
    For Each fileItem In fld.Files
        If (InStr(1, fso.GetExtensionName(fileItem.Name), "xls", vbTextCompare) > 0) And _
           (Left(fileItem.Name, 2) <> "~$") And (fileItem.Path <> wbMain.FullName) Then
            
            Application.StatusBar = "Processing: " & fileItem.Name
            
            ' Risk Check: Path Length
            If Len(fileItem.Path) > 218 Then
                strLog = strLog & "[ERROR] Path too long, skipped: " & fileItem.Name & vbNewLine
                countError = countError + 1
                GoTo NextFile
            End If
            
            ' Safe Open
            Set wbTemp = Nothing
            On Error Resume Next
            Set wbTemp = Workbooks.Open(FileName:=fileItem.Path, ReadOnly:=True, UpdateLinks:=0)
            On Error GoTo ErrorHandler
            
            If wbTemp Is Nothing Then
                strLog = strLog & "[ERROR] Cannot open: " & fileItem.Name & vbNewLine
                countError = countError + 1
                GoTo NextFile
            End If
            
            ' Copy Sheets
            For Each sht In wbTemp.Sheets
                If dictWanted.Exists(sht.Name) Then
                    If Not SheetExists(wbNew, sht.Name) Then
                        sht.Copy After:=wbNew.Sheets(wbNew.Sheets.Count)
                        
                        ' Ensure visibility & clear clipboard
                        wbNew.ActiveSheet.Visible = xlSheetVisible
                        Application.CutCopyMode = False 
                        
                        strLog = strLog & "[OK] " & sht.Name & " (" & fileItem.Name & ")" & vbNewLine
                        countSuccess = countSuccess + 1
                    Else
                        strLog = strLog & "[DUPLICATE] " & sht.Name & " skipped (" & fileItem.Name & ")" & vbNewLine
                        countSkipped = countSkipped + 1
                    End If
                End If
            Next sht
            
            wbTemp.Close SaveChanges:=False
        End If
NextFile:
    Next fileItem
    
    ' 5. Re-order Sheets
    For Each cell In rngList
        sheetName = Trim(cell.Value)
        If SheetExists(wbNew, sheetName) Then wbNew.Sheets(sheetName).Move After:=wbNew.Sheets(wbNew.Sheets.Count)
    Next cell
    
    If SheetExists(wbNew, "Sheet1") Then
        Application.DisplayAlerts = False
        wbNew.Sheets("Sheet1").Delete
    End If
    
    ' 6. Save Result
    Application.StatusBar = "Saving..."
    userSavePath = Application.GetSaveAsFilename(InitialFileName:=newFileName, FileFilter:="Excel Files (*.xlsx), *.xlsx")
    
    If userSavePath <> False Then
        On Error Resume Next
        wbNew.SaveAs userSavePath
        If Err.Number = 0 Then
            MsgBox "Done!" & vbNewLine & "Copied: " & countSuccess & vbNewLine & "Skipped: " & countSkipped & vbNewLine & "Errors: " & countError, vbInformation
        Else
            MsgBox "Error saving file (File might be open).", vbCritical
        End If
        On Error GoTo ErrorHandler
    Else
        wbNew.Close False
    End If

ExitSub:
    Set fso = Nothing
    Set wbTemp = Nothing
    Set wbNew = Nothing
    
    ' Restore settings
    With Application
        .StatusBar = False
        .PrintCommunication = True ' Restore printer communication
        .Calculation = xlCalculationAutomatic
        .EnableEvents = True
        .DisplayAlerts = True
        .ScreenUpdating = True
    End With
    Exit Sub

ErrorHandler:
    MsgBox "Error " & Err.Number & ": " & Err.Description, vbCritical
    If Not wbTemp Is Nothing Then wbTemp.Close False
    Resume ExitSub
End Sub

' --- Helpers ---

Function CopySheetIfExists(wbSrc As Workbook, wbDest As Workbook, sName As String) As Boolean
    If SheetExists(wbSrc, sName) Then
        wbSrc.Sheets(sName).Copy After:=wbDest.Sheets(wbDest.Sheets.Count)
        wbDest.ActiveSheet.Visible = xlSheetVisible
        Application.CutCopyMode = False
        CopySheetIfExists = True
    End If
End Function

Function SheetExists(wb As Workbook, sName As String) As Boolean
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = wb.Sheets(sName)
    On Error GoTo 0
    SheetExists = Not ws Is Nothing
End Function