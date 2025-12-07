' ==========================================
' >>> Standard Module
' ==========================================

Option Explicit

' ==========================================
' >>> CONFIGURATION AREA
' ==========================================
Public Const START_ROW As Long = 10         ' Data starts from this row (Header is at row 9)
Public Const COL_FILE As String = "A"       ' Column for File Names
Public Const COL_PATH As String = "B"       ' Column for Hidden Full Paths
Public Const COL_CHECK As String = "D"      ' Column for 'x' Checkboxes
Public Const COL_SHEET As String = "E"      ' Column for Sheet Names
Public Const COL_Q_PATH As String = "G"     ' Queue: Source Path
Public Const COL_Q_SHEET As String = "H"    ' Queue: Sheet Name
Public Const CELL_TEMP As String = "E9"     ' Cell to store current viewing path (Hidden/Comment)
' ==========================================

' --- 1. SELECT FOLDER & LIST FILES ---
Sub Main_SelectFolder()
    Dim fd As FileDialog
    Dim fso As Object, fld As Object, fileItem As Object
    Dim ws As Worksheet, r As Long
    
    Set ws = ThisWorkbook.Sheets("Dashboard")
    
    ' Clear old data based on Constants
    ws.Range(COL_FILE & START_ROW & ":" & COL_PATH & "50").ClearContents
    ws.Range(COL_CHECK & START_ROW & ":" & COL_SHEET & "50").ClearContents
    ws.Range(COL_Q_PATH & START_ROW & ":" & COL_Q_SHEET & "50").ClearContents
    
    Set fd = Application.FileDialog(msoFileDialogFolderPicker)
    If fd.Show = -1 Then
        Application.ScreenUpdating = False
        Set fso = CreateObject("Scripting.FileSystemObject")
        Set fld = fso.GetFolder(fd.SelectedItems(1))
        
        r = START_ROW
        On Error Resume Next
        For Each fileItem In fld.Files
            ' Filter Excel files
            If InStr(1, fso.GetExtensionName(fileItem.Name), "xls", vbTextCompare) > 0 And Left(fileItem.Name, 2) <> "~$" Then
                ws.Range(COL_FILE & r).Value = fileItem.Name
                ws.Range(COL_PATH & r).Value = fileItem.Path
                r = r + 1
            End If
        Next fileItem
        On Error GoTo 0
        Application.ScreenUpdating = True
        MsgBox "File list loaded!", vbInformation
    End If
End Sub

' --- 2. ADD SELECTED SHEETS TO QUEUE ---
Sub Main_AddToList()
    Dim ws As Worksheet
    Dim lastRowSrc As Long, lastRowDest As Long
    Dim i As Long, currentFilePath As String
    
    Set ws = ThisWorkbook.Sheets("Dashboard")
    
    ' Retrieve path from Note/Comment in Configured Cell
    On Error Resume Next
    currentFilePath = ws.Range(CELL_TEMP).NoteText
    On Error GoTo 0
    
    If currentFilePath = "" Then MsgBox "Double-click a file first.", vbExclamation: Exit Sub
    
    lastRowSrc = ws.Cells(ws.Rows.Count, COL_SHEET).End(xlUp).Row
    lastRowDest = ws.Cells(ws.Rows.Count, COL_Q_PATH).End(xlUp).Row + 1
    If lastRowDest < START_ROW Then lastRowDest = START_ROW
    
    ' Loop through checks
    For i = START_ROW To lastRowSrc
        If LCase(Trim(ws.Range(COL_CHECK & i).Value)) = "x" Then
            ws.Range(COL_Q_PATH & lastRowDest).Value = currentFilePath
            ws.Range(COL_Q_SHEET & lastRowDest).Value = ws.Range(COL_SHEET & i).Value
            ws.Range(COL_CHECK & i).Value = "Added"
            lastRowDest = lastRowDest + 1
        End If
    Next i
End Sub

