Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Wscript.Shell")
sh.CurrentDirectory = pasta
codigo = sh.Run("cmd /c node parar.mjs", 0, True)
MsgBox "AgroControl API encerrada.", 64, "AgroControl API"
