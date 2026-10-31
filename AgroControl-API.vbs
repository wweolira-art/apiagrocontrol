Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = pasta

codigo = sh.Run("cmd /c node iniciar.mjs", 0, True)
If codigo <> 0 Then
  MsgBox "Nao foi possivel iniciar a API." & vbCrLf & vbCrLf & "Instale o Node.js, abra esta pasta e rode: npm install", 16, "AgroControl API"
Else
  MsgBox "AgroControl API rodando em segundo plano." & vbCrLf & "Para usuario/porta do ngrok, clique em Configurar-API.", 64, "AgroControl API"
End If