' --- 3. EXPORT / MERGE FILES ---
Sub Main_ExportFile()
    Dim wsDash As Worksheet, wbNew As Workbook, wbSrc As Workbook
    Dim lastRow As Long, i As Long, cnt As Long
    
    Set wsDash = ThisWorkbook.Sheets("Dashboard")
    lastRow = wsDash.Cells(wsDash.Rows.Count, COL_Q_PATH).End(xlUp).Row
    
    If lastRow < START_ROW Then MsgBox "Queue is empty.", vbExclamation: Exit Sub
    
    Application.ScreenUpdating = False: Application.DisplayAlerts = False
    Set wbNew = Workbooks.Add
    
    For i = START_ROW To lastRow
        Application.StatusBar = "Merging: " & wsDash.Range(COL_Q_SHEET & i).Value
        
        Set wbSrc = Nothing
        On Error Resume Next
        Set wbSrc = Workbooks.Open(wsDash.Range(COL_Q_PATH & i).Value, ReadOnly:=True, UpdateLinks:=0, Password:="", IgnoreReadOnlyRecommended:=True)
        On Error GoTo 0
        
        If Not wbSrc Is Nothing Then
            On Error Resume Next
            wbSrc.Sheets(wsDash.Range(COL_Q_SHEET & i).Value).Copy After:=wbNew.Sheets(wbNew.Sheets.Count)
            If Err.Number = 0 Then cnt = cnt + 1
            wbSrc.Close False
            On Error GoTo 0
        End If
    Next i
    
    If wbNew.Sheets.Count > 1 Then On Error Resume Next: wbNew.Sheets(1).Delete: On Error GoTo 0
    
    Application.StatusBar = False: Application.ScreenUpdating = True: Application.DisplayAlerts = True
    MsgBox "Done! Merged " & cnt & " sheets.", vbInformation
End Sub

' --- 4. ADODB HELPER (Fast List) ---
Sub Helper_ListSheets_ADO(strFilePath As String)
    Dim ws As Worksheet
    Dim conn As Object, rs As Object
    Dim strConn As String, shtName As String
    Dim r As Long
    
    Set ws = ThisWorkbook.Sheets("Dashboard")
    
    Application.Cursor = xlWait: Application.ScreenUpdating = False
    
    ' Clear UI based on Constants
    ws.Range(COL_CHECK & START_ROW & ":" & COL_SHEET & "50").ClearContents
    ws.Range(CELL_TEMP).ClearComments
    ws.Range(CELL_TEMP).AddComment strFilePath
    ws.Range(CELL_TEMP).Value = "Viewing: " & Mid(strFilePath, InStrRev(strFilePath, "\") + 1)
    
    ' ADO Connection
    Set conn = CreateObject("ADODB.Connection")
    Set rs = CreateObject("ADODB.Recordset")
    strConn = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=" & strFilePath & ";Extended Properties=""Excel 12.0 Xml;HDR=NO"";"
    
    On Error Resume Next
    conn.Open strConn
    If Err.Number <> 0 Then ws.Range(COL_SHEET & START_ROW).Value = "Error: Cannot open file": GoTo Cleanup
    On Error GoTo 0
    
    Set rs = conn.OpenSchema(20) ' 20 = adSchemaTables
    r = START_ROW
    
    Do While Not rs.EOF
        shtName = rs.Fields("TABLE_NAME").Value
        ' Filter and Clean Name
        If Right(shtName, 1) = "$" Then
            shtName = Left(shtName, Len(shtName) - 1)
            If Left(shtName, 1) = "'" Then shtName = Mid(shtName, 2, Len(shtName) - 2)
            
            ws.Range(COL_SHEET & r).Value = shtName
            r = r + 1
        End If
        rs.MoveNext
    Loop
    conn.Close

Cleanup:
    Set rs = Nothing: Set conn = Nothing
    Application.ScreenUpdating = True: Application.Cursor = xlDefault
End Sub



' ==========================================
' >>> Sheet Module (Event)
' ==========================================

Option Explicit

Private Sub Worksheet_BeforeDoubleClick(ByVal Target As Range, Cancel As Boolean)
    Dim ws As Worksheet
    Set ws = Me
    
    ' 1. TRIGGER: File Name (Uses Constants COL_FILE and START_ROW)
    If Not Intersect(Target, ws.Range(COL_FILE & START_ROW & ":" & COL_FILE & "50")) Is Nothing Then
        If Target.Value <> "" Then
            ' Get Path from Hidden Column
            Dim filePath As String
            filePath = ws.Range(COL_PATH & Target.Row).Value
            
            Call Helper_ListSheets_ADO(filePath)
            Cancel = True
        End If
    End If
    
    ' 2. TRIGGER: Checkbox (Uses Constants COL_CHECK and START_ROW)
    If Not Intersect(Target, ws.Range(COL_CHECK & START_ROW & ":" & COL_CHECK & "50")) Is Nothing Then
        ' Only if Sheet Name exists
        If ws.Range(COL_SHEET & Target.Row).Value <> "" Then
            If Target.Value = "x" Then
                Target.Value = ""
            Else
                Target.Value = "x"
            End If
            Cancel = True
        End If
    End If
End Sub